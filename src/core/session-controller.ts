import { PtyHost, type PtyStartOptions } from '../main/pty-host';
import { LimitDetector, type LimitDetectorOptions, type LimitEvent } from './limit-detector';
import { createLogger } from './logger';
import { ResumeScheduler, type SchedulerEvent } from './resume-scheduler';
import { DEFAULT_RESUME_PROMPT, sanitizeResumePrompt } from './settings';
import { assertTransition, type SessionState } from './state';

const log = createLogger('session');

/**
 * Minimal scheduler surface the controller depends on. The real
 * {@link ResumeScheduler} satisfies it; tests can inject a fast fake so the
 * full loop runs in milliseconds without depending on wall-clock reset times.
 */
export interface IResumeScheduler {
  on(listener: (e: SchedulerEvent) => void): () => void;
  start(resetTime: Date | null): void;
  retry(): void;
  stop(): void;
}

/** Minimal PTY surface, so tests can inject a fake transport if desired. */
export interface IPtyHost {
  readonly running: boolean;
  start(opts: PtyStartOptions): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(handler: (data: string) => void): () => void;
  onExit(handler: (info: { exitCode: number; signal?: number }) => void): () => void;
}

/**
 * Heuristic match for the Claude CLI's working-directory trust / permission
 * prompt (e.g. "Do you trust the files in this folder?"). When a launch exits
 * shortly after printing this — typically because it can't get an interactive
 * answer and bails with code 1 — we surface an `untrusted` event so the UI can
 * offer to retry with the trust flag instead of silently dropping to idle.
 */
const TRUST_PROMPT_RE =
  /do you trust the files in this (?:folder|directory|workspace)|trust the files in this|do you trust this (?:folder|directory|workspace)/i;

/** Strip ANSI/VT escape sequences so text matching isn't defeated by coloring. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export type ControllerEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'data'; data: string }
  | { type: 'limit'; resetTime: Date | null; matchedText: string }
  | { type: 'countdown'; remainingMs: number; targetMs: number }
  | { type: 'resuming'; attempt: number }
  | { type: 'resumed' }
  | { type: 'notice'; message: string }
  | { type: 'untrusted'; message: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; exitCode: number };

export type ControllerListener = (event: ControllerEvent) => void;

export interface SessionControllerOptions {
  /** The CLI to run (e.g. "claude"). */
  command: string;
  /** Base args for a fresh launch. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /**
   * The prompt typed into the session (followed by Enter) when the wait ends.
   * Default "continue".
   */
  resumePrompt?: string;
  /**
   * Args appended when the session has to be *relaunched* to resume (the CLI
   * exited or the app restarted mid-wait). Default `['--continue']`, which
   * reattaches the most recent conversation before the prompt is typed.
   */
  continueArgs?: string[];
  /** Automatically schedule + perform resume when a limit is hit. Default true. */
  autoResume?: boolean;
  /**
   * How long a freshly resumed session must run *without* re-hitting a limit or
   * exiting before it is considered successfully resumed. Default 4s.
   */
  verifyWindowMs?: number;
  /**
   * When a limit message matches but arrives *without* a trailing newline — as it
   * does when the CLI renders it in place inside a live TUI (redrawn, never
   * newline-terminated) — wait this long for output to go idle, then force-flush
   * so the limit is detected *during* the running session instead of only when it
   * exits. Default 800ms.
   */
  limitIdleFlushMs?: number;
  /**
   * Launch with the directory-trust prompt bypassed. When true, {@link trustFlags}
   * are appended to every fresh launch AND every resume relaunch. Off by default.
   */
  trustWorkingDir?: boolean;
  /**
   * The flag(s) that bypass the CLI's working-directory trust / permission
   * prompt. Default `['--dangerously-skip-permissions']` (Claude Code). Only
   * applied when {@link trustWorkingDir} is true.
   */
  trustFlags?: string[];

  // --- Injectables (primarily for tests) ---
  scheduler?: IResumeScheduler;
  detectorOptions?: LimitDetectorOptions;
  /** Factory so each (re)spawn gets a clean PTY. Default constructs PtyHost. */
  createPty?: () => IPtyHost;
}

/**
 * SessionController orchestrates the limit -> wait -> auto-resume loop.
 *
 * It owns the state machine and wires together a PTY transport, the
 * {@link LimitDetector}, and a {@link ResumeScheduler}:
 *
 *   IDLE --start()--> RUNNING
 *   RUNNING --limit detected--> LIMIT_DETECTED --> WAITING  (scheduler armed,
 *     the CLI session is kept alive exactly as the user would leave it)
 *   WAITING --scheduler fires--> RESUMING  (type "continue" + Enter into the
 *     live session; relaunch `claude --continue` first if the session died)
 *   RESUMING --verified ok--> RUNNING (emit "resumed")
 *   RESUMING --re-limited / exited--> WAITING (scheduler.retry) ... or ERROR (exhausted)
 *
 * Pure of Electron; exercised end-to-end against the fake-claude fixture.
 */
export class SessionController {
  private readonly opts: Required<
    Pick<
      SessionControllerOptions,
      | 'command'
      | 'resumePrompt'
      | 'continueArgs'
      | 'autoResume'
      | 'verifyWindowMs'
      | 'limitIdleFlushMs'
      | 'trustWorkingDir'
      | 'trustFlags'
    >
  > &
    SessionControllerOptions;
  private readonly scheduler: IResumeScheduler;
  private readonly detector: LimitDetector;
  private readonly createPty: () => IPtyHost;

  private readonly listeners = new Set<ControllerListener>();

  private _state: SessionState = 'IDLE';
  private pty: IPtyHost | undefined;
  private ptyUnsubs: Array<() => void> = [];
  private verifyTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Debounce for detecting a limit the CLI renders in place (no trailing newline)
   * while the session stays live. Armed when {@link LimitDetector.push} matches
   * but withholds the event; force-flushes once output goes idle.
   */
  private limitFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private verifying = false;
  private disposed = false;
  private unsubScheduler: (() => void) | undefined;
  /** Reset time from the most recent limit, so toggling autoResume can re-arm. */
  private lastResetTime: Date | null = null;
  /** Small tail of recent output, for trust detection and exit diagnostics. */
  private recentOutput = '';

  constructor(options: SessionControllerOptions) {
    // Strip explicit `undefined` values so callers passing `{ verifyWindowMs:
    // someMaybeUndefined }` don't clobber the defaults below via the spread.
    const provided = Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined),
    ) as SessionControllerOptions;
    this.opts = {
      resumePrompt: DEFAULT_RESUME_PROMPT,
      continueArgs: ['--continue'],
      autoResume: true,
      verifyWindowMs: 4_000,
      limitIdleFlushMs: 800,
      trustWorkingDir: false,
      trustFlags: ['--dangerously-skip-permissions'],
      ...provided,
    };
    this.opts.resumePrompt = sanitizeResumePrompt(this.opts.resumePrompt);
    this.scheduler = options.scheduler ?? new ResumeScheduler();
    this.detector = new LimitDetector(options.detectorOptions);
    this.createPty = options.createPty ?? (() => new PtyHost());
    this.unsubScheduler = this.scheduler.on((e) => this.onSchedulerEvent(e));
  }

  get state(): SessionState {
    return this._state;
  }

  /**
   * Internal current-state read via a method call (not a getter/property) so
   * TypeScript's control-flow analysis doesn't retain a stale narrowing of
   * `this._state` from an enclosing comparison after setState()/emit().
   */
  private liveState(): SessionState {
    return this._state;
  }

  on(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Launch the CLI fresh. Valid only from IDLE. */
  start(): void {
    if (this._state !== 'IDLE') {
      throw new Error(`start() requires IDLE state (was ${this._state})`);
    }
    this.detector.reset();
    const args = this.opts.args ?? [];
    log.info('start()', {
      command: this.opts.command,
      args,
      cwd: this.opts.cwd,
      autoResume: this.opts.autoResume,
      trustWorkingDir: this.opts.trustWorkingDir,
    });
    this.spawn(this.withTrustFlags(args));
    this.setState('RUNNING');
  }

  /**
   * Re-enter WAITING directly from IDLE to recover a wait that was persisted
   * before the app restarted. No live session exists anymore, so when the
   * scheduler fires the resume relaunches `claude --continue` and types the
   * resume prompt. The scheduler is armed against the *same absolute* reset
   * time so we still resume on schedule (or immediately, if that time already
   * passed while the app was closed).
   */
  recoverWaiting(resetTime: Date | null): void {
    if (this._state !== 'IDLE') {
      throw new Error(`recoverWaiting() requires IDLE state (was ${this._state})`);
    }
    this.detector.reset();
    this.lastResetTime = resetTime;

    // Surface the recovered wait to listeners as a limit event so the UI shows
    // the countdown/overlay exactly as it would for a live limit.
    this.emit({
      type: 'limit',
      resetTime,
      matchedText: 'Recovered pending wait after restart',
    });
    if (this.liveState() !== 'IDLE') return; // a listener already moved us on
    this.setState('WAITING');
    if (this.liveState() !== 'WAITING') return;
    if (this.opts.autoResume) this.scheduler.start(resetTime);
  }

  /** Forward user keystrokes to the PTY. */
  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  /** Whether limits trigger an automatic, scheduled resume. */
  get autoResume(): boolean {
    return this.opts.autoResume;
  }

  /**
   * Replace the active limit-detection patterns mid-session so a settings change
   * applies to the *running* session without a relaunch. Delegates to the live
   * {@link LimitDetector}; the next chunk of output is matched against the new
   * patterns. Safe to call in any state.
   */
  setLimitPatterns(patterns: RegExp[]): void {
    this.detector.setPatterns(patterns);
    log.info('limit patterns updated mid-session', { count: patterns.length });
  }

  /**
   * Toggle automatic resume at runtime. If we are already WAITING, enabling
   * arms the scheduler (using the last known reset time) and disabling pauses it.
   */
  setAutoResume(enabled: boolean): void {
    this.opts.autoResume = enabled;
    if (this._state !== 'WAITING') return;
    if (enabled) this.scheduler.start(this.lastResetTime);
    else this.scheduler.stop();
  }

  /**
   * Manually trigger a resume (e.g. a UI "Resume now" button). Delegates to the
   * scheduler with an already-elapsed target so it fires immediately *and* resets
   * the retry budget, keeping the retry/exhaustion machinery active on failure.
   */
  resumeNow(): void {
    if (this._state === 'ERROR') this.setState('WAITING');
    if (this._state !== 'WAITING') return;
    this.scheduler.start(new Date(0));
  }

  /** Stop everything and return to IDLE. */
  stop(): void {
    this.scheduler.stop();
    this.clearVerifyTimer();
    this.verifying = false;
    this.teardownPty();
    if (this._state !== 'IDLE') this.setState('IDLE');
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.unsubScheduler?.();
    this.unsubScheduler = undefined;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // PTY lifecycle
  // ---------------------------------------------------------------------------

  private spawn(args: string[]): void {
    this.teardownPty();
    this.recentOutput = '';
    const host = this.createPty();
    this.pty = host;
    const myPty = host;

    this.ptyUnsubs.push(
      host.onData((d) => {
        if (myPty !== this.pty) return; // ignore stale output
        this.onData(d);
      }),
    );
    this.ptyUnsubs.push(
      host.onExit((info) => {
        if (myPty !== this.pty) return; // ignore stale exits
        this.onExit(info);
      }),
    );

    try {
      host.start({
        command: this.opts.command,
        args,
        cwd: this.opts.cwd,
        env: this.opts.env,
        cols: this.opts.cols,
        rows: this.opts.rows,
      });
    } catch (err) {
      // Don't leave half-wired listeners or a dangling pty reference behind.
      log.error('spawn failed', {
        command: this.opts.command,
        args,
        cwd: this.opts.cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const u of this.ptyUnsubs) u();
      this.ptyUnsubs = [];
      this.pty = undefined;
      throw err;
    }
  }

  private teardownPty(): void {
    this.clearLimitFlushTimer();
    for (const u of this.ptyUnsubs) u();
    this.ptyUnsubs = [];
    if (this.pty?.running) {
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.pty = undefined;
  }

  /**
   * Append the configured trust flag(s) when {@link SessionControllerOptions.trustWorkingDir}
   * is on, skipping any already present. Applied to both fresh launches and
   * resume relaunches so an auto-resume after a wait doesn't re-hit the trust
   * prompt. No-op when trust is off.
   */
  private withTrustFlags(args: string[]): string[] {
    if (!this.opts.trustWorkingDir) return args;
    const extra = this.opts.trustFlags.filter((f) => f && !args.includes(f));
    return extra.length > 0 ? [...args, ...extra] : args;
  }

  // ---------------------------------------------------------------------------
  // PTY event handling
  // ---------------------------------------------------------------------------

  private onData(data: string): void {
    this.emit({ type: 'data', data });
    // Keep a small tail of recent output so an exit can be diagnosed (trust
    // prompt detection, "why did it die" notices).
    if (this._state === 'RUNNING') {
      this.recentOutput = (this.recentOutput + data).slice(-8_192);
    }
    const ev = this.detector.push(data);
    if (ev) {
      this.clearLimitFlushTimer();
      this.handleLimit(ev);
      return;
    }
    // The CLI often renders the usage-limit notice *in place* inside its live TUI
    // (redrawn, never newline-terminated), so push() matches but withholds the
    // event pending a newline that never arrives while the session stays open —
    // the limit would otherwise only surface on flush() when the user exits. Arm
    // a one-shot idle flush so we detect it during the live session instead.
    if (
      this._state === 'RUNNING' &&
      this.limitFlushTimer === undefined &&
      this.detector.hasPendingMatch()
    ) {
      this.limitFlushTimer = setTimeout(() => this.onLimitIdle(), this.opts.limitIdleFlushMs);
    }
  }

  /**
   * Fired when output has been idle for {@link SessionControllerOptions.limitIdleFlushMs}
   * after a withheld limit match. Force-flushes the detector so an in-place TUI
   * limit notice (no trailing newline) is caught while the session is still live.
   */
  private onLimitIdle(): void {
    this.limitFlushTimer = undefined;
    if (this._state !== 'RUNNING') return;
    const ev = this.detector.flush();
    if (ev) {
      log.info('idle-flush detected limit in live session', { matchedText: ev.matchedText });
      this.handleLimit(ev);
    }
  }

  private onExit(info: { exitCode: number; signal?: number }): void {
    this.pty = undefined;
    this.clearLimitFlushTimer();
    log.info('pty exit handled', { exitCode: info.exitCode, signal: info.signal, state: this._state });

    if (this._state === 'RUNNING') {
      // The CLI may have printed a limit message without a trailing newline
      // right before exiting; force a flush to catch it.
      const ev = this.detector.flush();
      if (ev) {
        log.debug('exit flush detected limit', { matchedText: ev.matchedText });
        this.handleLimit(ev);
        return;
      }
      // The working directory isn't trusted: Claude printed its trust prompt and
      // bailed (usually code 1) because it couldn't get an interactive answer.
      // Surface an `untrusted` event so the UI can offer a one-click retry with
      // the trust flag, instead of leaving the user staring at a bare "code 1".
      if (!this.opts.trustWorkingDir && TRUST_PROMPT_RE.test(stripAnsi(this.recentOutput))) {
        const msg =
          "This folder isn't trusted yet, so the CLI exited. Trust it to run Claude here.";
        log.info('untrusted working dir detected on exit', { exitCode: info.exitCode });
        this.emit({ type: 'untrusted', message: msg });
        this.setState('IDLE');
        this.emit({ type: 'exit', exitCode: info.exitCode });
        return;
      }
      // Clean, user-initiated exit.
      const tail = stripAnsi(this.recentOutput).trim().slice(-300);
      log.info('clean exit -> IDLE', { exitCode: info.exitCode, recentOutputTail: tail.slice(-200) });
      // Surface *why* a non-zero exit happened: show the CLI's own last output so
      // the user isn't left with a bare "code 1". (A clean code-0 quit needs no note.)
      if (info.exitCode !== 0) {
        const detail = tail ? ` Last output: ${tail}` : ' (no output was captured)';
        this.emit({ type: 'notice', message: `Session exited with code ${info.exitCode}.${detail}` });
      }
      this.setState('IDLE');
      this.emit({ type: 'exit', exitCode: info.exitCode });
      return;
    }

    if (this._state === 'RESUMING' && this.verifying) {
      // Resume process died inside the verify window => resume failed.
      const ev = this.detector.flush();
      log.info('resume exited inside verify window -> resume failed', { exitCode: info.exitCode });
      this.handleResumeFailure(ev?.matchedText ?? `resume exited (code ${info.exitCode})`);
      return;
    }

    if (this._state === 'WAITING' || this._state === 'LIMIT_DETECTED') {
      // The limited session died while we wait (the CLI quit on its own, the OS
      // reclaimed it, ...). Keep waiting: the resume will relaunch `--continue`.
      log.info('session exited mid-wait; resume will relaunch', { exitCode: info.exitCode });
      this.emit({
        type: 'notice',
        message: 'The CLI exited while waiting — the session will be relaunched at resume time.',
      });
      return;
    }

    // ERROR / IDLE: nothing to do.
    log.debug('exit ignored for state', { state: this._state, exitCode: info.exitCode });
  }

  // ---------------------------------------------------------------------------
  // Limit + resume orchestration
  // ---------------------------------------------------------------------------

  private handleLimit(ev: LimitEvent): void {
    if (this._state === 'RUNNING') {
      this.lastResetTime = ev.resetTime;
      this.setState('LIMIT_DETECTED');
      // setState/emit invoke listeners synchronously; a listener may call
      // stop()/dispose() and change our state. Re-check before each step.
      // (`liveState` reads the field through a method so TS doesn't keep the
      //  RUNNING narrowing from the enclosing `if`.)
      if (this.liveState() !== 'LIMIT_DETECTED') return;
      this.emit({ type: 'limit', resetTime: ev.resetTime, matchedText: ev.matchedText });
      if (this.liveState() !== 'LIMIT_DETECTED') return;
      // The session is deliberately kept alive: at resume time the prompt is
      // typed into it exactly as the user would after waiting out the reset.
      this.setState('WAITING');
      if (this.liveState() !== 'WAITING') return;
      if (this.opts.autoResume) this.scheduler.start(ev.resetTime);
      // autoResume=false: stay in WAITING until a manual resumeNow().
      return;
    }

    if (this._state === 'RESUMING' && this.verifying) {
      this.handleResumeFailure(ev.matchedText);
      return;
    }
    // Any other state: ignore (e.g. duplicate match while already WAITING).
  }

  private onSchedulerEvent(e: SchedulerEvent): void {
    if (this.disposed) return;
    switch (e.type) {
      case 'tick':
        this.emit({ type: 'countdown', remainingMs: e.remainingMs, targetMs: e.targetMs });
        break;
      case 'resume':
        if (this._state === 'WAITING') this.doResume(e.attempt);
        break;
      case 'exhausted':
        // Bubble up from a retry(): give up. By the time exhausted fires we have
        // already moved back to WAITING (see handleResumeFailure).
        if (this._state === 'WAITING' || this._state === 'RESUMING') {
          this.setState('ERROR');
        }
        this.emit({ type: 'error', message: `Resume failed after ${e.attempts} attempts` });
        break;
    }
  }

  /**
   * The wait is over: type the resume prompt ("continue" + Enter) into the live
   * session — the same thing the user does by hand once the limit resets. If the
   * session died in the meantime (or we recovered a wait after an app restart),
   * relaunch the CLI attached to the previous conversation first, then type the
   * prompt to set it working again.
   */
  private doResume(attempt: number): void {
    this.setState('RESUMING');
    this.emit({ type: 'resuming', attempt });

    this.detector.reset();
    this.verifying = true;

    if (!this.pty?.running) {
      const args = this.withTrustFlags([...(this.opts.args ?? []), ...this.opts.continueArgs]);
      log.info('no live session at resume time — relaunching', { args });
      try {
        this.spawn(args);
      } catch (err) {
        // Spawn failed (bad command, PTY error): treat exactly like a failed resume.
        this.handleResumeFailure(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.pty?.write(this.opts.resumePrompt + '\r');

    this.clearVerifyTimer();
    this.verifyTimer = setTimeout(() => this.onVerifySuccess(), this.opts.verifyWindowMs);
  }

  private onVerifySuccess(): void {
    if (!this.verifying || this._state !== 'RESUMING') return;
    this.verifying = false;
    this.clearVerifyTimer();
    this.scheduler.stop();
    this.setState('RUNNING');
    this.emit({ type: 'resumed' });
  }

  private handleResumeFailure(_reason: string): void {
    if (!this.verifying) return;
    this.verifying = false;
    this.clearVerifyTimer();
    // A still-limited live session is kept alive — the next attempt just types
    // the prompt into it again. Only a dead PTY (exit/spawn failure) is gone.

    // Move back to WAITING *before* asking for the next attempt, so that a
    // synchronous scheduler can legally fire 'resume' (WAITING -> RESUMING) and
    // an 'exhausted' event lands while we are in WAITING (WAITING -> ERROR).
    if (this._state === 'RESUMING') this.setState('WAITING');
    if (this.liveState() !== 'WAITING') return; // a listener changed our state
    this.scheduler.retry();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private clearVerifyTimer(): void {
    if (this.verifyTimer !== undefined) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = undefined;
    }
  }

  private clearLimitFlushTimer(): void {
    if (this.limitFlushTimer !== undefined) {
      clearTimeout(this.limitFlushTimer);
      this.limitFlushTimer = undefined;
    }
  }

  private setState(next: SessionState): void {
    assertTransition(this._state, next);
    log.debug('state transition', { from: this._state, to: next });
    this._state = next;
    this.emit({ type: 'state', state: next });
  }

  private emit(event: ControllerEvent): void {
    for (const l of this.listeners) l(event);
  }
}

import { PtyHost, type PtyStartOptions } from '../main/pty-host';
import { LimitDetector, type LimitDetectorOptions, type LimitEvent } from './limit-detector';
import { createLogger } from './logger';
import { PromptTracker } from './prompt-tracker';
import { ResumeScheduler, type SchedulerEvent } from './resume-scheduler';
import { assertTransition, canTransition, type SessionState } from './state';

const log = createLogger('session');

/**
 * Minimal scheduler surface the controller depends on. The real
 * {@link ResumeScheduler} satisfies it; tests can inject a fast fake so the
 * full loop runs in milliseconds without depending on wall-clock reset times.
 */
export interface IResumeScheduler {
  on(listener: (e: SchedulerEvent) => void): () => void;
  start(resetTime: Date | null): void;
  startIn(delayMs: number): void;
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

export type ResumeStrategy = 'continue' | 'replay';

/**
 * Heuristic match for the Claude CLI's message when a `--continue`/`-c` launch
 * finds no prior conversation to resume. Kept broad so it survives minor wording
 * changes across CLI versions; only consulted as one of several fresh-fallback
 * signals (a quick exit alone is enough).
 */
const NO_CONVERSATION_RE =
  /no\s+(?:conversation|previous\s+conversation|conversations?|session|sessions?)\b[^.\n]*?\b(?:found|to\s+(?:continue|resume)|exists?)|nothing\s+to\s+(?:continue|resume)/i;

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

/**
 * Make a captured/overridden/persisted prompt safe to write verbatim to the PTY
 * at resume time. The replay strategy writes `prompt + '\r'` as raw keystrokes,
 * so any embedded C0/C1 control character — most importantly CR/LF (which the
 * TUI treats as Enter) or ESC (which begins a terminal control sequence) — would
 * otherwise multi-submit fragments or inject escape codes during an *unattended*
 * resume. Collapse every such byte to a space and trim. Centralized here so all
 * three prompt sources (live capture, explicit override, post-restart recovery)
 * share one guarantee.
 */
export function sanitizeReplayPrompt(text: string | null | undefined): string {
  return (
    String(text ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .trim()
  );
}

/** Human-readable rendering of a millisecond delay for notice messages. */
function formatDelay(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

export type ControllerEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'data'; data: string }
  | { type: 'limit'; resetTime: Date | null; matchedText: string }
  | { type: 'countdown'; remainingMs: number; targetMs: number }
  | { type: 'resuming'; attempt: number; strategy: ResumeStrategy }
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
  /** Resume approach: `claude --continue`, or replay the last prompt. */
  strategy?: ResumeStrategy;
  /** Args appended for a `continue` resume. Default `['--continue']`. */
  continueArgs?: string[];
  /**
   * Flags that mean "attach to an existing conversation" on a fresh launch.
   * If a launch using one of these exits quickly (no prior conversation to
   * continue), the controller retries once with these flags stripped so the
   * user gets a new session instead of an immediate exit. Default
   * `['--continue', '-c']`.
   */
  continueFlags?: string[];
  /**
   * Upper bound on how soon after a continue-launch an exit is treated as
   * "no existing session" purely on timing. Longer exits can still trigger the
   * fresh fallback via a non-zero exit code or the CLI's no-conversation
   * message, as long as the user never interacted. Default 10s.
   */
  quickExitMs?: number;
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
   * are appended to every fresh launch AND every resume launch. Off by default.
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
 *   RUNNING --limit detected--> LIMIT_DETECTED --> WAITING  (scheduler armed)
 *   WAITING --scheduler fires--> RESUMING  (respawn + verify window)
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
      | 'strategy'
      | 'continueArgs'
      | 'continueFlags'
      | 'quickExitMs'
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

  // Fresh-session fallback: when a launch that used a continue flag exits too
  // quickly to be a real session (no prior conversation to continue), retry once
  // with the continue flags stripped instead of just dropping to IDLE.
  private launchArgs: string[] = [];
  private launchedAt = 0;
  private recentOutput = '';
  private initialContinueLaunch = false;
  private freshFallbackDone = false;
  /**
   * Whether the user has actually engaged with the current launch (typed a
   * character, Enter, Ctrl-C, etc.). Used to tell "a real conversation was
   * resumed and used" apart from "the continue launch found nothing and
   * exited". Terminal auto-responses (ESC-prefixed) do not count.
   */
  private userInteracted = false;

  // Replay-mode prompt capture: a robust keystroke reconstructor plus an
  // optional explicit override the user can set from a prompt bar.
  private readonly promptTracker = new PromptTracker();
  private replayOverride: string | null = null;

  constructor(options: SessionControllerOptions) {
    // Strip explicit `undefined` values so callers passing `{ quickExitMs:
    // someMaybeUndefined }` don't clobber the defaults below via the spread.
    const provided = Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined),
    ) as SessionControllerOptions;
    this.opts = {
      strategy: 'continue',
      continueArgs: ['--continue'],
      continueFlags: ['--continue', '-c'],
      quickExitMs: 10_000,
      autoResume: true,
      verifyWindowMs: 4_000,
      limitIdleFlushMs: 800,
      trustWorkingDir: false,
      trustFlags: ['--dangerously-skip-permissions'],
      ...provided,
    };
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
    this.promptTracker.reset();
    this.replayOverride = null;
    const args = this.opts.args ?? [];
    // Only the very first user launch is eligible for the fresh-session
    // fallback, and only if it actually asked to continue an existing session.
    this.freshFallbackDone = false;
    this.initialContinueLaunch = this.argsHaveContinueFlag(args);
    this.userInteracted = false;
    log.info('start()', {
      command: this.opts.command,
      args,
      cwd: this.opts.cwd,
      strategy: this.opts.strategy,
      autoResume: this.opts.autoResume,
      initialContinueLaunch: this.initialContinueLaunch,
      trustWorkingDir: this.opts.trustWorkingDir,
    });
    this.spawn(this.withTrustFlags(args));
    this.setState('RUNNING');
  }

  /**
   * Re-enter WAITING directly from IDLE to recover a wait that was persisted
   * before the app restarted. No live session is spawned yet; the scheduler is
   * armed against the *same absolute* reset time so we still resume on schedule
   * (or immediately, if that time already passed while the app was closed).
   *
   * For the `replay` strategy the captured prompt is gone after a restart, so the
   * caller passes the persisted prompt to seed the replay override.
   */
  recoverWaiting(resetTime: Date | null, replayPrompt?: string): void {
    if (this._state !== 'IDLE') {
      throw new Error(`recoverWaiting() requires IDLE state (was ${this._state})`);
    }
    this.detector.reset();
    this.promptTracker.reset();
    const seed = sanitizeReplayPrompt(replayPrompt);
    this.replayOverride = seed.length > 0 ? seed : null;
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

  /** Forward user keystrokes to the PTY (and track them for replay). */
  write(data: string): void {
    // Only capture input that is actually accepted by a live, running session,
    // so keystrokes typed while WAITING/RESUMING aren't mistaken for a prompt.
    if (this._state === 'RUNNING') {
      this.promptTracker.push(data);
      // Real engagement with a resumed session: distinguishes "user used the
      // session" from "continue found nothing and exited". Ignore ESC-prefixed
      // sequences (arrow/function keys and terminal auto-responses like cursor-
      // position replies), which the renderer may emit without a real keypress.
      if (data.length > 0 && data.charCodeAt(0) !== 0x1b) this.userInteracted = true;
    }
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
   * The prompt that a `replay` resume will re-send: an explicit override if one
   * was set, otherwise the last captured input line. Empty string if neither.
   * Sanitized here so it is safe whether it came from the override or from raw
   * keystroke capture (which deliberately preserves interior newlines).
   */
  get replayPrompt(): string {
    return sanitizeReplayPrompt(this.replayOverride ?? this.promptTracker.lastPrompt);
  }

  /**
   * Explicitly set (or clear) the prompt to replay, overriding keystroke
   * capture. Pass an empty string to clear the override and fall back to
   * capture. Lets the UI offer a reliable prompt bar when TUI capture is
   * imperfect.
   */
  setReplayPrompt(text: string): void {
    // Strip C0/C1 control characters (CR/LF/ESC/Ctrl-*) before storing: the
    // override is written verbatim + a single CR at resume time, so an embedded
    // newline or escape could multi-submit or inject terminal control sequences.
    const clean = sanitizeReplayPrompt(text);
    this.replayOverride = clean.length > 0 ? clean : null;
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

  /**
   * Manually schedule a resume a fixed delay from now (a user-set timer in the
   * UI). Unlike {@link resumeNow}, this *drives* the session into WAITING: it can
   * be armed from a live RUNNING session, a detected limit, or a prior failure —
   * in every case the session converges on WAITING and counts down. When the
   * timer elapses the scheduler fires a normal `resume`, so the usual
   * WAITING -> RESUMING -> RUNNING flow (and the retry/exhaustion machinery)
   * takes over. A non-positive delay fires immediately, matching `resumeNow`.
   *
   * RESUMING is intentionally excluded: a resume is already in flight, so a new
   * timer would race the verify window. Returns true if a timer was armed.
   */
  resumeAfter(delayMs: number): boolean {
    if (this._state === 'RESUMING') return false;
    if (this._state !== 'WAITING') {
      if (!canTransition(this._state, 'WAITING')) return false;
      this.setState('WAITING');
      if (this.liveState() !== 'WAITING') return false; // a listener changed our state
    }
    // No limit drove this wait, so there is no reset time to re-arm from if the
    // user later toggles auto-resume; clear it to avoid a stale reset leaking in.
    this.lastResetTime = null;
    this.scheduler.startIn(delayMs);
    this.emit({ type: 'notice', message: `Manual timer set — resuming in ${formatDelay(delayMs)}.` });
    return true;
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
    this.launchArgs = args;
    this.launchedAt = Date.now();
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

  // ---------------------------------------------------------------------------
  // Fresh-session fallback helpers
  // ---------------------------------------------------------------------------

  private argsHaveContinueFlag(args: string[]): boolean {
    return args.some((a) => this.opts.continueFlags.includes(a));
  }

  private stripContinueFlags(args: string[]): string[] {
    return args.filter((a) => !this.opts.continueFlags.includes(a));
  }

  /**
   * Append the configured trust flag(s) when {@link SessionControllerOptions.trustWorkingDir}
   * is on, skipping any already present. Applied to both fresh launches and
   * resume launches so an auto-resume after a wait doesn't re-hit the trust
   * prompt. No-op when trust is off.
   */
  private withTrustFlags(args: string[]): string[] {
    if (!this.opts.trustWorkingDir) return args;
    const extra = this.opts.trustFlags.filter((f) => f && !args.includes(f));
    return extra.length > 0 ? [...args, ...extra] : args;
  }

  /**
   * True when a RUNNING-state exit looks like "couldn't continue an existing
   * session". The decisive signal is that the user never engaged with this
   * launch: a genuinely resumed conversation gets used before it ends, whereas
   * a `--continue` launch with nothing to resume exits untouched. We additionally
   * require at least one corroborating signal — a quick exit, a non-zero exit
   * code, or the CLI's no-conversation message — so a real session the user
   * merely watched for a long time and that then died on its own isn't relaunched.
   */
  private shouldFreshFallback(exitCode: number): boolean {
    const quick = Date.now() - this.launchedAt <= this.opts.quickExitMs;
    const noConvo = NO_CONVERSATION_RE.test(stripAnsi(this.recentOutput));
    const decision =
      this.initialContinueLaunch &&
      !this.freshFallbackDone &&
      this.argsHaveContinueFlag(this.launchArgs) &&
      !this.userInteracted &&
      (quick || exitCode !== 0 || noConvo);
    // Verbose: the full reasoning behind whether a no-session `--continue` exit
    // gets retried as a fresh session — the heart of the "doesn't restart" bug.
    log.debug('shouldFreshFallback', {
      decision,
      exitCode,
      initialContinueLaunch: this.initialContinueLaunch,
      freshFallbackDone: this.freshFallbackDone,
      argsHaveContinueFlag: this.argsHaveContinueFlag(this.launchArgs),
      userInteracted: this.userInteracted,
      quick,
      nonZeroExit: exitCode !== 0,
      noConversationMatch: noConvo,
      msSinceLaunch: Date.now() - this.launchedAt,
      quickExitMs: this.opts.quickExitMs,
    });
    return decision;
  }

  // ---------------------------------------------------------------------------
  // PTY event handling
  // ---------------------------------------------------------------------------

  private onData(data: string): void {
    this.emit({ type: 'data', data });
    // Keep a small tail of recent output so a quick exit can be classified as
    // "no conversation to continue" via the CLI's own message.
    if (this._state === 'RUNNING' && !this.freshFallbackDone) {
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
      // No existing session to continue: the CLI exited almost immediately.
      // Retry once with the continue flags stripped so the user lands in a new
      // session instead of seeing the app drop straight to idle.
      if (this.shouldFreshFallback(info.exitCode)) {
        this.freshFallbackDone = true;
        this.initialContinueLaunch = false;
        const freshArgs = this.stripContinueFlags(this.launchArgs);
        this.detector.reset();
        this.promptTracker.reset();
        const msg = 'No existing session found — starting a new session.';
        log.info('fresh-session fallback', { from: this.launchArgs, to: freshArgs });
        this.emit({ type: 'notice', message: msg });
        this.emit({ type: 'data', data: `\r\n\x1b[33m${msg}\x1b[0m\r\n` });
        this.spawn(freshArgs);
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

    // LIMIT_DETECTED / WAITING / ERROR / IDLE: the limited process exiting is
    // expected and must not be treated as a user quit.
    log.debug('exit ignored for state', { state: this._state, exitCode: info.exitCode });
  }

  // ---------------------------------------------------------------------------
  // Limit + resume orchestration
  // ---------------------------------------------------------------------------

  private handleLimit(ev: LimitEvent): void {
    if (this._state === 'RUNNING') {
      this.lastResetTime = ev.resetTime;
      // We hit a limit, so this launch did attach to a real session: it must
      // not be retried as a fresh session when the limited process exits.
      this.initialContinueLaunch = false;
      this.setState('LIMIT_DETECTED');
      // setState/emit invoke listeners synchronously; a listener may call
      // stop()/dispose() and change our state. Re-check before each step.
      // (`live` reads the field through a getter so TS doesn't keep the
      //  RUNNING narrowing from the enclosing `if`.)
      if (this.liveState() !== 'LIMIT_DETECTED') return;
      this.emit({ type: 'limit', resetTime: ev.resetTime, matchedText: ev.matchedText });
      if (this.liveState() !== 'LIMIT_DETECTED') return;
      this.teardownPty();
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

  private doResume(attempt: number): void {
    this.setState('RESUMING');
    this.emit({ type: 'resuming', attempt, strategy: this.opts.strategy });

    this.detector.reset();
    this.verifying = true;

    const args =
      this.opts.strategy === 'continue'
        ? this.withTrustFlags([...(this.opts.args ?? []), ...this.opts.continueArgs])
        : this.withTrustFlags([...(this.opts.args ?? [])]);

    try {
      this.spawn(args);
      if (this.opts.strategy === 'replay') {
        const prompt = this.replayPrompt;
        if (prompt) this.pty?.write(prompt + '\r');
      }
    } catch (err) {
      // Spawn failed (bad command, PTY error): treat exactly like a failed resume.
      this.handleResumeFailure(err instanceof Error ? err.message : String(err));
      return;
    }

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
    this.teardownPty();

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

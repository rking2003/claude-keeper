import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SessionController,
  type IPtyHost,
  type IResumeScheduler,
  type ControllerEvent,
} from '@core/session-controller';
import type { SchedulerEvent } from '@core/resume-scheduler';
import type { PtyStartOptions } from '../src/main/pty-host';

const LIMIT_LINE =
  'Claude usage limit reached. Your limit will reset at 3:00 PM (America/New_York).\r\n';

/** In-memory PTY so we can drive data/exit synchronously and deterministically. */
class FakePty implements IPtyHost {
  running = false;
  startError: Error | undefined;
  startArgs: string[] = [];
  readonly written: string[] = [];
  private readonly dataH = new Set<(d: string) => void>();
  private readonly exitH = new Set<(i: { exitCode: number; signal?: number }) => void>();

  start(opts: PtyStartOptions): void {
    if (this.startError) throw this.startError;
    this.startArgs = opts.args ?? [];
    this.running = true;
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(): void {}
  kill(): void {
    this.running = false;
  }
  onData(h: (d: string) => void): () => void {
    this.dataH.add(h);
    return () => this.dataH.delete(h);
  }
  onExit(h: (i: { exitCode: number; signal?: number }) => void): () => void {
    this.exitH.add(h);
    return () => this.exitH.delete(h);
  }
  emitData(d: string): void {
    for (const h of this.dataH) h(d);
  }
  emitExit(info: { exitCode: number; signal?: number }): void {
    this.running = false;
    for (const h of this.exitH) h(info);
  }
}

/** Fires `resume` synchronously on start()/retry(); honours maxRetries. */
class SyncScheduler implements IResumeScheduler {
  private readonly listeners = new Set<(e: SchedulerEvent) => void>();
  attempt = 0;
  private running = false;
  constructor(private readonly maxRetries = 5) {}
  on(l: (e: SchedulerEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  start(): void {
    this.attempt = 0;
    this.running = true;
    this.fire();
  }
  startIn(): void {
    this.attempt = 0;
    this.running = true;
    this.fire();
  }
  retry(): void {
    if (!this.running) return;
    if (this.attempt >= this.maxRetries) {
      this.stop();
      this.emit({ type: 'exhausted', attempts: this.attempt });
      return;
    }
    this.fire();
  }
  stop(): void {
    this.running = false;
  }
  private fire(): void {
    this.attempt += 1;
    this.emit({ type: 'resume', attempt: this.attempt, targetMs: 0 });
  }
  private emit(e: SchedulerEvent): void {
    for (const l of this.listeners) l(e);
  }
}

interface Harness {
  controller: SessionController;
  ptys: FakePty[];
  events: ControllerEvent[];
}

function harness(opts: {
  scheduler: IResumeScheduler;
  autoResume?: boolean;
  failPtyFrom?: number; // ptys with index >= this throw on start()
  verifyWindowMs?: number;
  strategy?: 'continue' | 'replay';
  args?: string[];
  quickExitMs?: number;
  trustWorkingDir?: boolean;
  trustFlags?: string[];
}): Harness {
  const ptys: FakePty[] = [];
  const events: ControllerEvent[] = [];
  const controller = new SessionController({
    command: 'fake',
    scheduler: opts.scheduler,
    autoResume: opts.autoResume ?? true,
    verifyWindowMs: opts.verifyWindowMs ?? 10_000,
    strategy: opts.strategy,
    args: opts.args,
    quickExitMs: opts.quickExitMs,
    trustWorkingDir: opts.trustWorkingDir,
    trustFlags: opts.trustFlags,
    createPty: () => {
      const p = new FakePty();
      if (opts.failPtyFrom !== undefined && ptys.length >= opts.failPtyFrom) {
        p.startError = new Error('spawn boom');
      }
      ptys.push(p);
      return p;
    },
  });
  controller.on((e) => events.push(e));
  return { controller, ptys, events };
}

const created: SessionController[] = [];
function track(h: Harness): Harness {
  created.push(h.controller);
  return h;
}
afterEach(() => {
  for (const c of created.splice(0)) c.dispose();
  vi.useRealTimers();
});

describe('SessionController unit (fake PTY)', () => {
  describe('working-directory trust', () => {
    const TRUST_LINE =
      '\x1b[33mDo you trust the files in this folder?\x1b[0m Claude may read files here.\r\n';

    it('appends the trust flag to a fresh launch only when trustWorkingDir is on', () => {
      const h = track(
        harness({ scheduler: new SyncScheduler(), trustWorkingDir: true, args: ['--foo'] }),
      );
      h.controller.start();
      expect(h.ptys[0].startArgs).toEqual(['--foo', '--dangerously-skip-permissions']);
    });

    it('does NOT append the trust flag when trustWorkingDir is off', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['--foo'] }));
      h.controller.start();
      expect(h.ptys[0].startArgs).toEqual(['--foo']);
    });

    it('honours a custom trust flag and never duplicates it', () => {
      const h = track(
        harness({
          scheduler: new SyncScheduler(),
          trustWorkingDir: true,
          trustFlags: ['--yolo'],
          args: ['--yolo'],
        }),
      );
      h.controller.start();
      expect(h.ptys[0].startArgs).toEqual(['--yolo']); // already present -> not duplicated
    });

    it('appends the trust flag to continue-strategy resume launches', () => {
      const h = track(
        harness({ scheduler: new SyncScheduler(), trustWorkingDir: true, strategy: 'continue' }),
      );
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE); // -> resume spawns pty[1]
      expect(h.ptys[1].startArgs).toEqual(['--continue', '--dangerously-skip-permissions']);
    });

    it('emits an `untrusted` event when the CLI exits after the trust prompt', () => {
      const h = track(harness({ scheduler: new SyncScheduler() }));
      h.controller.start();
      h.ptys[0].emitData(TRUST_LINE);
      h.ptys[0].emitExit({ exitCode: 1 });
      expect(h.events.some((e) => e.type === 'untrusted')).toBe(true);
      expect(h.controller.state).toBe('IDLE');
    });

    it('does not emit `untrusted` once trust is enabled (prompt suppressed)', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), trustWorkingDir: true }));
      h.controller.start();
      // Even if the text somehow appears, an explicitly-trusted run should not
      // re-surface the consent prompt.
      h.ptys[0].emitData(TRUST_LINE);
      h.ptys[0].emitExit({ exitCode: 1 });
      expect(h.events.some((e) => e.type === 'untrusted')).toBe(false);
    });
  });

  describe('setLimitPatterns (mid-session)', () => {
    it('detects a custom phrase only after patterns are updated on the live session', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
      h.controller.start();
      // Default patterns don't match this custom phrasing.
      h.ptys[0].emitData('RATE CEILING HIT for the day\r\n');
      expect(h.controller.state).toBe('RUNNING');

      h.controller.setLimitPatterns([/rate ceiling hit/i]);
      h.ptys[0].emitData('RATE CEILING HIT for the day\r\n');
      expect(h.controller.state).toBe('WAITING'); // now detected without a relaunch
    });
  });

  describe('live-TUI limit (no trailing newline)', () => {
    // The limit notice as the CLI renders it in place: matched by the patterns,
    // but NOT newline-terminated, so push() withholds it pending a newline.
    const LIMIT_NO_NEWLINE =
      'Claude usage limit reached. Your limit will reset at 3:00 PM (America/New_York).';

    it('detects the limit via idle flush while the session stays live', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
      h.controller.start();

      h.ptys[0].emitData(LIMIT_NO_NEWLINE);
      // Withheld: no newline yet, so nothing fires immediately — this is the bug
      // where nothing happened until the user exited the session.
      expect(h.controller.state).toBe('RUNNING');

      vi.advanceTimersByTime(800); // output idle -> force-flush
      expect(h.controller.state).toBe('WAITING');
      const limitEv = h.events.find((e) => e.type === 'limit');
      expect(limitEv).toBeDefined();
      expect(limitEv?.type === 'limit' && limitEv.resetTime).toBeInstanceOf(Date);
    });

    it('detects a limit rendered in place with ANSI redraws and no newline', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: true }));
      h.controller.start();

      // Realistic live-TUI render: cursor moves, a boxed panel drawn with ANSI,
      // the limit notice reflowed into it, and NOT terminated by a newline — the
      // input prompt is redrawn right after, still on the same pinned region.
      h.ptys[0].emitData('\x1b[2K\x1b[1G\x1b[38;5;208m╭─ Claude ');
      h.ptys[0].emitData('─────────╮\x1b[0m\r\n\x1b[38;5;208m│\x1b[0m ');
      h.ptys[0].emitData('You’ve reached your usage limit · resets 3:00 PM (America/New_York)');
      h.ptys[0].emitData('\x1b[0m \x1b[2K\x1b[1G> '); // input prompt redrawn, no newline
      // Still withheld — the matched notice never got a terminating newline.
      expect(h.controller.state).toBe('RUNNING');

      vi.advanceTimersByTime(800); // output goes idle -> force-flush while live
      expect(h.controller.state).toBe('RESUMING'); // SyncScheduler fires the armed resume
      expect(h.events.some((e) => e.type === 'limit')).toBe(true);
    });

    it('fires the idle flush even if the CLI keeps repainting after the notice', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
      h.controller.start();

      h.ptys[0].emitData(LIMIT_NO_NEWLINE); // arms the one-shot idle flush
      // Periodic repaints (e.g. a redrawn prompt) keep arriving but never add a
      // newline; the armed timer must still fire rather than be starved.
      vi.advanceTimersByTime(300);
      h.ptys[0].emitData('\x1b[2K\x1b[1G> ');
      vi.advanceTimersByTime(300);
      h.ptys[0].emitData('\x1b[2K\x1b[1G> ');
      expect(h.controller.state).toBe('RUNNING');
      vi.advanceTimersByTime(200); // 800ms since first pending match
      expect(h.controller.state).toBe('WAITING');
    });

    it('does not double-fire when the newline arrives before the idle flush', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
      h.controller.start();

      h.ptys[0].emitData(LIMIT_NO_NEWLINE); // arms the idle flush
      h.ptys[0].emitData('\r\n'); // newline completes the line -> push() emits now
      expect(h.controller.state).toBe('WAITING');

      vi.advanceTimersByTime(800); // stale idle flush must be a no-op
      expect(h.events.filter((e) => e.type === 'limit')).toHaveLength(1);
      expect(h.controller.state).toBe('WAITING');
    });

    it('does not flush a withheld limit after the session exits cleanly first', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
      h.controller.start();

      h.ptys[0].emitData('just some normal output'); // no match, no timer
      h.ptys[0].emitExit({ exitCode: 0 });
      expect(h.controller.state).toBe('IDLE');

      vi.advanceTimersByTime(800);
      expect(h.controller.state).toBe('IDLE');
    });
  });

  it('manual resumeNow() succeeds when autoResume is off', () => {
    vi.useFakeTimers();
    const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
    h.controller.start();
    expect(h.controller.state).toBe('RUNNING');

    h.ptys[0].emitData(LIMIT_LINE);
    expect(h.controller.state).toBe('WAITING'); // no scheduler armed (autoResume off)

    h.controller.resumeNow(); // fires sync resume -> RESUMING, spawns pty[1]
    expect(h.controller.state).toBe('RESUMING');
    expect(h.ptys).toHaveLength(2);

    vi.advanceTimersByTime(10_000); // verify window elapses with no re-limit
    expect(h.controller.state).toBe('RUNNING');
    expect(h.events.some((e) => e.type === 'resumed')).toBe(true);
  });

  it('manual resumeAfter() drives a live RUNNING session WAITING -> RESUMING -> RUNNING', () => {
    vi.useFakeTimers();
    const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
    h.controller.start();
    expect(h.controller.state).toBe('RUNNING'); // no limit needed

    const armed = h.controller.resumeAfter(60_000); // user sets a manual timer
    expect(armed).toBe(true);
    // SyncScheduler fires immediately, so we land in RESUMING (the real scheduler
    // would wait out the delay first); a fresh pty is spawned for the continue.
    expect(h.controller.state).toBe('RESUMING');
    expect(h.ptys).toHaveLength(2);
    expect(h.events.some((e) => e.type === 'notice' && /Manual timer set/.test(e.message))).toBe(true);

    vi.advanceTimersByTime(10_000); // verify window elapses with no re-limit
    expect(h.controller.state).toBe('RUNNING');
    expect(h.events.some((e) => e.type === 'resumed')).toBe(true);
  });

  it('resumeAfter() is rejected while a resume is already in flight (RESUMING)', () => {
    vi.useFakeTimers();
    const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
    h.controller.start();
    h.ptys[0].emitData(LIMIT_LINE);
    h.controller.resumeNow(); // -> RESUMING
    expect(h.controller.state).toBe('RESUMING');

    const armed = h.controller.resumeAfter(60_000);
    expect(armed).toBe(false);
    expect(h.controller.state).toBe('RESUMING'); // unchanged
  });

  it('manual resume that keeps failing does not stall in WAITING — it ends in ERROR', () => {
    // pty[0] (initial) ok; every resume pty fails to spawn.
    const h = track(harness({ scheduler: new SyncScheduler(2), autoResume: false, failPtyFrom: 1 }));
    h.controller.start();
    h.ptys[0].emitData(LIMIT_LINE);
    expect(h.controller.state).toBe('WAITING');

    h.controller.resumeNow(); // attempt1 spawn fails -> retry -> attempt2 fails -> exhausted

    expect(h.controller.state).toBe('ERROR');
    expect(h.events.filter((e) => e.type === 'resuming')).toHaveLength(2);
    expect(h.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('a listener calling stop() during the limit event does not crash the state machine', () => {
    const h = track(harness({ scheduler: new SyncScheduler() }));
    h.controller.start();
    h.controller.on((e) => {
      if (e.type === 'limit') h.controller.stop();
    });
    expect(() => h.ptys[0].emitData(LIMIT_LINE)).not.toThrow();
    expect(h.controller.state).toBe('IDLE');
  });

  it('a resume spawn failure is treated as a failed attempt and retried', () => {
    // initial ok; first resume fails, later resumes also fail -> exhaust at ERROR.
    const h = track(harness({ scheduler: new SyncScheduler(3), failPtyFrom: 1 }));
    h.controller.start();
    h.ptys[0].emitData(LIMIT_LINE); // autoResume on -> scheduler.start fires sync resume immediately

    expect(h.controller.state).toBe('ERROR');
    expect(h.events.filter((e) => e.type === 'resuming').length).toBeGreaterThanOrEqual(3);
  });

  it('sanitizes a recovered multi-line replay prompt so resume cannot multi-submit', () => {
    vi.useFakeTimers();
    const h = track(harness({ scheduler: new SyncScheduler(), strategy: 'replay' }));
    // A captured paste preserves interior newlines; recovery seeds them verbatim.
    h.controller.recoverWaiting(new Date(Date.now() - 1000), 'fix this:\nline 1\nline 2');

    // Getter collapses every embedded control char (incl. CR/LF/ESC) to a space.
    expect(h.controller.replayPrompt).toBe('fix this: line 1 line 2');

    // autoResume armed the sync scheduler, which fired the resume immediately.
    expect(h.controller.state).toBe('RESUMING');
    const written = h.ptys[0].written.join('');
    // Exactly one submit: a single trailing CR and no interior CR/LF that would
    // otherwise fragment the prompt into several Enter-terminated submissions.
    expect(written).toBe('fix this: line 1 line 2\r');
    expect((written.match(/\r/g) ?? []).length).toBe(1);
    expect(written).not.toContain('\n');
  });

  it('strips control characters from an explicit replay override', () => {
    const h = track(harness({ scheduler: new SyncScheduler(), strategy: 'replay' }));
    h.controller.setReplayPrompt('a\r\nb\u001bc');
    expect(h.controller.replayPrompt).toBe('a  b c');
  });

  it('recovers to RUNNING when a later manual resume finally spawns', () => {    vi.useFakeTimers();
    // First resume fails; after reaching ERROR, a manual resumeNow with a now-healthy
    // factory should recover. We model "healthy" by only failing pty index 1.
    const ptys: FakePty[] = [];
    const sched = new SyncScheduler(1);
    const controller = new SessionController({
      command: 'fake',
      scheduler: sched,
      verifyWindowMs: 5_000,
      createPty: () => {
        const p = new FakePty();
        if (ptys.length === 1) p.startError = new Error('transient'); // only the first resume fails
        ptys.push(p);
        return p;
      },
    });
    created.push(controller);

    controller.start();
    ptys[0].emitData(LIMIT_LINE); // resume attempt1 (pty1) fails -> exhausted -> ERROR
    expect(controller.state).toBe('ERROR');

    controller.resumeNow(); // ERROR -> WAITING -> sync resume -> pty2 spawns ok -> RESUMING
    expect(controller.state).toBe('RESUMING');
    vi.advanceTimersByTime(5_000);
    expect(controller.state).toBe('RUNNING');
  });

  // ---------------------------------------------------------------------------
  // Fresh-session fallback: when a `--continue`/`-c` launch can't continue an
  // existing session, the controller must respawn fresh (flags stripped) rather
  // than dropping to IDLE. These cover the matrix of exit code / timing / output
  // / user-interaction so future changes can't silently regress the behavior.
  // ---------------------------------------------------------------------------
  describe('fresh-session fallback', () => {
    it('respawns fresh on a quick CLEAN (code 0) exit with no message — the real mac case', () => {
      // This is exactly what broke on macOS: claude --continue exits 0, prints a
      // message our regex may not match. The decisive signal is "no interaction".
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['--continue'] }));
      h.controller.start();
      expect(h.ptys).toHaveLength(1);

      h.ptys[0].emitExit({ exitCode: 0 }); // fast, clean, silent

      expect(h.ptys).toHaveLength(2);
      expect(h.controller.state).toBe('RUNNING');
      expect(h.events.some((e) => e.type === 'notice')).toBe(true);
      expect(h.events.some((e) => e.type === 'exit')).toBe(false);
    });

    it('strips ALL continue flags from the respawned args, preserving the rest', () => {
      const h = track(
        harness({ scheduler: new SyncScheduler(), args: ['--continue', '--model', 'opus', '-c'] }),
      );
      h.controller.start();
      h.ptys[0].emitExit({ exitCode: 0 });

      expect(h.ptys).toHaveLength(2);
      const freshArgs = h.ptys[1].startArgs;
      expect(freshArgs).toEqual(['--model', 'opus']);
    });

    it('respawns fresh on a nonzero exit even when slow (no interaction)', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['-c'], quickExitMs: 100 }));
      h.controller.start();
      vi.advanceTimersByTime(5_000); // well past quickExitMs
      h.ptys[0].emitExit({ exitCode: 1 });
      expect(h.ptys).toHaveLength(2);
      expect(h.controller.state).toBe('RUNNING');
    });

    it('respawns fresh on a slow CLEAN exit when the no-conversation message appears (ANSI-wrapped)', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['--continue'], quickExitMs: 100 }));
      h.controller.start();
      vi.advanceTimersByTime(5_000);
      // Colored output must not defeat detection.
      h.ptys[0].emitData('\x1b[31mNo conversation found to continue\x1b[0m\r\n');
      h.ptys[0].emitExit({ exitCode: 0 });
      expect(h.ptys).toHaveLength(2);
      expect(h.controller.state).toBe('RUNNING');
    });

    it('does NOT respawn when the user actually interacted (a real session existed)', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['--continue'] }));
      h.controller.start();
      h.controller.write('hello\r'); // genuine engagement
      h.ptys[0].emitExit({ exitCode: 0 }); // quick, but user used the session
      expect(h.ptys).toHaveLength(1);
      expect(h.controller.state).toBe('IDLE');
      expect(h.events.some((e) => e.type === 'exit')).toBe(true);
    });

    it('treats ESC-prefixed input (arrow keys / terminal auto-responses) as NON-interaction', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['--continue'] }));
      h.controller.start();
      h.controller.write('\x1b[A'); // up-arrow / could also be a cursor-position auto-reply
      h.controller.write('\x1b[6n'); // device-status query echo
      h.ptys[0].emitExit({ exitCode: 0 });
      expect(h.ptys).toHaveLength(2); // still treated as "no real interaction"
      expect(h.controller.state).toBe('RUNNING');
    });

    it('only retries the fresh fallback once, then exits normally', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['-c'] }));
      h.controller.start();
      h.ptys[0].emitExit({ exitCode: 1 }); // -> fresh fallback (pty[1], no -c)
      expect(h.ptys).toHaveLength(2);
      expect(h.controller.state).toBe('RUNNING');
      // pty[1] was spawned without a continue flag, so even a quick exit must NOT
      // re-trigger the fallback (and the guard would block it regardless).
      h.ptys[1].emitExit({ exitCode: 1 });
      expect(h.ptys).toHaveLength(2);
      expect(h.controller.state).toBe('IDLE');
      expect(h.events.some((e) => e.type === 'exit')).toBe(true);
    });

    it('does not fresh-fallback when the launch had no continue flag', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), args: [] }));
      h.controller.start();
      h.ptys[0].emitExit({ exitCode: 1 });
      expect(h.ptys).toHaveLength(1);
      expect(h.controller.state).toBe('IDLE');
      expect(h.events.some((e) => e.type === 'exit')).toBe(true);
    });

    it('emits a diagnostic notice with output context on a non-zero exit', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), args: [] }));
      h.controller.start();
      h.ptys[0].emitData('error: something went wrong\r\n');
      h.ptys[0].emitExit({ exitCode: 1 });
      const notice = h.events.find((e) => e.type === 'notice') as { type: 'notice'; message: string } | undefined;
      expect(notice).toBeDefined();
      expect(notice?.message).toContain('code 1');
      expect(notice?.message).toContain('something went wrong');
    });

    it('does not emit an exit notice on a clean (code 0) exit', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), args: [], quickExitMs: 50 }));
      h.controller.start();
      vi.advanceTimersByTime(200);
      h.ptys[0].emitExit({ exitCode: 0 });
      expect(h.events.some((e) => e.type === 'notice')).toBe(false);
      expect(h.controller.state).toBe('IDLE');
    });

    it('does not fresh-fallback when a continue launch exits cleanly and slowly with no message', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['--continue'], quickExitMs: 50 }));
      h.controller.start();
      vi.advanceTimersByTime(200); // past quickExitMs
      h.ptys[0].emitExit({ exitCode: 0 }); // clean, silent, slow -> treat as a real watched session
      expect(h.ptys).toHaveLength(1);
      expect(h.controller.state).toBe('IDLE');
      expect(h.events.some((e) => e.type === 'exit')).toBe(true);
    });

    it('a usage limit on the continue launch is handled as a limit, not a fresh fallback', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false, args: ['--continue'] }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE); // limit before any exit
      expect(h.controller.state).toBe('WAITING');
      // The PTY for the continue launch is torn down by the limit flow; no fresh
      // respawn should have occurred.
      expect(h.ptys).toHaveLength(1);
      expect(h.events.some((e) => e.type === 'notice')).toBe(false);
    });

    it('a limit clears continue-launch eligibility so a later resumed-session exit does not respawn', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler(), args: ['--continue'] }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE); // RUNNING -> WAITING -> RESUMING (autoResume on, sync)
      vi.advanceTimersByTime(10_000); // verify window passes with no re-limit -> RUNNING
      expect(h.controller.state).toBe('RUNNING');
      const before = h.ptys.length;
      // The resumed session now exits quickly; this must be a normal exit, not a
      // fresh fallback (eligibility was cleared when the limit fired).
      h.ptys[h.ptys.length - 1].emitExit({ exitCode: 0 });
      expect(h.ptys).toHaveLength(before);
      expect(h.controller.state).toBe('IDLE');
      expect(h.events.some((e) => e.type === 'exit')).toBe(true);
    });
  });
});

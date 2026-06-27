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
  resumePrompt?: string;
  args?: string[];
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
    resumePrompt: opts.resumePrompt,
    args: opts.args,
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
  describe('keep-alive resume (the core loop)', () => {
    it('keeps the limited session alive through WAITING', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE);
      expect(h.controller.state).toBe('WAITING');
      expect(h.ptys).toHaveLength(1); // never respawned
      expect(h.ptys[0].running).toBe(true); // and never killed
    });

    it('types the resume prompt + Enter into the live session when the wait ends', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler() }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE); // SyncScheduler fires the resume immediately
      expect(h.controller.state).toBe('RESUMING');
      expect(h.ptys).toHaveLength(1); // same session
      expect(h.ptys[0].written).toEqual(['continue\r']);

      vi.advanceTimersByTime(10_000); // verify window elapses with no re-limit
      expect(h.controller.state).toBe('RUNNING');
      expect(h.events.some((e) => e.type === 'resumed')).toBe(true);
    });

    it('honours a custom resume prompt', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), resumePrompt: 'keep going' }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE);
      expect(h.ptys[0].written).toEqual(['keep going\r']);
    });

    it('sanitizes a resume prompt with control characters so it cannot multi-submit', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), resumePrompt: 'a\r\nb\u001bc' }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE);
      const written = h.ptys[0].written.join('');
      expect(written).toBe('a  b c\r');
      expect((written.match(/\r/g) ?? []).length).toBe(1);
      expect(written).not.toContain('\n');
    });

    it('a still-limited reply fails the attempt but keeps the session alive for the retry', () => {
      const sched = new SyncScheduler(2);
      const h = track(harness({ scheduler: sched }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE); // attempt 1: types the prompt
      expect(h.ptys[0].written).toEqual(['continue\r']);
      h.ptys[0].emitData(LIMIT_LINE); // still limited inside the verify window
      // Failure -> WAITING -> sync retry -> attempt 2 types the prompt AGAIN
      // into the SAME session; nothing was killed or respawned.
      expect(h.controller.state).toBe('RESUMING');
      expect(h.ptys).toHaveLength(1);
      expect(h.ptys[0].running).toBe(true);
      expect(h.ptys[0].written).toEqual(['continue\r', 'continue\r']);
    });

    it('relaunches with --continue when the session died during the wait', () => {
      const h = track(harness({ scheduler: new SyncScheduler(), autoResume: false }));
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE);
      expect(h.controller.state).toBe('WAITING');

      h.ptys[0].emitExit({ exitCode: 7 }); // the CLI died mid-wait
      expect(h.controller.state).toBe('WAITING'); // still waiting
      expect(h.events.some((e) => e.type === 'notice' && /relaunched/.test(e.message))).toBe(true);

      h.controller.resumeNow();
      expect(h.controller.state).toBe('RESUMING');
      expect(h.ptys).toHaveLength(2);
      expect(h.ptys[1].startArgs).toEqual(['--continue']);
      expect(h.ptys[1].written).toEqual(['continue\r']); // prompt typed after relaunch
    });

    it('recovers a persisted wait: resume relaunches --continue and types the prompt', () => {
      vi.useFakeTimers();
      const h = track(harness({ scheduler: new SyncScheduler() }));
      h.controller.recoverWaiting(new Date(Date.now() - 1000));
      // autoResume armed the sync scheduler, which fired the resume immediately.
      expect(h.controller.state).toBe('RESUMING');
      expect(h.ptys).toHaveLength(1);
      expect(h.ptys[0].startArgs).toEqual(['--continue']);
      expect(h.ptys[0].written).toEqual(['continue\r']);

      vi.advanceTimersByTime(10_000);
      expect(h.controller.state).toBe('RUNNING');
    });
  });

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

    it('appends the trust flag to resume relaunches', () => {
      const h = track(
        harness({ scheduler: new SyncScheduler(), trustWorkingDir: true, autoResume: false }),
      );
      h.controller.start();
      h.ptys[0].emitData(LIMIT_LINE);
      h.ptys[0].emitExit({ exitCode: 7 }); // dead session -> resume must relaunch
      h.controller.resumeNow();
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

    h.controller.resumeNow(); // fires sync resume -> types the prompt into the live session
    expect(h.controller.state).toBe('RESUMING');
    expect(h.ptys).toHaveLength(1);
    expect(h.ptys[0].written).toEqual(['continue\r']);

    vi.advanceTimersByTime(10_000); // verify window elapses with no re-limit
    expect(h.controller.state).toBe('RUNNING');
    expect(h.events.some((e) => e.type === 'resumed')).toBe(true);
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

  it('a relaunch spawn failure is treated as a failed attempt and exhausts to ERROR', () => {
    // Recovery path: no live session exists, and every relaunch fails to spawn.
    const h = track(harness({ scheduler: new SyncScheduler(3), failPtyFrom: 0 }));
    h.controller.recoverWaiting(new Date(0));

    expect(h.controller.state).toBe('ERROR');
    expect(h.events.filter((e) => e.type === 'resuming').length).toBeGreaterThanOrEqual(3);
    expect(h.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('recovers to RUNNING when a later manual resume finally spawns', () => {
    vi.useFakeTimers();
    // The first relaunch fails; after reaching ERROR, a manual resumeNow with a
    // now-healthy factory should recover. We model "healthy" by only failing pty 0.
    const ptys: FakePty[] = [];
    const sched = new SyncScheduler(1);
    const controller = new SessionController({
      command: 'fake',
      scheduler: sched,
      verifyWindowMs: 5_000,
      createPty: () => {
        const p = new FakePty();
        if (ptys.length === 0) p.startError = new Error('transient'); // only the first relaunch fails
        ptys.push(p);
        return p;
      },
    });
    created.push(controller);

    controller.recoverWaiting(new Date(0)); // relaunch attempt (pty0) fails -> exhausted -> ERROR
    expect(controller.state).toBe('ERROR');

    controller.resumeNow(); // ERROR -> WAITING -> sync resume -> pty1 spawns ok -> RESUMING
    expect(controller.state).toBe('RESUMING');
    vi.advanceTimersByTime(5_000);
    expect(controller.state).toBe('RUNNING');
  });

  describe('exit diagnostics', () => {
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
      const h = track(harness({ scheduler: new SyncScheduler(), args: [] }));
      h.controller.start();
      h.ptys[0].emitExit({ exitCode: 0 });
      expect(h.events.some((e) => e.type === 'notice')).toBe(false);
      expect(h.controller.state).toBe('IDLE');
    });
  });
});

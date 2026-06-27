import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  SessionController,
  type ControllerEvent,
  type IResumeScheduler,
  type SessionControllerOptions,
} from '@core/session-controller';
import type { SchedulerEvent } from '@core/resume-scheduler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');

/**
 * Fires a resume shortly after start()/retry() regardless of the parsed reset
 * time, so the full loop runs in milliseconds. Honours maxRetries -> exhausted.
 */
class FastScheduler implements IResumeScheduler {
  private readonly listeners = new Set<(e: SchedulerEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private running = false;
  constructor(
    private readonly delayMs = 15,
    private readonly maxRetries = 5,
  ) {}
  on(l: (e: SchedulerEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  start(): void {
    this.attempt = 0;
    this.running = true;
    this.arm();
  }
  retry(): void {
    if (!this.running) return;
    if (this.attempt >= this.maxRetries) {
      this.stop();
      this.emit({ type: 'exhausted', attempts: this.attempt });
      return;
    }
    this.arm();
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.attempt += 1;
      this.emit({ type: 'resume', attempt: this.attempt, targetMs: Date.now() });
    }, this.delayMs);
  }
  private emit(e: SchedulerEvent): void {
    for (const l of this.listeners) l(e);
  }
}

interface Recorder {
  events: ControllerEvent[];
  waitFor(pred: (e: ControllerEvent) => boolean, timeoutMs?: number): Promise<ControllerEvent>;
  states(): string[];
  text(): string;
  count(type: ControllerEvent['type']): number;
}

function record(controller: SessionController): Recorder {
  const events: ControllerEvent[] = [];
  const waiters: Array<{ pred: (e: ControllerEvent) => boolean; res: (e: ControllerEvent) => void }> = [];
  controller.on((e) => {
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(e);
      }
    }
  });
  return {
    events,
    waitFor(pred, timeoutMs = 6000) {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise<ControllerEvent>((res, rej) => {
        const w = { pred, res };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            rej(new Error('timeout; saw events: ' + JSON.stringify(events.map((e) => e.type))));
          }
        }, timeoutMs);
      });
    },
    states() {
      return events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
    },
    text() {
      return events
        .filter((e) => e.type === 'data')
        .map((e) => (e as { data: string }).data)
        .join('');
    },
    count(type) {
      return events.filter((e) => e.type === type).length;
    },
  };
}

const controllers: SessionController[] = [];
const tmpDirs: string[] = [];
function newController(opts: Partial<SessionControllerOptions> & { scheduler: IResumeScheduler }): SessionController {
  const c = new SessionController({
    command: process.execPath,
    args: [FAKE_CLAUDE],
    verifyWindowMs: 250,
    ...opts,
  });
  controllers.push(c);
  return c;
}
function tmpState(): string {
  const d = mkdtempSync(join(tmpdir(), 'ck-'));
  tmpDirs.push(d);
  return join(d, 'state');
}

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('SessionController integration (fake-claude over a real PTY)', () => {
  it('detects a limit and resumes by typing "continue" into the SAME live session', async () => {
    const c = newController({ scheduler: new FastScheduler(15) });
    const rec = record(c);

    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));

    c.write('/triggerlimit\r');
    const limit = await rec.waitFor((e) => e.type === 'limit');
    expect(limit).toMatchObject({ type: 'limit' });

    await rec.waitFor((e) => e.type === 'resumed');

    expect(rec.states()).toEqual(['RUNNING', 'LIMIT_DETECTED', 'WAITING', 'RESUMING', 'RUNNING']);
    // The prompt was typed into the surviving session and echoed back by the CLI.
    expect(rec.text()).toContain('● continue');
    // The session was never relaunched: no "resumed conversation" banner.
    expect(rec.text()).not.toContain('Resuming previous conversation');
    expect(c.state).toBe('RUNNING');
  });

  it('types a custom resume prompt when one is configured', async () => {
    const c = newController({ scheduler: new FastScheduler(15), resumePrompt: 'keep going' });
    const rec = record(c);

    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));
    c.write('/triggerlimit\r');
    await rec.waitFor((e) => e.type === 'resumed');

    expect(rec.text()).toContain('● keep going');
  });

  it('retries when the session is still limited, then succeeds on the same session', async () => {
    const c = newController({
      scheduler: new FastScheduler(15, 5),
      env: {
        ...(process.env as Record<string, string>),
        FAKE_CLAUDE_STILL_LIMITED: '1', // first "continue" is answered with the limit again
      },
    });
    const rec = record(c);

    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));
    c.write('/triggerlimit\r');
    await rec.waitFor((e) => e.type === 'limit');
    await rec.waitFor((e) => e.type === 'resumed');

    const resuming = rec.events.filter((e) => e.type === 'resuming') as Array<{ attempt: number }>;
    expect(resuming.length).toBeGreaterThanOrEqual(2);
    expect(resuming.at(-1)!.attempt).toBeGreaterThanOrEqual(2);
    // Both attempts typed into the one live session — never a relaunch.
    expect(rec.text()).not.toContain('Resuming previous conversation');
    expect(rec.text()).toContain('● continue');
    expect(c.state).toBe('RUNNING');
  });

  it('relaunches with --continue and types the prompt when the CLI exits at the limit', async () => {
    const c = newController({
      scheduler: new FastScheduler(15),
      env: {
        ...(process.env as Record<string, string>),
        FAKE_CLAUDE_LIMIT_EXITS: '1', // the CLI dies right after printing the limit
      },
    });
    const rec = record(c);

    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));
    c.write('/triggerlimit\r');
    await rec.waitFor((e) => e.type === 'limit');
    await rec.waitFor((e) => e.type === 'resumed');

    // The dead session was relaunched attached to the previous conversation,
    // and the resume prompt was typed into it.
    expect(rec.text()).toContain('Resuming previous conversation');
    expect(rec.text()).toContain('● continue');
    expect(c.state).toBe('RUNNING');
  });

  it('recovers a persisted wait from IDLE: relaunches --continue and types the prompt', async () => {
    // Simulate an app restart: a fresh controller that never RAN, asked to
    // recover straight into WAITING with an absolute reset time, then resume.
    const c = newController({ scheduler: new FastScheduler(15) });
    const rec = record(c);

    // resetTime in the past => scheduler should fire immediately on recovery.
    c.recoverWaiting(new Date(Date.now() - 1000));

    await rec.waitFor((e) => e.type === 'limit');
    await rec.waitFor((e) => e.type === 'resumed');

    expect(rec.text()).toContain('Resuming previous conversation');
    expect(rec.text()).toContain('● continue');
    // No fresh RUNNING precedes the wait: IDLE -> WAITING -> RESUMING -> RUNNING.
    expect(rec.states()).toEqual(['WAITING', 'RESUMING', 'RUNNING']);
  });

  it('rejects recoverWaiting() when not IDLE', async () => {
    const c = newController({ scheduler: new FastScheduler(99999) });
    const rec = record(c);
    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));
    expect(() => c.recoverWaiting(null)).toThrow(/requires IDLE/);
  });

  it('retries a relaunch that is still limited, then succeeds', async () => {
    const resumeState = tmpState();
    const c = newController({
      scheduler: new FastScheduler(15, 5),
      env: {
        ...(process.env as Record<string, string>),
        FAKE_CLAUDE_LIMIT_EXITS: '1',
        FAKE_CLAUDE_FAIL_RESUMES: '1', // first --continue relaunch is still limited
        FAKE_CLAUDE_STATE: resumeState,
      },
    });
    const rec = record(c);

    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));
    c.write('/triggerlimit\r');
    await rec.waitFor((e) => e.type === 'limit');
    await rec.waitFor((e) => e.type === 'resumed');

    const resuming = rec.events.filter((e) => e.type === 'resuming') as Array<{ attempt: number }>;
    expect(resuming.length).toBeGreaterThanOrEqual(2);
    expect(c.state).toBe('RUNNING');
  });

  it('gives up with an ERROR after maxRetries when resume keeps failing', async () => {
    const c = newController({
      scheduler: new FastScheduler(10, 2),
      env: {
        ...(process.env as Record<string, string>),
        FAKE_CLAUDE_STILL_LIMITED: '99', // every "continue" stays limited
      },
    });
    const rec = record(c);

    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));
    c.write('/triggerlimit\r');
    await rec.waitFor((e) => e.type === 'limit');

    const err = await rec.waitFor((e) => e.type === 'error');
    expect(err).toMatchObject({ type: 'error' });
    expect(c.state).toBe('ERROR');
    expect(rec.count('resuming')).toBe(2);
  });

  it('treats a clean user-driven exit as IDLE (no false limit)', async () => {
    const c = newController({ scheduler: new FastScheduler(15) });
    const rec = record(c);

    c.start();
    await rec.waitFor((e) => e.type === 'data' && e.data.includes('ready'));
    c.write('/quit\r');

    const exit = await rec.waitFor((e) => e.type === 'exit');
    expect(exit).toMatchObject({ type: 'exit', exitCode: 0 });
    expect(c.state).toBe('IDLE');
    expect(rec.count('limit')).toBe(0);
  });
});

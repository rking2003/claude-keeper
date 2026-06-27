import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResumeScheduler, type SchedulerEvent } from '@core/resume-scheduler';

describe('ResumeScheduler', () => {
  let events: SchedulerEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    events = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(opts = {}) {
    const s = new ResumeScheduler({ tickMs: 1000, safetyBufferMs: 1000, ...opts });
    s.on((e) => events.push(e));
    return s;
  }
  const resumes = () => events.filter((e) => e.type === 'resume');

  it('fires resume at resetTime + safetyBuffer', () => {
    const s = make();
    s.start(new Date(5000)); // fireAt = 6000
    expect(resumes()).toHaveLength(0);
    vi.advanceTimersByTime(5999);
    expect(resumes()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(resumes()).toHaveLength(1);
    expect(resumes()[0]).toMatchObject({ type: 'resume', attempt: 1 });
    s.stop();
  });

  it('emits ticking countdown with decreasing remaining time', () => {
    const s = make();
    s.start(new Date(5000)); // fireAt = 6000
    vi.advanceTimersByTime(3000);
    const ticks = events.filter((e) => e.type === 'tick') as Extract<SchedulerEvent, { type: 'tick' }>[];
    expect(ticks.length).toBeGreaterThan(1);
    const remainings = ticks.map((t) => t.remainingMs);
    for (let i = 1; i < remainings.length; i++) {
      expect(remainings[i]).toBeLessThan(remainings[i - 1]!);
    }
    s.stop();
  });

  it('fires immediately when the target is already in the past', () => {
    vi.setSystemTime(10_000);
    const s = make();
    s.start(new Date(0)); // fireAt = 1000, already < now
    expect(resumes()).toHaveLength(1);
    s.stop();
  });

  it('polls at pollIntervalMs when no reset time is known', () => {
    const s = make({ pollIntervalMs: 4000 });
    s.start(null); // fireAt = now + 4000
    vi.advanceTimersByTime(3999);
    expect(resumes()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(resumes()).toHaveLength(1);
    s.stop();
  });

  it('reschedules with linear backoff on retry()', () => {
    const s = make({ pollIntervalMs: 1000, backoffMs: 1000, maxRetries: 5 });
    s.start(new Date(0)); // fireAt 1000
    vi.advanceTimersByTime(1000);
    expect(resumes()).toHaveLength(1); // attempt 1

    s.retry(); // attempt was 1 -> delay = 1000 * 1
    vi.advanceTimersByTime(1000);
    expect(resumes()).toHaveLength(2); // attempt 2

    s.retry(); // attempt was 2 -> delay = 1000 * 2
    vi.advanceTimersByTime(1999);
    expect(resumes()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(resumes()).toHaveLength(3); // attempt 3
    s.stop();
  });

  it('emits "exhausted" after maxRetries attempts', () => {
    const s = make({ backoffMs: 1000, maxRetries: 2 });
    s.start(new Date(0));
    vi.advanceTimersByTime(1000); // attempt 1
    s.retry();
    vi.advanceTimersByTime(1000); // attempt 2
    expect(resumes()).toHaveLength(2);
    s.retry(); // attempt >= maxRetries -> exhausted
    expect(events.some((e) => e.type === 'exhausted')).toBe(true);
    expect(s.isRunning).toBe(false);
  });

  it('survives a sleep: a long jump past the target still fires once', () => {
    const s = make({ safetyBufferMs: 0, tickMs: 1000 });
    s.start(new Date(60 * 60 * 1000)); // 1h out
    // Simulate the machine sleeping and waking 2h later in one jump.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(resumes()).toHaveLength(1);
    s.stop();
  });

  it('stop() prevents any further events', () => {
    const s = make();
    s.start(new Date(5000));
    s.stop();
    vi.advanceTimersByTime(10_000);
    expect(resumes()).toHaveLength(0);
  });
});

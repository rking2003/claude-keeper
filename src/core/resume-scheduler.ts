/**
 * ResumeScheduler — decides *when* to attempt a resume after a limit is hit.
 *
 * - Given a reset time, it fires a `resume` event at resetTime + safetyBuffer.
 * - Given no reset time, it polls every `pollIntervalMs` (fallback).
 * - It is tick-based (re-evaluates `now()` each tick), so it survives system
 *   sleep: on wake the next tick sees the target has passed and fires.
 * - After a failed attempt the caller invokes `retry()`, which reschedules with
 *   linear backoff until `maxRetries` attempts are exhausted.
 *
 * Pure and Electron-free. Uses the ambient timer functions so tests can drive it
 * with fake timers; `now` is injectable.
 */
export type SchedulerEvent =
  | { type: 'tick'; remainingMs: number; targetMs: number }
  | { type: 'resume'; attempt: number; targetMs: number }
  | { type: 'exhausted'; attempts: number };

export type SchedulerListener = (event: SchedulerEvent) => void;

export interface ResumeSchedulerOptions {
  /** Delay added after the reset time before resuming. Default 60s. */
  safetyBufferMs?: number;
  /** Interval used when no reset time is known. Default 5 minutes. */
  pollIntervalMs?: number;
  /** Base backoff between retries (multiplied by attempt number). Default = pollIntervalMs. */
  backoffMs?: number;
  /** Upper bound on a single backoff delay. Default 30 minutes. */
  maxBackoffMs?: number;
  /** Maximum number of resume attempts before giving up. Default 5. */
  maxRetries?: number;
  /** Countdown tick granularity. Default 1s. */
  tickMs?: number;
  /** Injectable clock. Default Date.now. */
  now?: () => number;
}

export class ResumeScheduler {
  private readonly safetyBufferMs: number;
  private readonly pollIntervalMs: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;
  private readonly tickMs: number;
  private readonly now: () => number;

  private readonly listeners = new Set<SchedulerListener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private fireAtMs = 0;
  private attempt = 0;
  private running = false;

  constructor(opts: ResumeSchedulerOptions = {}) {
    this.safetyBufferMs = opts.safetyBufferMs ?? 60_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5 * 60_000;
    this.backoffMs = opts.backoffMs ?? this.pollIntervalMs;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30 * 60_000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.tickMs = opts.tickMs ?? 1_000;
    this.now = opts.now ?? (() => Date.now());
  }

  on(listener: SchedulerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  /** Begin waiting. Pass the parsed reset time, or null to poll. */
  start(resetTime: Date | null): void {
    this.attempt = 0;
    this.running = true;
    const target =
      resetTime !== null
        ? resetTime.getTime() + this.safetyBufferMs
        : this.now() + this.pollIntervalMs;
    this.armAt(target);
  }

  /** Reschedule another attempt after a failed resume, or give up. */
  retry(): void {
    if (!this.running) return;
    if (this.attempt >= this.maxRetries) {
      this.stop();
      this.emit({ type: 'exhausted', attempts: this.attempt });
      return;
    }
    const delay = Math.min(this.backoffMs * this.attempt, this.maxBackoffMs);
    this.armAt(this.now() + delay);
  }

  stop(): void {
    this.running = false;
    this.stopTicking();
  }

  private armAt(targetMs: number): void {
    this.fireAtMs = targetMs;
    this.stopTicking();
    this.timer = setInterval(() => this.onTick(), this.tickMs);
    this.onTick(); // evaluate immediately (handles already-past targets)
  }

  private onTick(): void {
    if (!this.running) return;
    const remaining = this.fireAtMs - this.now();
    if (remaining > 0) {
      this.emit({ type: 'tick', remainingMs: remaining, targetMs: this.fireAtMs });
      return;
    }
    this.stopTicking();
    this.attempt += 1;
    this.emit({ type: 'resume', attempt: this.attempt, targetMs: this.fireAtMs });
  }

  private stopTicking(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private emit(event: SchedulerEvent): void {
    for (const l of this.listeners) l(event);
  }
}

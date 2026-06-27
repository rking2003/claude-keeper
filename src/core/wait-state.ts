/**
 * Cross-restart wait recovery (pure, Electron-free, unit-tested).
 *
 * When a usage limit is hit the app enters WAITING and counts down to an
 * absolute reset time. If the user quits (or the OS kills) the app mid-wait, we
 * still want to honor the wait and auto-resume when the limit resets. To do that
 * we persist a {@link PendingWait} snapshot to disk on entering WAITING, and on
 * the next launch we validate it and, if still fresh, reconstruct the session
 * straight into WAITING with the *same absolute* reset time.
 *
 * Everything here treats the on-disk JSON as fully untrusted input: corrupt,
 * truncated, hand-edited, or written by a newer/older app version. Parsing is
 * defensive and always returns either a fully-normalized record or `null`.
 */
import { DEFAULT_RESUME_PROMPT, sanitizeResumePrompt } from './settings';

/** Schema version so a future format change can be detected/migrated. */
export const PENDING_WAIT_VERSION = 1;

/** Default staleness horizon: a saved wait older than this is discarded. */
export const DEFAULT_WAIT_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000; // 8 days (covers weekly caps)

/** A reset time more than this far in the future is treated as bogus/abandoned. */
export const MAX_WAIT_FUTURE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Upper bound for a plausible absolute reset time (≈ year 2100). */
const MAX_DATE_MS = 4_102_444_800_000;

/**
 * Everything required to reconstruct a SessionController back into WAITING and
 * resume correctly after an app restart.
 */
export interface PendingWait {
  version: number;
  /** Absolute reset time (epoch ms), or null if the limit gave no time. */
  resetTimeMs: number | null;
  /** Wall-clock time the snapshot was written (epoch ms). */
  savedAtMs: number;

  command: string;
  args: string[];
  cwd?: string;
  autoResume: boolean;
  verifyWindowMs?: number;

  safetyBufferMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;

  customPatterns: string[];
  replaceDefaultPatterns: boolean;

  /** The prompt typed (plus Enter) into the session when the wait ends. */
  resumePrompt: string;
}

/** Fields a caller must supply to build a PendingWait; the rest are defaulted. */
export interface PendingWaitInput {
  resetTimeMs: number | null;
  command: string;
  args?: string[];
  cwd?: string;
  autoResume?: boolean;
  verifyWindowMs?: number;
  safetyBufferMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  customPatterns?: string[];
  replaceDefaultPatterns?: boolean;
  resumePrompt?: string;
  /** Override the saved-at clock (tests). Default Date.now(). */
  savedAtMs?: number;
}

const MAX_PATTERNS = 50;
const MAX_PATTERN_LEN = 500;
const MAX_PROMPT_LEN = 500;
const MAX_ARGS = 256;
const MAX_ARG_LEN = 4096;

/**
 * Inclusive [min,max] clamp bounds for the session timing options, shared by the
 * persisted-recovery path (here) and the live `session:start` path in main so a
 * corrupt snapshot *or* a buggy/hostile renderer can't trigger a launch-time
 * retry storm, a 0ms poll loop, or an instant-false "resumed" verify window.
 */
export const SESSION_LIMIT_BOUNDS = {
  verifyWindowMs: [100, 60_000],
  safetyBufferMs: [0, 3_600_000],
  pollIntervalMs: [60_000, 86_400_000],
  maxRetries: [0, 100],
} as const;

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toStringArray(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    out.push(item.length > maxLen ? item.slice(0, maxLen) : item);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Clamp an optional integer to [min,max]; undefined (use defaults) if absent/invalid. */
export function clampOptInt(v: unknown, min: number, max: number): number | undefined {
  if (!isFiniteInt(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Normalize an absolute reset time, rejecting non-finite / negative / absurd values to null. */
function normalizeReset(v: number | null): number | null {
  if (v === null || !isFiniteInt(v)) return null;
  const r = Math.round(v);
  return r >= 0 && r <= MAX_DATE_MS ? r : null;
}

/** Build a normalized PendingWait from typed input + supplied defaults. */
export function buildPendingWait(input: PendingWaitInput): PendingWait {
  const prompt = sanitizeResumePrompt(
    typeof input.resumePrompt === 'string' ? input.resumePrompt.slice(0, MAX_PROMPT_LEN) : DEFAULT_RESUME_PROMPT,
  );
  return {
    version: PENDING_WAIT_VERSION,
    resetTimeMs: normalizeReset(input.resetTimeMs),
    savedAtMs: input.savedAtMs ?? Date.now(),
    command: input.command,
    args: toStringArray(input.args, MAX_ARGS, MAX_ARG_LEN),
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    autoResume: input.autoResume !== false,
    // Bounded so a corrupt/hand-edited snapshot can't trigger a launch-time retry
    // storm or a 0ms poll loop (mirrors the settings store's clamps).
    verifyWindowMs: clampOptInt(input.verifyWindowMs, ...SESSION_LIMIT_BOUNDS.verifyWindowMs),
    safetyBufferMs: clampOptInt(input.safetyBufferMs, ...SESSION_LIMIT_BOUNDS.safetyBufferMs),
    pollIntervalMs: clampOptInt(input.pollIntervalMs, ...SESSION_LIMIT_BOUNDS.pollIntervalMs),
    maxRetries: clampOptInt(input.maxRetries, ...SESSION_LIMIT_BOUNDS.maxRetries),
    customPatterns: toStringArray(input.customPatterns, MAX_PATTERNS, MAX_PATTERN_LEN),
    replaceDefaultPatterns: input.replaceDefaultPatterns === true,
    resumePrompt: prompt,
  };
}

/**
 * Parse untrusted JSON-ish input into a normalized PendingWait, or null if it is
 * not a usable record. Builds a fresh object from known keys only (no prototype
 * pollution; unknown keys dropped). A missing/blank `command` is fatal (we can't
 * relaunch the CLI without it).
 */
export function parsePendingWait(raw: unknown): PendingWait | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  // A present-but-mismatched version means a format we don't understand; reject
  // rather than risk partially accepting an incompatible shape. (Absent version
  // is tolerated and treated as the current schema.)
  if (o['version'] !== undefined && o['version'] !== PENDING_WAIT_VERSION) return null;

  if (typeof o['command'] !== 'string' || o['command'].trim().length === 0) return null;
  if (!isFiniteInt(o['savedAtMs'])) return null;

  const resetRaw = o['resetTimeMs'];
  const resetTimeMs = resetRaw === null ? null : isFiniteInt(resetRaw) ? Math.round(resetRaw) : null;

  return buildPendingWait({
    resetTimeMs,
    savedAtMs: Math.round(o['savedAtMs']),
    command: o['command'],
    args: o['args'] as string[] | undefined,
    cwd: o['cwd'] as string | undefined,
    autoResume: o['autoResume'] as boolean | undefined,
    verifyWindowMs: o['verifyWindowMs'] as number | undefined,
    safetyBufferMs: o['safetyBufferMs'] as number | undefined,
    pollIntervalMs: o['pollIntervalMs'] as number | undefined,
    maxRetries: o['maxRetries'] as number | undefined,
    customPatterns: o['customPatterns'] as string[] | undefined,
    replaceDefaultPatterns: o['replaceDefaultPatterns'] as boolean | undefined,
    resumePrompt: o['resumePrompt'] as string | undefined,
  });
}

/** Serialize a PendingWait to a stable JSON string. */
export function serializePendingWait(p: PendingWait): string {
  return JSON.stringify(p, null, 2);
}

/**
 * A persisted wait is "fresh" if it was saved recently enough that resuming
 * still makes sense. We key off save time (not reset time) because a long
 * weekly-cap reset can legitimately be days in the future, while a snapshot that
 * has sat on disk for over a week almost certainly belongs to an abandoned
 * session whose CLI conversation context is gone. A snapshot saved in the future
 * (clock skew / tampering) beyond a small tolerance — or whose reset time is
 * implausibly far ahead — is rejected.
 */
export function isWaitFresh(
  p: PendingWait,
  nowMs: number,
  maxAgeMs: number = DEFAULT_WAIT_MAX_AGE_MS,
): boolean {
  const age = nowMs - p.savedAtMs;
  const futureToleranceMs = 60 * 60 * 1000; // 1h of acceptable forward skew
  if (age < -futureToleranceMs) return false;
  if (age > maxAgeMs) return false;
  // A reset time far beyond any real Claude cap (weekly ≈ 7d) is bogus/abandoned.
  if (p.resetTimeMs !== null && p.resetTimeMs - nowMs > MAX_WAIT_FUTURE_MS) return false;
  return true;
}

/** Minimal disk surface so the store is unit-testable without a real fs. */
export interface WaitStateIO {
  read(): string | null;
  write(data: string): void;
  remove(): void;
}

/**
 * Persists at most one PendingWait. `load()` returns a normalized record or
 * null (and never throws on corrupt input). `save()`/`clear()` are best-effort.
 */
export class WaitStateStore {
  constructor(private readonly io: WaitStateIO) {}

  load(): PendingWait | null {
    let text: string | null;
    try {
      text = this.io.read();
    } catch {
      return null;
    }
    if (text === null || text.trim().length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    return parsePendingWait(parsed);
  }

  save(input: PendingWaitInput): PendingWait {
    const record = buildPendingWait(input);
    this.io.write(serializePendingWait(record));
    return record;
  }

  /** Persist an already-built record verbatim (used when re-saving on resume). */
  saveRecord(record: PendingWait): void {
    this.io.write(serializePendingWait(record));
  }

  clear(): void {
    try {
      this.io.remove();
    } catch {
      /* best-effort: nothing to clean up */
    }
  }
}

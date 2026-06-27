import stripAnsi from 'strip-ansi';
import { parseResetTime, type ParsedReset } from './reset-time-parser';

export interface LimitEvent {
  /** The full output line that matched a limit pattern (ANSI-stripped). */
  matchedText: string;
  /** Parsed reset time, or null when none could be extracted. */
  resetTime: Date | null;
  /** Full parse detail, or null. */
  reset: ParsedReset | null;
}

export interface LimitDetectorOptions {
  /** Limit-reached patterns. Defaults cover the known Claude phrasings. */
  patterns?: RegExp[];
  /** Injectable clock for deterministic reset-time parsing. */
  now?: () => number;
  /** Soft cap on the retained tail buffer (chars) when no candidate is pending. */
  maxBuffer?: number;
}

export const DEFAULT_LIMIT_PATTERNS: RegExp[] = [
  // "Claude usage limit reached.", "Weekly usage limit reached." — qualifier (if
  // any) sits before "usage limit", so this already covers the weekly variant.
  /usage limit reached/i,
  // "You've reached your usage limit", "...weekly usage limit", "...session limit".
  // Allow up to 3 qualifier words (e.g. "your weekly") between "reached" and the
  // limit noun — the missing tolerance here is exactly why weekly limits, phrased
  // "reached your weekly usage limit", went undetected. The noun is no longer
  // pinned to "usage": newer builds say "session limit" (and "weekly limit").
  /reached (?:[\w-]+\s+){0,3}(?:usage|session|weekly|daily|hourly|monthly) limit/i,
  // "You've hit your usage limit", "you have hit your weekly usage limit",
  // "You've hit your session limit" — the current phrasing that broke detection.
  /hit (?:[\w-]+\s+){0,3}(?:usage|session|weekly|daily|hourly|monthly) limit/i,
  // "Weekly limit reached", "5-hour limit reached", "Daily/Hourly/Monthly/Session
  // limit reached" — the bare phrasing that omits the word "usage".
  /\b(?:weekly|daily|hourly|monthly|session|\d+\s*-?\s*hour)\s+limit reached/i,
  // "Session limit · resets 11:30am", "Weekly limit · resets …" — the newest
  // phrasing pairs the limit noun with "resets" instead of "reached", and may
  // arrive without any "hit"/"reached" verb to anchor on.
  /\b(?:usage|session|weekly|daily|hourly|monthly|\d+\s*-?\s*hour)\s+limit\b[^\n]*\bresets?\b/i,
  // "reset(s) at|by <time>" — treat any reset phrase carrying a concrete time as
  // a limit signal even when the surrounding wording changes. Covers a clock time
  // ("resets at 11:30am", "reset by 9 PM"), an ISO timestamp, or noon/midnight.
  /\breset(?:s)?\s+(?:at|by)\s+(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|noon|midnight)/i,
  // Encoding-robust catch-all: the stems "limit" and "reset" co-occurring within a
  // single sentence, or split across two consecutive sentences (at most one
  // sentence terminator between them). Claude varies the exact wording, spacing
  // (e.g. non-breaking spaces), and apostrophe glyphs between CLI builds, but a
  // usage-limit notice reliably pairs these two words. Keying on just them —
  // tolerant of any in-between text — picks up phrasings the specific patterns
  // above miss. The sentence-gap whitespace is `[^\S\n]` (space/tab, never a
  // newline) so the two words must co-occur on the SAME physical line: the
  // detector emits line-by-line, so a cross-line bridge would both falsely join
  // unrelated lines and lose the reset time. Both word orders covered.
  /\blimit\b[^.!?\n]*(?:[.!?]+[^\S\n]*)?[^.!?\n]*?\breset/i,
  /\breset[^.!?\n]*(?:[.!?]+[^\S\n]*)?[^.!?\n]*?\blimit\b/i,
];

/** Absolute ceiling so a pinned, never-terminated candidate line can't grow forever. */
const HARD_BUFFER_MULTIPLIER = 8;

/**
 * Scans streamed terminal output for a "usage limit reached" message and
 * extracts the reset time. ANSI is stripped; a rolling buffer reassembles
 * messages split across chunks. Emits at most once per occurrence (the matched
 * line is consumed from the buffer). A line is normally emitted once it is
 * newline-terminated (so a partially-streamed reset time is not lost); use
 * {@link flush} to force-emit a pending line when the process exits or stalls.
 */
export class LimitDetector {
  private buf = '';
  private patterns: RegExp[];
  private readonly now: () => number;
  private readonly maxBuffer: number;

  constructor(opts: LimitDetectorOptions = {}) {
    this.patterns = LimitDetector.normalizePatterns(opts.patterns ?? DEFAULT_LIMIT_PATTERNS);
    this.now = opts.now ?? (() => Date.now());
    this.maxBuffer = opts.maxBuffer ?? 8192;
  }

  /**
   * Normalize away the global flag so repeated `.match`/`.test`/`.search` stay
   * stateless (a `g`-flagged regex carries `lastIndex` between calls).
   */
  private static normalizePatterns(patterns: RegExp[]): RegExp[] {
    return patterns.map((p) => (p.global ? new RegExp(p.source, p.flags.replace('g', '')) : p));
  }

  /**
   * Swap the active limit-detection patterns at runtime so a settings change
   * takes effect on the *current* session without a relaunch. The rolling
   * buffer is preserved, so output already streamed (but not yet newline-
   * terminated) is re-evaluated against the new patterns on the next push/flush.
   */
  setPatterns(patterns: RegExp[]): void {
    this.patterns = LimitDetector.normalizePatterns(patterns);
  }

  /** Feed a chunk of (possibly ANSI-laden, possibly partial) output. */
  push(chunk: string): LimitEvent | null {
    this.buf += stripAnsi(chunk);
    const ev = this.scan(false);
    if (!ev) this.trim();
    return ev;
  }

  /** Force-emit a pending (unterminated) limit line, e.g. on process exit. */
  flush(): LimitEvent | null {
    return this.scan(true);
  }

  /**
   * True when the buffer currently holds a pattern match whose line is *not*
   * newline-terminated — i.e. {@link push} matched but is withholding the event
   * pending a newline, so only {@link flush} would emit it. Lets a caller detect
   * a limit that the CLI renders in place (a live TUI redraw with no trailing
   * newline) by force-flushing once output goes idle, instead of waiting for a
   * newline that never comes or for the process to exit.
   */
  hasPendingMatch(): boolean {
    let matchIndex = -1;
    for (const p of this.patterns) {
      const m = this.buf.match(p);
      if (m && m.index !== undefined && (matchIndex < 0 || m.index < matchIndex)) {
        matchIndex = m.index;
      }
    }
    if (matchIndex < 0) return false;
    return this.buf.indexOf('\n', matchIndex) < 0;
  }

  reset(): void {
    this.buf = '';
  }

  /** Find the earliest matching line; emit it if complete (or forced). */
  private scan(force: boolean): LimitEvent | null {
    let matchIndex = -1;
    for (const p of this.patterns) {
      const m = this.buf.match(p);
      if (m && m.index !== undefined && (matchIndex < 0 || m.index < matchIndex)) {
        matchIndex = m.index;
      }
    }
    if (matchIndex < 0) return null;

    let lineEnd = this.buf.indexOf('\n', matchIndex);
    if (lineEnd < 0) {
      if (!force) return null; // wait for the full line
      lineEnd = this.buf.length;
    }

    const lineStart = this.buf.lastIndexOf('\n', matchIndex) + 1;
    const line = this.buf.slice(lineStart, lineEnd).replace(/\r$/, '').trim();
    this.buf = lineEnd < this.buf.length ? this.buf.slice(lineEnd + 1) : '';

    const reset = parseResetTime(line, this.now());
    return { matchedText: line, resetTime: reset?.date ?? null, reset };
  }

  /** Bound memory — but never discard an unterminated line that holds a match. */
  private trim(): void {
    const hasPendingCandidate = this.patterns.some((p) => this.buf.search(p) >= 0);
    if (hasPendingCandidate && this.buf.length <= this.maxBuffer * HARD_BUFFER_MULTIPLIER) {
      return;
    }
    if (this.buf.length > this.maxBuffer) {
      this.buf = this.buf.slice(-this.maxBuffer);
    }
  }
}

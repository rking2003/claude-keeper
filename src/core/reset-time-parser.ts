/**
 * ResetTimeParser — converts the human reset-time phrasing Claude prints
 * (e.g. "3:00 PM (America/New_York)", "9am (UTC)", "in 2 hours", ISO strings,
 * "midnight"/"noon") into an absolute Date. Timezone- and DST-aware via Intl.
 * Returns null when no usable time can be found, so callers can fall back to
 * interval polling.
 *
 * Pure and Electron-free; `now` is injectable for deterministic tests.
 */

const ABBREV: Record<string, string> = {
  UTC: 'UTC',
  GMT: 'UTC',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CET: 'Europe/Paris',
  CEST: 'Europe/Paris',
  BST: 'Europe/London',
};

/**
 * Tolerance for "the announced reset minute is essentially now". Reset times are
 * announced in the future, so the only realistic past-skew is sub-minute clock
 * rounding / processing delay. Without this, a time 30s in the past would roll a
 * full day forward.
 */
const GRACE_MS = 120_000;

export interface ParsedReset {
  date: Date;
  /** How the time was derived; useful for logging/telemetry. */
  kind: 'iso' | 'relative' | 'clock';
  /** Resolved IANA zone, or 'local' when no zone was given. */
  zone: string;
}

export function parseResetTime(text: string, now: number = Date.now()): ParsedReset | null {
  // 1) Absolute ISO timestamp (carries its own offset / Z).
  const iso = text.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/,
  );
  if (iso) {
    const d = new Date(iso[0]);
    if (!Number.isNaN(d.getTime())) return { date: d, kind: 'iso', zone: 'UTC' };
  }

  // 2) Relative: "in 2 hours", "in 30 minutes".
  const rel = text.match(/in\s+(\d+)\s*(hours?|hrs?|minutes?|mins?)/i);
  if (rel) {
    const n = parseInt(rel[1]!, 10);
    const ms = /min/i.test(rel[2]!) ? n * 60_000 : n * 3_600_000;
    return { date: new Date(now + ms), kind: 'relative', zone: 'local' };
  }

  // 3) Clock time, optionally with a timezone. Prefer the time stated after a
  //    reset phrase ("reset at 9am") so a leading log timestamp can't hijack it.
  const scoped = scopeAfterResetPhrase(text);
  const time = matchClockTime(scoped.text, scoped.anchored);
  if (!time) return null;

  const zone = resolveZone(scoped.text);
  if (zone === 'local') {
    return { date: nextLocal(now, time.hour, time.minute), kind: 'clock', zone: 'local' };
  }
  return { date: nextZoned(now, time.hour, time.minute, zone), kind: 'clock', zone };
}

interface ClockTime {
  hour: number;
  minute: number;
}

/** Narrow the search to the text after a reset/try-again phrase, when present. */
function scopeAfterResetPhrase(text: string): { text: string; anchored: boolean } {
  // "reset at", "resets by", and — for the newer "resets 11:30am" phrasing —
  // "resets"/"reset"/"resume" with the preposition omitted. "available"/"back"
  // still require an explicit "at" so they don't anchor on unrelated prose.
  const anchor = text.match(
    /(?:reset(?:s)?|resume)\s+(?:at|by)?\s*|(?:available|back)\s+at\b|try\s+again\s+at\b/i,
  );
  if (anchor && anchor.index !== undefined) {
    return { text: text.slice(anchor.index), anchored: true };
  }
  return { text, anchored: false };
}

function matchClockTime(text: string, anchored: boolean): ClockTime | null {
  if (/\bmidnight\b/i.test(text)) return { hour: 0, minute: 0 };
  if (/\bnoon\b/i.test(text)) return { hour: 12, minute: 0 };

  // "3:00 PM" | "15:00" | "3pm" | "12:30am". Require a colon OR an am/pm marker so
  // we don't latch onto arbitrary integers in the surrounding text.
  const re = /\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?|\b(\d{1,2})\s*([ap])\.?m\.?/gi;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return null;

  // When anchored to a reset phrase, the first time is the reset time. Otherwise
  // the reset time is most likely the last time on the line (after any prefix).
  const m = anchored ? matches[0]! : matches[matches.length - 1]!;

  let hour: number;
  let minute: number;
  let ap: string | undefined;
  if (m[1] !== undefined) {
    hour = parseInt(m[1], 10);
    minute = parseInt(m[2]!, 10);
    ap = m[3]?.toLowerCase();
  } else {
    hour = parseInt(m[4]!, 10);
    minute = 0;
    ap = m[5]?.toLowerCase();
  }

  if (ap === 'p' && hour < 12) hour += 12;
  if (ap === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function resolveZone(text: string): string {
  const candidates: string[] = [];
  const paren = text.match(/\(([^)]+)\)/);
  if (paren) candidates.push(paren[1]!.trim());
  const iana = text.match(/\b([A-Za-z]+(?:\/[A-Za-z_-]+)+)\b/);
  if (iana) candidates.push(iana[1]!);
  const abbr = text.match(/\b(UTC|GMT|CEST|BST|CET|[PMCE][SD]T)\b/);
  if (abbr) candidates.push(abbr[1]!);

  for (const c of candidates) {
    if (c.includes('/') && isValidZone(c)) return c;
    const up = c.toUpperCase();
    if (ABBREV[up]) return ABBREV[up]!;
  }
  return 'local';
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(tz: string, instantMs: number): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  let hour = parseInt(p.hour!, 10);
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return {
    year: parseInt(p.year!, 10),
    month: parseInt(p.month!, 10),
    day: parseInt(p.day!, 10),
    hour,
    minute: parseInt(p.minute!, 10),
  };
}

function zoneOffsetMs(tz: string, instantMs: number): number {
  const p = zonedParts(tz, instantMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - roundToMinute(instantMs);
}

function roundToMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * All UTC instants whose wall-clock time in `tz` equals (y,mo,d,h,mi). Returns:
 *  - one instant for normal times,
 *  - two for fall-back overlaps (ambiguous),
 *  - zero for spring-forward gaps (nonexistent).
 */
function wallToInstants(tz: string, y: number, mo: number, d: number, h: number, mi: number): number[] {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offBefore = zoneOffsetMs(tz, guess - 12 * 3_600_000);
  const offAfter = zoneOffsetMs(tz, guess + 12 * 3_600_000);
  const out = new Set<number>();
  for (const off of [offBefore, offAfter]) {
    const inst = guess - off;
    const p = zonedParts(tz, inst);
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) {
      out.add(inst);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Resolve a wall time to a single instant, picking the later side of a gap. */
function resolveWall(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const insts = wallToInstants(tz, y, mo, d, h, mi);
  if (insts.length > 0) return insts[0]!; // earliest valid (caller filters by now)
  // Spring-forward gap: schedule no earlier than requested -> use the later side.
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const a = guess - zoneOffsetMs(tz, guess - 12 * 3_600_000);
  const b = guess - zoneOffsetMs(tz, guess + 12 * 3_600_000);
  return Math.max(a, b);
}

function nextZoned(now: number, hour: number, minute: number, tz: string): Date {
  const today = zonedParts(tz, now);
  const candidates: number[] = [];
  for (let addDay = 0; addDay <= 1; addDay++) {
    const insts = wallToInstants(tz, today.year, today.month, today.day + addDay, hour, minute);
    if (insts.length > 0) candidates.push(...insts);
    else candidates.push(resolveWall(tz, today.year, today.month, today.day + addDay, hour, minute));
  }
  candidates.sort((a, b) => a - b);
  const next = candidates.find((c) => c > now - GRACE_MS);
  return new Date(next ?? candidates[candidates.length - 1]!);
}

function nextLocal(now: number, hour: number, minute: number): Date {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now - GRACE_MS) d.setDate(d.getDate() + 1);
  return d;
}

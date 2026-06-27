import { describe, it, expect } from 'vitest';
import { parseResetTime } from '@core/reset-time-parser';

// Fixed reference instants (UTC) to keep timezone math deterministic.
const JAN = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z (winter / standard time)

describe('parseResetTime', () => {
  it('parses "3:00 PM (America/New_York)" to the next occurrence in that zone', () => {
    // 12:00Z == 07:00 EST; 15:00 EST is later the same day == 20:00Z.
    const r = parseResetTime('Your limit will reset at 3:00 PM (America/New_York).', JAN);
    expect(r?.date.toISOString()).toBe('2026-01-15T20:00:00.000Z');
    expect(r?.zone).toBe('America/New_York');
    expect(r?.kind).toBe('clock');
  });

  it('rolls to the next day when the zoned time already passed', () => {
    const now = Date.UTC(2026, 0, 15, 21, 0, 0); // 16:00 EST, after 15:00
    const r = parseResetTime('reset at 3:00 PM (America/New_York)', now);
    expect(r?.date.toISOString()).toBe('2026-01-16T20:00:00.000Z');
  });

  it('parses "9:00 AM (UTC)"', () => {
    const now = Date.UTC(2026, 0, 15, 8, 0, 0);
    const r = parseResetTime('limit reached. reset at 9:00 AM (UTC)', now);
    expect(r?.date.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(r?.zone).toBe('UTC');
  });

  it('parses bare "4pm (PST)" via abbreviation map', () => {
    // 12:00Z == 04:00 PST; 16:00 PST == 00:00Z next day.
    const r = parseResetTime('try again at 4pm (PST)', JAN);
    expect(r?.date.toISOString()).toBe('2026-01-16T00:00:00.000Z');
    expect(r?.zone).toBe('America/Los_Angeles');
  });

  it('parses a trailing abbreviation without parentheses ("15:00 UTC")', () => {
    const now = Date.UTC(2026, 0, 15, 8, 0, 0);
    const r = parseResetTime('resets at 15:00 UTC', now);
    expect(r?.date.toISOString()).toBe('2026-01-15T15:00:00.000Z');
  });

  it('parses an absolute ISO timestamp directly', () => {
    const r = parseResetTime('reset at 2026-03-01T15:30:00Z', JAN);
    expect(r?.kind).toBe('iso');
    expect(r?.date.toISOString()).toBe('2026-03-01T15:30:00.000Z');
  });

  it('parses relative "in 2 hours"', () => {
    const r = parseResetTime('try again in 2 hours', JAN);
    expect(r?.kind).toBe('relative');
    expect(r?.date.getTime()).toBe(JAN + 2 * 3_600_000);
  });

  it('parses relative "in 30 minutes"', () => {
    const r = parseResetTime('reset in 30 minutes', JAN);
    expect(r?.date.getTime()).toBe(JAN + 30 * 60_000);
  });

  it('handles a no-timezone clock time as local time, rolling forward', () => {
    // Compare against the same local-time logic to stay machine-independent.
    const now = JAN;
    const r = parseResetTime('reset at 11:30pm', now);
    const expected = new Date(now);
    expected.setHours(23, 30, 0, 0);
    if (expected.getTime() <= now) expected.setDate(expected.getDate() + 1);
    expect(r?.zone).toBe('local');
    expect(r?.date.getTime()).toBe(expected.getTime());
  });

  it('returns null when no time is present', () => {
    expect(parseResetTime('something went wrong, please retry', JAN)).toBeNull();
    expect(parseResetTime('', JAN)).toBeNull();
  });

  it('does not latch onto bare numbers without a colon or am/pm', () => {
    expect(parseResetTime('processed 42 files in folder 7', JAN)).toBeNull();
  });

  it('handles DST: "3:00 PM (America/New_York)" in summer is EDT (UTC-4)', () => {
    const summer = Date.UTC(2026, 6, 15, 12, 0, 0); // July -> EDT
    const r = parseResetTime('reset at 3:00 PM (America/New_York)', summer);
    expect(r?.date.toISOString()).toBe('2026-07-15T19:00:00.000Z'); // 15:00 EDT == 19:00Z
  });

  it('spring-forward gap: a nonexistent wall time is scheduled no earlier than requested', () => {
    // 2026-03-08 02:30 America/New_York does not exist (clocks jump 02:00->03:00).
    const now = Date.UTC(2026, 2, 8, 6, 0, 0); // 01:00 EST, before the gap
    const r = parseResetTime('reset at 2:30 AM (America/New_York)', now);
    // Must not resolve to 01:30 EST (06:30Z); resolves to the post-transition instant.
    expect(r?.date.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('fall-back overlap: picks the valid next occurrence, not 24h later', () => {
    // 2026-11-01 01:30 America/New_York occurs twice (05:30Z EDT, 06:30Z EST).
    const now = Date.UTC(2026, 10, 1, 6, 15, 0); // 01:15 EST, inside the repeated hour
    const r = parseResetTime('reset at 1:30 AM (America/New_York)', now);
    expect(r?.date.toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  it('does not skip a day when the reset minute just passed (grace window)', () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 30); // 30s past 9:00 UTC
    const r = parseResetTime('reset at 9:00 AM (UTC)', now);
    expect(r?.date.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('ignores a leading timestamp and parses the time after "reset at"', () => {
    const now = Date.UTC(2026, 0, 15, 8, 0, 0);
    const r = parseResetTime(
      '[12:34:56] Claude usage limit reached. Your limit will reset at 9:00 AM (UTC).',
      now,
    );
    expect(r?.date.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('parses "midnight" and "noon"', () => {
    const now = Date.UTC(2026, 0, 15, 8, 0, 0);
    expect(parseResetTime('reset at midnight (UTC)', now)?.date.toISOString()).toBe(
      '2026-01-16T00:00:00.000Z',
    );
    expect(parseResetTime('reset at noon (UTC)', now)?.date.toISOString()).toBe(
      '2026-01-15T12:00:00.000Z',
    );
  });

  it('parses multi-segment IANA zones', () => {
    const now = Date.UTC(2026, 0, 15, 0, 0, 0);
    const r = parseResetTime('reset at 9:00 AM (America/Argentina/Buenos_Aires)', now);
    // UTC-3 year round -> 09:00 ART == 12:00Z
    expect(r?.date.toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });
});

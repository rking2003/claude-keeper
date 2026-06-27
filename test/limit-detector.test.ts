import { describe, it, expect } from 'vitest';
import { LimitDetector } from '@core/limit-detector';

const NOW = Date.UTC(2026, 0, 15, 8, 0, 0); // 2026-01-15T08:00:00Z
const now = () => NOW;

describe('LimitDetector', () => {
  it('detects the real Claude message and parses the reset time', () => {
    const d = new LimitDetector({ now });
    const ev = d.push(
      'Claude usage limit reached. Your limit will reset at 9:00 AM (UTC).\r\n',
    );
    expect(ev).not.toBeNull();
    expect(ev!.matchedText).toContain('usage limit reached');
    expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('reassembles a message split across chunks', () => {
    const d = new LimitDetector({ now });
    expect(d.push('Claude usage limit reached. Your limit will ')).toBeNull();
    const ev = d.push('reset at 9:00 AM (UTC).\n');
    expect(ev).not.toBeNull();
    expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('waits for the newline before emitting (avoids losing a partial reset time)', () => {
    const d = new LimitDetector({ now });
    // pattern present but line not terminated yet
    expect(d.push('Claude usage limit reached. Your limit will reset at 9:00 AM (UTC).')).toBeNull();
    const ev = d.push('\n');
    expect(ev?.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('reports a withheld match via hasPendingMatch, then flush emits it', () => {
    const d = new LimitDetector({ now });
    expect(d.hasPendingMatch()).toBe(false);
    // Matched but not newline-terminated: push withholds, but the caller can see
    // there is a pending candidate and force-flush it (the live-TUI case).
    expect(
      d.push('Claude usage limit reached. Your limit will reset at 9:00 AM (UTC).'),
    ).toBeNull();
    expect(d.hasPendingMatch()).toBe(true);
    const ev = d.flush();
    expect(ev?.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    // Consumed: no longer pending.
    expect(d.hasPendingMatch()).toBe(false);
  });

  it('hasPendingMatch is false once the line is newline-terminated', () => {
    const d = new LimitDetector({ now });
    d.push('Claude usage limit reached. reset at 9:00 AM (UTC).\n'); // emitted by push
    expect(d.hasPendingMatch()).toBe(false);
  });

  it('strips ANSI escape codes before matching', () => {
    const d = new LimitDetector({ now });
    const ev = d.push('\x1b[33mClaude usage limit reached. reset at 10:00 AM (UTC).\x1b[0m\n');
    expect(ev).not.toBeNull();
    expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });

  it('returns null for ordinary output', () => {
    const d = new LimitDetector({ now });
    expect(d.push('● building the auth module\r\n')).toBeNull();
    expect(d.push('running tests... 42 passed\r\n')).toBeNull();
  });

  it('emits once per occurrence (no duplicate on subsequent output)', () => {
    const d = new LimitDetector({ now });
    const ev1 = d.push('Claude usage limit reached. reset at 9:00 AM (UTC).\n');
    expect(ev1).not.toBeNull();
    expect(d.push('● still here\n')).toBeNull();
    expect(d.push('more logs\n')).toBeNull();
  });

  it('re-detects a fresh occurrence later in the stream', () => {
    const d = new LimitDetector({ now });
    expect(d.push('Claude usage limit reached. reset at 9:00 AM (UTC).\n')).not.toBeNull();
    expect(d.push('● resumed work\n')).toBeNull();
    expect(d.push('Claude usage limit reached. reset at 11:00 AM (UTC).\n')).not.toBeNull();
  });

  describe('setPatterns (mid-session update)', () => {
    it('matches against newly-supplied patterns', () => {
      const d = new LimitDetector({ now, patterns: [/never matches this/i] });
      expect(d.push('RATE CEILING HIT for today\n')).toBeNull();
      d.setPatterns([/rate ceiling hit/i]);
      const ev = d.push('RATE CEILING HIT for today\n');
      expect(ev).not.toBeNull();
      expect(ev!.matchedText).toContain('RATE CEILING HIT');
    });

    it('stops matching patterns that were replaced', () => {
      const d = new LimitDetector({ now }); // defaults match "usage limit reached"
      d.setPatterns([/something else entirely/i]);
      expect(d.push('Claude usage limit reached. reset at 9:00 AM (UTC).\n')).toBeNull();
    });

    it('re-evaluates already-buffered, unterminated output against new patterns', () => {
      const d = new LimitDetector({ now, patterns: [/zzz/i] });
      // Buffer a line (no newline yet) that the OLD patterns don't match.
      expect(d.push('weekly quota exhausted, reset at 9:00 AM (UTC)')).toBeNull();
      d.setPatterns([/quota exhausted/i]);
      const ev = d.push('\n'); // terminate the buffered line
      expect(ev).not.toBeNull();
      expect(ev!.matchedText).toContain('quota exhausted');
    });

    it('normalizes away the global flag so matching stays stateless', () => {
      const d = new LimitDetector({ now });
      d.setPatterns([/limit hit/gi]);
      expect(d.push('LIMIT HIT now\n')).not.toBeNull();
      expect(d.push('LIMIT HIT again\n')).not.toBeNull(); // would fail if lastIndex carried
    });
  });

  it('emits with null resetTime when the message has no time', () => {
    const d = new LimitDetector({ now });
    const ev = d.push('Claude usage limit reached. Please try again later.\n');
    expect(ev).not.toBeNull();
    expect(ev!.resetTime).toBeNull();
  });

  it('supports custom patterns', () => {
    const d = new LimitDetector({ now, patterns: [/quota exhausted/i] });
    expect(d.push('usage limit reached.\n')).toBeNull(); // not in custom set
    const ev = d.push('error: quota exhausted, retry at 9:00 AM (UTC).\n');
    expect(ev).not.toBeNull();
    expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('flush() emits a pending limit line that never received a newline', () => {
    const d = new LimitDetector({ now });
    expect(d.push('Claude usage limit reached. reset at 9:00 AM (UTC).')).toBeNull();
    const ev = d.flush();
    expect(ev).not.toBeNull();
    expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('flush() returns null when there is no pending limit', () => {
    const d = new LimitDetector({ now });
    d.push('● building things');
    expect(d.flush()).toBeNull();
  });

  it('does not trim away an active, unterminated limit line (small buffer)', () => {
    const d = new LimitDetector({ now, maxBuffer: 64 });
    // pattern arrives, then a long run with no newline that would normally trim
    expect(d.push('Claude usage limit reached.' + ' '.repeat(200))).toBeNull();
    const ev = d.push(' reset at 9:00 AM (UTC).\n');
    expect(ev).not.toBeNull();
    expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('emits the earliest matching line regardless of pattern order', () => {
    const d = new LimitDetector({ now });
    const ev = d.push(
      'you have hit your usage limit. reset at 9:00 AM (UTC).\n' +
        'Claude usage limit reached. reset at 10:00 AM (UTC).\n',
    );
    expect(ev).not.toBeNull();
    expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z'); // the earlier line
  });

  describe('weekly limit phrasings', () => {
    it('detects "reached your weekly usage limit" (qualifier between your and usage limit)', () => {
      const d = new LimitDetector({ now });
      const ev = d.push(
        "You've reached your weekly usage limit. Your limit will reset at 9:00 AM (UTC).\r\n",
      );
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    });

    it('detects "Weekly limit reached." with an ISO reset timestamp', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('Weekly limit reached. Resets at 2026-11-06T03:59:59.943679+00:00\n');
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-11-06T03:59:59.943Z');
    });

    it('detects "Weekly usage limit reached."', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('Weekly usage limit reached. Try again later.\n');
      expect(ev).not.toBeNull();
    });

    it('detects "you\'ve hit your weekly usage limit"', () => {
      const d = new LimitDetector({ now });
      const ev = d.push("you've hit your weekly usage limit. reset at 11:00 AM (UTC).\n");
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T11:00:00.000Z');
    });

    it('detects a "5-hour limit reached" (session) message', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('5-hour limit reached. reset at 1:00 PM (UTC).\n');
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T13:00:00.000Z');
    });
  });

  describe('session limit "resets <time>" phrasing (the new CLI message)', () => {
    it('detects "You\'ve hit your session limit · resets 11:30am (zone)"', () => {
      const d = new LimitDetector({ now });
      const ev = d.push(
        "You've hit your session limit · resets 11:30am (America/Los_Angeles)\n",
      );
      expect(ev).not.toBeNull();
      // 11:30 America/Los_Angeles on 2026-01-15 (PST, UTC-8) => 19:30Z
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T19:30:00.000Z');
    });

    it('detects the bare "Session limit · resets 11:30am" (no verb)', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('Session limit · resets 11:30am (UTC)\n');
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T11:30:00.000Z');
    });

    it("detects \"reached your session limit\"", () => {
      const d = new LimitDetector({ now });
      const ev = d.push("You've reached your session limit. reset at 9:00 AM (UTC).\n");
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    });

    it('treats "resets at <time>" as a detection point on its own', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('Please wait — resets at 10:15 AM (UTC).\n');
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T10:15:00.000Z');
    });

    it('treats "reset by <time>" as a detection point on its own', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('Back online — reset by 1:00 PM (UTC).\n');
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T13:00:00.000Z');
    });
  });

  describe('"limit" + "reset" co-occurrence (encoding-robust catch-all)', () => {
    // The first three phrasings are chosen so NONE of the more specific patterns
    // above match (no "usage/weekly/session limit", no "reached/hit … limit", no
    // "reset at/by <time>"). Detection therefore comes solely from the new
    // co-occurrence patterns — proving they add coverage.
    it('matches both words in the same sentence', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('Your plan limit will reset shortly.\n');
      expect(ev).not.toBeNull();
      expect(ev!.matchedText).toContain('plan limit will reset');
    });

    it('matches the two words split across two consecutive sentences', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('Your account limit is active now. It will reset overnight.\n');
      expect(ev).not.toBeNull();
    });

    it('matches the reverse order (reset … limit)', () => {
      const d = new LimitDetector({ now });
      const ev = d.push('We reset the counter once your plan limit lifts.\n');
      expect(ev).not.toBeNull();
    });

    it('tolerates a curly apostrophe and wording the specific patterns miss', () => {
      const d = new LimitDetector({ now });
      // Curly apostrophe (U+2019) plus "maxed your daily limit" \u2014 not a
      // "reached/hit ... limit" phrasing \u2014 so only the co-occurrence pattern
      // fires. The reset time still parses from the matched line.
      const ev = d.push('You\u2019ve maxed your daily limit \u2014 it will reset by 9:00 AM (UTC).\n');
      expect(ev).not.toBeNull();
      expect(ev!.resetTime?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    });

    it('does NOT match when the words are more than one sentence apart', () => {
      const d = new LimitDetector({ now });
      // "limit" and "reset" separated by a full intervening sentence (two
      // terminators) — beyond "two consecutive sentences", so no false trigger.
      expect(
        d.push('There is no limit here. This is unrelated. Let us reset the layout.\n'),
      ).toBeNull();
    });

    it('does NOT match a sentence with only one of the two words', () => {
      const d = new LimitDetector({ now });
      expect(d.push('Please reset your password to continue.\n')).toBeNull();
      expect(d.push('There is no rate limit on this endpoint.\n')).toBeNull();
    });
  });
});

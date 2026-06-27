import { describe, it, expect } from 'vitest';
import {
  buildPendingWait,
  parsePendingWait,
  serializePendingWait,
  isWaitFresh,
  WaitStateStore,
  PENDING_WAIT_VERSION,
  DEFAULT_WAIT_MAX_AGE_MS,
  type WaitStateIO,
  type PendingWait,
} from '../src/core/wait-state';

function memIO(initial: string | null = null): WaitStateIO & { value: string | null } {
  const box = {
    value: initial,
    read() {
      return this.value;
    },
    write(data: string) {
      this.value = data;
    },
    remove() {
      this.value = null;
    },
  };
  return box;
}

describe('buildPendingWait', () => {
  it('fills defaults and stamps the version', () => {
    const p = buildPendingWait({ resetTimeMs: 1000, command: 'claude', savedAtMs: 50 });
    expect(p.version).toBe(PENDING_WAIT_VERSION);
    expect(p.command).toBe('claude');
    expect(p.autoResume).toBe(true);
    expect(p.args).toEqual([]);
    expect(p.customPatterns).toEqual([]);
    expect(p.replaceDefaultPatterns).toBe(false);
    expect(p.resumePrompt).toBe('continue');
    expect(p.savedAtMs).toBe(50);
  });

  it('honors a custom resume prompt and sanitizes control characters', () => {
    const p = buildPendingWait({
      resetTimeMs: null,
      command: 'claude',
      resumePrompt: 'do the\r\nthing',
      autoResume: false,
    });
    expect(p.resumePrompt).toBe('do the  thing'); // CR/LF collapsed to spaces
    expect(p.resetTimeMs).toBeNull();
    expect(p.autoResume).toBe(false);
  });

  it('caps oversized arrays and strings defensively', () => {
    const p = buildPendingWait({
      resetTimeMs: 0,
      command: 'claude',
      customPatterns: Array.from({ length: 200 }, (_, i) => `p${i}`),
      resumePrompt: 'x'.repeat(99999),
    });
    expect(p.customPatterns.length).toBe(50);
    expect(p.resumePrompt.length).toBe(500);
  });

  it('clamps dangerous numeric fields into safe bounds', () => {
    const p = buildPendingWait({
      resetTimeMs: 1,
      command: 'claude',
      pollIntervalMs: -1,
      maxRetries: 1_000_000_000,
      safetyBufferMs: -50,
      verifyWindowMs: 9_999_999,
    });
    expect(p.pollIntervalMs).toBe(60_000); // floored to 1 min
    expect(p.maxRetries).toBe(100); // capped
    expect(p.safetyBufferMs).toBe(0); // floored
    expect(p.verifyWindowMs).toBe(60_000); // capped
  });

  it('coerces an absurd / non-finite resetTimeMs to null', () => {
    expect(buildPendingWait({ resetTimeMs: -5, command: 'c' }).resetTimeMs).toBeNull();
    expect(buildPendingWait({ resetTimeMs: 9e18, command: 'c' }).resetTimeMs).toBeNull();
    expect(buildPendingWait({ resetTimeMs: Number.NaN, command: 'c' }).resetTimeMs).toBeNull();
  });
});

describe('parsePendingWait', () => {
  it('round-trips a serialized record', () => {
    const p = buildPendingWait({
      resetTimeMs: 123456,
      command: 'claude',
      resumePrompt: 'hi',
      args: ['--foo'],
      savedAtMs: 999,
    });
    const back = parsePendingWait(JSON.parse(serializePendingWait(p)));
    expect(back).toEqual(p);
  });

  it('rejects non-objects', () => {
    expect(parsePendingWait(null)).toBeNull();
    expect(parsePendingWait(42)).toBeNull();
    expect(parsePendingWait('str')).toBeNull();
    expect(parsePendingWait([])).toBeNull();
  });

  it('rejects a record with no usable command', () => {
    expect(parsePendingWait({ command: '', savedAtMs: 1 })).toBeNull();
    expect(parsePendingWait({ command: '   ', savedAtMs: 1 })).toBeNull();
    expect(parsePendingWait({ savedAtMs: 1 })).toBeNull();
  });

  it('rejects a record without a numeric savedAtMs', () => {
    expect(parsePendingWait({ command: 'claude' })).toBeNull();
    expect(parsePendingWait({ command: 'claude', savedAtMs: 'soon' })).toBeNull();
  });

  it('normalizes a hand-edited record and drops unknown keys', () => {
    const parsed = parsePendingWait({
      command: 'claude',
      savedAtMs: 10,
      resetTimeMs: 5000,
      resumePrompt: 42,
      customPatterns: ['ok', 7, 'two'],
      evil: 'dropped',
    }) as PendingWait;
    expect(parsed.resumePrompt).toBe('continue'); // bogus -> default
    expect(parsed.customPatterns).toEqual(['ok', 'two']); // non-strings filtered
    expect((parsed as unknown as Record<string, unknown>)['evil']).toBeUndefined();
  });

  it('coerces a non-finite resetTimeMs to null', () => {
    const parsed = parsePendingWait({ command: 'claude', savedAtMs: 1, resetTimeMs: 'later' });
    expect(parsed?.resetTimeMs).toBeNull();
  });

  it('rejects a record stamped with an unknown version', () => {
    const p = buildPendingWait({ resetTimeMs: 1, command: 'claude', savedAtMs: 1 });
    const future = { ...p, version: 999 };
    expect(parsePendingWait(future)).toBeNull();
  });

  it('accepts a versionless legacy record (treated as current schema)', () => {
    expect(parsePendingWait({ command: 'claude', savedAtMs: 1, resetTimeMs: 0 })).not.toBeNull();
  });
});

describe('isWaitFresh', () => {
  const base = buildPendingWait({ resetTimeMs: 0, command: 'claude', savedAtMs: 1_000_000 });

  it('accepts a recently-saved wait', () => {
    expect(isWaitFresh(base, base.savedAtMs + 60_000)).toBe(true);
  });

  it('rejects a wait older than the max age', () => {
    expect(isWaitFresh(base, base.savedAtMs + DEFAULT_WAIT_MAX_AGE_MS + 1)).toBe(false);
  });

  it('accepts a long but in-bounds weekly-cap wait', () => {
    expect(isWaitFresh(base, base.savedAtMs + 7 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('rejects a wait saved far in the future (clock skew/tamper)', () => {
    expect(isWaitFresh(base, base.savedAtMs - 2 * 60 * 60 * 1000)).toBe(false);
  });

  it('tolerates minor forward clock skew', () => {
    expect(isWaitFresh(base, base.savedAtMs - 30_000)).toBe(true);
  });

  it('rejects a wait whose reset time is implausibly far in the future', () => {
    const farFuture = buildPendingWait({
      resetTimeMs: 2_000_000,
      command: 'claude',
      savedAtMs: 1_000_000,
    });
    // reset time ~31 days past "now" => bogus/abandoned.
    const now = farFuture.savedAtMs;
    const p = { ...farFuture, resetTimeMs: now + 31 * 24 * 60 * 60 * 1000 };
    expect(isWaitFresh(p, now)).toBe(false);
  });
});

describe('WaitStateStore', () => {
  it('saves and loads a normalized record', () => {
    const io = memIO();
    const store = new WaitStateStore(io);
    const saved = store.save({ resetTimeMs: 42, command: 'claude', resumePrompt: 'go' });
    expect(io.value).not.toBeNull();
    const loaded = store.load();
    expect(loaded).toEqual(saved);
  });

  it('returns null when nothing is stored', () => {
    expect(new WaitStateStore(memIO(null)).load()).toBeNull();
    expect(new WaitStateStore(memIO('')).load()).toBeNull();
    expect(new WaitStateStore(memIO('   ')).load()).toBeNull();
  });

  it('returns null (never throws) on corrupt JSON', () => {
    expect(new WaitStateStore(memIO('{not json')).load()).toBeNull();
  });

  it('returns null on structurally invalid JSON', () => {
    expect(new WaitStateStore(memIO('{"savedAtMs":1}')).load()).toBeNull();
  });

  it('clear() removes the stored record', () => {
    const io = memIO();
    const store = new WaitStateStore(io);
    store.save({ resetTimeMs: 1, command: 'claude' });
    store.clear();
    expect(io.value).toBeNull();
    expect(store.load()).toBeNull();
  });

  it('survives a read that throws', () => {
    const throwing: WaitStateIO = {
      read() {
        throw new Error('EACCES');
      },
      write() {},
      remove() {},
    };
    expect(new WaitStateStore(throwing).load()).toBeNull();
  });
});

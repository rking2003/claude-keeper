import { describe, it, expect } from 'vitest';
import {
  SettingsStore,
  mergeSettings,
  compilePatterns,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  type SettingsIO,
  type KeeperSettings,
} from '../src/core/settings';
import { DEFAULT_LIMIT_PATTERNS } from '../src/core/limit-detector';

/** In-memory IO seam for the store. */
function memIO(initial: string | null = null): SettingsIO & { value: string | null; writes: number } {
  return {
    value: initial,
    writes: 0,
    read() {
      return this.value;
    },
    write(c: string) {
      this.value = c;
      this.writes++;
    },
  };
}

describe('mergeSettings', () => {
  it('returns a complete copy of defaults for non-object input', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      expect(mergeSettings(bad)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('overlays provided fields and keeps defaults for the rest', () => {
    const out = mergeSettings({ command: 'mycli', autoResume: false });
    expect(out.command).toBe('mycli');
    expect(out.autoResume).toBe(false);
    expect(out.strategy).toBe(DEFAULT_SETTINGS.strategy);
    expect(out.safetySec).toBe(DEFAULT_SETTINGS.safetySec);
  });

  it('drops unknown keys and the version wrapper', () => {
    const out = mergeSettings({ version: 99, command: 'c', hacker: 'x', __proto__: { polluted: true } });
    expect(out).not.toHaveProperty('version');
    expect(out).not.toHaveProperty('hacker');
    expect(Object.keys(out).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('coerces an empty/blank command back to "claude"', () => {
    expect(mergeSettings({ command: '' }).command).toBe('claude');
    expect(mergeSettings({ command: '   ' }).command).toBe('claude');
    expect(mergeSettings({ command: 42 }).command).toBe('claude');
  });

  it('only accepts the two known strategies', () => {
    expect(mergeSettings({ strategy: 'replay' }).strategy).toBe('replay');
    expect(mergeSettings({ strategy: 'continue' }).strategy).toBe('continue');
    expect(mergeSettings({ strategy: 'nonsense' }).strategy).toBe('continue');
    expect(mergeSettings({ strategy: 7 }).strategy).toBe('continue');
  });

  it('clamps numeric fields to their bounds and rounds', () => {
    expect(mergeSettings({ safetySec: -5 }).safetySec).toBe(0);
    expect(mergeSettings({ safetySec: 99999 }).safetySec).toBe(3600);
    expect(mergeSettings({ safetySec: 12.7 }).safetySec).toBe(13);
    expect(mergeSettings({ pollMin: 0 }).pollMin).toBe(1); // min poll is 1
    expect(mergeSettings({ pollMin: 5000 }).pollMin).toBe(1440);
    expect(mergeSettings({ maxRetries: -1 }).maxRetries).toBe(0);
    expect(mergeSettings({ maxRetries: 1000 }).maxRetries).toBe(100);
  });

  it('falls back to the default for non-numeric / NaN numbers', () => {
    expect(mergeSettings({ safetySec: 'abc' }).safetySec).toBe(60);
    expect(mergeSettings({ pollMin: NaN }).pollMin).toBe(5);
    expect(mergeSettings({ maxRetries: Infinity }).maxRetries).toBe(5);
  });

  it('treats null / arrays / objects / blank strings as "use default", not 0', () => {
    expect(mergeSettings({ maxRetries: null }).maxRetries).toBe(5);
    expect(mergeSettings({ pollMin: [] }).pollMin).toBe(5);
    expect(mergeSettings({ safetySec: {} }).safetySec).toBe(60);
    expect(mergeSettings({ safetySec: '' }).safetySec).toBe(60);
    expect(mergeSettings({ safetySec: '   ' }).safetySec).toBe(60);
    expect(mergeSettings({ maxRetries: true }).maxRetries).toBe(5);
  });

  it('accepts numeric strings (coerces them)', () => {
    expect(mergeSettings({ safetySec: '120' }).safetySec).toBe(120);
    expect(mergeSettings({ maxRetries: '3' }).maxRetries).toBe(3);
  });

  it('coerces booleans, including the "true"/"false" strings', () => {
    expect(mergeSettings({ autoResume: 'false' }).autoResume).toBe(false);
    expect(mergeSettings({ autoResume: 'true' }).autoResume).toBe(true);
    expect(mergeSettings({ autoResume: 0 }).autoResume).toBe(true); // unknown -> default(true)
  });

  it('defaults the new logging/trust fields to off (file logging) and 10MB', () => {
    expect(DEFAULT_SETTINGS.logToFile).toBe(false);
    expect(DEFAULT_SETTINGS.logMaxSizeMB).toBe(10);
    expect(DEFAULT_SETTINGS.trustWorkingDir).toBe(false);
    const out = mergeSettings({});
    expect(out.logToFile).toBe(false);
    expect(out.logMaxSizeMB).toBe(10);
    expect(out.trustWorkingDir).toBe(false);
  });

  it('coerces logToFile / trustWorkingDir booleans', () => {
    expect(mergeSettings({ logToFile: 'true' }).logToFile).toBe(true);
    expect(mergeSettings({ logToFile: true }).logToFile).toBe(true);
    expect(mergeSettings({ trustWorkingDir: 'true' }).trustWorkingDir).toBe(true);
    expect(mergeSettings({ trustWorkingDir: 1 }).trustWorkingDir).toBe(false); // unknown -> default(false)
  });

  it('clamps logMaxSizeMB to 1..1000 and rounds, falling back to 10', () => {
    expect(mergeSettings({ logMaxSizeMB: 0 }).logMaxSizeMB).toBe(1);
    expect(mergeSettings({ logMaxSizeMB: 5000 }).logMaxSizeMB).toBe(1000);
    expect(mergeSettings({ logMaxSizeMB: 12.4 }).logMaxSizeMB).toBe(12);
    expect(mergeSettings({ logMaxSizeMB: 'abc' }).logMaxSizeMB).toBe(10);
    expect(mergeSettings({ logMaxSizeMB: null }).logMaxSizeMB).toBe(10);
  });

  it('sanitizes customPatterns: trims, drops blanks/non-strings, caps count', () => {
    const out = mergeSettings({
      customPatterns: ['  foo  ', '', 7, null, 'bar', '   '],
    });
    expect(out.customPatterns).toEqual(['foo', 'bar']);

    const many = Array.from({ length: 80 }, (_, i) => `p${i}`);
    expect(mergeSettings({ customPatterns: many }).customPatterns.length).toBe(50);
  });

  it('returns [] for a non-array customPatterns', () => {
    expect(mergeSettings({ customPatterns: 'foo' }).customPatterns).toEqual([]);
    expect(mergeSettings({ customPatterns: { 0: 'foo' } }).customPatterns).toEqual([]);
  });
});

describe('compilePatterns', () => {
  it('augments the defaults by default', () => {
    const { patterns, errors } = compilePatterns({
      customPatterns: ['custom limit hit'],
      replaceDefaultPatterns: false,
    });
    expect(errors).toEqual([]);
    expect(patterns.length).toBe(DEFAULT_LIMIT_PATTERNS.length + 1);
    expect(patterns.some((p) => p.test('CUSTOM LIMIT HIT'))).toBe(true); // case-insensitive
    // a default still present
    expect(patterns.some((p) => p.test('usage limit reached'))).toBe(true);
  });

  it('replaces the defaults when asked', () => {
    const { patterns } = compilePatterns({
      customPatterns: ['only this'],
      replaceDefaultPatterns: true,
    });
    expect(patterns.length).toBe(1);
    expect(patterns[0]!.test('ONLY THIS line')).toBe(true);
    expect(patterns.some((p) => p.test('usage limit reached'))).toBe(false);
  });

  it('skips invalid regex and reports the error instead of throwing', () => {
    const { patterns, errors } = compilePatterns({
      customPatterns: ['good', '(unclosed', 'also good'],
      replaceDefaultPatterns: true,
    });
    expect(patterns.length).toBe(2);
    expect(errors.length).toBe(1);
    expect(errors[0]!.source).toBe('(unclosed');
    expect(errors[0]!.message).toBeTruthy();
  });

  it('de-duplicates identical custom sources', () => {
    const { patterns } = compilePatterns({
      customPatterns: ['dup', 'dup', 'dup'],
      replaceDefaultPatterns: true,
    });
    expect(patterns.length).toBe(1);
  });

  it('falls back to defaults if replace is requested with no valid patterns', () => {
    const { patterns } = compilePatterns({
      customPatterns: ['(bad', '[oops'],
      replaceDefaultPatterns: true,
    });
    expect(patterns).toEqual(DEFAULT_LIMIT_PATTERNS);
  });

  it('falls back to defaults for an empty custom list with replace=true', () => {
    const { patterns } = compilePatterns({ customPatterns: [], replaceDefaultPatterns: true });
    expect(patterns).toEqual(DEFAULT_LIMIT_PATTERNS);
  });

  it('rejects catastrophic-backtracking (ReDoS) patterns and reports them', () => {
    const { patterns, errors } = compilePatterns({
      customPatterns: ['(a+)+', '(a*)*', '(.*)+$', '(?:ab+)*', 'usage limit reached'],
      replaceDefaultPatterns: true,
    });
    // only the safe one survives
    expect(patterns.length).toBe(1);
    expect(patterns[0]!.test('usage limit reached')).toBe(true);
    expect(errors.length).toBe(4);
    expect(errors.every((e) => /catastrophic/i.test(e.message))).toBe(true);
  });

  it('allows benign quantified groups (no nested quantifier)', () => {
    const { patterns, errors } = compilePatterns({
      customPatterns: ['(error|warn)+', 'reset at (.+)', 'limit\\d{1,3}'],
      replaceDefaultPatterns: true,
    });
    expect(errors).toEqual([]);
    expect(patterns.length).toBe(3);
  });
});

describe('SettingsStore', () => {
  it('returns defaults when nothing is stored', () => {
    const store = new SettingsStore(memIO(null));
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for corrupt JSON on disk', () => {
    const store = new SettingsStore(memIO('{ not valid json'));
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults if the IO read throws', () => {
    const io: SettingsIO = {
      read() {
        throw new Error('disk gone');
      },
      write() {},
    };
    expect(new SettingsStore(io).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips: save then load yields the cleaned settings', () => {
    const io = memIO();
    const store = new SettingsStore(io);
    const written = store.save({ command: 'claude', strategy: 'replay', safetySec: 90, customPatterns: ['x'] });
    expect(written.strategy).toBe('replay');
    expect(written.safetySec).toBe(90);

    const reloaded = new SettingsStore(io).load();
    expect(reloaded).toEqual(written);
  });

  it('persists a version stamp but does not expose it on the loaded object', () => {
    const io = memIO();
    new SettingsStore(io).save({ command: 'c' });
    expect(io.value).toContain(`"version": ${SETTINGS_VERSION}`);
    const loaded = new SettingsStore(io).load();
    expect(loaded).not.toHaveProperty('version');
  });

  it('save normalizes/clamps invalid input before persisting', () => {
    const io = memIO();
    const written = new SettingsStore(io).save({ safetySec: -99, maxRetries: 9999, strategy: 'bogus' });
    const clean: KeeperSettings = { ...DEFAULT_SETTINGS, safetySec: 0, maxRetries: 100 };
    expect(written).toEqual(clean);
    // nothing invalid leaked onto disk
    expect(io.value).not.toContain('bogus');
    expect(io.value).not.toContain('-99');
  });
});

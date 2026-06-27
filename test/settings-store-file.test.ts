import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSettingsStore } from '../src/main/settings-store';
import { DEFAULT_SETTINGS } from '../src/core/settings';

/**
 * Exercises the real filesystem-backed store (atomic write + read) through the
 * CLAUDE_KEEPER_DATA_DIR override, so we cover the actual persistence path the
 * app uses — not just the in-memory IO seam.
 */
describe('createFileSettingsStore (real fs)', () => {
  let dir: string;
  const prevEnv = process.env['CLAUDE_KEEPER_DATA_DIR'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-settings-'));
    process.env['CLAUDE_KEEPER_DATA_DIR'] = dir;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env['CLAUDE_KEEPER_DATA_DIR'];
    else process.env['CLAUDE_KEEPER_DATA_DIR'] = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns defaults when no file exists yet', () => {
    const store = createFileSettingsStore('/unused/default');
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });

  it('persists to settings.json and round-trips through a fresh store', () => {
    const a = createFileSettingsStore('/unused/default');
    const written = a.save({ command: 'mycli', strategy: 'replay', safetySec: 90, customPatterns: ['x', 'y'] });
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);

    const b = createFileSettingsStore('/unused/default');
    expect(b.load()).toEqual(written);
  });

  it('leaves no .tmp files behind after a write (atomic rename)', () => {
    createFileSettingsStore('/unused/default').save({ command: 'c' });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('recovers to defaults when the file on disk is corrupt', () => {
    writeFileSync(join(dir, 'settings.json'), '{ broken json', 'utf8');
    expect(createFileSettingsStore('/unused/default').load()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to the provided default dir when the env override is unset', () => {
    delete process.env['CLAUDE_KEEPER_DATA_DIR'];
    const def = mkdtempSync(join(tmpdir(), 'ck-default-'));
    try {
      const store = createFileSettingsStore(def);
      store.save({ command: 'fromdefault' });
      expect(JSON.parse(readFileSync(join(def, 'settings.json'), 'utf8')).command).toBe('fromdefault');
    } finally {
      rmSync(def, { recursive: true, force: true });
    }
  });
});

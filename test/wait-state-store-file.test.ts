import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileWaitStore } from '../src/main/wait-state-store';

/**
 * Exercises the real filesystem-backed pending-wait store (atomic write + read +
 * remove) through the CLAUDE_KEEPER_DATA_DIR override, covering the actual
 * persistence path the app uses on restart recovery.
 */
describe('createFileWaitStore (real fs)', () => {
  let dir: string;
  const prevEnv = process.env['CLAUDE_KEEPER_DATA_DIR'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-wait-'));
    process.env['CLAUDE_KEEPER_DATA_DIR'] = dir;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env['CLAUDE_KEEPER_DATA_DIR'];
    else process.env['CLAUDE_KEEPER_DATA_DIR'] = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no wait file exists yet', () => {
    expect(createFileWaitStore('/unused/default').load()).toBeNull();
    expect(existsSync(join(dir, 'pending-wait.json'))).toBe(false);
  });

  it('persists and round-trips through a fresh store', () => {
    const a = createFileWaitStore('/unused/default');
    const saved = a.save({ resetTimeMs: 1234, command: 'claude', strategy: 'replay', replayPrompt: 'go' });
    expect(existsSync(join(dir, 'pending-wait.json'))).toBe(true);

    const b = createFileWaitStore('/unused/default');
    expect(b.load()).toEqual(saved);
  });

  it('clear() deletes the wait file', () => {
    const store = createFileWaitStore('/unused/default');
    store.save({ resetTimeMs: 1, command: 'claude' });
    store.clear();
    expect(existsSync(join(dir, 'pending-wait.json'))).toBe(false);
    expect(store.load()).toBeNull();
  });

  it('leaves no .tmp files behind after a write (atomic rename)', () => {
    createFileWaitStore('/unused/default').save({ resetTimeMs: 0, command: 'c' });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('returns null when the file on disk is corrupt', () => {
    writeFileSync(join(dir, 'pending-wait.json'), '{ broken json', 'utf8');
    expect(createFileWaitStore('/unused/default').load()).toBeNull();
  });

  it('rejects an oversized snapshot file without parsing it', () => {
    // A valid-looking but huge file should be ignored (launch-time DoS guard).
    const huge = '{"command":"claude","savedAtMs":1,"x":"' + 'a'.repeat(300 * 1024) + '"}';
    writeFileSync(join(dir, 'pending-wait.json'), huge, 'utf8');
    expect(createFileWaitStore('/unused/default').load()).toBeNull();
  });

  it('clear() on a missing file is a no-op (no throw)', () => {
    expect(() => createFileWaitStore('/unused/default').clear()).not.toThrow();
  });
});

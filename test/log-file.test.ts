import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSink, createRotatingFileSink, readVerboseFromEnv, resolveDataDir } from '../src/main/log-file';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveDataDir', () => {
  it('returns the default dir when no override is set', () => {
    expect(resolveDataDir('/default', {})).toBe('/default');
  });

  it('prefers CLAUDE_KEEPER_DATA_DIR when set', () => {
    expect(resolveDataDir('/default', { CLAUDE_KEEPER_DATA_DIR: '/override' })).toBe('/override');
  });

  it('falls back to the default for an empty override', () => {
    expect(resolveDataDir('/default', { CLAUDE_KEEPER_DATA_DIR: '' })).toBe('/default');
  });
});

describe('readVerboseFromEnv', () => {
  it('defaults to false with no relevant env vars', () => {
    expect(readVerboseFromEnv({})).toBe(false);
  });

  it('accepts truthy values for CLAUDE_KEEPER_VERBOSE', () => {
    for (const v of ['1', 'true', 'YES', 'On', ' true ']) {
      expect(readVerboseFromEnv({ CLAUDE_KEEPER_VERBOSE: v })).toBe(true);
    }
  });

  it('honors the CLAUDE_KEEPER_DEBUG alias', () => {
    expect(readVerboseFromEnv({ CLAUDE_KEEPER_DEBUG: '1' })).toBe(true);
  });

  it('treats other values as false', () => {
    expect(readVerboseFromEnv({ CLAUDE_KEEPER_VERBOSE: '0' })).toBe(false);
    expect(readVerboseFromEnv({ CLAUDE_KEEPER_VERBOSE: 'nope' })).toBe(false);
  });
});

describe('createFileSink', () => {
  it('appends formatted lines to a log file, creating the dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-log-'));
    tmpDirs.push(dir);
    const sink = createFileSink(join(dir, 'nested'), 'app.log');
    sink({ ts: 0, level: 'info', scope: 's', msg: 'one' }, 'LINE ONE');
    sink({ ts: 0, level: 'info', scope: 's', msg: 'two' }, 'LINE TWO');
    const contents = readFileSync(join(dir, 'nested', 'app.log'), 'utf8');
    expect(contents).toBe('LINE ONE\nLINE TWO\n');
  });

  it('never throws on an unwritable path', () => {
    // A path containing a NUL byte is rejected by the OS; sink must swallow it.
    const sink = createFileSink('\u0000bad');
    expect(() => sink({ ts: 0, level: 'error', scope: 's', msg: 'x' }, 'X')).not.toThrow();
  });
});

describe('createRotatingFileSink', () => {
  const rec = { ts: 0, level: 'info' as const, scope: 's', msg: 'm' };

  it('appends without rotating while under the size limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-rot-'));
    tmpDirs.push(dir);
    const sink = createRotatingFileSink(dir, { fileName: 'r.log', maxBytes: 1000 });
    sink(rec, 'aaaa');
    sink(rec, 'bbbb');
    expect(readFileSync(join(dir, 'r.log'), 'utf8')).toBe('aaaa\nbbbb\n');
    expect(existsSync(join(dir, 'r.log.1'))).toBe(false);
  });

  it('rotates to a .1 backup once the limit would be exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-rot-'));
    tmpDirs.push(dir);
    // Each line "xxxxx\n" is 6 bytes; cap at 10 forces rotation on the 2nd line.
    const sink = createRotatingFileSink(dir, { fileName: 'r.log', maxBytes: 10 });
    sink(rec, 'xxxxx'); // 6 bytes -> active
    sink(rec, 'yyyyy'); // would be 12 -> rotate, then write
    expect(readFileSync(join(dir, 'r.log.1'), 'utf8')).toBe('xxxxx\n');
    expect(readFileSync(join(dir, 'r.log'), 'utf8')).toBe('yyyyy\n');
  });

  it('keeps only a single backup across repeated rotations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-rot-'));
    tmpDirs.push(dir);
    const sink = createRotatingFileSink(dir, { fileName: 'r.log', maxBytes: 10 });
    sink(rec, 'aaaaa');
    sink(rec, 'bbbbb'); // rotate: .1 = aaaaa
    sink(rec, 'ccccc'); // rotate: .1 = bbbbb (aaaaa dropped)
    expect(readFileSync(join(dir, 'r.log.1'), 'utf8')).toBe('bbbbb\n');
    expect(readFileSync(join(dir, 'r.log'), 'utf8')).toBe('ccccc\n');
    expect(existsSync(join(dir, 'r.log.2'))).toBe(false);
  });

  it('accounts for an existing log file on first write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-rot-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'r.log'), 'preexisting-content\n'); // 20 bytes
    const sink = createRotatingFileSink(dir, { fileName: 'r.log', maxBytes: 10 });
    sink(rec, 'zzzzz'); // existing 20 > 10 -> rotate first
    expect(readFileSync(join(dir, 'r.log.1'), 'utf8')).toBe('preexisting-content\n');
    expect(readFileSync(join(dir, 'r.log'), 'utf8')).toBe('zzzzz\n');
  });

  it('never throws on an unwritable path', () => {
    const sink = createRotatingFileSink('\u0000bad');
    expect(() => sink(rec, 'X')).not.toThrow();
  });
});

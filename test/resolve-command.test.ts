import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand, buildSpawnSpec } from '../src/main/resolve-command';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ck-resolve-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, '');
  return p;
}

describe('resolveCommand', () => {
  it('returns null for an empty command', () => {
    expect(resolveCommand('', { env: {}, platform: 'linux' })).toBeNull();
  });

  it('finds a bare name on a POSIX PATH (no extension)', () => {
    const p = touch('claude');
    const got = resolveCommand('claude', { platform: 'linux', env: { PATH: `/nope:${dir}` }, cwd: dir });
    expect(got).toBe(p);
  });

  it('returns null when a bare name is not on PATH', () => {
    expect(resolveCommand('claude', { platform: 'linux', env: { PATH: dir }, cwd: dir })).toBeNull();
  });

  it('applies PATHEXT on win32 and matches case-insensitively', () => {
    const p = touch('claude.CMD');
    const got = resolveCommand('claude', {
      platform: 'win32',
      env: { Path: dir, PATHEXT: '.COM;.EXE;.CMD' },
      cwd: dir,
    });
    expect(got).toBe(p);
  });

  it('matches an already-extensioned win32 name verbatim', () => {
    const p = touch('claude.cmd');
    const got = resolveCommand('claude.cmd', { platform: 'win32', env: { Path: dir, PATHEXT: '.EXE' }, cwd: dir });
    expect(got).toBe(p);
  });

  it('splits PATH on the platform delimiter (win32 = ;)', () => {
    const p = touch('claude.exe');
    const got = resolveCommand('claude', {
      platform: 'win32',
      env: { Path: `C:\\nope;${dir}`, PATHEXT: '.exe' },
      cwd: dir,
    });
    expect(got).toBe(p);
  });

  it('resolves an explicit relative path against cwd without searching PATH', () => {
    const p = touch('tool');
    const got = resolveCommand('./tool', { platform: 'linux', env: { PATH: '/nope' }, cwd: dir });
    expect(got).toBe(p);
  });

  it('honors a case-insensitive PATH key lookup', () => {
    const p = touch('claude');
    // Only lowercase `path` provided — must still be found.
    const got = resolveCommand('claude', { platform: 'linux', env: { path: dir }, cwd: dir });
    expect(got).toBe(p);
  });
});

describe('buildSpawnSpec', () => {
  it('uses the resolved absolute path as the command on POSIX', () => {
    const p = touch('claude');
    const spec = buildSpawnSpec('claude', ['--continue'], { platform: 'linux', env: { PATH: dir }, cwd: dir });
    expect(spec).toEqual({ command: p, args: ['--continue'], resolved: p, wrapped: false });
  });

  it('falls back to the bare command when resolution fails', () => {
    const spec = buildSpawnSpec('claude', ['-x'], { platform: 'linux', env: { PATH: '/nope' }, cwd: dir });
    expect(spec).toEqual({ command: 'claude', args: ['-x'], resolved: null, wrapped: false });
  });

  it('wraps a Windows .cmd target through ComSpec', () => {
    const p = touch('claude.cmd');
    const spec = buildSpawnSpec('claude', ['--continue'], {
      platform: 'win32',
      env: { Path: dir, PATHEXT: '.cmd', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      cwd: dir,
    });
    expect(spec.wrapped).toBe(true);
    expect(spec.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(spec.args).toEqual(['/c', p, '--continue']);
    expect(spec.resolved).toBe(p);
  });

  it('does NOT wrap a Windows .exe target', () => {
    const p = touch('claude.exe');
    const spec = buildSpawnSpec('claude', [], { platform: 'win32', env: { Path: dir, PATHEXT: '.exe' }, cwd: dir });
    expect(spec.wrapped).toBe(false);
    expect(spec.command).toBe(p);
  });

  it('defaults ComSpec to cmd.exe when unset', () => {
    touch('claude.bat');
    const spec = buildSpawnSpec('claude', [], { platform: 'win32', env: { Path: dir, PATHEXT: '.bat' }, cwd: dir });
    expect(spec.command).toBe('cmd.exe');
    expect(spec.args[0]).toBe('/c');
  });
});

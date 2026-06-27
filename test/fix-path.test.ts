import { describe, it, expect, afterAll } from 'vitest';
import {
  mergePaths,
  defaultExtraDirs,
  computeFixedPath,
  fixPath,
} from '../src/main/fix-path';

describe('mergePaths', () => {
  it('appends additions, de-duplicating while preserving order (POSIX)', () => {
    const got = mergePaths('/usr/bin:/bin', ['/opt/homebrew/bin', '/bin', '/usr/bin'], 'linux');
    expect(got).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('drops empty segments and trims whitespace', () => {
    const got = mergePaths('/usr/bin:: /bin ', ['', '/x'], 'linux');
    expect(got).toBe('/usr/bin:/bin:/x');
  });

  it('handles an empty base', () => {
    expect(mergePaths('', ['/a', '/b'], 'linux')).toBe('/a:/b');
    expect(mergePaths(undefined, ['/a'], 'linux')).toBe('/a');
  });

  it('uses the platform delimiter (win32 = ;)', () => {
    const got = mergePaths('C:\\Windows', ['C:\\extra', 'C:\\Windows'], 'win32');
    expect(got).toBe('C:\\Windows;C:\\extra');
  });

  it('is case-sensitive on POSIX (distinct entries kept)', () => {
    expect(mergePaths('/Bin', ['/bin'], 'linux')).toBe('/Bin:/bin');
  });
});

describe('defaultExtraDirs', () => {
  it('returns nothing on win32', () => {
    expect(defaultExtraDirs('win32', 'C:\\Users\\x')).toEqual([]);
  });

  it('includes homebrew and home bin dirs on darwin', () => {
    const dirs = defaultExtraDirs('darwin', '/Users/me');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/Users/me/.local/bin');
  });

  it('omits home-relative dirs when home is empty', () => {
    const dirs = defaultExtraDirs('linux', '');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs.some((d) => d.includes('.local'))).toBe(false);
  });
});

describe('computeFixedPath', () => {
  it('is a no-op on win32', () => {
    const r = computeFixedPath({
      platform: 'win32',
      env: { Path: 'C:\\Windows' },
      home: 'C:\\Users\\x',
      probeShellPath: () => 'SHOULD_NOT_BE_USED',
    });
    expect(r.changed).toBe(false);
    expect(r.after).toBe('C:\\Windows');
    expect(r.usedShell).toBe(false);
  });

  it('prefers the login-shell PATH as the base when the probe succeeds', () => {
    const r = computeFixedPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      home: '/Users/me',
      probeShellPath: (shell) => {
        expect(shell).toBe('/bin/zsh');
        return '/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin';
      },
    });
    expect(r.usedShell).toBe(true);
    expect(r.changed).toBe(true);
    // Shell PATH leads; claude's dir (~/.local/bin) is now present up front.
    expect(r.after.startsWith('/Users/me/.local/bin:/opt/homebrew/bin')).toBe(true);
  });

  it('falls back to current PATH + default dirs when the probe fails', () => {
    const r = computeFixedPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      home: '/Users/me',
      probeShellPath: () => null,
    });
    expect(r.usedShell).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.after.split(':')).toContain('/opt/homebrew/bin');
    expect(r.after.split(':')).toContain('/Users/me/.local/bin');
    // Original entries are preserved at the front.
    expect(r.after.startsWith('/usr/bin:/bin')).toBe(true);
  });

  it('reports no change when shell PATH already contains every fallback dir', () => {
    const full = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/Users/me/.local/bin',
      '/Users/me/bin',
      '/Users/me/.npm-global/bin',
      '/Users/me/.volta/bin',
      '/Users/me/.asdf/shims',
      '/Users/me/.bun/bin',
      '/Users/me/.deno/bin',
    ].join(':');
    const r = computeFixedPath({
      platform: 'darwin',
      env: { PATH: full, SHELL: '/bin/zsh' },
      home: '/Users/me',
      probeShellPath: () => full,
    });
    expect(r.changed).toBe(false);
    expect(r.after).toBe(full);
  });

  it('defaults SHELL to /bin/bash when unset', () => {
    let seen = '';
    computeFixedPath({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      home: '/home/me',
      probeShellPath: (shell) => {
        seen = shell;
        return null;
      },
    });
    expect(seen).toBe('/bin/bash');
  });
});

describe('fixPath (mutating)', () => {
  const ORIGINAL = process.env['PATH'];
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env['PATH'];
    else process.env['PATH'] = ORIGINAL;
  });

  it('mutates process.env.PATH when changed', () => {
    process.env['PATH'] = '/usr/bin:/bin';
    const r = fixPath({
      platform: 'linux',
      env: process.env,
      home: '/home/me',
      probeShellPath: () => '/home/me/.local/bin:/usr/bin:/bin',
    });
    expect(r.changed).toBe(true);
    expect(process.env['PATH']).toBe(r.after);
    expect(process.env['PATH']!.split(':')).toContain('/home/me/.local/bin');
  });

  it('leaves process.env.PATH untouched on win32', () => {
    const before = process.env['PATH'];
    const r = fixPath({ platform: 'win32', env: process.env });
    expect(r.changed).toBe(false);
    expect(process.env['PATH']).toBe(before);
  });
});

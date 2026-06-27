/**
 * Repair PATH for GUI-launched apps on macOS/Linux.
 *
 * When an app is started from Finder/Dock (macOS) or a `.desktop` entry/AppImage
 * (Linux) rather than from a terminal, it does NOT inherit the login shell's
 * environment. `process.env.PATH` is the bare system PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so user-installed tools — Homebrew
 * (`/opt/homebrew/bin`), npm-global, `~/.local/bin`, asdf/volta shims, etc. —
 * are invisible. A bare command like `claude` then fails to resolve even though
 * it runs fine in the user's terminal. This is NOT a node-pty quirk: node-pty
 * launches via the OS with whatever PATH we hand it, and that PATH is already
 * truncated before any PTY is created.
 *
 * The fix (same approach as sindresorhus/fix-path): ask the user's login shell
 * what its PATH actually is and merge it into `process.env.PATH`, plus a set of
 * well-known fallback bin directories in case the shell probe fails. Windows GUI
 * launches inherit the full user/system PATH, so this is a no-op there.
 *
 * Pure where it matters: the merge logic and shell probing are split and fully
 * injectable so the behavior is unit-tested deterministically on any host OS.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

export interface FixPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /**
   * Injectable login-shell PATH probe. Returns the shell's `$PATH` string, or
   * null if it could not be obtained. Defaults to {@link readLoginShellPath}.
   */
  probeShellPath?: (shell: string, opts: { home: string }) => string | null;
}

/** Unique sentinel that brackets the PATH we print, isolating it from rc noise. */
const MARKER = '__CK_PATH_8f3a__';

/**
 * Well-known per-user/system bin directories that GUI launches commonly miss.
 * Used as a safety net merged on top of the (preferred) login-shell PATH, so the
 * common case still works even when the shell probe fails or times out.
 */
export function defaultExtraDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') return [];
  const dirs = [
    '/opt/homebrew/bin', // Apple-silicon Homebrew
    '/opt/homebrew/sbin',
    '/usr/local/bin', // Intel Homebrew / common installs
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  if (home) {
    dirs.push(
      `${home}/.local/bin`, // pipx, user installs
      `${home}/bin`,
      `${home}/.npm-global/bin`, // npm prefix=~/.npm-global
      `${home}/.volta/bin`, // Volta
      `${home}/.asdf/shims`, // asdf
      `${home}/.bun/bin`, // Bun
      `${home}/.deno/bin`, // Deno
    );
  }
  return dirs;
}

/**
 * Merge `base` PATH with `additions`, de-duplicating while preserving order
 * (base entries win their position; new additions are appended). POSIX paths are
 * case-sensitive, so comparison is exact. Empty segments are dropped.
 */
export function mergePaths(
  base: string | undefined,
  additions: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const delim = platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (seg: string): void => {
    const s = seg.trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const seg of (base ?? '').split(delim)) add(seg);
  for (const seg of additions) add(seg);
  return out.join(delim);
}

/**
 * Probe the user's login shell for its real PATH. Runs the shell as a
 * login+interactive shell (`-ilc`) so it sources the same rc/profile files a
 * terminal would, then prints `$PATH` bracketed by a sentinel we can extract
 * even if the rc files emit banners. Impure; returns null on any failure
 * (missing shell, non-zero exit, timeout) so callers fall back to defaults.
 */
export function readLoginShellPath(
  shell: string,
  opts: { home: string } = { home: homedir() },
): string | null {
  try {
    const script = `printf '%s' "${MARKER}$PATH${MARKER}"`;
    const stdout = execFileSync(shell, ['-ilc', script], {
      encoding: 'utf8',
      timeout: 5000,
      // A login shell may try to read from the tty; give it no stdin and capture
      // stdout/stderr so it can't hang or pollute our streams.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: opts.home },
    });
    const start = stdout.indexOf(MARKER);
    const end = stdout.indexOf(MARKER, start + MARKER.length);
    if (start === -1 || end === -1) return null;
    const path = stdout.slice(start + MARKER.length, end);
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export interface FixPathResult {
  /** PATH value before any change. */
  before: string;
  /** PATH value after merging the shell PATH + fallback dirs. */
  after: string;
  /** True when `after` differs from `before`. */
  changed: boolean;
  /** True when the login-shell probe yielded a usable PATH. */
  usedShell: boolean;
  /** The login shell that was probed (empty on Windows / when skipped). */
  shell: string;
}

/**
 * Compute the repaired PATH without mutating anything. On Windows this is a
 * no-op (GUI launches already inherit the full PATH). Elsewhere it prefers the
 * login-shell PATH and appends well-known fallback dirs, de-duplicated.
 */
export function computeFixedPath(opts: FixPathOptions = {}): FixPathResult {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const before = env['PATH'] ?? env['Path'] ?? '';

  if (platform === 'win32') {
    return { before, after: before, changed: false, usedShell: false, shell: '' };
  }

  const shell = env['SHELL'] || '/bin/bash';
  const probe = opts.probeShellPath ?? readLoginShellPath;
  const shellPath = probe(shell, { home });

  // Prefer the shell PATH as the base (it reflects the user's real setup), then
  // append our fallback dirs. If the probe failed, start from the current PATH.
  const base = shellPath ?? before;
  const after = mergePaths(base, defaultExtraDirs(platform, home), platform);

  return {
    before,
    after,
    changed: after !== before,
    usedShell: shellPath !== null,
    shell,
  };
}

/**
 * Repair `process.env.PATH` in place for GUI-launched macOS/Linux apps and
 * return what happened (for logging). Idempotent and safe to call once at
 * startup before any child process / PTY is spawned.
 */
export function fixPath(opts: FixPathOptions = {}): FixPathResult {
  const result = computeFixedPath(opts);
  if (result.changed) {
    process.env['PATH'] = result.after;
    // Some POSIX tooling reads `Path`; keep them consistent if it was set.
    if (process.env['Path'] !== undefined) process.env['Path'] = result.after;
  }
  return result;
}

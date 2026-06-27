/**
 * Cross-platform command resolution for the PTY launcher.
 *
 * node-pty launches via the OS directly (no shell), so a bare command name like
 * `claude` must be resolved against PATH ourselves to (a) give an actionable
 * error when it isn't found and (b) handle the Windows case where the resolved
 * target is a batch script (`.cmd`/`.bat`) — those are NOT PE executables and
 * cannot be CreateProcess'd directly, which surfaces as a cryptic non-zero exit
 * (commonly code 1). On Windows such targets are wrapped through `ComSpec`
 * (`cmd.exe /c …`), exactly like npm/npx do.
 *
 * Pure and Electron-free; platform/env/cwd are injectable so the logic is unit-
 * tested identically for win32 and POSIX regardless of the host OS.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Look up an env var case-insensitively (Windows uses `Path`/`PATHEXT`/`ComSpec`). */
function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Candidate extensions to try, in order. POSIX only ever tries the name as-is. */
function extCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [''];
  const pathext = (getEnv(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  // '' first so an already-extensioned name (claude.cmd) matches verbatim.
  return ['', ...pathext];
}

function hasPathSeparator(command: string, platform: NodeJS.Platform): boolean {
  return command.includes('/') || (platform === 'win32' && command.includes('\\'));
}

/**
 * Resolve `command` to an absolute file path, or `null` if it cannot be found.
 * Mirrors OS lookup rules: explicit paths are resolved against `cwd`; bare names
 * are searched across each PATH entry, applying PATHEXT on Windows.
 */
export function resolveCommand(command: string, opts: ResolveOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const name = command.trim();
  if (!name) return null;

  const exts = extCandidates(platform, env);

  // Explicit path (absolute or containing a separator): resolve against cwd and
  // probe the extension candidates directly — no PATH search.
  if (isAbsolute(name) || hasPathSeparator(name, platform)) {
    const base = resolvePath(cwd, name);
    for (const ext of exts) {
      const candidate = base + ext;
      if (isFile(candidate)) return candidate;
    }
    return null;
  }

  // Bare name: search PATH. Use the platform's own delimiter so a win32 PATH is
  // split on ';' even when this code runs on a POSIX host (and vice versa).
  const delim = platform === 'win32' ? ';' : ':';
  const pathVar = getEnv(env, 'PATH') ?? '';
  for (const rawDir of pathVar.split(delim)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1'); // strip surrounding quotes
    if (!dir) continue;
    const base = resolvePath(dir, name);
    for (const ext of exts) {
      const candidate = base + ext;
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export interface SpawnSpec {
  /** The executable to hand to the PTY. */
  command: string;
  /** Final argv for the executable. */
  args: string[];
  /** Absolute resolved path of the user's command, or null if unresolved. */
  resolved: string | null;
  /** True when wrapped through ComSpec because the target is a Windows script. */
  wrapped: boolean;
}

/** True when a resolved Windows target must be run via cmd.exe (`.cmd`/`.bat`). */
function isWindowsScript(resolved: string | null, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && resolved !== null && /\.(cmd|bat)$/i.test(resolved);
}

/**
 * Decide exactly how to spawn `command args`: resolve it on PATH, and on Windows
 * wrap batch scripts through `cmd.exe /c`. Falls back to the original (bare)
 * command when resolution fails, so node-pty can still try (and we enrich its
 * error elsewhere). Pure + injectable for cross-platform testing.
 */
export function buildSpawnSpec(
  command: string,
  args: string[],
  opts: ResolveOptions = {},
): SpawnSpec {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const resolved = resolveCommand(command, opts);

  if (isWindowsScript(resolved, platform)) {
    const comspec = getEnv(env, 'ComSpec') || 'cmd.exe';
    return { command: comspec, args: ['/c', resolved as string, ...args], resolved, wrapped: true };
  }
  return { command: resolved ?? command, args, resolved, wrapped: false };
}

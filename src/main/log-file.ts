/**
 * Electron-main wiring for the shared logger: a console sink, an append-only
 * file sink under the app's data directory, and the configuration knob that
 * decides whether verbose (`debug`) logging is on.
 *
 * Verbose logging is OFF by default. Turn it on with the `CLAUDE_KEEPER_VERBOSE`
 * (or `CLAUDE_KEEPER_DEBUG`) environment variable set to a truthy value
 * (`1`/`true`/`yes`/`on`). Basic `info`/`warn`/`error` milestones are always
 * written so a plain run still leaves a useful trail in `claude-keeper.log`.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogRecord, LogSink } from '../core/logger';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Resolve the directory app data (including the log file) lives in. Mirrors the
 * settings/wait stores: `CLAUDE_KEEPER_DATA_DIR` overrides the per-OS default
 * (`app.getPath('userData')`) so every artifact stays together under one root
 * for tests and sandboxed runs.
 */
export function resolveDataDir(defaultDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_KEEPER_DATA_DIR'] || defaultDir;
}

/** Decide the verbose flag from the environment. Defaults to false. */
export function readVerboseFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['CLAUDE_KEEPER_VERBOSE'] ?? env['CLAUDE_KEEPER_DEBUG'] ?? '';
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** Console sink: warnings/errors to stderr, everything else to stdout. */
export const consoleSink: LogSink = (record: LogRecord, formatted: string): void => {
  if (record.level === 'error' || record.level === 'warn') console.error(formatted);
  else console.log(formatted);
};

/**
 * Append-only file sink. Best-effort: filesystem errors are swallowed so logging
 * can never take the app down. The target file lives at
 * `<dir>/<fileName>` (default `<dir>/claude-keeper.log`).
 */
export function createFileSink(dir: string, fileName = 'claude-keeper.log'): LogSink {
  const target = join(dir, fileName);
  let dirReady = false;
  return (_record: LogRecord, formatted: string): void => {
    try {
      if (!dirReady) {
        mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      appendFileSync(target, `${formatted}\n`);
    } catch {
      /* best-effort: never let logging failures break the app */
    }
  };
}

/** Default rotation threshold (10 MB) when none is supplied. */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface RotatingFileSinkOptions {
  fileName?: string;
  /** Rotate once the active file would exceed this many bytes. */
  maxBytes?: number;
}

/**
 * Append-only file sink that rotates by size. When the active file would grow
 * past `maxBytes`, it is renamed to `<file>.1` (replacing any previous backup)
 * and a fresh active file is started — so on-disk usage stays bounded at roughly
 * `2 × maxBytes` (current + one backup). Best-effort: every filesystem error is
 * swallowed so logging can never take the app down.
 */
export function createRotatingFileSink(dir: string, opts: RotatingFileSinkOptions = {}): LogSink {
  const fileName = opts.fileName ?? 'claude-keeper.log';
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_LOG_MAX_BYTES;
  const target = join(dir, fileName);
  const backup = `${target}.1`;
  let dirReady = false;
  // Track size in-process so we don't stat() on every line; seeded from disk on
  // first write so an existing file is accounted for across restarts.
  let size = -1;

  const currentSize = (): number => {
    try {
      return statSync(target).size;
    } catch {
      return 0; // missing file => empty
    }
  };

  return (_record: LogRecord, formatted: string): void => {
    try {
      if (!dirReady) {
        mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      if (size < 0) size = currentSize();
      const line = `${formatted}\n`;
      const lineBytes = Buffer.byteLength(line);
      // Rotate before writing if this line would push us over the threshold, but
      // never rotate away a brand-new empty file (a single huge line still lands).
      if (size > 0 && size + lineBytes > maxBytes) {
        try {
          rmSync(backup, { force: true });
          renameSync(target, backup);
        } catch {
          /* if rotation fails, fall through and keep appending to the active file */
        }
        size = 0;
      }
      appendFileSync(target, line);
      size += lineBytes;
    } catch {
      /* best-effort: never let logging failures break the app */
    }
  };
}

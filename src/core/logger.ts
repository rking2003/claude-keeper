/**
 * Tiny, Electron-free leveled logger shared by the core state machine and the
 * Electron main process.
 *
 * Two tiers, controlled by a single `verbose` flag:
 *   - **Basic** (`error` / `warn` / `info`): always emitted once a sink is
 *     configured. These are the milestones you want even in normal operation —
 *     "session starting", "pty spawned (pid …)", "process exited (code …)".
 *   - **Verbose** (`debug`): emitted ONLY when verbose logging is enabled. These
 *     are the high-volume, decision-level details (state transitions, fresh-
 *     fallback reasoning, per-chunk sizes) you turn on to diagnose a problem.
 *
 * Nothing is printed until {@link configureLogger} installs at least one sink,
 * so importing this module in unit tests (or in the pure core) stays silent.
 * The main process wires a console sink plus a rotating-free append-only file
 * sink and decides `verbose` from configuration (see `src/main/log-file.ts`).
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogRecord {
  /** Epoch milliseconds when the record was created. */
  ts: number;
  level: LogLevel;
  /** Short subsystem tag, e.g. `main`, `session`, `pty`. */
  scope: string;
  msg: string;
  /** Optional structured context, rendered as compact JSON. */
  data?: unknown;
}

/** A destination for formatted log lines (console, file, in-memory test buffer). */
export type LogSink = (record: LogRecord, formatted: string) => void;

let verbose = false;
let sinks: LogSink[] = [];

/**
 * Install sinks and/or set the verbose flag. Replaces the current sink list when
 * `sinks` is provided. Call once during app startup; safe to call again to
 * toggle verbosity at runtime.
 */
export function configureLogger(opts: { verbose?: boolean; sinks?: LogSink[] }): void {
  if (typeof opts.verbose === 'boolean') verbose = opts.verbose;
  if (opts.sinks) sinks = [...opts.sinks];
}

/** Enable/disable verbose (`debug`) output at runtime without touching sinks. */
export function setVerbose(value: boolean): void {
  verbose = value;
}

/** Whether verbose (`debug`) logging is currently enabled. */
export function isVerbose(): boolean {
  return verbose;
}

/** Remove all sinks and reset verbosity. Primarily for test isolation. */
export function resetLogger(): void {
  verbose = false;
  sinks = [];
}

/** JSON-stringify arbitrary context defensively (handles cycles / BigInt / Errors). */
function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v as unknown;
    });
  } catch {
    return String(value);
  }
}

/** Render a record as a single, grep-friendly line. */
export function formatRecord(r: LogRecord): string {
  const time = new Date(r.ts).toISOString();
  const level = r.level.toUpperCase().padEnd(5);
  let line = `${time} ${level} [${r.scope}] ${r.msg}`;
  if (r.data !== undefined) line += ` ${safeStringify(r.data)}`;
  return line;
}

function emit(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  // Verbose-only records are dropped entirely unless verbose is enabled, so they
  // cost nothing (beyond the call) in normal operation.
  if (level === 'debug' && !verbose) return;
  if (sinks.length === 0) return;
  const record: LogRecord = { ts: Date.now(), level, scope, msg };
  if (data !== undefined) record.data = data;
  const formatted = formatRecord(record);
  for (const sink of sinks) {
    try {
      sink(record, formatted);
    } catch {
      /* a failing sink must never break the app it is observing */
    }
  }
}

/** Scoped logging surface. `debug` is the only verbose-gated method. */
export interface ScopedLogger {
  error(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  /** Verbose-only: emitted solely when verbose logging is enabled. */
  debug(msg: string, data?: unknown): void;
  /** Derive a logger with a nested scope, e.g. `main` -> `main:session`. */
  child(subScope: string): ScopedLogger;
}

/** Create a logger bound to a subsystem `scope`. */
export function createLogger(scope: string): ScopedLogger {
  return {
    error: (msg, data) => emit('error', scope, msg, data),
    warn: (msg, data) => emit('warn', scope, msg, data),
    info: (msg, data) => emit('info', scope, msg, data),
    debug: (msg, data) => emit('debug', scope, msg, data),
    child: (subScope) => createLogger(`${scope}:${subScope}`),
  };
}

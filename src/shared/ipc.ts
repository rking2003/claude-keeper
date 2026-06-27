import type { ControllerEvent } from '@core/session-controller';
import type { SessionState } from '@core/state';

/** Re-exported so preload/renderer can type settings without reaching into core. */
export type { KeeperSettings, PatternError } from '@core/settings';

import type { KeeperSettings as _KeeperSettings, PatternError as _PatternError } from '@core/settings';

/**
 * Result of persisting settings: the cleaned/clamped settings plus any custom
 * limit-pattern regexes that failed to compile, so the renderer can warn the
 * user that those patterns were dropped instead of silently ignoring them.
 */
export interface SettingsSaveResult {
  settings: _KeeperSettings;
  patternErrors: _PatternError[];
}

/** IPC channel names shared by main, preload, and renderer. */
export const IPC = {
  sessionStart: 'session:start',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionStop: 'session:stop',
  sessionResumeNow: 'session:resumeNow',
  sessionSetAutoResume: 'session:setAutoResume',
  sessionReady: 'session:ready',
  sessionEvent: 'session:event',
  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',
  logsOpen: 'logs:open',
  logWrite: 'log:write',
} as const;

/** A diagnostic log line forwarded from the renderer to the main-process log. */
export interface RendererLogPayload {
  level: 'error' | 'warn' | 'info' | 'debug';
  msg: string;
  data?: unknown;
}

/** Renderer's request to start a session. Omitting `command` defaults to `claude`. */
export interface SessionStartConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  /** The prompt typed (plus Enter) into the session when the wait ends. */
  resumePrompt?: string;
  autoResume?: boolean;
  verifyWindowMs?: number;
  safetyBufferMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  cols?: number;
  rows?: number;
  /** User-supplied limit-detection regex sources (compiled in main). */
  customPatterns?: string[];
  /** When true, customPatterns replace the built-in defaults instead of augmenting. */
  replaceDefaultPatterns?: boolean;
  /**
   * Launch with the directory-trust prompt bypassed (`--dangerously-skip-permissions`).
   * Sourced from the persisted setting OR a one-time in-app consent.
   */
  trustWorkingDir?: boolean;
}

/**
 * Wire-friendly variant of {@link ControllerEvent}: identical except the `limit`
 * event carries `resetTimeMs` (epoch millis) instead of a `Date`, so it survives
 * IPC structured-clone unambiguously and is trivial for the renderer to format.
 */
export type SessionWireEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'data'; data: string }
  | { type: 'limit'; resetTimeMs: number | null; matchedText: string }
  | { type: 'countdown'; remainingMs: number; targetMs: number }
  | { type: 'resuming'; attempt: number }
  | { type: 'resumed' }
  | { type: 'notice'; message: string }
  | { type: 'untrusted'; message: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; exitCode: number };

/** Convert a controller event into its serializable wire form. */
export function toWireEvent(ev: ControllerEvent): SessionWireEvent {
  if (ev.type === 'limit') {
    return {
      type: 'limit',
      resetTimeMs: ev.resetTime ? ev.resetTime.getTime() : null,
      matchedText: ev.matchedText,
    };
  }
  return ev;
}

/**
 * Split the single-line `args` settings string into argv. Used by the renderer
 * when starting a session *and* by main when validating a recovered snapshot, so
 * the two parse identically and never drift. Whitespace-separated; a blank string
 * yields no args. (No shell quoting — matching the plain Settings args field.)
 */
export function parseArgsString(args: string): string[] {
  const trimmed = args.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

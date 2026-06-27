/**
 * SettingsStore — pure, Electron-free persistence + validation for user
 * settings. The store is given an injectable {@link SettingsIO} (a tiny
 * read/write seam) so it can be unit-tested without touching the filesystem;
 * the main process wires it to a JSON file under `app.getPath('userData')`.
 *
 * Everything here is defensive: settings on disk are untrusted (a user — or a
 * future/older app version — may have written anything), so {@link mergeSettings}
 * coerces, clamps, and drops unknown keys, always returning a complete,
 * well-typed {@link KeeperSettings}. {@link compilePatterns} turns user-supplied
 * regex source strings into real {@link RegExp}s, skipping (and reporting) any
 * that fail to compile so one bad pattern can never crash detection.
 */

import { DEFAULT_LIMIT_PATTERNS } from './limit-detector';

/** The prompt typed into the session (plus Enter) to resume work after a reset. */
export const DEFAULT_RESUME_PROMPT = 'continue';

/**
 * Make the resume prompt safe to write verbatim to the PTY. It is written as raw
 * keystrokes followed by a single CR, so any embedded C0/C1 control character —
 * most importantly CR/LF (which the TUI treats as Enter) or ESC (which begins a
 * terminal control sequence) — would multi-submit fragments or inject escape
 * codes during an *unattended* resume. Collapse every such byte to a space and
 * trim; an empty result falls back to {@link DEFAULT_RESUME_PROMPT}.
 */
export function sanitizeResumePrompt(text: string | null | undefined): string {
  const clean = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  return clean.length > 0 ? clean : DEFAULT_RESUME_PROMPT;
}

export interface KeeperSettings {
  /** The CLI to launch. Empty is coerced to 'claude'. */
  command: string;
  /** Raw argument string (space-split at launch time by the caller). */
  args: string;
  /** Working directory; empty means "app default". */
  cwd: string;
  /** The prompt typed (plus Enter) into the session when the wait ends. */
  resumePrompt: string;
  autoResume: boolean;
  /** Seconds of safety buffer added after the parsed reset time. */
  safetySec: number;
  /** Fallback poll interval (minutes) when no reset time can be parsed. */
  pollMin: number;
  /** Max resume attempts before surfacing an error. */
  maxRetries: number;
  /** Extra user-supplied limit-detection patterns (regex source strings). */
  customPatterns: string[];
  /**
   * When true the {@link customPatterns} REPLACE the built-in defaults;
   * when false (default) they augment them.
   */
  replaceDefaultPatterns: boolean;
  /** Enable verbose (debug-level) diagnostic logging. Off by default. */
  verboseLogging: boolean;
  /**
   * Write logs to a file on disk. OFF by default — the log file is only created
   * and appended to once this is switched on.
   */
  logToFile: boolean;
  /** Max size (in MB) the log file may reach before it is rotated. */
  logMaxSizeMB: number;
  /**
   * Launch the CLI with the directory-trust prompt bypassed (Claude's
   * `--dangerously-skip-permissions`). OFF by default; only enable for folders
   * you trust, since it also skips tool-permission prompts.
   */
  trustWorkingDir: boolean;
}

/** Bumped when the on-disk shape changes in a non-back-compatible way. */
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: KeeperSettings = {
  command: 'claude',
  args: '',
  cwd: '',
  resumePrompt: DEFAULT_RESUME_PROMPT,
  autoResume: true,
  safetySec: 60,
  pollMin: 5,
  maxRetries: 5,
  customPatterns: [],
  replaceDefaultPatterns: false,
  verboseLogging: false,
  logToFile: false,
  logMaxSizeMB: 10,
  trustWorkingDir: false,
};

/** Inclusive integer bounds + fallback for each numeric setting. */
const NUM_BOUNDS = {
  safetySec: { min: 0, max: 3600, def: 60 },
  pollMin: { min: 1, max: 1440, def: 5 },
  maxRetries: { min: 0, max: 100, def: 5 },
  logMaxSizeMB: { min: 1, max: 1000, def: 10 },
} as const;

/** Hard cap on the number of custom patterns we will retain / compile. */
const MAX_CUSTOM_PATTERNS = 50;
/** Hard cap on a single pattern's source length (defensive against junk). */
const MAX_PATTERN_LEN = 500;
/** Hard cap on the resume prompt length (it is typed verbatim into the PTY). */
export const MAX_RESUME_PROMPT_LEN = 500;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce to a finite integer within [min,max]; otherwise return `def`. */
function clampInt(value: unknown, bounds: { min: number; max: number; def: number }): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
  } else {
    return bounds.def; // null, [], {}, '', boolean, undefined -> default (not 0)
  }
  if (!Number.isFinite(n)) return bounds.def;
  const i = Math.round(n);
  if (i < bounds.min) return bounds.min;
  if (i > bounds.max) return bounds.max;
  return i;
}

function coerceBool(value: unknown, def: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return def;
}

function coerceString(value: unknown, def: string): string {
  return typeof value === 'string' ? value : def;
}

/** Normalize an arbitrary value into a clean `string[]` of pattern sources. */
function coercePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, MAX_PATTERN_LEN));
    if (out.length >= MAX_CUSTOM_PATTERNS) break;
  }
  return out;
}

/**
 * Merge untrusted input over the defaults, validating/clamping every field.
 * Always returns a complete {@link KeeperSettings}. Accepts a possible
 * `{ version, ... }` wrapper (the extra key is simply ignored).
 */
export function mergeSettings(input: unknown): KeeperSettings {
  if (!isObject(input)) return { ...DEFAULT_SETTINGS };

  const command = coerceString(input['command'], DEFAULT_SETTINGS.command).trim();
  const resumePrompt = coerceString(input['resumePrompt'], DEFAULT_SETTINGS.resumePrompt)
    .trim()
    .slice(0, MAX_RESUME_PROMPT_LEN);

  return {
    command: command || 'claude',
    args: coerceString(input['args'], DEFAULT_SETTINGS.args),
    cwd: coerceString(input['cwd'], DEFAULT_SETTINGS.cwd),
    resumePrompt: resumePrompt || DEFAULT_RESUME_PROMPT,
    autoResume: coerceBool(input['autoResume'], DEFAULT_SETTINGS.autoResume),
    safetySec: clampInt(input['safetySec'], NUM_BOUNDS.safetySec),
    pollMin: clampInt(input['pollMin'], NUM_BOUNDS.pollMin),
    maxRetries: clampInt(input['maxRetries'], NUM_BOUNDS.maxRetries),
    customPatterns: coercePatterns(input['customPatterns']),
    replaceDefaultPatterns: coerceBool(input['replaceDefaultPatterns'], DEFAULT_SETTINGS.replaceDefaultPatterns),
    verboseLogging: coerceBool(input['verboseLogging'], DEFAULT_SETTINGS.verboseLogging),
    logToFile: coerceBool(input['logToFile'], DEFAULT_SETTINGS.logToFile),
    logMaxSizeMB: clampInt(input['logMaxSizeMB'], NUM_BOUNDS.logMaxSizeMB),
    trustWorkingDir: coerceBool(input['trustWorkingDir'], DEFAULT_SETTINGS.trustWorkingDir),
  };
}

export interface PatternError {
  source: string;
  message: string;
}

export interface CompiledPatterns {
  patterns: RegExp[];
  errors: PatternError[];
}

/**
 * Conservative heuristic that rejects regex sources prone to catastrophic
 * backtracking (ReDoS): a quantified group whose body also contains an
 * unbounded quantifier — e.g. `(a+)+`, `(a*)*`, `(.*)+`, `(?:ab+)*`. Limit
 * detection runs these synchronously against streamed terminal output in the
 * Electron main process, so a single bad user pattern could otherwise freeze
 * the whole app. This is intentionally strict and best-effort (it does not
 * model deeply nested groups); risky patterns are reported, not executed.
 */
export function isPotentiallyCatastrophic(source: string): boolean {
  const s = source.replace(/\\./g, ''); // drop escaped chars so \( \+ don't fool the scan
  const quantifiedGroup = /\(([^()]*)\)\s*(?:[*+]|\{\d+,\d*\})/g;
  let m: RegExpExecArray | null;
  while ((m = quantifiedGroup.exec(s)) !== null) {
    const body = m[1] ?? '';
    if (/[*+]|\{\d+,\d*\}/.test(body)) return true;
  }
  return false;
}

/**
 * Build the effective limit-detection pattern list from settings. Custom
 * sources are compiled case-insensitively; sources that fail to compile OR look
 * prone to catastrophic backtracking are skipped and reported in `errors`
 * rather than thrown/executed. If the result would be empty (e.g.
 * `replaceDefaultPatterns` with no valid custom patterns), falls back to the
 * built-in defaults so detection can never silently become a no-op.
 */
export function compilePatterns(
  s: Pick<KeeperSettings, 'customPatterns' | 'replaceDefaultPatterns'>,
): CompiledPatterns {
  const errors: PatternError[] = [];
  const custom: RegExp[] = [];
  const seen = new Set<string>();

  for (const src of s.customPatterns) {
    const trimmed = src.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (isPotentiallyCatastrophic(trimmed)) {
      errors.push({ source: trimmed, message: 'rejected: pattern may cause catastrophic backtracking (nested quantifier)' });
      continue;
    }
    try {
      custom.push(new RegExp(trimmed, 'i'));
    } catch (e) {
      errors.push({ source: trimmed, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const base = s.replaceDefaultPatterns ? [] : [...DEFAULT_LIMIT_PATTERNS];
  let patterns = [...base, ...custom];
  if (patterns.length === 0) patterns = [...DEFAULT_LIMIT_PATTERNS];

  return { patterns, errors };
}

/** Minimal storage seam so the store is filesystem-agnostic and testable. */
export interface SettingsIO {
  /** Return the persisted contents, or null if nothing is stored yet. */
  read(): string | null;
  /** Persist the given serialized contents. */
  write(contents: string): void;
}

export class SettingsStore {
  constructor(private readonly io: SettingsIO) {}

  /** Load + validate persisted settings, falling back to defaults on any error. */
  load(): KeeperSettings {
    let raw: string | null;
    try {
      raw = this.io.read();
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
    if (!raw) return { ...DEFAULT_SETTINGS };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
    return mergeSettings(parsed);
  }

  /**
   * Validate + persist settings. Returns the cleaned object that was written
   * (so callers can adopt the normalized values). Never persists raw,
   * unvalidated input.
   */
  save(input: unknown): KeeperSettings {
    const clean = mergeSettings(input);
    this.io.write(JSON.stringify({ version: SETTINGS_VERSION, ...clean }, null, 2));
    return clean;
  }
}

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { sanitizeEnv } from './pty-host';
import { SessionController } from '../core/session-controller';
import { ResumeScheduler } from '../core/resume-scheduler';
import { compilePatterns, mergeSettings } from '../core/settings';
import { isWaitFresh, clampOptInt, SESSION_LIMIT_BOUNDS } from '../core/wait-state';
import { createFileSettingsStore } from './settings-store';
import { createFileWaitStore } from './wait-state-store';
import { configureLogger, createLogger, setVerbose, type LogLevel } from '../core/logger';
import { consoleSink, createRotatingFileSink, readVerboseFromEnv, resolveDataDir } from './log-file';
import { fixPath } from './fix-path';
import { IPC, toWireEvent, parseArgsString, type SessionStartConfig, type KeeperSettings, type SettingsSaveResult, type RendererLogPayload } from '../shared/ipc';
import type { SettingsStore } from '../core/settings';
import type { WaitStateStore } from '../core/wait-state';

const log = createLogger('main');

/**
 * Verbose logging is enabled by EITHER the environment (CLAUDE_KEEPER_VERBOSE)
 * or the persisted `verboseLogging` setting. The env var is a hard override that
 * keeps verbose on regardless of the setting, so a one-off debug run never needs
 * a settings change. Recomputed whenever settings are saved.
 */
const envVerbose = readVerboseFromEnv();
function applyVerbose(settingEnabled: boolean): boolean {
  const on = envVerbose || settingEnabled;
  setVerbose(on);
  return on;
}

/**
 * (Re)configure the logger's sinks from the current settings. The console sink
 * is always present; the rotating file sink is added ONLY when `logToFile` is
 * on, with the rotation threshold taken from `logMaxSizeMB`. Called at startup
 * and again whenever settings are saved, so toggling file logging or changing
 * the size takes effect live without a restart.
 */
function applyLogging(dataDir: string, s: { logToFile: boolean; logMaxSizeMB: number }): void {
  const sinks = [consoleSink];
  if (s.logToFile) {
    sinks.push(createRotatingFileSink(dataDir, { maxBytes: s.logMaxSizeMB * 1024 * 1024 }));
  }
  configureLogger({ sinks });
}

/** App-wide settings store (file-backed, under userData / CLAUDE_KEEPER_DATA_DIR). */
let _settingsStore: SettingsStore | undefined;
function settings(): SettingsStore {
  if (!_settingsStore) _settingsStore = createFileSettingsStore(app.getPath('userData'));
  return _settingsStore;
}

/** App-wide pending-wait store, for cross-restart resume recovery. */
let _waitStore: WaitStateStore | undefined;
function waitStore(): WaitStateStore {
  if (!_waitStore) _waitStore = createFileWaitStore(app.getPath('userData'));
  return _waitStore;
}

/**
 * The currently-live controller, mirrored at module scope so the app-global
 * settings-save handler can push live updates (e.g. recompiled limit patterns)
 * into the running session without reaching into the per-window closure.
 */
let activeController: SessionController | undefined;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0d1117',
    title: 'Claude Keeper',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return win;
}

/** Bind a SessionController's lifetime + IPC to a specific window. */
function wireSession(win: BrowserWindow): void {
  let controller: SessionController | undefined;
  let offEvent: (() => void) | undefined;
  /** The config of the live/last session, needed to persist a recoverable wait. */
  let lastCfg: SessionStartConfig = {};
  /** Most recent reset time (epoch ms) seen from a limit, for wait persistence. */
  let lastResetMs: number | null = null;
  let recoveryChecked = false;
  /**
   * When recovering a persisted wait we re-enter WAITING immediately; suppress
   * the resulting re-save once so the original `savedAtMs` (and thus the
   * staleness horizon) is preserved rather than refreshed on every launch.
   */
  let suppressNextWaitPersist = false;

  const disposeController = (): void => {
    offEvent?.();
    offEvent = undefined;
    controller?.dispose();
    if (activeController === controller) activeController = undefined;
    controller = undefined;
  };

  const persistWait = (): void => {
    try {
      waitStore().save({
        resetTimeMs: lastResetMs,
        command: lastCfg.command || 'claude',
        args: lastCfg.args,
        cwd: lastCfg.cwd,
        verifyWindowMs: lastCfg.verifyWindowMs,
        safetyBufferMs: lastCfg.safetyBufferMs,
        pollIntervalMs: lastCfg.pollIntervalMs,
        maxRetries: lastCfg.maxRetries,
        autoResume: lastCfg.autoResume,
        customPatterns: lastCfg.customPatterns,
        replaceDefaultPatterns: lastCfg.replaceDefaultPatterns,
        resumePrompt: lastCfg.resumePrompt,
      });
    } catch {
      /* best-effort: losing a wait snapshot only costs recovery, not correctness */
    }
  };

  const clearWait = (): void => {
    try {
      waitStore().clear();
    } catch {
      /* best-effort */
    }
  };

  /** Construct (but do not start) a controller for the given config and wire IPC out. */
  const buildController = (cfg: SessionStartConfig): SessionController => {
    disposeController();
    lastCfg = cfg;
    lastResetMs = null;
    const scheduler = new ResumeScheduler({
      safetyBufferMs: clampOptInt(cfg.safetyBufferMs, ...SESSION_LIMIT_BOUNDS.safetyBufferMs),
      pollIntervalMs: clampOptInt(cfg.pollIntervalMs, ...SESSION_LIMIT_BOUNDS.pollIntervalMs),
      maxRetries: clampOptInt(cfg.maxRetries, ...SESSION_LIMIT_BOUNDS.maxRetries),
    });
    // Normalize untrusted renderer input through the same validation/caps the
    // settings store uses, so session:start can't bypass MAX_CUSTOM_PATTERNS /
    // type coercion or throw on a non-array.
    const norm = mergeSettings({
      customPatterns: cfg.customPatterns,
      replaceDefaultPatterns: cfg.replaceDefaultPatterns,
    });
    const { patterns } = compilePatterns(norm);
    // Clamp every numeric knob from the (untrusted) renderer through the same
    // bounds the persistence layer uses, so a buggy/hostile renderer can't e.g.
    // set verifyWindowMs:0 (instant false "resumed") or maxRetries:1e9. The
    // recovery path already feeds pre-clamped values; re-clamping is idempotent.
    const c = new SessionController({
      command: cfg.command || 'claude',
      args: cfg.args,
      cwd: cfg.cwd,
      env: sanitizeEnv(process.env),
      cols: clampOptInt(cfg.cols, 1, 1000),
      rows: clampOptInt(cfg.rows, 1, 1000),
      resumePrompt: cfg.resumePrompt,
      autoResume: cfg.autoResume,
      verifyWindowMs: clampOptInt(cfg.verifyWindowMs, ...SESSION_LIMIT_BOUNDS.verifyWindowMs),
      detectorOptions: { patterns },
      trustWorkingDir: cfg.trustWorkingDir === true,
      scheduler,
    });
    controller = c;
    activeController = c;
    offEvent = c.on((ev) => {
      // Persist/clear the recoverable wait as the session crosses WAITING.
      if (ev.type === 'limit') {
        lastResetMs = ev.resetTime ? ev.resetTime.getTime() : null;
      } else if (ev.type === 'state') {
        if (ev.state === 'WAITING') {
          if (suppressNextWaitPersist) suppressNextWaitPersist = false;
          else persistWait();
        } else if (ev.state === 'RUNNING' || ev.state === 'IDLE' || ev.state === 'ERROR') {
          clearWait();
        }
      }
      if (!win.isDestroyed()) win.webContents.send(IPC.sessionEvent, toWireEvent(ev));
    });
    return c;
  };

  const onStart = (_e: unknown, cfg: SessionStartConfig = {}): { ok: true } => {
    log.info('IPC session:start', {
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      resumePrompt: cfg.resumePrompt,
      autoResume: cfg.autoResume,
    });
    try {
      buildController(cfg).start();
    } catch (err) {
      log.error('session:start failed', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return { ok: true };
  };
  const onWrite = (_e: unknown, data: string): void => controller?.write(data);
  const onResize = (_e: unknown, size: { cols: number; rows: number }): void =>
    controller?.resize(size.cols, size.rows);
  const onStop = (): { ok: true } => {
    log.info('IPC session:stop');
    controller?.stop();
    clearWait();
    return { ok: true };
  };
  const onResumeNow = (): void => controller?.resumeNow();
  const onSetAutoResume = (_e: unknown, enabled: boolean): void => controller?.setAutoResume(enabled);

  /**
   * Called by the renderer once it has wired its event listener. If a fresh
   * pending wait was persisted before the app closed, reconstruct the session
   * straight into WAITING so it auto-resumes at the original reset time.
   */
  const onReady = (): { recovered: boolean } => {
    if (recoveryChecked || controller) return { recovered: false };
    recoveryChecked = true;
    let pending = null;
    try {
      pending = waitStore().load();
    } catch {
      pending = null;
    }
    if (!pending) {
      log.info('session:ready — no pending wait to recover');
      return { recovered: false };
    }
    if (!isWaitFresh(pending, Date.now())) {
      log.info('session:ready — pending wait is stale, discarding');
      clearWait();
      return { recovered: false };
    }
    // Defense-in-depth: the snapshot dictates the command/args/cwd we auto-spawn
    // with no user action. If the command, the exact argv, or the working
    // directory we'd launch it in don't match what the user has configured,
    // refuse to recover (an attacker who can write userData could otherwise plant
    // an arbitrary executable, inject extra flags, or run the configured binary
    // from an attacker-chosen directory on next start).
    const configured = settings().load();
    const configuredCommand = (configured.command || 'claude').trim();
    const configuredCwd = (configured.cwd || '').trim();
    const configuredArgs = parseArgsString(configured.args);
    const argsMatch =
      pending.args.length === configuredArgs.length &&
      pending.args.every((a, i) => a === configuredArgs[i]);
    if (
      pending.command.trim() !== configuredCommand ||
      (pending.cwd ?? '').trim() !== configuredCwd ||
      !argsMatch
    ) {
      log.warn('session:ready — recovery refused (snapshot/config mismatch)', {
        snapshotCommand: pending.command,
        configuredCommand,
        argsMatch,
      });
      clearWait();
      return { recovered: false };
    }
    const c = buildController({
      command: pending.command,
      args: pending.args,
      cwd: pending.cwd,
      resumePrompt: pending.resumePrompt,
      verifyWindowMs: pending.verifyWindowMs,
      safetyBufferMs: pending.safetyBufferMs,
      pollIntervalMs: pending.pollIntervalMs,
      maxRetries: pending.maxRetries,
      autoResume: pending.autoResume,
      customPatterns: pending.customPatterns,
      replaceDefaultPatterns: pending.replaceDefaultPatterns,
    });
    // Keep the existing snapshot (don't refresh its age) for this first WAITING.
    suppressNextWaitPersist = true;
    c.recoverWaiting(pending.resetTimeMs === null ? null : new Date(pending.resetTimeMs));
    log.info('session:ready — recovered pending wait', {
      command: pending.command,
      resetTimeMs: pending.resetTimeMs,
    });
    return { recovered: true };
  };

  ipcMain.handle(IPC.sessionStart, onStart);
  ipcMain.on(IPC.sessionWrite, onWrite);
  ipcMain.on(IPC.sessionResize, onResize);
  ipcMain.handle(IPC.sessionStop, onStop);
  ipcMain.on(IPC.sessionResumeNow, onResumeNow);
  ipcMain.on(IPC.sessionSetAutoResume, onSetAutoResume);
  ipcMain.handle(IPC.sessionReady, onReady);

  win.on('closed', () => {
    disposeController();
    ipcMain.removeHandler(IPC.sessionStart);
    ipcMain.removeHandler(IPC.sessionStop);
    ipcMain.removeHandler(IPC.sessionReady);
    ipcMain.removeListener(IPC.sessionWrite, onWrite);
    ipcMain.removeListener(IPC.sessionResize, onResize);
    ipcMain.removeListener(IPC.sessionResumeNow, onResumeNow);
    ipcMain.removeListener(IPC.sessionSetAutoResume, onSetAutoResume);
  });
}

app.whenReady().then(() => {
  // Configure logging first so every subsequent milestone is captured. Basic
  // info/warn/error always go to the console; they are additionally written to a
  // rotating log file under the app data dir ONLY when the `logToFile` setting is
  // on (see applyLogging). Verbose (debug) detail is enabled via
  // CLAUDE_KEEPER_VERBOSE or the persisted `verboseLogging` setting.
  const userData = app.getPath('userData');
  const dataDir = resolveDataDir(userData);
  const logFile = join(dataDir, 'claude-keeper.log');
  const persisted = settings().load();
  const verbose = applyVerbose(persisted.verboseLogging);
  applyLogging(dataDir, persisted);
  log.info('app ready', {
    verbose,
    verboseFromEnv: envVerbose,
    verboseFromSetting: persisted.verboseLogging,
    logToFile: persisted.logToFile,
    logMaxSizeMB: persisted.logMaxSizeMB,
    userData,
    dataDir,
    logFile,
    platform: process.platform,
    electron: process.versions['electron'],
  });
  if (!persisted.logToFile) {
    log.info('file logging is OFF — enable it in Settings → Diagnostics to write a rotating log file');
  }
  if (!verbose) {
    log.info('verbose logging is OFF — set CLAUDE_KEEPER_VERBOSE=1 or enable it in Settings for detailed logs');
  }

  // Repair PATH for GUI launches. When started from Finder/Dock (macOS) or a
  // .desktop entry/AppImage (Linux), the app inherits only the bare system PATH,
  // so user-installed tools like `claude` (Homebrew, npm-global, ~/.local/bin,
  // version-manager shims) aren't found even though they work in a terminal.
  // Must run BEFORE any session/PTY is created, since each session snapshots
  // process.env at spawn time. No-op on Windows.
  const pathFix = fixPath();
  if (pathFix.changed) {
    log.info('PATH repaired for GUI launch', {
      usedShell: pathFix.usedShell,
      shell: pathFix.shell,
      before: pathFix.before,
      after: pathFix.after,
    });
  } else {
    log.debug('PATH unchanged', { usedShell: pathFix.usedShell, shell: pathFix.shell });
  }

  // Settings IPC is app-global (handlers are singletons), registered once.
  ipcMain.handle(IPC.settingsLoad, (): KeeperSettings => settings().load());
  ipcMain.handle(IPC.settingsSave, (_e, incoming: unknown): SettingsSaveResult => {
    const clean = settings().save(incoming);
    // Adopt a verbose toggle immediately, without requiring a restart.
    const on = applyVerbose(clean.verboseLogging);
    // Apply file-logging changes (on/off + size) live too.
    applyLogging(dataDir, clean);
    // Surface any custom limit-pattern regexes that failed to compile so the
    // renderer can warn the user the offending patterns were dropped.
    const { patterns, errors: patternErrors } = compilePatterns(clean);
    // Live-apply the (recompiled) patterns to a running session so a settings
    // change takes effect mid-session without a relaunch.
    if (activeController) activeController.setLimitPatterns(patterns);
    log.info('settings saved', {
      verbose: on,
      logToFile: clean.logToFile,
      logMaxSizeMB: clean.logMaxSizeMB,
      patternErrors: patternErrors.length,
      liveSession: !!activeController,
    });
    return { settings: clean, patternErrors };
  });

  // Open the on-disk log file in the OS default handler.
  ipcMain.handle(IPC.logsOpen, async (): Promise<{ path: string }> => {
    log.info('logs:open', { logFile });
    const err = await shell.openPath(logFile);
    if (err) log.warn('logs:open failed', { error: err });
    return { path: logFile };
  });

  // Bridge renderer diagnostics into the same log stream/file.
  const rendererLog = createLogger('renderer');
  ipcMain.on(IPC.logWrite, (_e, payload: RendererLogPayload) => {
    const level: LogLevel =
      payload?.level === 'error' || payload?.level === 'warn' || payload?.level === 'debug'
        ? payload.level
        : 'info';
    rendererLog[level](String(payload?.msg ?? ''), payload?.data);
  });

  const win = createWindow();
  wireSession(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      wireSession(w);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

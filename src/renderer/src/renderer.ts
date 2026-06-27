import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { KeeperApi } from '../../preload';
import type { SessionWireEvent, KeeperSettings } from '../../shared/ipc';
import { parseArgsString } from '../../shared/ipc';

declare global {
  interface Window {
    keeper: KeeperApi;
  }
}

const keeper = window.keeper;

// Forward uncaught renderer errors/rejections into the main-process log so they
// land in claude-keeper.log alongside session/pty diagnostics.
function forwardDiag(level: 'error' | 'warn', msg: string, data?: unknown): void {
  try {
    keeper.diag?.log({ level, msg, data });
  } catch {
    /* best-effort */
  }
}
window.addEventListener('error', (e) => {
  forwardDiag('error', `renderer error: ${e.message}`, {
    source: e.filename,
    line: e.lineno,
    col: e.colno,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
  forwardDiag('error', `renderer unhandledrejection: ${reason}`);
});

/** Typed `getElementById` helper. */
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
const term = new Terminal({
  fontFamily: 'Consolas, "SFMono-Regular", Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#0a0e14', foreground: '#c9d1d9' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(el('terminal'));
fit.fit();

term.onData((data) => keeper.session.write(data));
term.onResize(({ cols, rows }) => keeper.session.resize(cols, rows));
window.addEventListener('resize', () => fit.fit());

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------
type State = 'IDLE' | 'RUNNING' | 'LIMIT_DETECTED' | 'WAITING' | 'RESUMING' | 'ERROR';

const STATE_META: Record<State, { color: string; label: string }> = {
  IDLE: { color: 'var(--gray)', label: 'IDLE' },
  RUNNING: { color: 'var(--green)', label: 'RUNNING' },
  LIMIT_DETECTED: { color: 'var(--amber)', label: 'LIMIT' },
  WAITING: { color: 'var(--blue)', label: 'WAITING' },
  RESUMING: { color: 'var(--teal)', label: 'RESUMING' },
  ERROR: { color: 'var(--red)', label: 'ERROR' },
};

const settings: KeeperSettings = {
  command: 'claude',
  args: '',
  cwd: '',
  strategy: 'continue',
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

let waitTotalMs = 0; // captured at the start of a wait cycle, for the progress bar
let sessionStart = 0;
/**
 * One-shot working-directory trust granted via the consent bar. Applied to the
 * NEXT start only (not persisted), then cleared, so a single "Trust & restart"
 * doesn't silently make every future run skip permission prompts.
 */
let trustOnce = false;
/** Resolves once boot-time settings load completes; startSession awaits it. */
let bootLoad: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// View updates
// ---------------------------------------------------------------------------
function setStatusInfo(info: string): void {
  el('stInfo').textContent = info;
}

function applyState(next: State): void {
  const meta = STATE_META[next];
  el('pillDot').style.background = meta.color;
  el('stDot').style.background = meta.color;
  el('pillTxt').textContent = meta.label;
  el('stState').textContent = meta.label;
  el('stStrat').textContent = settings.strategy;
  el('stAuto').textContent = settings.autoResume ? 'ON' : 'OFF';

  el<HTMLButtonElement>('btnStart').disabled = next !== 'IDLE';
  el<HTMLButtonElement>('btnStop').disabled = next === 'IDLE';

  const showOverlay = next === 'WAITING';
  el('overlay').classList.toggle('show', showOverlay);

  if (next === 'IDLE') setStatusInfo('no session');
  else if (next === 'RUNNING') setStatusInfo(sessionStart ? `session up ${uptime()}` : 'session active');
  else if (next === 'LIMIT_DETECTED') setStatusInfo('usage limit reached');
  else if (next === 'WAITING') setStatusInfo(settings.autoResume ? 'waiting for reset' : 'paused — auto-resume off');
  else if (next === 'RESUMING') setStatusInfo(`resuming (${settings.strategy})`);
  else if (next === 'ERROR') setStatusInfo('resume failed');
}

function uptime(): string {
  const s = Math.floor((Date.now() - sessionStart) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function log(msg: string): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const div = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${hh}:${mm}:${ss} `;
  div.appendChild(t);
  div.appendChild(document.createTextNode(msg));
  const box = el('log');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  // Mirror the renderer's activity narrative into the main-process log file so a
  // single claude-keeper.log tells the whole story (UI + session + pty).
  try {
    keeper.diag?.log({ level: 'info', msg, data: { source: 'activity' } });
  } catch {
    /* diagnostics are best-effort */
  }
}

// ---------------------------------------------------------------------------
// Session event handling
// ---------------------------------------------------------------------------
function handleEvent(ev: SessionWireEvent): void {
  switch (ev.type) {
    case 'data':
      term.write(ev.data);
      break;
    case 'state':
      applyState(ev.state as State);
      break;
    case 'limit': {
      waitTotalMs = 0;
      setBannerLimitMode(); // restore wording in case a manual timer overrode it
      el('bnMode').textContent = settings.autoResume ? 'ON' : 'OFF';
      el('atStrat').textContent = settings.strategy;
      const at = ev.resetTimeMs ? new Date(ev.resetTimeMs).toLocaleTimeString() : 'soon';
      el('atTime').textContent = at;
      log(`⚠ Usage limit reached · reset ${at}`);
      break;
    }
    case 'countdown': {
      if (waitTotalMs === 0 || ev.remainingMs > waitTotalMs) waitTotalMs = ev.remainingMs;
      el('count').textContent = fmtDuration(ev.remainingMs);
      const pct = waitTotalMs > 0 ? Math.min(100, Math.round((1 - ev.remainingMs / waitTotalMs) * 100)) : 0;
      el<HTMLElement>('barFill').style.width = `${pct}%`;
      el('pct').textContent = `${pct}%`;
      setStatusInfo(`next resume in ${fmtDuration(ev.remainingMs)}`);
      break;
    }
    case 'resuming':
      log(`↻ Resuming · attempt ${ev.attempt} · ${ev.strategy}`);
      break;
    case 'resumed':
      sessionStart = sessionStart || Date.now();
      log('● Resume verified · running');
      break;
    case 'notice':
      log(`ℹ ${ev.message}`);
      break;
    case 'untrusted':
      log(`⚠ ${ev.message}`);
      showTrustBar(ev.message);
      break;
    case 'error':
      log(`✕ ${ev.message}`);
      break;
    case 'exit':
      term.writeln(`\r\n\x1b[90m[process exited: code ${ev.exitCode}]\x1b[0m`);
      log(`○ Session exited (code ${ev.exitCode})`);
      sessionStart = 0;
      break;
  }
}

keeper.session.onEvent(handleEvent);

// ---------------------------------------------------------------------------
// Toolbar + settings actions
// ---------------------------------------------------------------------------
async function startSession(): Promise<void> {
  await bootLoad; // ensure persisted settings (incl. custom patterns) are loaded first
  term.reset();
  hideTrustBar();
  const trust = settings.trustWorkingDir || trustOnce;
  sessionStart = Date.now();
  const args = parseArgsString(settings.args);
  log(`▶ Starting · ${settings.command} ${args.join(' ')}`.trim());
  try {
    await keeper.session.start({
      command: settings.command || 'claude',
      args,
      cwd: settings.cwd.trim() || undefined,
      strategy: settings.strategy,
      autoResume: settings.autoResume,
      safetyBufferMs: settings.safetySec * 1000,
      pollIntervalMs: settings.pollMin * 60_000,
      maxRetries: settings.maxRetries,
      customPatterns: settings.customPatterns,
      replaceDefaultPatterns: settings.replaceDefaultPatterns,
      trustWorkingDir: trust,
      cols: term.cols,
      rows: term.rows,
    });
  } catch (err) {
    log(`✕ Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    applyState('IDLE');
  } finally {
    trustOnce = false; // one-shot: never carries past a single start attempt
  }
}

function setPauseLabel(): void {
  el('pauseLbl').textContent = settings.autoResume ? 'Pause auto-resume' : 'Resume auto-resume';
}

function togglePause(): void {
  settings.autoResume = !settings.autoResume;
  setPauseLabel();
  el('stAuto').textContent = settings.autoResume ? 'ON' : 'OFF';
  el('bnMode').textContent = settings.autoResume ? 'ON' : 'OFF';
  keeper.session.setAutoResume(settings.autoResume);
  void persistSettings(); // remember the auto-resume preference across restarts
  log(settings.autoResume ? '▶ Auto-resume enabled' : '⏸ Auto-resume paused');
}

/** Restore the wait overlay's default "usage limit reached" wording. */
function setBannerLimitMode(): void {
  el('bnTitle').innerHTML = '<span class="warn">⚠</span> Usage limit reached';
  el('bnSub').innerHTML = 'Auto-resume is <b id="bnMode">ON</b>.';
}

/** Re-label the wait overlay to reflect a user-armed manual resume timer. */
function setBannerManualMode(resumeAtMs: number): void {
  el('bnTitle').innerHTML = '<span class="warn">⏱</span> Manual resume timer';
  // Keep a hidden #bnMode element in the DOM so code that updates it (togglePause,
  // the limit handler) never trips over a missing element while a timer is armed.
  el('bnSub').innerHTML = 'Resuming automatically when the timer ends.<b id="bnMode" hidden></b>';
  el('atTime').textContent = new Date(resumeAtMs).toLocaleTimeString();
  el('atStrat').textContent = settings.strategy;
}

/** Open the manual-resume-timer dialog with the inputs reset and error hidden. */
function openTimer(): void {
  el('timerError').classList.add('hidden');
  el<HTMLInputElement>('timerMins').value = '5';
  el<HTMLInputElement>('timerSecs').value = '0';
  el('timerModal').classList.add('show');
  el<HTMLInputElement>('timerMins').focus();
}

function closeTimer(): void {
  el('timerModal').classList.remove('show');
}

/** Validate the entered delay and arm a deferred resume, then close the dialog. */
function startTimer(): void {
  const mins = Math.max(0, Math.floor(Number(el<HTMLInputElement>('timerMins').value) || 0));
  const secs = Math.max(0, Math.floor(Number(el<HTMLInputElement>('timerSecs').value) || 0));
  const delayMs = (mins * 60 + secs) * 1000;
  if (delayMs <= 0) {
    el('timerError').classList.remove('hidden');
    return;
  }
  waitTotalMs = delayMs; // seed the overlay progress bar for the manual countdown
  keeper.session.resumeAfter(delayMs);
  setBannerManualMode(Date.now() + delayMs);
  const label = secs === 0 ? `${mins}m` : mins === 0 ? `${secs}s` : `${mins}m ${secs}s`;
  log(`⏱ Manual resume timer started — resuming in ${label}`);
  closeTimer();
}

function openSettings(): void {
  el<HTMLInputElement>('setCmd').value = settings.command;
  el<HTMLInputElement>('setArgs').value = settings.args;
  el<HTMLInputElement>('setCwd').value = settings.cwd;
  el<HTMLInputElement>('setTrustWorkingDir').checked = settings.trustWorkingDir;
  el<HTMLInputElement>('stratContinue').checked = settings.strategy === 'continue';
  el<HTMLInputElement>('setSafety').value = String(settings.safetySec);
  el<HTMLInputElement>('setPoll').value = String(settings.pollMin);
  el<HTMLInputElement>('setRetries').value = String(settings.maxRetries);
  el<HTMLTextAreaElement>('setPatterns').value = settings.customPatterns.join('\n');
  el<HTMLInputElement>('setReplace').checked = settings.replaceDefaultPatterns;
  el<HTMLInputElement>('setVerbose').checked = settings.verboseLogging;
  el<HTMLInputElement>('setLogToFile').checked = settings.logToFile;
  el<HTMLInputElement>('setLogMaxSizeMB').value = String(settings.logMaxSizeMB);
  el('modal').classList.add('show');
}

function closeSettings(): void {
  el('modal').classList.remove('show');
}

function saveSettings(): void {
  settings.command = el<HTMLInputElement>('setCmd').value.trim() || 'claude';
  settings.args = el<HTMLInputElement>('setArgs').value;
  settings.cwd = el<HTMLInputElement>('setCwd').value;
  settings.trustWorkingDir = el<HTMLInputElement>('setTrustWorkingDir').checked;
  const strat = document.querySelector<HTMLInputElement>('input[name="strat"]:checked');
  settings.strategy = strat?.value === 'replay' ? 'replay' : 'continue';
  settings.safetySec = Number(el<HTMLInputElement>('setSafety').value) || 60;
  settings.pollMin = Number(el<HTMLInputElement>('setPoll').value) || 5;
  settings.maxRetries = Number(el<HTMLInputElement>('setRetries').value) || 5;
  settings.customPatterns = el<HTMLTextAreaElement>('setPatterns').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  settings.replaceDefaultPatterns = el<HTMLInputElement>('setReplace').checked;
  settings.verboseLogging = el<HTMLInputElement>('setVerbose').checked;
  settings.logToFile = el<HTMLInputElement>('setLogToFile').checked;
  settings.logMaxSizeMB = Number(el<HTMLInputElement>('setLogMaxSizeMB').value) || 10;
  el('stStrat').textContent = settings.strategy;
  updatePromptBar();
  closeSettings();
  void persistSettings();
  log('⚙ Settings saved');
}

/** Persist settings to disk via main; adopt the normalized values it returns. */
async function persistSettings(): Promise<void> {
  try {
    const res = await keeper.settings.save(settings);
    Object.assign(settings, res.settings);
    for (const e of res.patternErrors) {
      log(`⚠ Ignored invalid limit pattern "${e.source}": ${e.message}`);
    }
  } catch (err) {
    log(`✕ Could not save settings: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Load persisted settings on boot and reflect them in the status bar. */
async function loadSettings(): Promise<void> {
  try {
    const loaded = await keeper.settings.load();
    Object.assign(settings, loaded);
    el('stStrat').textContent = settings.strategy;
    el('stAuto').textContent = settings.autoResume ? 'ON' : 'OFF';
    setPauseLabel();
    updatePromptBar();
  } catch {
    /* keep in-memory defaults */
  }
}

/** Show the replay prompt bar only when the replay strategy is active. */
function updatePromptBar(): void {
  el('promptbar').classList.toggle('hidden', settings.strategy !== 'replay');
}

/** Reveal the trust-consent bar after an `untrusted` exit. */
function showTrustBar(message: string): void {
  el('trustMsg').textContent = message;
  el('trustbar').classList.remove('hidden');
}

function hideTrustBar(): void {
  el('trustbar').classList.add('hidden');
}

el('btnStart').addEventListener('click', () => void startSession());
el('btnStop').addEventListener('click', () => void keeper.session.stop());
el('btnLogs').addEventListener('click', () => {
  void keeper.logs
    .open()
    .then((r) => log(`🗎 Opened log file: ${r.path}`))
    .catch((err) => log(`✕ Could not open logs: ${err instanceof Error ? err.message : String(err)}`));
});
el('btnPause').addEventListener('click', togglePause);
el('btnResume').addEventListener('click', () => keeper.session.resumeNow());
el('btnTimer').addEventListener('click', openTimer);
el('btnTimerClose').addEventListener('click', closeTimer);
el('btnTimerCancel').addEventListener('click', closeTimer);
el('btnTimerStart').addEventListener('click', startTimer);
el<HTMLInputElement>('timerMins').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startTimer();
});
el<HTMLInputElement>('timerSecs').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startTimer();
});
el('btnSettings').addEventListener('click', openSettings);
el('btnSettingsClose').addEventListener('click', closeSettings);
el('btnSettingsCancel').addEventListener('click', closeSettings);
el('btnSettingsSave').addEventListener('click', saveSettings);
el('btnBannerResume').addEventListener('click', () => keeper.session.resumeNow());
el('btnBannerCancel').addEventListener('click', togglePause);
el('btnTrustOnce').addEventListener('click', () => {
  trustOnce = true; // one-shot trust for the imminent restart
  hideTrustBar();
  void startSession();
});
el('btnTrustDismiss').addEventListener('click', hideTrustBar);

el('pbSet').addEventListener('click', () => {
  const text = el<HTMLInputElement>('pbInput').value.trim();
  keeper.session.setReplayPrompt(text);
  log(text ? `↻ Replay prompt set: "${text}"` : '↻ Replay prompt cleared (will use captured input)');
});
el<HTMLInputElement>('pbInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('pbSet').click();
});

applyState('IDLE');
setPauseLabel();
log('Ready. Press Start to launch a session.');
bootLoad = loadSettings();
// After settings load, ask main whether a wait persisted from a previous run
// should be recovered. If so, main drives us straight into the WAITING UI.
void bootLoad
  .catch(() => {})
  .then(() => keeper.session.ready())
  .then((r) => {
    if (r?.recovered) {
      sessionStart = Date.now();
      log('↻ Recovered a pending wait from a previous run — will auto-resume at reset.');
    }
  })
  .catch(() => {});

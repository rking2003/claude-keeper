// P7 smoke test: load the BUILT renderer in a hidden window, verify the
// `window.keeper.session` bridge + UX scaffold, then drive the renderer through
// a full RUNNING -> limit -> WAITING(countdown) -> RESUMING -> RUNNING cycle by
// sending real `session:event` IPC messages and asserting the DOM reacts.
// Exits 0 on PASS, 1 on FAIL.
const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');

const ROOT = join(__dirname, '..', '..');
app.disableHardwareAcceleration();

// Stub the session control channels so the preload bridge resolves cleanly.
ipcMain.handle('session:start', () => ({ ok: true }));
ipcMain.handle('session:stop', () => ({ ok: true }));
ipcMain.on('session:write', () => {});
ipcMain.on('session:resize', () => {});
ipcMain.on('session:resumeNow', () => {});
ipcMain.on('session:setAutoResume', () => {});
ipcMain.on('session:setReplayPrompt', () => {});
ipcMain.handle('session:ready', () => ({ recovered: false }));

// Stub the settings bridge. `load` returns a known object the renderer should
// adopt on boot; `save` echoes the payload so we can verify the round-trip.
const LOADED_SETTINGS = {
  command: 'claude',
  args: '',
  cwd: '',
  strategy: 'replay',
  autoResume: false,
  safetySec: 60,
  pollMin: 5,
  maxRetries: 5,
  customPatterns: ['rate limit exceeded'],
  replaceDefaultPatterns: false,
};
let lastSaved = null;
ipcMain.handle('settings:load', () => LOADED_SETTINGS);
ipcMain.handle('settings:save', (_e, s) => {
  lastSaved = s;
  return s;
});

function fail(msg) {
  console.error('[smoke] FAIL - ' + msg);
  app.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(ROOT, 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const timeout = setTimeout(() => fail('timed out waiting for renderer'), 20000);
  win.webContents.on('render-process-gone', (_e, d) => fail('render-process-gone: ' + d.reason));

  const send = (ev) => win.webContents.send('session:event', ev);
  const read = (expr) => win.webContents.executeJavaScript(expr);

  try {
    await win.loadFile(join(ROOT, 'out', 'renderer', 'index.html'));

    // 1) Bridge + scaffold.
    const scaffold = JSON.parse(
      await read(
        'JSON.stringify({' +
          'platform: window.keeper && window.keeper.platform,' +
          'sessionApi: window.keeper && window.keeper.session && ' +
          '["start","write","resize","stop","resumeNow","setAutoResume","setReplayPrompt","ready","onEvent"].every(k => typeof window.keeper.session[k] === "function"),' +
          'hasTerm: !!document.querySelector("#terminal .xterm"),' +
          'hasToolbar: ["btnStart","btnStop","btnPause","btnResume","btnSettings"].every(id => !!document.getElementById(id)),' +
          'startDisabled: document.getElementById("btnStart").disabled,' +
          'overlayHidden: !document.getElementById("overlay").classList.contains("show")' +
          '})',
      ),
    );
    if (!scaffold.platform) return fail('window.keeper.platform missing (preload bridge broken)');
    if (!scaffold.sessionApi) return fail('window.keeper.session API surface incomplete');
    if (!scaffold.hasTerm) return fail('xterm terminal did not mount');
    if (!scaffold.hasToolbar) return fail('toolbar buttons missing');
    if (scaffold.startDisabled) return fail('Start should be enabled while IDLE');
    if (!scaffold.overlayHidden) return fail('overlay should be hidden while IDLE');

    // 1b) Settings bridge: load on boot should be reflected in the status bar,
    //     and save() should round-trip through the preload bridge.
    await sleep(80); // let boot loadSettings() resolve
    const settingsApi = JSON.parse(
      await read(
        'JSON.stringify({' +
          'api: window.keeper.settings && typeof window.keeper.settings.load === "function" && typeof window.keeper.settings.save === "function",' +
          'strat: document.getElementById("stStrat").textContent,' +
          'auto: document.getElementById("stAuto").textContent,' +
          'promptbarShown: !document.getElementById("promptbar").classList.contains("hidden")' +
          '})',
      ),
    );
    if (!settingsApi.api) return fail('window.keeper.settings API surface incomplete');
    if (settingsApi.strat !== 'replay') return fail('boot settings.load not adopted (strategy=' + settingsApi.strat + ')');
    if (settingsApi.auto !== 'OFF') return fail('boot settings.load autoResume not adopted (auto=' + settingsApi.auto + ')');
    if (!settingsApi.promptbarShown) return fail('replay prompt bar should be visible when strategy=replay');

    const saveRoundtrip = JSON.parse(
      await read(
        '(async () => JSON.stringify(await window.keeper.settings.save(' +
          '{ command: "claude", strategy: "continue", customPatterns: ["x"] })))()',
      ),
    );
    if (saveRoundtrip.strategy !== 'continue') return fail('settings.save did not round-trip');

    // 2) Drive the loop via real IPC events.
    send({ type: 'state', state: 'RUNNING' });
    send({ type: 'data', data: 'Claude Code (fake) - Pro\r\nready\r\n' });
    await sleep(60);
    let s = JSON.parse(
      await read(
        'JSON.stringify({ pill: document.getElementById("pillTxt").textContent,' +
          'startDisabled: document.getElementById("btnStart").disabled,' +
          'overlayHidden: !document.getElementById("overlay").classList.contains("show") })',
      ),
    );
    if (s.pill !== 'RUNNING') return fail('pill should read RUNNING, got ' + s.pill);
    if (!s.startDisabled) return fail('Start should be disabled while RUNNING');
    if (!s.overlayHidden) return fail('overlay should be hidden while RUNNING');

    // Limit hit -> WAITING with a countdown.
    const resetMs = Date.now() + 3_600_000;
    send({ type: 'limit', resetTimeMs: resetMs, matchedText: 'usage limit reached' });
    send({ type: 'state', state: 'WAITING' });
    send({ type: 'countdown', remainingMs: 3_600_000, targetMs: resetMs }); // total -> 0%
    send({ type: 'countdown', remainingMs: 1_800_000, targetMs: resetMs }); // -> ~50%
    await sleep(60);
    s = JSON.parse(
      await read(
        'JSON.stringify({ pill: document.getElementById("pillTxt").textContent,' +
          'overlayShown: document.getElementById("overlay").classList.contains("show"),' +
          'count: document.getElementById("count").textContent,' +
          'pct: document.getElementById("pct").textContent })',
      ),
    );
    if (s.pill !== 'WAITING') return fail('pill should read WAITING, got ' + s.pill);
    if (!s.overlayShown) return fail('overlay should be shown while WAITING');
    if (s.count !== '00:30:00') return fail('countdown should read 00:30:00, got ' + s.count);
    if (s.pct !== '50%') return fail('progress should read 50%, got ' + s.pct);

    // Resume -> back to RUNNING; overlay hides.
    send({ type: 'resuming', attempt: 1, strategy: 'continue' });
    send({ type: 'state', state: 'RESUMING' });
    send({ type: 'data', data: 'Resuming previous conversation...\r\nready\r\n' });
    send({ type: 'resumed' });
    send({ type: 'state', state: 'RUNNING' });
    await sleep(60);
    s = JSON.parse(
      await read(
        'JSON.stringify({ pill: document.getElementById("pillTxt").textContent,' +
          'overlayHidden: !document.getElementById("overlay").classList.contains("show"),' +
          'logLines: document.querySelectorAll("#log div").length })',
      ),
    );
    if (s.pill !== 'RUNNING') return fail('pill should return to RUNNING, got ' + s.pill);
    if (!s.overlayHidden) return fail('overlay should hide after resume');
    if (!(s.logLines > 0)) return fail('activity log should have entries');

    clearTimeout(timeout);
    console.log('[smoke] PASS - session bridge + UX + full limit/resume cycle verified');
    app.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    fail(String(err && err.stack ? err.stack : err));
  }
});

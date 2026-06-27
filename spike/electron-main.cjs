// Phase 0 spike: prove @lydell/node-pty works INSIDE Electron's main process
// without electron-rebuild (N-API prebuilt binary). Headless: no visible window.
const { app } = require('electron');
const os = require('node:os');
const pty = require('@lydell/node-pty');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
  const marker = 'ELECTRON_PTY_OK_' + Date.now();
  const args = isWin ? ['/c', `echo ${marker}`] : ['-c', `echo ${marker}`];

  console.log(`[espike] electron=${process.versions.electron} node=${process.versions.node} platform=${process.platform} arch=${process.arch}`);

  const term = pty.spawn(shell, args, {
    name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });

  let buf = '';
  term.onData((d) => { buf += d; });
  term.onExit(({ exitCode }) => {
    const ok = buf.includes(marker);
    console.log(`[espike] exitCode=${exitCode} markerSeen=${ok}`);
    if (ok) {
      console.log('[espike] RESULT: PASS - node-pty works under Electron on ' + os.platform() + '/' + os.arch());
      app.exit(0);
    } else {
      console.error('[espike] RESULT: FAIL - marker not found');
      app.exit(1);
    }
  });
});

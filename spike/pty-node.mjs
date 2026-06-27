// Phase 0 spike: prove @lydell/node-pty spawns a real PTY under plain Node,
// runs a command on the OS shell, and captures its output. Cross-platform.
import os from 'node:os';
import * as pty from '@lydell/node-pty';

const isWin = process.platform === 'win32';
const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
// A command whose output we can assert on, on every OS.
const marker = 'PTY_SPIKE_OK_' + Date.now();
const args = isWin ? ['/c', `echo ${marker}`] : ['-c', `echo ${marker}`];

console.log(`[spike] platform=${process.platform} arch=${process.arch} shell=${shell}`);

const term = pty.spawn(shell, args, {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let buf = '';
term.onData((d) => { buf += d; process.stdout.write(d); });

term.onExit(({ exitCode }) => {
  const ok = buf.includes(marker);
  console.log(`\n[spike] exitCode=${exitCode} markerSeen=${ok}`);
  if (ok) {
    console.log('[spike] RESULT: PASS - node-pty works under Node on ' + os.platform() + '/' + os.arch());
    process.exit(0);
  } else {
    console.error('[spike] RESULT: FAIL - marker not found in PTY output');
    process.exit(1);
  }
});

import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PtyHost, sanitizeEnv } from '../src/main/pty-host';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fixtures', 'fake-claude.mjs');
const NODE = process.execPath;

function makeHost() {
  const host = new PtyHost();
  let buf = '';
  host.onData((d) => { buf += d; });
  return {
    host,
    getBuf: () => buf,
    async waitFor(pred: (s: string) => boolean, ms = 8000): Promise<string> {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (pred(buf)) return buf;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor timed out. Buffer so far:\n${buf}`);
    },
  };
}

let active: PtyHost | undefined;
afterEach(() => {
  if (active?.running) active.kill();
  active = undefined;
});

describe('PtyHost + fake-claude (integration, real PTY)', () => {
  it('streams the banner, echoes input, and reports a clean exit on /quit', async () => {
    const { host, waitFor } = makeHost();
    active = host;

    const exit = new Promise<{ exitCode: number }>((resolve) => host.onExit(resolve));
    host.start({ command: NODE, args: [FAKE_CLAUDE] });
    expect(host.running).toBe(true);
    expect(typeof host.pid).toBe('number');

    await waitFor((s) => s.includes('ready'));

    host.write('hello world\r');
    await waitFor((s) => s.includes('● hello world'));

    // The limit message is printed but — like the real TUI — the session stays alive.
    host.write('/triggerlimit\r');
    await waitFor((s) => s.includes('Claude usage limit reached'));
    expect(host.running).toBe(true);

    host.write('/quit\r');
    const info = await exit;
    expect(info.exitCode).toBe(0);
    expect(host.running).toBe(false);
  });

  it('prints a resume banner when launched with --continue', async () => {
    const { host, waitFor } = makeHost();
    active = host;
    host.start({ command: NODE, args: [FAKE_CLAUDE, '--continue'] });
    await waitFor((s) => s.includes('Resuming previous conversation'));
  });

  it('auto-emits the limit message when FAKE_CLAUDE_AUTOLIMIT=1', async () => {
    const { host, waitFor } = makeHost();
    active = host;
    const env = { ...sanitizeEnv(process.env), FAKE_CLAUDE_AUTOLIMIT: '1', FAKE_CLAUDE_RESET: '9:00 AM (UTC)' };
    host.start({ command: NODE, args: [FAKE_CLAUDE], env });
    await waitFor((s) => s.includes('reset at 9:00 AM (UTC)'));
  });

  it('throws if start() is called while already running', async () => {
    const { host, waitFor } = makeHost();
    active = host;
    host.start({ command: NODE, args: [FAKE_CLAUDE] });
    await waitFor((s) => s.includes('ready'));
    expect(() => host.start({ command: NODE, args: [FAKE_CLAUDE] })).toThrowError(/already running/);
  });
});

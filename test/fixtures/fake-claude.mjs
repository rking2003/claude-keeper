#!/usr/bin/env node
/**
 * fake-claude — a deterministic stand-in for the Claude Code CLI, used by tests.
 * It never makes network calls and behaves predictably so the full
 * limit -> wait -> resume loop can be exercised without the real binary.
 *
 * Behaviour:
 *   - prints a banner on start (a "resumed" banner when launched with --continue)
 *   - echoes each submitted line as "● <line>"
 *   - on input "/triggerlimit" (or env FAKE_CLAUDE_AUTOLIMIT=1) it prints a
 *     realistic usage-limit message and exits
 *   - on input "/quit" it exits cleanly
 *
 * Env:
 *   FAKE_CLAUDE_RESET   reset-time text shown in the limit message
 *                       (default "3:00 PM (America/New_York)")
 *   FAKE_CLAUDE_AUTOLIMIT=1  emit the limit message immediately after the banner
 */
import readline from 'node:readline';
import fs from 'node:fs';

const args = process.argv.slice(2);
const isContinue = args.includes('--continue') || args.includes('-c');
const reset = process.env.FAKE_CLAUDE_RESET || '3:00 PM (America/New_York)';

function out(line) {
  process.stdout.write(line + '\r\n');
}

function emitLimitAndExit() {
  out(`Claude usage limit reached. Your limit will reset at ${reset}.`);
  // distinct exit code from a clean /quit, so callers can tell them apart
  process.exit(7);
}

/**
 * Resume-failure simulation: when launched with --continue, increment a counter
 * in FAKE_CLAUDE_STATE. While that counter is <= FAKE_CLAUDE_FAIL_RESUMES the
 * resume is treated as "still limited" (prints the limit message and exits),
 * letting tests exercise retry/backoff and exhaustion paths deterministically.
 */
function maybeFailResume() {
  if (!isContinue) return;
  const failResumes = parseInt(process.env.FAKE_CLAUDE_FAIL_RESUMES || '0', 10);
  if (!failResumes) return;
  const statePath = process.env.FAKE_CLAUDE_STATE;
  let count = 1;
  if (statePath) {
    try {
      count = parseInt(fs.readFileSync(statePath, 'utf8'), 10) + 1;
    } catch {
      count = 1;
    }
    try {
      fs.writeFileSync(statePath, String(count));
    } catch {
      /* best effort */
    }
  }
  if (count <= failResumes) {
    emitLimitAndExit();
  }
}

if (isContinue) {
  // No-session simulation: when launched with --continue/-c and asked to behave
  // as if there is nothing to resume, print the CLI's no-conversation message
  // and exit. The exit code is configurable (default 0) so we can mirror the
  // real CLI, which exits *cleanly* in this case on some platforms.
  if (process.env.FAKE_CLAUDE_NO_SESSION === '1') {
    out('No conversation found to continue.');
    const code = parseInt(process.env.FAKE_CLAUDE_NO_SESSION_CODE || '0', 10);
    process.exit(Number.isNaN(code) ? 0 : code);
  }
  out('Resuming previous conversation...');
  maybeFailResume();
} else {
  out('Claude Code (fake) - Pro');
}
out('ready');

if (process.env.FAKE_CLAUDE_AUTOLIMIT === '1') {
  emitLimitAndExit();
}

/**
 * Limit-trigger counter: by default every "/triggerlimit" emits the limit and
 * exits. When FAKE_CLAUDE_LIMIT_TRIGGERS=N (with a shared FAKE_CLAUDE_TRIGGER_STATE
 * file) only the first N triggers actually limit; subsequent ones behave like a
 * normal prompt. This lets the replay test resend the captured prompt without
 * re-hitting the limit.
 */
function onTrigger(line) {
  const max = process.env.FAKE_CLAUDE_LIMIT_TRIGGERS
    ? parseInt(process.env.FAKE_CLAUDE_LIMIT_TRIGGERS, 10)
    : Infinity;
  const sp = process.env.FAKE_CLAUDE_TRIGGER_STATE;
  let count = 1;
  if (sp) {
    try {
      count = parseInt(fs.readFileSync(sp, 'utf8'), 10) + 1;
    } catch {
      count = 1;
    }
    try {
      fs.writeFileSync(sp, String(count));
    } catch {
      /* best effort */
    }
  }
  if (count <= max) emitLimitAndExit();
  out('● ' + line);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.replace(/[\r\n]+$/, '').trim();
  if (line === '/triggerlimit') return onTrigger(line);
  if (line === '/quit') {
    rl.close();
    process.exit(0);
    return;
  }
  if (line.length > 0) out('● ' + line);
});
rl.on('close', () => process.exit(0));

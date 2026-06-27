#!/usr/bin/env node
/**
 * fake-claude — a deterministic stand-in for the Claude Code CLI, used by tests.
 * It never makes network calls and behaves predictably so the full
 * limit -> wait -> resume loop can be exercised without the real binary.
 *
 * Behaviour (mirrors the real interactive CLI):
 *   - prints a banner on start (a "resumed" banner when launched with --continue)
 *   - echoes each submitted line as "● <line>"
 *   - on input "/triggerlimit" (or env FAKE_CLAUDE_AUTOLIMIT=1) it prints a
 *     realistic usage-limit message and — like the real TUI — STAYS ALIVE,
 *     waiting for the user to type a prompt after the reset
 *   - on input "/quit" it exits cleanly
 *
 * Env:
 *   FAKE_CLAUDE_RESET          reset-time text shown in the limit message
 *                              (default "3:00 PM (America/New_York)")
 *   FAKE_CLAUDE_AUTOLIMIT=1    emit the limit message immediately after the banner
 *   FAKE_CLAUDE_LIMIT_EXITS=1  exit (code 7) right after printing the limit,
 *                              modelling a CLI that dies at the limit — exercises
 *                              the relaunch-with---continue resume path
 *   FAKE_CLAUDE_STILL_LIMITED=N  after a limit, the first N submitted prompts are
 *                              answered with the limit message again (still
 *                              limited); the next prompt succeeds — exercises
 *                              retry/backoff on the live session
 *   FAKE_CLAUDE_FAIL_RESUMES=N (with FAKE_CLAUDE_STATE=<file>) when launched with
 *                              --continue, the first N such launches print the
 *                              limit and exit — exercises relaunch retries
 */
import readline from 'node:readline';
import fs from 'node:fs';

const args = process.argv.slice(2);
const isContinue = args.includes('--continue') || args.includes('-c');
const reset = process.env.FAKE_CLAUDE_RESET || '3:00 PM (America/New_York)';
const limitExits = process.env.FAKE_CLAUDE_LIMIT_EXITS === '1';

let limited = false;
let stillLimitedReplies = parseInt(process.env.FAKE_CLAUDE_STILL_LIMITED || '0', 10) || 0;

function out(line) {
  process.stdout.write(line + '\r\n');
}

function emitLimit() {
  out(`Claude usage limit reached. Your limit will reset at ${reset}.`);
  // distinct exit code from a clean /quit, so callers can tell them apart
  if (limitExits) process.exit(7);
  limited = true;
}

/**
 * Relaunch-failure simulation: when launched with --continue, increment a counter
 * in FAKE_CLAUDE_STATE. While that counter is <= FAKE_CLAUDE_FAIL_RESUMES the
 * relaunch is treated as "still limited" (prints the limit message and exits),
 * letting tests exercise relaunch retry/backoff deterministically.
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
    out(`Claude usage limit reached. Your limit will reset at ${reset}.`);
    process.exit(7);
  }
}

if (isContinue) {
  out('Resuming previous conversation...');
  maybeFailResume();
} else {
  out('Claude Code (fake) - Pro');
}
out('ready');

if (process.env.FAKE_CLAUDE_AUTOLIMIT === '1') {
  emitLimit();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.replace(/[\r\n]+$/, '').trim();
  if (line === '/quit') {
    rl.close();
    process.exit(0);
    return;
  }
  if (limited) {
    // The real TUI answers prompts sent before the reset with the limit notice
    // again; once the reset has passed, the next prompt just works.
    if (stillLimitedReplies > 0) {
      stillLimitedReplies -= 1;
      out(`Claude usage limit reached. Your limit will reset at ${reset}.`);
      return;
    }
    limited = false;
    if (line.length > 0) out('● ' + line);
    return;
  }
  if (line === '/triggerlimit') return emitLimit();
  if (line.length > 0) out('● ' + line);
});
rl.on('close', () => process.exit(0));

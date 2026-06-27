# Manual testing against the real Claude CLI

The automated suite (`npm test`) uses a deterministic mock CLI and never needs
the real `claude` binary. This document covers the **manual** end-to-end checks
that can only be done against the real CLI on a real Pro-plan account.

> These tests intentionally consume real usage. Run them when you actually have
> long-running work, or near a known reset boundary, so you do not waste quota.

## Prerequisites

- `claude` on your `PATH`, logged in to a **Pro** plan.
- A built app: `npm run dev` (dev) or an installed build from `dist/`.
- A scratch project directory to point the session at (Settings → cwd).

## Test data isolation

Point the app at a throwaway data directory so you never clobber real config:

```sh
# Windows (PowerShell)
$env:CLAUDE_KEEPER_DATA_DIR = "$env:TEMP\ck-manual"; npm run dev

# macOS / Linux
CLAUDE_KEEPER_DATA_DIR="$TMPDIR/ck-manual" npm run dev
```

Delete that directory between runs to start from a clean slate.

---

## T1 — Basic hosting

1. Launch the app; open Settings, confirm command `claude`, set cwd.
2. Start the session. **Expect:** Claude's normal interactive UI in the
   terminal; typing and arrow keys work; resizing the window reflows the PTY.
3. Status bar shows **RUNNING**.

## T2 — Limit detection + countdown

1. Drive the session until you hit the 5-hour limit (or run near a known cap).
2. When `Claude usage limit reached. Your limit will reset at <time> (<tz>)`
   appears: **Expect** status → **WAITING**, a parsed reset time, and a live
   countdown matching the stated reset time **in your local timezone**.
3. Verify the countdown decrements and the parsed time matches the message
   (especially across a timezone with DST, if possible).

## T3 — Auto-resume: prompt typed into the live session

1. Trigger a limit (T2), then wait for reset (or run near a reset boundary).
2. **Expect:** the Claude session stays open (exactly as you left it) during
   the whole wait; at reset **+ the safety buffer (default 60 s)** the app types
   the resume prompt (default `continue`) plus Enter into that same session,
   status returns to **RUNNING**, and Claude picks the work back up with full
   context — no relaunch, no `--continue`.

## T4 — Auto-resume: relaunch fallback when the session died

1. Trigger a limit (T2), then kill the `claude` process from another terminal
   (or use T5's app-restart path) while the app is **WAITING**.
2. **Expect:** at reset, the app relaunches `claude --continue`, types the
   resume prompt into it, and the conversation resumes with prior context
   intact (ask Claude to recall something from before the limit).

## T5 — Restart recovery (app crash / quit mid-wait)

1. Enter the **WAITING** state (T2).
2. Fully quit the app (or kill it) before reset.
3. Relaunch. **Expect:** the app reads the persisted pending wait, re-enters
   **WAITING** with the same reset time and remaining countdown — it does **not**
   resume immediately or lose the wait. (If the saved command no longer matches
   current settings, it safely clears and starts idle.)
4. Wait for reset. **Expect:** auto-resume relaunches `claude --continue` (the
   original session is gone after a restart) and types the resume prompt.

## T6 — Sleep/wake recovery

1. Enter **WAITING**.
2. Sleep the laptop for several minutes, then wake it.
3. **Expect:** the countdown reflects real elapsed wall-clock time; if the reset
   passed during sleep, the app resumes promptly on wake (tick-based scheduler,
   not a single fixed timer).

## T7 — Stale / future wait rejection

1. Manually edit `pending-wait.json` in the data dir to a `resetTimeMs` far in
   the future (> 30 days) or a `savedAtMs` older than ~8 days.
2. Relaunch. **Expect:** the app rejects the stale/implausible wait and starts
   idle rather than scheduling a bogus resume.

## T8 — Custom resume prompt

1. Settings → Resume prompt = something distinctive (e.g. `carry on with the plan`).
2. Trigger a limit and wait for reset (or use **Resume now**).
3. **Expect:** exactly that text is typed into the session, followed by a single
   Enter (no stray control characters, no double submission).

---

## What to record

For each test note: OS + arch, app version, pass/fail, the exact limit message
seen, the parsed reset time vs. actual, and any unexpected terminal artifacts.
File issues with that context attached.

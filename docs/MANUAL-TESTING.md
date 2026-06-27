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

## T3 — Auto-resume: Continue strategy

1. Settings → resume strategy = **Continue**.
2. Trigger a limit (T2), then wait for reset (or set a near reset boundary).
3. **Expect:** at reset, the app relaunches `claude --continue`, the session
   returns to **RUNNING**, and prior context is intact (ask Claude to recall
   something from before the limit).

## T4 — Auto-resume: Replay strategy

1. Settings → resume strategy = **Replay**.
2. Type a distinctive last prompt, then trigger a limit.
3. **Expect:** at reset, the app relaunches `claude` and re-sends exactly that
   last prompt (check multi-line / pasted prompts are reproduced verbatim, no
   stray control characters).

## T5 — Restart recovery (app crash / quit mid-wait)

1. Enter the **WAITING** state (T2).
2. Fully quit the app (or kill it) before reset.
3. Relaunch. **Expect:** the app reads the persisted pending wait, re-enters
   **WAITING** with the same reset time and remaining countdown — it does **not**
   resume immediately or lose the wait. (If the saved command no longer matches
   current settings, it safely clears and starts idle.)
4. Wait for reset. **Expect:** auto-resume fires per the configured strategy.

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

## T8 — Manual resume timer (`Resume in…`)

1. Start a session and let it reach **RUNNING** (no limit needed).
2. Click **⏱ Resume in…** in the toolbar. **Expect:** a small dialog with
   minutes/seconds inputs. Entering `0` min `0` sec and pressing Start shows the
   "Enter a delay greater than zero" error and does not arm.
3. Enter a short delay (e.g. 0 min, 30 sec) and Start. **Expect:** the dialog
   closes, status → **WAITING**, the overlay re-labels to "⏱ Manual resume
   timer" with the projected resume time, and the countdown decrements.
4. When the timer elapses: **Expect** status → **RESUMING** → **RUNNING**, the
   session relaunches with the configured strategy (Continue by default), and
   prior context is intact.
5. Repeat with **auto-resume paused** (⏸). **Expect:** the manual timer still
   fires — it is an explicit override independent of the auto-resume toggle.

---

## What to record

For each test note: OS + arch, app version, pass/fail, the exact limit message
seen, the parsed reset time vs. actual, and any unexpected terminal artifacts.
File issues with that context attached.

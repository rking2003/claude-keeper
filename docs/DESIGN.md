# Claude Keeper — Design & Build Plan

A cross-platform desktop app that hosts the Claude Code CLI inside an embedded
terminal, detects when the Pro-plan usage limit is reached (5-hour rolling and
weekly caps), and **automatically resumes** the session once the limit window
resets — so long-running work survives the limit without babysitting.

> Status: planning. Nothing depends on a specific machine. Works for any user on
> Windows / macOS / Linux. The real `claude` binary is **not** required to
> develop or test (a deterministic mock CLI drives all automated tests).

---

## 1. Problem statement

- Claude Code on the Pro plan enforces a **5-hour rolling window** and a
  **weekly** cap. When hit, the CLI prints a limit-reached message such as:
  `Claude usage limit reached. Your limit will reset at <time> (<timezone>).`
  For the weekly cap the phrasing varies, e.g.
  `You've reached your weekly usage limit. …` or
  `Weekly limit reached. Resets at <ISO-8601 timestamp>`. Newer builds also use a
  "resets" (not "reached") phrasing with a `session`/`weekly` noun, e.g.
  `You've hit your session limit · resets <time> (<tz>)`. The detector's default
  patterns tolerate the qualifier word ("weekly", "session", "5-hour") the CLI
  inserts, the `usage`-vs-`session` noun, and the `reached`/`resets at|by <time>`
  variants, so 5-hour, session, and weekly limits are all caught. As an
  encoding-robust backstop (Claude varies spacing and apostrophe glyphs across
  builds), a final default pattern matches any line where the words **"limit"**
  and **"reset"** co-occur within one sentence or two consecutive sentences,
  in either order — catching re-encoded phrasings the literal patterns miss.
  After printing it the CLI blocks further prompts until reset.
- The user wants an app that:
  1. Runs the Claude CLI inside a UI (interactive terminal).
  2. Detects the limit-reached condition and enters a **waiting stage**.
  3. Determines the reset time (parse the message; fall back to interval poll).
  4. At reset **+ a safety buffer** (default 1 min), types the resume prompt
     ("continue" + Enter) into the still-open session — exactly what the user
     does by hand today.
  5. Shows a live countdown while waiting.

## 2. Goals / non-goals

**Goals**
- Machine-agnostic, cross-platform desktop app (Electron).
- Reliable limit detection + reset-time parsing, both user-configurable.
- Resume by **typing the resume prompt into the live session** (the session is
  kept alive through the wait); relaunch `claude --continue` first only if the
  CLI died mid-wait or the app was restarted.
- Resilience: survive app restart and laptop sleep during a long wait.
- Strict TDD: every change goes edit → build → run → test → verify.

**Non-goals (v1)**
- No Anthropic API integration (we only observe terminal output).
- No multi-session orchestration in v1 (single active session; multi later).
- Not bypassing limits — only waiting for the legitimate reset.

## 3. Cross-platform / portability rules

- **No hardcoded paths or drive letters.** Runtime config lives in
  `app.getPath('userData')` (per-OS, per-user). Overridable via
  `CLAUDE_KEEPER_DATA_DIR` for tests/sandbox.
- PTY via **node-pty** (ConPTY on Windows, forkpty on macOS/Linux).
- Default command is just `claude`, resolved from the user's PATH; fully
  configurable (command, args, cwd, env) in Settings.
- Default shell for the spike resolves per-OS (`ComSpec`/`cmd.exe` on Windows,
  `$SHELL`/`/bin/bash` elsewhere).
- Packaged for win/mac/linux via electron-builder.
- All timestamps handled as absolute `Date` (UTC internally) with timezone-aware
  parsing so reset times are correct regardless of locale.

## 4. Architecture

Electron, three processes, with the **core logic kept Electron-free and pure**
so it is fast to unit-test.

```
┌──────────────────────────────────────────────────────────────────┐
│ Renderer (browser)                                                 │
│   xterm.js terminal • status bar • countdown • settings • log      │
│        ▲  IPC (contextBridge / preload, contextIsolation on)       │
└────────┼───────────────────────────────────────────────────────────┘
         │
┌────────┼───────────────────────────────────────────────────────────┐
│ Main (Node)                                                         │
│   SessionController (state machine)                                 │
│     ├─ PtyHost ............ spawn/write/kill node-pty               │
│     ├─ LimitDetector ...... scan output → limit / reset-time events │
│     ├─ ResetTimeParser .... parse "reset at <time> (<tz>)" → Date   │
│     ├─ ResumeScheduler .... schedule resume (injected clock)        │
│     ├─ SettingsStore ...... JSON persist in userData                │
│     └─ Notifier ........... desktop notifications                   │
└────────────────────────────────────────────────────────────────────┘
```

### Core modules (pure, unit-tested in isolation)

1. **LimitDetector** — feed ANSI-stripped output chunks; emits
   `LimitReached` (with raw matched text) and `ResetTimeFound`. Pattern list is
   configurable (default patterns ship built-in).
2. **ResetTimeParser** — converts phrasings into an absolute `Date`:
   `"3pm (America/New_York)"`, `"15:00 PST"`, ISO timestamps, `"in 2 hours"`.
   Returns `null` when unparseable (→ scheduler falls back to polling).
3. **ResumeScheduler** — given a target `Date` (or `null`), fires a `resume`
   event at `target + safetyBuffer`; if `null`, polls every `interval`. Uses an
   **injectable clock** and recomputes remaining time on each tick
   (sleep-safe). Honors `maxRetries` with backoff.
4. **SessionController** — the state machine that wires everything:
   `IDLE → RUNNING → LIMIT_DETECTED → WAITING → RESUMING → RUNNING`
   (`→ ERROR/RETRYING` on repeated failure). Keeps the limited session alive
   through WAITING and types the resume prompt into it at resume time;
   `resumeNow()` fires immediately.
5. **SettingsStore** — load/save/validate JSON; migrations; defaults.
6. **PtyHost** — thin wrapper over node-pty (resize, write, kill, onData/onExit).

### State machine

```
        start           limit msg                 reset time + buffer reached
 IDLE ─────────► RUNNING ───────────────────────► WAITING ───────────────► RESUMING
   ▲                ▲                                   ▲                       │
   │ stop           │                                   │ retry/backoff        │ ok
   └────────────────┴───────────── stop ───────────────┴───────────────────────┘
                                                              fail (limit again)
```

## 5. Auto-resume mechanics

- On `LimitReached`: parse reset time → enter **WAITING**, show countdown. The
  CLI session is **left open** exactly as the user would leave it.
- At `resetTime + safetyBuffer` (default 60s): enter **RESUMING** and type the
  resume prompt (default `continue`) + Enter into the live session. If the
  session died mid-wait (or the app restarted), relaunch `claude --continue`
  first and then type the prompt.
- **Verify**: if a limit message reappears immediately, treat as not-yet-reset →
  back off, retry up to `maxRetries` (the live session is never killed by a
  failed attempt — the next attempt just types the prompt again), then surface
  ERROR.
- Persist `{ resetTime, command, args, resumePrompt, … }` so a restart mid-wait
  recovers and still resumes.
- **Manual override**: `Resume now` skips the countdown and reuses the same
  RESUMING → verify → RUNNING path.

## 6. Testing strategy (TDD — the "full loop")

The real `claude` CLI is nondeterministic, costs quota, and may be absent, so we
build **`fake-claude`** — a tiny Node script used by tests:
- prints a realistic banner, accepts input;
- on trigger (special input `/triggerlimit` or env var) prints a realistic
  `Claude usage limit reached. Your limit will reset at <time> (<tz>).` and —
  like the real TUI — **stays alive** waiting for the post-reset prompt
  (`FAKE_CLAUDE_LIMIT_EXITS=1` models a CLI that dies at the limit instead);
- supports `--continue` (prints a "resumed" banner) so a relaunch is observable;
- `FAKE_CLAUDE_STILL_LIMITED=N` answers the first N post-limit prompts with the
  limit message again, to exercise retry/backoff.

Layers:
1. **Unit** (Vitest): LimitDetector, ResetTimeParser, ResumeScheduler (virtual
   clock), SettingsStore. Fast, deterministic.
2. **Integration**: SessionController + real node-pty + fake-claude, with a
   compressed clock (resume delay ~1s) to exercise the full loop in milliseconds.
3. **E2E/smoke**: Electron launch + renderer wiring (Playwright-electron);
   heavier GUI flows may be manual.

Every change: `npm run build` (electron-vite + tsc typecheck) → `npm test` →
smoke-run. Deep code review + adversarial review (sub-agents) after each phase.

## 7. Risks & mitigations (adversarial)

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | node-pty native build / Electron ABI mismatch (esp. Windows) | **Phase 0 spike** before anything else; electron-rebuild; pin versions |
| 2 | Limit message format varies / changes | Configurable regex list + research-based defaults + manual override |
| 3 | Reset-time parsing across formats/timezones | Extensive unit tests; fallback to interval polling on parse failure |
| 4 | Typed prompt eaten by a relaunching TUI | The prompt is written to the PTY, which buffers it until the CLI reads stdin; the verify window + retries catch a swallowed prompt |
| 5 | `claude --continue` semantics differ | Resume command fully configurable; verify with real CLI (user-assisted) |
| 6 | App closed / machine sleeps during long wait | Persist wait state; absolute target time; recompute on wake/restart |
| 7 | False-positive detection (e.g. word "limit" in code) | Anchor patterns to known phrasing; require "reset at"; configurable |

## 8. Tech stack

- **TypeScript** everywhere.
- **Electron** + **electron-vite** (main/preload/renderer bundling, HMR).
- **@xterm/xterm** + **@xterm/addon-fit** (terminal UI).
- **node-pty** (cross-platform PTY).
- **Vitest** (tests), **strip-ansi** (detection), **electron-builder** (package).
- Settings persisted as JSON in `app.getPath('userData')`.

## 9. Build phases (each = TDD build→run→test→verify loop)

- **P0 Spike**: prove node-pty + Electron spawn a shell and echo, on this OS.
  De-risks the native build before investing further.
- **P1 Scaffold**: TS + Vitest + lint + electron-vite skeleton; window renders
  xterm; smoke test green.
- **P2 PTY bridge**: main↔renderer IPC; type in xterm → real shell; integration
  test against fake-claude echo.
- **P3 Detection**: LimitDetector + ResetTimeParser, TDD-first with sample
  messages (incl. timezones, weekly vs 5-hour).
- **P4 Scheduler**: ResumeScheduler with injected clock, TDD.
- **P5 Controller**: SessionController state machine wiring detector + scheduler
  + pty; full-loop integration tests vs fake-claude (compressed clock). **Core
  feature works end-to-end.**
- **P6 Settings**: resume prompt, intervals, patterns, command; persistence + UI. ✅
- **P7 UX**: status bar, countdown, manual Resume/Pause, notifications. ✅
- **P8 Keep-alive resume**: the limited session survives WAITING; resume types
  the prompt into it, relaunching `--continue` only when it died. ✅
- **P9 Resilience**: persist/recover wait state across app restart (absolute reset
  time, fresh-only via `isWaitFresh`); sleep/wake handled by the tick-based
  scheduler that re-evaluates `now()` each tick. ✅
- **P10 Hardening**: adversarial reviews on P8/P9 (all findings fixed + tested);
  cross-platform packaging via electron-builder (win/mac/linux, x64+arm64;
  node-pty asar-unpacked; Windows pack verified to launch); CI workflow
  (`.github/workflows/build.yml`) builds/tests all 3 OSes and releases on tags;
  `README.md` + `docs/MANUAL-TESTING.md` (real-claude verification). ✅

---

## 10. UX design

### 10.1 Main window — RUNNING

```
┌─ Claude Keeper ─────────────────────────────────────────  ● RUNNING ─┐
│ [▶ Start] [■ Stop] [⏸ Pause] [↻ Resume now] [⚙ Settings]           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   claude>  building the auth module...                               │
│   ● Implementing JWT refresh                                         │
│   ...                                                                 │
│   (interactive xterm.js terminal — full Claude Code TUI)             │
│                                                                      │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ ● RUNNING · session 1h12m · auto-resume: ON                           │
└──────────────────────────────────────────────────────────────────────┘
```

### 10.2 Limit reached — WAITING (countdown)

```
┌─ Claude Keeper ─────────────────────────────────────  ◐ WAITING ─────┐
│ [▶ Start] [■ Stop] [⏸ Pause] [↻ Resume now] [⚙ Settings]           │
├──────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │  ⚠  Usage limit reached.                                          │ │
│ │     Resuming in   02 : 14 : 31                                    │ │
│ │     at 3:00 PM (America/New_York) · then it types "continue"      │ │
│ │     [████████████░░░░░░░░░░░░░░░░░░]  43%                          │ │
│ │     [ ↻ Resume now ]   [ ✕ Cancel auto-resume ]                   │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│   ...terminal output frozen at the limit message above...            │
├──────────────────────────────────────────────────────────────────────┤
│ ◐ WAITING · next resume 3:00 PM · retries 0/5 · source: parsed        │
└──────────────────────────────────────────────────────────────────────┘
```

If the reset time could **not** be parsed, the banner reads
"Reset time unknown — polling every 5 min" and the countdown is replaced by a
"next check in mm:ss" indicator.

### 10.3 Settings (modal)

```
┌─ Settings ───────────────────────────────────────────────────────────┐
│ Command                                                              │
│   Claude command:  [ claude                                  ]        │
│   Arguments:       [                                         ]        │
│   Working dir:     [ (project folder)              ] [Browse]        │
│   [ ] Trust the working directory (--dangerously-skip-permissions)  │
│                                                                      │
│ Resume                                                               │
│   Resume prompt (typed + Enter at reset):  [ continue          ]     │
│   Safety buffer after reset:  [ 60 ] sec                             │
│                                                                      │
│ Reset timing                                                         │
│   [x] Parse reset time from output                                   │
│   Fallback poll interval:  [ 5 ] min     Max retries: [ 5 ]          │
│                                                                      │
│ Detection patterns (advanced)                                        │
│   Custom limit-detection patterns (one regex per line)              │
│   [ usage limit reached                                  ]           │
│   [ ] Replace built-in patterns                                     │
│                                                                      │
│ Diagnostics                                                          │
│   [ ] Verbose debug logging                                          │
│   [ ] Write logs to a file (off by default)                         │
│   Rotate log at:  [ 10 ] MB            [ 🗎 Open log file ]          │
│                                                                      │
│                                   [ Cancel ]   [ Save ]              │
└──────────────────────────────────────────────────────────────────────┘
```

**Working-directory trust.** Claude Code refuses to run in an untrusted folder,
printing a "Do you trust the files in this folder?" prompt and exiting (code 1)
when it can't get an interactive answer. Two paths cover this:

- **Persistent opt-in** — the `trustWorkingDir` setting appends
  `--dangerously-skip-permissions` to every fresh *and* resume launch.
- **One-time consent** — when an untrusted exit is detected, the controller
  emits an `untrusted` event; the renderer shows a "Trust & restart" bar that
  relaunches once with trust, without changing the persisted setting.

**File logging.** Off by default (`logToFile = false`): no log file is written
until the user enables it in Diagnostics. When on, a size-rotating sink writes to
`claude-keeper.log`, rolling to `claude-keeper.log.1` once it exceeds
`logMaxSizeMB` (default 10 MB, 1–1000). The console sink is always present.
Toggling either setting applies live on Save — no restart required.

**Live pattern updates.** Saving Settings recompiles the custom limit-detection
patterns and pushes them into the *running* session's `LimitDetector`
(`SessionController.setLimitPatterns`), so a newly-added regex takes effect
immediately without a relaunch. The trust flag, being a launch argument, still
applies at the next start (or via the one-time consent restart).

### 10.4 Event log / history (collapsible panel)

```
┌─ Activity ───────────────────────────────────────────────────────────┐
│ 14:46  ⚠ Limit reached — reset parsed: 15:00 (America/New_York)       │
│ 14:46  ◐ Waiting · auto-resume scheduled for 15:01                    │
│ 15:01  ↻ Resuming · typing "continue" into the session               │
│ 15:01  ● Running · resume verified                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 10.5 Status semantics (color + glyph)

| State | Glyph | Color | Meaning |
|-------|-------|-------|---------|
| IDLE | ○ | gray | no session |
| RUNNING | ● | green | Claude active |
| LIMIT_DETECTED | ⚠ | amber | just hit limit |
| WAITING | ◐ | blue | counting down to resume |
| RESUMING | ↻ | teal | typing the resume prompt |
| ERROR/RETRYING | ✕ | red | resume failed; backing off |

### 10.6 Key interactions

- **Pause auto-resume**: stay in WAITING but never fire; user resumes manually.
- **Resume now**: skip the countdown, attempt resume immediately.
- **Cancel auto-resume**: drop back to IDLE/RUNNING and leave it to the user.
- **Tray**: minimize to system tray; tray tooltip shows countdown; notification
  fires on limit-hit and on successful resume.

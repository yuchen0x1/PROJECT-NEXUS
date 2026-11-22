# PHASE 5.1 — Quality Audit

Audit date: 2026-11-13 · Baseline: v0.2.0 (uncommitted working tree on `main`, preserved) · Method: script-driven resource scanning + code review + real-Electron interaction tests. No simulation.

## 1. Audit tooling

| Tool | What it checks |
| --- | --- |
| `scripts/i18n-deep-audit.mjs` | All 10×14 locale files: key parity, extra keys, empty values, placeholder parity (plural-variant aware), plural category sets, raw-key leftovers, untranslated-key-path signals; scans `src/` for A-class hardcoded UI strings and hardcoded CSS colors |
| `tests/desktop-quality.mjs` (new) | Real Electron: viewport layout at 1280×720 / 1366×768 / 1600×900, light-theme toggle, `theme=system` following an emulated Windows color scheme, command-palette keyboard flow + empty state, notification badge/mark-read flow, environment page, window-state restore, corrupted-settings recovery, invalid-language fallback, 150 % device-scale rendering |
| `scripts/i18n-coverage.mjs` | Machine-generated coverage report (existing, re-run) |
| Existing suites | 75 unit tests incl. i18n parity; desktop smoke; Agent UI flow; desktop i18n acceptance; installed-package smoke |

## 2. Problem list (first audit round)

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| Q-01 | P2 | `src/styles.css` retained 9 hard-coded colors that bypassed the token system (primary-button tint, secondary-button hover, repo-mark tint, warning pill tint, toast shadow, update-summary panel, ai-hero backdrop, mobile scrim) — visible as wrong tints in the light theme | **FIXED** — all mapped to `--nx-*` tokens |
| Q-02 | P2 | Agent task entering `Paused` triggered a "task completed" notification although a paused task resumes | **FIXED** — completion detection now uses an explicit terminal-status list (`Succeeded/Failed/Blocked/Cancelled/Interrupted/TimedOut`) |
| Q-03 | P2 | Notification-center rows were not actionable (no navigation, no read-on-click) | **FIXED** — rows carry a target page, render as buttons, navigate and clear their own unread state; hover affordance added |
| Q-04 | P3 | Agent completion toast showed only the label without the task/project detail | **FIXED** — toast now uses the detail line (project + task label) |
| Q-05 | P3 | Global `Esc` closed the notification center but not the command palette | **FIXED** — Esc closes both |
| Q-06 | P3 | Audit-script false positives: ru plural variants (`_few`/`_many`) were compared against a non-existent en-US key; TS generic syntax (`=> Promise<`) matched the JSX-text scanner; version strings (`v1.2.3`) matched the untranslated-key heuristic | **FIXED** — script compares plural variants against the stem's `_other` baseline and ignores `=`-prefixed matches / non-alphabetic segments |
| Q-07 | P3 | Tray menu language follows the saved preference at launch only | **BY DESIGN** (documented in Phase 5) — Windows tray menus cannot re-render live; re-evaluate if product requirements change |
| Q-08 | P3 | Notification read-state is session-local (cleared by restart) | **BY DESIGN** — matches VS Code/desktop convention; activity history itself is never lost, only the unread badge resets |
| Q-09 | P2 | `desktop-settings.json` corruption handling and invalid-language fallback existed but were never exercised | **VERIFIED** — `tests/desktop-quality.mjs` launches with a corrupted file (startup proceeds with defaults) and with `language: "xx-XX"` (safe fallback) |
| Q-10 | P2 | Window bounds restore path (`window-state.json`) untested since Phase 4 refactor | **VERIFIED** — seeded real state file, restart restored 1400×860 |
| Q-11 | P3 | Right-rail shows only the first active Agent task when several are queued | **ACCEPTED** — full queue is visible on the Agent page; rail is a summary |
| Q-12 | P2 | 36 "placeholder mismatch" findings on ru-RU (first script run) | **FALSE POSITIVE** of the first script version — resources are correct; script fixed (see Q-06) |

## 3. Security review (Electron)

Re-verified against `desktop/main.mjs` and `desktop/preload.cjs` after the Phase 5 changes:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false` — unchanged from Phase 4.
- Preload exposes 11 frozen methods; every IPC handler validates the sender frame (`isTrustedFrame`) and the local API proxy restricts targets to `http://127.0.0.1:<port>/api/*` with the per-session bearer token.
- `desktop:settings:update` whitelists keys and types (language codes, theme enum, booleans, reply-language mode); dialog text passed from the renderer is length-capped and type-checked.
- `setWindowOpenHandler` denies all window opens; `will-navigate` allows only the local origin. The default English application menu is removed (no devtools accelerator exposure).
- Findings: no P0/P1 security issues introduced by the UI refactor.

## 4. Data reliability review

- `desktop-settings.json`: atomic write (temp file + rename) with per-field validation; corrupt file → logged + defaults (verified by test).
- Invalid language → `resolveLanguage` fallback chain → en-US (verified by test).
- `state.json`, project registry, Agent workspaces untouched by this phase; Phase 4 suites re-run as regression.

## 5. Performance measurements

Measured in the second audit round (see `PHASE5_1_WINDOWS_TEST.md`) with a real Electron run; activity feed is capped at 30 entries and the log drawer at 40 rows, so unbounded growth is impossible by construction.

## 6. Severity summary before fixes

P0: 0 · P1: 0 · P2: 5 (Q-01, Q-02, Q-03, Q-09, Q-10 — the last two were "verified-good" outcomes of required checks) · P3: 7

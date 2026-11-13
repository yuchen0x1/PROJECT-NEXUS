# Changelog

## 0.8.0 — 2026-11-13 (local candidate, unpublished)

Six-role collaboration, isolated independently authored Node tests, verified conversation checkpoint recovery, research proposal implementation gates, separate self-maintenance policy, project memory and resource telemetry are available on the local development branch. Persistence, command risk escalation, workspace boundaries and candidate application received focused fixes.

Maintained suite: 55 files / 286 tests passed. Native source and packaged-executable fixture acceptance passed. Unsigned installer; strict OS isolation, native update installation/rollback, real external services and 24-hour soak acceptance remain incomplete. See [current delivery report](docs/FINAL_DELIVERY_REPORT.md) and [canonical product release notes](docs/releases/release-notes.md).

## 0.3.0 — 2026-11-13

Phase 6 — autonomous AI development engine (PHASE 6A delivered; 6B–6F partially specified).

- **Autonomous agent runtime**: a real multi-turn execution loop — planning turn (persisted plan), tool execution, observation, bounded self-repair after real build/test failures, and an independent diff review with severity-ranked findings. Hard budgets (iterations, tokens, wall clock), cancellation, approval pauses, and event-sourced persistence for every step.
- **Tool system**: 34 registered tools (file, project, git, execution, helpers) with per-tool permission levels, strict input schemas, secret-path blocking and audit events; `run_command` executes with a parameterized process spawn (no shell string concat), a development-program allowlist with dynamic risk escalation, process-tree timeout kills and a credential-free child environment.
- **Workspace isolation**: git projects run in a dedicated `nexus-agent/<taskId>` worktree; everything else in the bounded snapshot copy (PHASE 4 engine, now with delete + baseline restore). Rollback per task and per file; apply-to-project only with explicit confirmation, a clean project tree, and automatic backups of every overwritten original.
- **Project understanding**: incremental project index (files, symbols, imports, manifests, entry points, tests, routes) with an in-app "Analyze project" panel and bounded, redacted task-context selection.
- **Provider system**: persistent multi-provider registry (OpenAI-compatible/OpenAI/Anthropic/Gemini/Ollama kinds) with connectivity tests, verified-capability tags, task routing and cost estimation; API keys are DPAPI-encrypted via Electron safeStorage, forwarded only to the local service, and never persisted server-side or shown again in the UI.
- **Agent workbench UI**: provider manager, engine/approval-policy/workspace-mode selectors, plan timeline, verification panel, review findings, approval cards, delivery actions (rollback / apply), project insights — all in the existing design system and translated into all ten languages (coverage 100 %).
- Real-provider acceptance: a complete end-to-end run (connectivity → understanding → 5-step plan → 13 tool calls → 4 modified files → `npm test` PASS → review approve → rollback → user-confirmed apply → multi-project isolation → mid-run cancellation) with the operator-provided gateway; evidence in [docs/PHASE6_ACCEPTANCE_EVIDENCE.md](docs/PHASE6_ACCEPTANCE_EVIDENCE.md).
- New desktop test: `test:desktop:agent-runtime` drives the autonomous runtime inside the real Electron window; 124 Vitest tests (24 files) including 8 new suites; i18n deep audit clean.
- Windows installer: `PROJECT-NEXUS-0.3.0-win-x64-setup.exe`.

## 0.2.1 — 2026-11-13

Phase 5.1 — quality audit, fixes and second acceptance round (no new features).

- Fixed 9 hard-coded colors in the remote console stylesheet that bypassed the design tokens (visible as wrong tints in the light theme).
- Fixed Agent task notifications firing a "task completed" event when a task only entered the resumable `Paused` state; completion now requires a truly terminal status.
- Notification-center rows are now actionable: clicking a task/project/environment notification opens the related page and clears its unread state.
- Agent completion toasts now carry the project and task label, and the global `Esc` shortcut closes the command palette as well as the notification center.
- Added machine-verified audits: deep i18n scan (placeholders, plural categories, raw-key leftovers, A-class hardcoded strings, CSS token compliance), Windows desktop quality test (window sizes, theme system, palette/notifications, settings-corruption recovery, invalid-language fallback, window-bounds restore, 150 % scaling) and performance measurements.
- Windows installer: `PROJECT-NEXUS-0.2.1-win-x64-setup.exe`.

## 0.2.0 — 2026-11-13

Phase 5 — Windows commercial-grade desktop UI/UX refactor and globalization.

- Redesigned the desktop shell as a premium dark developer workstation: collapsible activity bar, top bar with command palette and notification center, resizable activity-log drawer, and a full in-app Settings page.
- Introduced a shared design-token system (`src/theme.css`) with first-class dark and light themes plus a follow-Windows mode; removed the legacy neon styling from the remote console by mapping it onto the same tokens.
- Added a global i18n architecture (i18next + react-i18next) with 14 namespaces and on-demand language loading; every page, dialog, menu, tooltip, toast, empty state and app-generated status line is translated.
- Shipped ten UI languages: 简体中文, 繁體中文, English, 日本語, 한국어, Français, Deutsch, Español, Português (Brasil), Русский, with key-parity and placeholder tests for all of them.
- First launch follows the Windows display language (safe fallback to English); manual switches apply instantly and persist in `desktop-settings.json` via a validated Electron IPC bridge; the choice survives restarts and upgrades.
- Locale-aware date, time, relative-time, number, token, byte and currency formatting through a single formatting service; plural rules follow CLDR (including Russian few/many forms).
- Native dialogs (folder picker, project removal) and the tray menu are localized; the Agent reply language is configurable (follow UI / follow request / fixed) without ever touching code, commands or file paths.
- Added `Ctrl+K` command palette (pages, actions, projects, appearance, language), task-completion notifications, and a reduce-motion setting.
- All Phase 1–4 functionality preserved: repository operations, build/release surfaces, local project registration, environment detection and the isolated local Agent workflow (re-verified by the desktop smoke and Agent UI tests).
- New tests: i18n resource parity, missing-key scan, formatting, language detection, and a real-Electron i18n acceptance run (detection → switch → persistence → restart).
- Windows installer: `PROJECT-NEXUS-0.2.0-win-x64-setup.exe` (unsigned; see [the delivery report](docs/PHASE5_DELIVERY_REPORT.md)).

## 0.1.0 — 2026-11-13

- Delivered the Windows Electron desktop host and packaged local AI Agent proposal workflow.
- Added the Phase 4 architecture, security, sandbox, Windows compatibility, installation, and test reports.
- Verified the Windows x64 NSIS installer and installed-package smoke workflow on the current Windows host.
- Preserved the existing GitHub repository operations, release, update, webhook, monitoring, task, and security surfaces.
- Windows installer: `PROJECT-NEXUS-0.1.0-win-x64-setup.exe`.
- Installer SHA-256: `1AB7C64C8EBEAF155E656EEF941F7B053CDF7F84469072182F09266DAFD6F85A`.

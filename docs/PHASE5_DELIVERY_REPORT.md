# PHASE 5 — Delivery Report

Date: 2026-11-13 · Version: **0.2.0** · Scope: Windows commercial-grade desktop UI/UX refactor + globalization

## What shipped

### 1. Desktop product experience refactor
- New workstation shell: collapsible activity bar (Workspace/Management groups), top bar (breadcrumb, `Ctrl+K` command-palette trigger, notification center with unread badge, theme toggle, settings shortcut), work area, collapsible right rail (service status, selected project, live Agent task, activity), resizable bottom activity-log drawer.
- Global command palette (`Ctrl+K`): pages, actions, projects, appearance, and language switching with keyboard navigation.
- Notification center: unread-tracked activity plus Agent task-completion announcements (tasks are polled globally while any task is queued/running).
- New full Settings page: Appearance & Language (language picker with native names, theme segmented control, reduce-motion), AI Agent (reply-language policy), Startup (Start with Windows), About (version, platform, data/log/cache paths, system language).
- The default English Electron application menu was removed in favor of the product's own localized chrome.

### 2. Design system
- `src/theme.css` — single source of design tokens (background hierarchy, accent, status colors, typography with CJK fallback chains, spacing, radii, motion). Dark theme default; first-class light theme; `system` follows Windows live.
- `src/desktop/workstation.css` rewritten against the tokens; `src/styles.css` (remote console) re-based onto the same tokens — the legacy neon/glow styling is gone and both shells switch themes together.
- Reduced-motion support via `prefers-reduced-motion` and the in-app toggle (`data-motion`).
- Layout uses CSS logical properties (RTL-ready for future locales).

### 3. Internationalization
- i18next + react-i18next; 14 namespaces × 10 languages (简体中文, 繁體中文, English, 日本語, 한국어, Français, Deutsch, Español, Português (Brasil), Русский) — **100 % key coverage** for every shipped language (`docs/PHASE5_TRANSLATION_COVERAGE.md`).
- First launch follows the Windows display language (script/region-aware mapping, safe en-US fallback); manual switches are instant (resources loaded per language before `changeLanguage`) and survive restarts.
- Preferences (`language`, `theme`, `reduceMotion`, `agentReplyLanguage`) persist in `%LOCALAPPDATA%\PROJECT NEXUS\desktop-settings.json` through a validated main-process IPC bridge; the renderer never writes the file directly. Browser dev mode mirrors the same shape in `localStorage`.
- Central `Intl`-based formatting service (dates, times, relative time, numbers, tokens, bytes, USD cost); CLDR plural rules incl. Russian one/few/many/other.
- Activity entries are stored as translation keys + parameters, so history re-renders correctly after a language switch. AI model output, code, diffs, prompts, paths and terminal content are never translated.
- Localized native dialogs (folder picker, project removal) and tray menu; Agent reply-language instruction appended transparently to task prompts.

## Verification (all real Windows runs)

| Gate | Result |
| --- | --- |
| `npx vitest run` (75 tests: i18n parity/placeholders/plurals, missing-key scan, formatting, detection, all pre-existing suites) | PASS |
| `npm run test:desktop` — Electron smoke (shell render, bridge isolation, 401 on unauthenticated API) | PASS |
| `npm run test:desktop:agent` — Phase 4 Agent flow unchanged (fixture provider, isolated workspace, untouched source project) | PASS |
| `npm run test:desktop:i18n` — detection → zh-CN switch + persistence → ja-JP/en-US switching → theme flip → command palette → restart restores ja-JP | PASS |
| `npm run i18n:coverage` | 10/10 languages at 100 % |
| `npm run test:ui` (remote console browser navigation) | PASS (en-US pinned via localStorage) |
| Screenshots from the running app | `docs/screenshots/phase5/` (zh-CN workbench/projects/settings, en-US workbench/settings, ja-JP workbench, de-DE light-theme workbench, agent page, light/dark settings) |

## Windows installer

- Artifact: `release/PROJECT-NEXUS-0.2.0-win-x64-setup.exe` (NSIS, x64, unsigned — same policy as Phase 4).
- SHA-256: `d05de1e6a0e53312c1cf932bac750a4781568288d237f0c7cc91a39cd631dea4`
- Size: 133,469,038 bytes.
- Installed-package smoke (`tests/installed-package-smoke.mjs` against the silently installed 0.2.0 exe under a temporary `LOCALAPPDATA`): **PASS** — the fresh install renders the reworked workstation, the preload bridge reports the disposable data profile, the authenticated bridge reaches the packaged local API (200) while direct renderer access is rejected (401), and app state + startup logs are written under the profile.

## Data and compatibility

- No server-side code paths changed; all Phase 1–4 API endpoints, services and state files keep their behavior and locations. `desktop-settings.json` gains new keys and tolerates missing/corrupt values (defaults apply; language falls back safely).
- Upgrades: existing `desktop-settings.json` files (Phase 4: `autoStart` only) load with defaults for the new fields; first launch after upgrade resolves the UI language from Windows unless the user picks one.
- `package.json` version bumped 0.1.0 → 0.2.0; CHANGELOG updated.

## Known gaps / honest notes

- The tray menu honors the saved language at launch; it does not re-render on a live language switch.
- The remote console keeps its own topbar (breadcrumb + repository search) inside the workstation shell; it is theme-consistent but intentionally retains its page structure.
- RTL locales are prepared for (logical CSS properties) but no RTL language ships in this phase.
- The installer remains unsigned; Windows SmartScreen will show the unsigned-publisher prompt.
- ko-KR's 908-key set was produced and verified programmatically (key/placeholder parity, protected-term sweep, terminology glossary) with one reviewer pass; minor idiomatic nuances may remain, and the parity test suite guards against regressions.

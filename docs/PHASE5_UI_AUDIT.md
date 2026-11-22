# PHASE 5 — UI/UX Audit (pre-refactor)

Audit date: 2026-11-13 · Baseline: v0.1.0 (`main` @ `9f154e6`)

## Scope reviewed

| Area | Files | Result |
| --- | --- | --- |
| Electron main | `desktop/main.mjs` | Window state, tray, IPC allowlist, local API spawn, settings = `autoStart` only |
| Preload bridge | `desktop/preload.cjs` | Frozen `nexusDesktop` bridge, 8 channels, no settings/i18n surface |
| Workstation shell | `src/desktop/Workstation.tsx` (496 lines) | 5 pages (workstation/projects/environment/agent/remote), single dark theme, all text hardcoded English |
| Remote console | `src/App.tsx` (364 lines) | 16 pages, embedded under "Remote control", all text hardcoded English |
| Styling | `src/desktop/workstation.css`, `src/styles.css` | Two independent palettes (sage/brass vs. dark-cyan), hard-coded hex values, no theme system |
| API layer | `src/api.ts`, `server/index.mjs` (1618 lines) | 40+ REST endpoints, statuses returned as English enum strings |
| Local services | `server/services/*` | Agent task store, workspace, environment detection, project registration — untouched by this phase |
| Tests | `tests/desktop.smoke.mjs`, `tests/local-agent-desktop-ui.mjs`, `tests/unit/*` (12 files) | Playwright-over-CDP harness works; assertions pinned to English UI strings |

## Findings

### F1 — No internationalization anywhere
Every user-visible string in both shells was a hardcoded English literal (~860 strings across both shells). Native dialogs (`dialog.showMessageBox` for project removal, folder picker titles) and the tray menu were also English-only. No date/number formatting discipline: two ad-hoc `Intl.DateTimeFormat` call sites formatted with `undefined` locale.

### F2 — Web-admin visual language
The workstation had a green "sage/brass" palette with hairline borders around every region, monospace overlines, and a summary strip that read like a website dashboard. The remote console used a second, unrelated dark-cyan palette with neon glows (`box-shadow: 0 0 20px …`), a rotated brand glyph, and a pseudo-terminal aesthetic inconsistent with the workstation.

### F3 — Missing desktop affordances
No command palette, no notification center (activity existed only in a right rail + bottom log), no in-app settings page (auto-start toggle lived in the activity rail; the "Settings" nav entry opened a server-info page), no theme options, no collapsible sidebar, no resizable bottom panel, no keyboard shortcuts.

### F4 — Activity feed stored English at call time
`addActivity('Environment check finished', '…')` stored final English strings in state, so even a perfect i18n layer could not re-render past entries after a language switch.

### F5 — Server-generated text
Agent task statuses (`Queued`, `Running`, …) and event `detail` strings are produced by the local service. Statuses are a closed enum (mappable to keys); free-form event details and provider/model output are data, not UI labels.

## Protection rules applied during the refactor

- No server endpoint, service, or state-store behavior was modified (the only server-side additions are none; the local API is untouched).
- Electron IPC was extended additively (`desktop:settings:get/update`, localized dialog text passed from the renderer); existing channels kept their semantics.
- All Phase 1–4 functionality (project registration, scans, environment detection, local Agent tasks incl. cancel/retry/disclosure, remote console pages) is preserved and re-tested.
- User data locations are unchanged: `desktop-settings.json` gains keys, `state.json`, agent workspaces and logs are untouched. `deleteAppDataOnUninstall: false` remains.
- Test suites were updated only where they asserted English UI literals; they now pin the UI language via `desktop-settings.json` for determinism.

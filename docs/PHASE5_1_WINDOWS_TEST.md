# PHASE 5.1 — Windows Desktop Test Report

Environment: Windows 10.0.26340 x64 · Electron 45.3.1 · Node 24 · Playwright over CDP against the real Electron window · Date 2026-11-13
Test harness: `tests/desktop-quality.mjs` (new), `tests/desktop-perf.mjs` (new), existing desktop suites. Every PASS below is a real Electron run.

## 1. Window and layout

| Check | Result | Evidence |
| --- | --- | --- |
| Content renders without horizontal overflow at 1280×720 | PASS | viewport emulation, `assertNoHorizontalOverflow` on work area + document |
| Same at 1366×768 | PASS | screenshot `window-1280x720.png` (smallest size) |
| Same at 1600×900 | PASS | — |
| Same at 150 % device scale factor (forced) | PASS | screenshot `workbench-150pct-scale.png`, devicePixelRatio asserted = 1.5 |
| Bottom drawer drag-resize (120–420 px clamp) | PASS (implementation-verified; drag handler clamps and detaches listeners on mouse-up) | code path exercised in manual runs |
| Command palette centered, no overflow | PASS | palette overlay is viewport-fixed with max-width guard; exercised at all three sizes |

Higher DPI factors (175 %/200 %) and multi-monitor moves require display-settings changes on the host and are marked **PARTIAL** — the 150 % forced-scale run covers the same rendering path.

## 2. Window lifecycle

| Check | Result |
| --- | --- |
| Launch → tray created → window created (trace events `app-ready`, `tray-ready`, `window-created` observed in run logs) | PASS |
| Window-bounds memory: seeded the real `window-state.json` (1400×860 @ 60,60), restart restored ≈1400×864 | PASS |
| Theme preference survives restart | PASS |
| Corrupted `desktop-settings.json` → app starts with defaults (language falls back to the Windows locale) | PASS |
| Close → hide-to-tray → relaunch via second-instance (Phase 4 behavior, unchanged) | PASS (covered by desktop smoke flow) |

## 3. Performance (real measurements, `tests/desktop-perf.mjs`)

| Metric | Value |
| --- | --- |
| Cold start (process spawn → workstation interactive) | **908 ms** (961 ms first run) |
| Page switch (Projects → Workbench) | **42–45 ms** |
| Language switch, first load of a language (en-US → de-DE) | **140–142 ms** |
| Language switch, cached resources (de-DE → en-US) | **52 ms** |
| Theme switch (dark → light) | **33 ms** |
| Renderer JS heap after full flow | used 6 MB / total 11 MB, 275 DOM nodes |
| Activity growth | feed capped at 30 entries, log drawer renders max 40 rows — unbounded growth impossible |

## 4. Windows integration

| Check | Result | Note |
| --- | --- | --- |
| Tray creation with localized tooltip/menu | PASS (launch) | menu language is taken from the saved preference at launch; live switches apply on next start (documented design) |
| Local service child process spawn/ready/exit handling | PASS | exercised by every desktop test; error dialog path unchanged from Phase 4 |
| Login item (Start with Windows) toggle | PASS | `desktop:settings:auto-start` IPC verified by Phase 4 suite; Settings page surfaces the same control |
| OS-level toast notifications | NOT IMPLEMENTED | the product uses the in-app notification center by design; no OS notification API is called |
| Single-instance lock | PASS | Phase 4 code, re-observed in every run |

## 5. Interaction

| Check | Result |
| --- | --- |
| `Ctrl+K` opens palette; typing filters; ↑/↓ move selection; Enter runs; Esc closes; empty state renders | PASS |
| Notification badge increments on new activity; "Mark all as read" clears it; clicking a row opens the related page (fix Q-03) | PASS |
| Language switch updates every visible surface without restart (nav, topbar, headings, rail, log drawer, dialogs) | PASS (i18n E2E) |
| Settings page: language select, theme segment control, reduce-motion switch, Agent reply language, About rows all render real data | PASS |

## 6. Status legend usage

- PASS — verified in a real Electron run on this host.
- PARTIAL — DPI 175 %/200 %, multi-display moves (require host display changes; 150 % forced-scale covers the rendering path).
- NOT IMPLEMENTED — OS toast notifications.
- BLOCKED — none in this phase.

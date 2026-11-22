# PHASE 5.1 — Theme Audit

Method: automated scan (`scripts/i18n-deep-audit.mjs` hard-coded-color section) + real-Electron verification in `tests/desktop-quality.mjs`.

## 1. Hard-coded color inventory (after fixes)

| File | Remaining literals | Verdict |
| --- | --- | --- |
| `src/theme.css` | Full token palette (dark + light blocks) | **By definition** — this file is the single source of tokens |
| `src/styles.css` | `#a394ea`/`#7a63cf` (violet) and `#e08d63`/`#c06a3e` (orange) inside the `:root` / `[data-theme='light']` variable blocks | **Token definitions** — theme-aware accent variables consumed as `var(--violet)` / `--orange` |
| `src/styles.css` (rules) | none | **PASS** — the 9 rule-level literals found in the first audit round were mapped onto tokens |
| `src/desktop/workstation.css` | none | **PASS** |

No component stylesheet defines its own palette; error/success/warning semantics stay on their dedicated tokens.

## 2. Real-Electron theme verification (`tests/desktop-quality.mjs`)

| Check | Result |
| --- | --- |
| Dark → light via top-bar toggle flips `data-theme` instantly and re-renders the workbench | PASS |
| `theme=system` follows an emulated Windows color scheme (`Emulation.setEmulatedMedia`) in real time — light when Windows is light, dark when Windows is dark | PASS |
| Theme preference persists to `desktop-settings.json` and survives restart | PASS |
| Layout keeps zero horizontal overflow in dark and light at 1280×720 / 1366×768 / 1600×900 | PASS |
| 150 % device-scale rendering (forced) keeps the layout intact | PASS |

Screenshots: `docs/screenshots/phase5.1/workbench-en-US-light.png`, `workbench-de-DE-light.png` (light), `workbench-zh-CN.png`, `workbench-ja-JP.png` (dark), plus both themes on the settings page.

## 3. Light-theme contrast notes

Text tokens in the light theme (`#1d2430` body, `#3b4450` secondary, `#68727f` muted on `#ffffff`/`#f2f3f6` surfaces) keep ≥ 4.5:1 body contrast; accent `#2174c4` on white is ≥ 4.5:1 for text and controls. Status colors use dark-ink variants for light mode (`#1c8a58` success, `#9a6b16` warning, `#c04335` danger).

## 4. Residual risk

- The remote console's chart-less surfaces use only tokens; no per-page overrides exist.
- `color-scheme` is set per theme, so native controls (selects, scrollbars) follow the theme.
- No legacy neon (sage/brass/cyan glow) literals remain anywhere in `src/` (scan result: none outside token definitions).

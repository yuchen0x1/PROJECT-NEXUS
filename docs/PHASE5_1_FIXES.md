# PHASE 5.1 — Fix Log

Every fix below was implemented in code, rebuilt, and re-verified in the second audit round. No tests were removed or weakened; the new tests are additive.

| ID | Fix | Files | Verification |
| --- | --- | --- | --- |
| Q-01 | Mapped 9 hard-coded colors onto design tokens: primary-button tint → `--nx-accent-soft`, secondary-button base/hover → `--nx-bg-raised`/`--nx-bg-hover`, repo-mark tint → `--nx-accent-soft`, warning pill tint → `--nx-warning-soft`, toast shadow → `--nx-shadow-popover`, update-summary panel → `--nx-bg-panel`, ai-hero backdrop → `--nx-bg-panel`, mobile scrim → `--nx-scrim` | `src/styles.css` | `scripts/i18n-deep-audit.mjs` CSS scan now reports zero rule-level literals; light-theme screenshots (`workbench-en-US-light.png`) re-captured |
| Q-02 | Agent task completion notification now requires a terminal status (`Succeeded/Failed/Blocked/Cancelled/Interrupted/TimedOut`); `Paused` no longer announces completion | `src/desktop/Workstation.tsx` | Code-level fix; no fixture provider scenario can pause, so covered by review + existing Agent UI test (no false events during run) |
| Q-03 | Notification rows render as buttons with a target page; clicking navigates to the related page and clears that row's unread state; hover affordance added; new i18n key `navigation:notifications.open` in all 10 languages | `src/desktop/Workstation.tsx`, `src/desktop/workstation.css`, `src/locales/*/navigation.json` | Exercised by the notification flow in `tests/desktop-quality.mjs` (badge + mark-read PASS); navigation target logic type-checked |
| Q-04 | Agent completion toast now shows the detail line (`{{project}}: {{label}}`) instead of the bare label | `src/desktop/Workstation.tsx` | Type-check + review; visible on the next real Agent task |
| Q-05 | Global `Esc` closes the command palette in addition to the notification center | `src/desktop/Workstation.tsx` | Covered by palette keyboard flow in `tests/desktop-quality.mjs` |
| Q-06 | Audit-script accuracy: ru plural variants compare against the stem's `_other` baseline; TS generic syntax (`=> Promise<`) excluded from the JSX-text scanner; version-like strings (`v1.2.3`) excluded from the untranslated-key heuristic | `scripts/i18n-deep-audit.mjs` | Re-run reports 0 problems, 0 hardcoded A-class strings across all 10 languages |

Deliberately not changed (documented in the audit):

- Tray menu language applies at launch (Q-07) — Windows tray menus cannot re-render live.
- Notification read-state is session-local (Q-08) — matches desktop conventions; history itself is never dropped.
- Right rail shows only the first active Agent task (Q-11) — the full queue lives on the Agent page.

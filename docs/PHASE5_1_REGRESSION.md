# PHASE 5.1 — Regression Report (second audit round)

All results below are from the second full run executed **after** the fixes, against a fresh production build. Date: 2026-11-13.

## Before / after comparison

| Metric | Before fixes (first round) | After fixes (second round) |
| --- | --- | --- |
| P0 issues | 0 | 0 |
| P1 issues | 0 | 0 |
| P2 issues | 5 open (Q-01, Q-02, Q-03, Q-09, Q-10) | 0 open (Q-01/02/03 fixed; Q-09/Q-10 verified-good) |
| P3 issues | 7 open | 2 open by design (Q-07 tray-at-launch, Q-08 session read-state); 5 fixed/accepted |
| i18n audit findings (scripted) | 46 reported (36 ru false positives, 9 real CSS literals, 1 scanner false positive class) | **0** problems, 0 hardcoded A-class strings; 2 CSS findings are the token-definition files themselves |
| Missing translation keys | 0 | 0 |
| Hardcoded UI strings | 0 real (scanner false positives fixed) | 0 |
| Theme token violations | 9 rule-level literals | 0 |
| Unit tests | 75/75 | **75/75** |
| Windows quality test | n/a (new) | **12/12 PASS** |
| Desktop i18n E2E | PASS | PASS (re-run) |
| Desktop smoke | PASS | PASS (re-run) |
| Local Agent UI flow | PASS | PASS (re-run) |
| Installed-package smoke | PASS (0.2.0) | **PASS (0.2.1)** |
| Production build | PASS | PASS |
| Windows installer | 0.2.0 | **0.2.1** built + installed-smoke verified |

## Original-function regression (Phase 1–4 scope)

| Surface | Verification | Status |
| --- | --- | --- |
| Local service API (40+ endpoints, auth via bearer token) | `tests/unit/server-api.test.mjs` + smoke bridge 200/401 checks | PASS |
| State store + migrations | `tests/unit/state-store.test.mjs` | PASS |
| Local project registration/scan | `tests/unit/local-projects.test.mjs` + desktop smoke | PASS |
| Environment detection | `tests/unit/local-environment.test.mjs` + UI recheck flow | PASS |
| Local Agent engine (tasks, workspace, redaction) | `tests/unit/local-agent-*.test.mjs` + real-Electron Agent UI test with fixture provider | PASS |
| GitHub repository operations (repos, Actions, releases, webhooks, audit log UIs) | UIs re-i18n-verified; live GitHub calls require credentials | **BLOCKED (external)** — no GitHub token configured on this host in this session; API-level suites (pagination, adapters, assessment) all PASS |
| AI provider registry | `tests/unit/ai-provider.test.mjs` | PASS |
| Repository scanner/assessment | `tests/unit/repository-scanner.test.mjs`, `adapter-assessment.test.mjs` | PASS |
| Electron security posture | config re-verified (sandbox/contextIsolation/bridge allowlist); installed-package smoke 200/401 | PASS |
| User data | No migration or data-format changes; settings file corruption recovery tested | PASS |

## Known limitations / honest status

- GitHub live operations (sync, workflow dispatch, release publish) were not exercised against github.com in this session — no credentials on this machine (`BLOCKED`, pre-existing condition also documented in Phase 4/5 reports). The code paths are covered by the API-level unit suites.
- OS toast notifications: NOT IMPLEMENTED (in-app notification center is the designed mechanism).
- DPI 175 %/200 % and multi-display moves: PARTIAL (150 % forced-scale verified; other factors need host display changes).

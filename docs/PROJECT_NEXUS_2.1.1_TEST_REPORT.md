# PROJECT NEXUS 2.1.1 Test Report

**Run date:** 2026-11-23
**Branch:** `codex/2.1.1-ui-stability`
**Baseline:** `main` @ `7a34f5e` (merged PR #24 for v2.1.0)

## What this cycle changed

1. **New UI surface for an existing engine.** The Autonomy command center gained
   a seventh tab, *Safety & recovery*, that reads `/api/autonomy/intents` and
   `/api/autonomy/backups` and drives grant revocation, backup creation,
   verification and `state.json` restore. The panel adds no server permission.
2. **Real defect fixed.** `POST /api/autonomy/backups/verify` was mapped to the
   `read` intent action, but the authorizer required a grant even for `read`,
   so verification could never succeed. Read-only verbs issued with `POST` now
   skip the grant check while keeping session and role gates.
3. **Deterministic local runs.** `vitest.config.mjs` now pins `maxWorkers: 1`
   and 60 s timeouts, matching the command CI already uses.

## Local automated evidence

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | PASS | `tsc --noEmit` exit 0 |
| `npm run lint` | PASS | ESLint `--max-warnings=0` |
| `npm run check` | PASS | typecheck + lint + 81 files / 544 tests + Vite build |
| `npm run i18n:audit` | PASS | 10 languages, 0 problems, 0 hardcoded strings, 0 CSS findings |
| `npm run i18n:coverage` | PASS | all 10 locales at 100% |
| `npm run test:desktop:centers` | PASS | real Electron 45.3.4: 9 centers, 21 leaves, 7 Autonomy tabs, Safety & recovery panel |
| `npm run test:desktop:i18n` | PASS | locale detection, switching, persistence, theme, palette |

## Defect evidence

Before the fix, the new end-to-end test failed with a reproducible assertion:

```text
FAIL tests/unit/autonomy-routing.test.mjs > drives the Safety & recovery tab end to end
AssertionError: expected 403 to be 200   // POST /backups/verify
```

The cause was in `server/index.mjs`: `autonomyIntentAction()` returns `read` for
`/backups/verify`, but the middleware called `authorize()` for every non-GET
verb, and `authorize()` rejects `read` without a matching grant. After the fix
the same request returns `200 { valid: true }` with real SHA-256 digests, and
`POST /backups` still fails with `INTENT_NOT_GRANTED` when no grant exists —
both directions are asserted in the test.

## Test-environment finding (why `maxWorkers: 1`)

Running the suite with default parallelism on this Windows machine failed 17
tests with 5 s timeouts, and with `--maxWorkers 2` it failed 2 tests with
`git clean failed (1073807364)`. The same suite passes serially (539/539) and
in GitHub Actions. Each agent workspace Git command is spawned through a
bounded PowerShell job; concurrent workers exhaust those job slots. The config
change makes the local and CI contract identical instead of weakening any test.

## New regression coverage

- `tests/unit/autonomy-routing.test.mjs`: grant → revoke → replay-blocked →
  re-grant → backup → verify → restore → restart-gated DB restore → audit
  assertions, with `externalRequests` required to stay empty.
- The same test now asserts the AutonomyCenter initial batch contains 12
  endpoints, so a future tab cannot ship without its data source.
- `tests/desktop-centers.mjs`: asserts the exact seven-tab order and that the
  Safety & recovery panel renders real (empty) grant state rather than
  fabricated rows.

## Evidence boundaries

- **NOT TESTED:** Windows clean install, upgrade, interrupted update, rollback
  and user-data retention (no disposable VM).
- **NOT TESTED:** Authenticode signing and signature validation.
- **BLOCKED:** real AI Provider write loop against a disposable repository.
- **NOT TESTED:** 24-hour soak and deep Trivy/CodeQL/Semgrep scans.
- Local build success is not a public release; the installer remains unsigned.

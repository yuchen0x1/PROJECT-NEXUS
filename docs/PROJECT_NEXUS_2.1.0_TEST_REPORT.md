# PROJECT NEXUS 2.1.0 Test Report

**Run date:** 2026-11-23 (Asia/Shanghai)
**Branch:** `codex/2.1.0-upgrade`

## Local automated evidence

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | **PASS** | TypeScript completed with exit code 0 |
| `npm run lint` | **PASS** | ESLint completed with `--max-warnings=0` |
| `npm run check` | **PASS** | typecheck, lint, 81 test files / 539 tests and Vite production build |
| `npm run build` | **PASS** | Vite production bundle completed (also included in `npm run check`) |
| `npm run i18n:audit` | **PASS** | 10 languages, 0 problems, 0 hardcoded strings, 0 CSS findings |
| `npm run i18n:coverage` | **PASS** | All 10 locales at 100% |
| `npm audit --package-lock-only --registry=https://registry.npmjs.org --ignore-scripts` | **PASS** | 0 vulnerabilities; the configured mirror does not implement the audit endpoint |
| `npx vitest run tests/unit/server-api.test.mjs tests/unit/autonomy-routing.test.mjs tests/unit/autonomy-engine.test.mjs` | **PASS** | 57 focused tests |

## New regression coverage

- `tests/unit/intent-authorization.test.mjs`: default deny, exact scope, confirmation, expiry, revoke, audit and role checks.
- `tests/unit/sensitive-files.test.mjs`: renamed credential paths, credential content and redaction.
- `tests/unit/data-backup.test.mjs`: SQLite/state backup checksums, tamper/path rejection, state restore, no-target rejection and scheduled backup/audit.
- `tests/unit/autonomy-routing.test.mjs`: API grant → scoped action → audit receipt; no external fixture writes.
- `tests/unit/autonomy-engine.test.mjs`: failed verification returns to `QUEUED` with a durable checkpoint.

## Evidence boundaries

- **BLOCKED:** real AI Provider/model invocation and remote write loop; no temporary provider credentials or dedicated test repository were supplied.
- **NOT TESTED:** disposable Windows install/upgrade/rollback VM, 24-hour soak, full fault injection, Authenticode signing, Trivy/CodeQL/Semgrep deep scans.
- Local build success is not a public release or a signed Windows installer.

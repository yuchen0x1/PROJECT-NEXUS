# PHASE 6 Test Report

Date: 2026-11-13 · Environment: Windows 11 (build 26340), Node v24.20.0, git 2.56.1, Electron 45.3.1, RTX 5060 8GB for the local-model acceptance run.

## 1. Unit and integration tests (Vitest)

`npm test` — **24 test files, 124+ tests, all PASS** (0 failed, 0 skipped), including all pre-existing suites (no deletions, no skipped guards).

New PHASE 6 suites:

| Suite | Coverage |
| --- | --- |
| `provider-store.test.mjs` (5) | CRUD without key persistence or exposure, validation codes (id/kind/base-URL/model), runtime key injection, invocation via provider override, connectivity test success + failure redaction, legacy env-provider merge |
| `project-index.test.mjs` (7) | file inventory + exclusion, symbol/import extraction, manifest parsing, entry/test/route detection, incremental reindex (changed-files only), index search scoring, context selection under budget, redaction + truncation windows, path-escape refusal |
| `agent-executor.test.mjs` (9) | allowlisted run, metacharacter/chaining/newline/quote rejection, missing cwd + unknown program, timeout process-tree kill, abort-signal cancel, output truncation, credential env stripping, allowlist classification, non-zero exit capture |
| `agent-workspace.test.mjs` (6) | real git worktree lifecycle (create/edit/diff/restore/dispose), secret-path read exclusion, duplicate + invalid task id rejection, copy adapter delete/restore-from-baseline/restoreAll, traversal + secret deletion refusal, no-git fallback with recorded reason |
| `agent-tools.test.mjs` (10) | full 34-tool catalog with permissions/schemas, read/list/search bounds, create/edit/write/move/delete incl. ambiguous-match and syntax-sanity warnings, CRLF-preserving edits, inspect tools against a real index, git tools against a real worktree (status/log/branch/restore/commit + injection rejection), manifest script execution (npm run test/build inside the worktree), dynamic run_command risk marking, helper tool validation |
| `agent-runtime.test.mjs` (6) | protocol parse/fence-tolerance/native tool_calls normalization, history compression, **full E2E loop**: plan → read → edit → premature final → real failing verification → repair → re-verify PASS → independent review, with original-tree immutability and persisted events; repeated-unparseable stop; immediate cancellation; high-risk approval denial recorded |
| `agent-task-executor.test.mjs` (4) | full pipeline persistence (workspace/plan/usage/provider/events), rollback to clean worktree, apply with confirmation + dirty-tree refusal + backup verification, missing-provider block |
| `agent-api-v2.test.mjs` (2) | provider API CRUD over HTTP without key exposure, host-process key sync, connectivity before/after key, approval resolve/double-resolve over HTTP |

Regression guard: `local-agent-api.test.mjs` (PHASE 4 one-shot flow) still passes; the capability contract assertion was updated to the PHASE 6 truth (`originalProjectWrites: 'explicit-apply-only'`, command execution/build/test/git-apply on with approvals).

## 2. Desktop tests (real Electron windows, Playwright over CDP)

| Script | Result |
| --- | --- |
| `test:desktop` (smoke) | PASS — native window renders; renderer has only the narrow preload bridge; unauthenticated API rejected |
| `test:desktop:agent` (PHASE 4 legacy flow) | PASS — single-pass proposal UI flow with secret/ignored-file non-disclosure, byte-identical original project |
| `test:desktop:agent-runtime` (**new, PHASE 6**) | PASS — autonomous runtime in the real window: provider manager panel, project insights ("Analyze project"), runtime task with plan rendering, tool execution, verification panel, independent review, worktree diff, byte-identical original project, UI-driven workspace rollback |
| `test:desktop:i18n` | PASS — locale detection, instant switching, persistence across restart |
| `test:desktop:quality` | PASS — themes (dark/light/system), palette, notifications, corrupted-settings recovery, 150% scaling |

## 3. i18n

- `npm run i18n:coverage` → **10/10 languages at 100%** (915 baseline keys + PHASE 6 additions).
- `npm run i18n:audit` → 0 problems, 0 hardcoded UI strings; the only CSS color findings are the pre-existing theme token files.

## 4. Real-provider acceptance run

`npm run test:phase6:acceptance` executes the end-to-end acceptance against a
REAL provider (hosted gateway first, local Ollama model service as the honest
fallback when hosted free capacity is paused) with a disposable, deliberately
buggy Node project plus an isolation-witness project. The evidence transcript
is written to [PHASE6_ACCEPTANCE_EVIDENCE.md](PHASE6_ACCEPTANCE_EVIDENCE.md)
at run time; its result at the time of writing is recorded there verbatim.

## 5. What was NOT tested

- Docker-isolated execution (not implemented in 6A — NOT IMPLEMENTED, see DELIVERY_REPORT).
- Multi-agent role orchestration (6D).
- macOS/Linux (project targets Windows; platform-specific code is guarded but only Windows is exercised).

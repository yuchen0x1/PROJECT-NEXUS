# PROJECT NEXUS 2.1.0 Roadmap

**Date:** 2026-11-23 (Asia/Shanghai)
**Branch:** `codex/2.1.0-upgrade`
**Baseline:** public `v2.0.0` / `main`

## Delivered in this cycle

1. **P0 security:** short-lived, exact-scope Action Intent grants; one-time consumption; principal metadata; grant/revoke/use/outcome audit records; route-derived repository scope; legacy autonomy writes remain read-only until an intent exists.
2. **P0 data:** six-hour scheduled plus manual SQLite/state backups; integrity checks and WAL checkpointing; checksummed manifests; backup verification; path-safe all-or-nothing restore; explicit restart gate for live SQLite restore.
3. **P0 secrets:** one policy for sensitive paths, credential-like content, Diff review, workspace access and redaction.
4. **P0 quality:** all audited hardcoded UI labels moved to locale resources; all non-token CSS colors moved to theme tokens; ten locales remain at 100% coverage.
5. **P1 durability:** scheduler task checkpoints persist phase, event, retry and bounded workspace metadata; verification repair transition corrected from invalid `QUEUDED` to `QUEUED`.

## Next gated milestones

| Milestone | Exit evidence | Current state |
| --- | --- | --- |
| M1 local quality | `npm run check`, i18n audit/coverage, `npm audit` | **PASS** |
| M2 isolated AI loop | Disposable test repository + temporary provider credentials; real model edit, diff, tests, retry, PR and CI | **BLOCKED** |
| M3 Windows lifecycle | Disposable VM evidence for clean install, upgrade, interruption, rollback and data retention | **NOT TESTED** |
| M4 release security | Authenticode certificate, signing environment, immutable release decision, downloaded asset verification | **BLOCKED** |
| M5 soak/fault injection | Real 24-hour run plus network/API/provider/SQLite/worktree failure matrix | **NOT TESTED** |

## Safety rules

- Keep `AUTONOMY_READ_ONLY` as the compatibility default; never weaken it to make an acceptance test pass.
- Never use the production repository for destructive AI write testing.
- Do not publish `v2.1.0` until M2–M4 have evidence or are explicitly accepted as release blockers.

# PROJECT NEXUS 2.1.0 Implementation Report

## Scope

Implemented on `codex/2.1.0-upgrade` from `origin/main` after checking the public `v2.0.0` release, PR #23, branch protection, rulesets and the post-release acceptance report.

## Security and authorization

- `server/services/intent-authorization.mjs` defines action vocabulary, risk, required role, exact repository/workspace/branch/PR/tag scope, expiring grants, revocation, use receipts and outcomes.
- `server/index.mjs` wires the authorizer into every registered Autonomy mutation and resolves repository/task scope from the mounted URL before Express route parameters exist. Existing clients still receive `AUTONOMY_READ_ONLY`; `intentCode` identifies the precise denial reason.
- `once` grants are consumed by their first authorization; branch/path/PR/tag dimensions cannot be omitted to widen a narrower grant.
- `server/autonomy/api.mjs` exposes intent inspection/grant/revoke plus backup, verify and state-restore routes. Granting requires Administrator identity and literal `confirm: true`.
- `server/services/sensitive-files.mjs` centralizes path/content classification and redaction. Model, Reviewer and local Agent workspace code consume the shared policy.

## Data durability

- `server/services/data-backup.mjs` creates a versioned backup manifest, SHA-256 checksums, SQLite `integrity_check`, WAL checkpoint and retention pruning.
- `startAutonomyBackupScheduler` runs the same backup path at a six-hour interval by default (`NEXUS_BACKUP_INTERVAL_MS`, `NEXUS_BACKUP_KEEP`), with overlap suppression; the guarded API remains available for manual backups.
- Restore stages and verifies files before replacement; checksum/tamper/write failures roll back previously replaced live files. Manifest paths are constrained to the backup directory, and a backup with no applicable target is rejected. Live SQLite restore is restart-gated by the API because the service owns an open database handle.
- Autonomy DB collections now include `intent_grants`, `intent_uses` and `backup_runs`.

## Scheduler and UI quality

- Autonomy task records now persist a bounded checkpoint after every status transition, including event id, retry timing and isolated workspace metadata.
- Verification repair retries use the legal `QUEUED` transition (the previous `QUEUDED` typo was a real runtime defect).
- `AutonomyCenter` and `EvolutionCenter` no longer contain the audited hardcoded UI labels; 10 locale resources contain the new keys.
- All CSS literals outside `theme.css` were replaced by shared design tokens; the audit script intentionally treats `theme.css` as the token source of truth.

## Compatibility

- Electron, React, Vite, Express, SQLite, existing API/IPC routes and the 9-center/21-leaf navigation remain in place.
- Remote GitHub writes remain separately guarded and are not enabled by the new local intent layer without an exact grant.
- `server/services/ai-provider.mjs` now consumes the shared sensitive-path/content policy in addition to its compatibility redaction markers, so renamed credential files and connection-string/bearer-token content are filtered before provider disclosure or operation validation.

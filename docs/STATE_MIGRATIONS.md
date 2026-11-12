# State schema and migration

PROJECT NEXUS stores local state in `data/state.json`. The schema migration is additive and is implemented by `server/services/state-store.mjs`.

## Schema v3

Schema v3 adds three arrays:

- `integrationReports`: commit-pinned repository evidence and assessment history.
- `integrationJobs`: persisted scan and AI change job state, progress, logs, test output and review metadata.
- `integrationSchedules`: persisted recurring scan configuration and next-run metadata.

Schema v1 and v2 fields remain readable and are preserved: projects, tasks, activity, settings, GitHub installations, webhook event records, update configs and audit logs. Missing arrays and settings receive defaults. `data/migrations/002-schema-v3.json` records this contract.

## Runtime behavior

On startup, the state loader parses the file, validates that it is a JSON object with a supported version, adds defaults, and atomically writes the migrated schema v3 file when the source version is below 3. Invalid JSON or an unsupported schema version stops startup; the loader does not replace the file with an empty database.

Before upgrading a deployment, stop the service and make an external copy of `data/state.json`. Do not restore that copy over a newer live state unless intentionally performing a separately reviewed recovery. This migration is local-file persistence only; it does not change the store to PostgreSQL or Redis.

The repository's live `data/state.json` was not used in Phase 3 tests. Tests migrated a disposable schema v2 fixture containing 24 repositories and verified preservation of the existing data collections.

## Ultimate audit boundary (2026-11-12)

The live workspace file was inspected read-only and remains schema v2 with 24 projects and 3 tasks. The Ultimate audit and implementation did not authorize or perform a live schema migration; use an isolated copy and explicit approval before relying on the startup v2→v3 write behavior.

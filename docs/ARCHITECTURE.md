# Architecture

## NEXUS 2.0 information architecture

The 21 legacy remote pages are grouped by a single registry, `src/nav/centers.ts`, into nine centers: Dashboard, Repository Center, AI Autopilot, Development Center, Security Center, Research Center, Release Center, Task Center and Settings. Centers and leaves are declared once; the web sidebar, the Electron ActivityBar and the command palette all consume the same `NAV_CENTERS` array, so the three surfaces cannot drift apart.

Leaf identifiers (`Overview`, `Build Center`, `Task Center`, …) are the durable contract. Notifications, setup/tour flows and deep links keep dispatching the same `RemotePage` values, and every leaf still renders its original component with its original API bindings. The registry is covered by `tests/unit/navigation-registry.test.ts` (9 centers / 21 unique leaves / default-leaf membership) and by `tests/desktop-centers.mjs`, which drives a real Electron window.

## Runtime shape

PROJECT NEXUS is a modular monolith. The browser calls the Express API; the server owns GitHub and AI credentials, repository reads, persisted task state, and guarded remote-write workflows.

```text
React + Vite UI
      │ /api
Express API ── GitHub REST API
      │
      ├── task and schedule runner (in process)
      ├── repository scanner ── framework update adapters
      ├── AI provider ── isolated repository workspaces ── Docker checks
      └── atomic JSON state store (schema v3)
```

## 2.1 authorization, durability and disclosure boundaries

The v2.1.0 Autonomy surface keeps the existing loopback/session/role gates and
adds a second, action-specific boundary before any mutating handler runs:

1. `server/index.mjs` classifies the mounted route and resolves its repository
   or task scope from the URL/body before Express route parameters are
   available.
2. `IntentAuthorizer` checks the process principal, required role, literal
   confirmation, exact declared scope and expiry/one-time consumption. It
   persists grant/use/outcome records; a role by itself never widens a grant.
3. A failed check returns the legacy `AUTONOMY_READ_ONLY` code with a precise
   `intentCode`, and no engine, GitHub or adapter side effect is started.

Read-only verbs that the REST surface exposes through `POST` (currently backup
verification) are role- and session-gated but do not require a writable grant;
they cannot mutate a resource. The Autonomy center's **Safety & recovery** tab
is the graphical client for this layer: it lists active grants with their scope
and expiry, revokes them, and drives backup create/verify/state-restore. The
panel holds no privilege of its own — every action it issues is authorised by
the same middleware described above.

The shared sensitive-file policy is consumed at all disclosure boundaries:
source selection and model redaction, AI operation validation, local Agent
workspace traversal and Diff review. It combines path and content signals but
is intentionally heuristic; deployment still needs a dedicated secret scanner.

`data-backup.mjs` treats `state.json` and the Autonomy SQLite file as separate
durable inputs. A backup records a schema version, per-file byte count and
SHA-256, validates SQLite and checkpoints its WAL before copy, and prunes old
backup directories. Restore verifies the manifest, stages and validates all
applicable files, and restores earlier live bytes if a later write fails. The
running service only exposes state restore; SQLite replacement is restart-gated
because its handle remains open. `startAutonomyBackupScheduler` repeats this
path every six hours by default, with environment-configurable cadence and
retention; the manual endpoint does not use a separate implementation.

Task status transitions append an event and persist a bounded checkpoint in the
same store. The checkpoint carries phase, retry timing and isolated workspace
identity only; prompts, model output and credentials are not copied into it.
The scheduler remains process-local, so multi-process lease coordination and
real crash/soak recovery are still open work.

## Admission and concurrency controls (2.0)

Three duplicate-execution paths were closed without changing feature scope:

- **Hosting inspection admission.** Scheduled and manual inspections now share a per-repository admission map keyed by repository identity. A second concurrent inspection for the same repository is rejected with `HOSTING_INSPECTION_IN_PROGRESS` (HTTP 409 plus the active `inspectionToken`) instead of starting a second GitHub walk. The guard is process-local, matching the existing queue/lock model.
- **Scan queue pump.** Manual, scheduled and resume paths enqueue into one process-level pump that de-duplicates job ids and merges concurrent batches, so overlapping requests cannot multiply worker concurrency.
- **Autonomy ticker ownership.** Startup no longer schedules a detached one-off `tickNow()` beside the interval ticker; a single `startAutonomyTicker(..., { immediate: true })` owns the first tick.

These are admission controls only. They do not raise any automation permission, and every existing approval gate and read-only default remains in force.

## Main modules

- `server/index.mjs`: API routes, GitHub integration, job scheduling, task orchestration and authorization checks.
- `server/services/state-store.mjs`: compatible state migration, JSON validation and atomic file replacement.
- `server/services/github-pagination.mjs`: bounded GitHub pagination and same-origin validation for provider-supplied next links.
- `server/services/repository-scanner.mjs`: resolve a default branch to a commit, inspect its tree, read a bounded set of evidence files and create a report.
- `server/services/update-assessor.mjs`: score evidence and create framework recommendations without claiming cryptographic verification.
- `server/integrations/`: Electron, Tauri, Python desktop, .NET and Web/PWA evidence adapters.
- `server/services/ai-provider.mjs`: provider registry/router for OpenAI-compatible, Ollama, Anthropic and Gemini request formats, source redaction, bounded retries/usage accounting, and file-operation response validation.
- `server/services/agent-runner.mjs`: bounded AgentRun phases, attempts, checkpoints and append-only execution events stored with integration jobs.
- `server/services/agent-workspace.mjs`: per-repository workspace locks, shallow clone, path/symlink checks, selected file reads, diff and optional branch push.
- `server/services/sandbox-runner.mjs`: network-disabled Docker build/test process with resource bounds. Unsupported or unavailable runtimes return BLOCKED.
- `src/api.ts`: typed browser API contract.
- `src/App.tsx` and `src/styles.css`: product screens and dark operations-console visual system.

## Scan and change flow

1. A manual request or schedule creates a persisted scan job unless an active scan already exists for that repository.
2. The scanner resolves the default branch and pins evidence to the commit SHA. Tree reads, file counts, read sizes and selected source are bounded.
3. An adapter identifies supported frameworks and reports observed evidence, missing checks, recommendations and limits. Android/iOS evidence is surfaced as unsupported until dedicated adapters exist.
4. Reports are stored in `integrationReports`; jobs and corresponding Task Center tasks persist progress, logs, errors and timestamps.
5. An AI change job requires explicit source disclosure confirmation. It clones the target into an isolated per-repository workspace, sends selected redacted files to the configured provider, validates bounded create/replace/delete operations, then stores the local diff and check result.
6. A passing result can be reviewed. Pushing a branch and opening a draft PR are separate operations, disabled by default, and never merge or publish a release.

The queue and repository locks are process-local. They prevent duplicate work within one server process but do not provide durable multi-worker coordination. On restart, interrupted scans are marked failed for retry; interrupted AI jobs are blocked for review.

## State model

Schema v3 preserves the existing v2 collections and adds `integrationReports`, `integrationJobs` and `integrationSchedules`. The migration is additive and writes atomically. See [STATE_MIGRATIONS.md](STATE_MIGRATIONS.md). JSON is intended for local or single-instance use; concurrent multi-process production writes require a separately approved store/queue migration.

## Trust and external side effects

Repository contents and model output are untrusted. The server limits paths, rejects symlinks and secret-like filenames, caps file operations, and runs target checks in a network-disabled container. Container dependency restore can be blocked when dependencies are not already cached. The AI source-redaction patterns reduce accidental disclosure but cannot guarantee secret discovery.

The process-level role setting is not user authentication. The local server binds to loopback by default; Compose publishes loopback by default. A deployment exposed through a proxy needs authentication, per-user authorization, TLS and a restricted origin policy before it is suitable for untrusted users. Keep remote writes disabled until those controls are implemented.

## Phase 4 Windows desktop and local Agent

The Windows Electron host, process layout, local data path, bearer-token bridge and task-private local Agent workspace are described in [PHASE4_ARCHITECTURE.md](PHASE4_ARCHITECTURE.md). The desktop Agent generates and reviews an isolated proposal; it is not wired to the existing GitHub job sandbox and does not apply changes to the local project or run local builds/tests.

# Architecture

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
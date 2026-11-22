# Phase 4 desktop and local Agent architecture

**Status date:** 2026-11-12

## Windows desktop process layout

```text
Windows user
  └─ Electron main process (desktop/main.mjs)
       ├─ owns BrowserWindow, tray, window state and startup preference
       ├─ exposes narrow, origin-checked preload IPC
       ├─ holds a random per-launch 32-byte API bearer token
       └─ starts the packaged Node/Express service
            ├─ binds to loopback on an ephemeral port
            ├─ receives the token through its process environment
            ├─ serves the built renderer and existing API routes
            └─ stores application state, logs and task workspaces under
               %LOCALAPPDATA%\PROJECT NEXUS
```

On Windows, the host selects `%LOCALAPPDATA%` (falling back to the local portion of `%APPDATA%`) and sets Electron `userData` and `sessionData` beneath the product data directory. The renderer has no Node integration. Calls to the local API go through the preload/main bridge, which adds the bearer token; a direct unauthenticated renderer request is rejected. The API token is not returned through the bridge.

Closing the main window hides it to the tray. The tray's Exit action quits the app; the `before-quit` handler requests termination of the supervised service process. Startup with Windows is off unless the user enables it. These behaviors are implemented; this turn's installed-package smoke did not independently exercise tray exit, graceful shutdown or startup persistence.

## Local project boundary

A native folder picker registers the selected canonical path in per-user app data. Project inventory scanning is read-only, bounded to 900 entries and depth 2, and records project marker names rather than reading source file contents. Unregistering a project removes only its NEXUS reference.

The desktop local Agent creates a task-private workspace under `agent-workspaces/local/<project-id>/<task-id>`. Its baseline is stored separately from the editable workspace copy. The registered source directory remains unchanged by model output.

## Local Agent request path

```text
UI disclosure + explicit confirmation
        │
        ▼
Persist bounded task ──► create bounded source copy + separate baseline
        │                               │
        │                               └─► choose eligible UTF-8 context files
        ▼
In-process task queue ──► configured AI provider request
                                      │
                                      ▼
                       validate bounded create/replace operations
                                      │
                                      ▼
                       write only to task-private workspace
                                      │
                                      ▼
                      persist status/events + render diff
```

The prompt limit is 8 KiB and the in-process queue is bounded to 8 queued/running tasks. Context selection is limited to 20 eligible files; the UI disclosure states a 120 KiB cap after redaction. The workspace copy is bounded by the limits in [`local-agent-workspace.mjs`](../server/services/local-agent-workspace.mjs): 20,000 entries, 4,000 files, 256 MiB total, 16 MiB per file and depth 16. Proposed operation count, individual/batch byte sizes and path safety are also bounded there.

Task records are versioned JSON in app data, with at most 100 tasks and 200 events per task. On service startup, a persisted `Running` task is marked `Interrupted`; there is no durable worker or automatic resumption. Cancellation aborts the current provider request when supported. Retry creates a fresh task and requires disclosure consent again.

## Provider boundary

The desktop service uses the existing environment-backed provider registry (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, and optional `AI_PROVIDER_KIND`, default-provider and registry/routing settings). The provider key stays in the local service process, not the renderer. The installed application does not include a development server requirement. An actual external model, key custody workflow and provider-specific quality were not verified in this acceptance run; the UI smoke used one loopback HTTP fixture.

## Intentionally absent local execution stages

The present desktop Agent stops after diff review. It has no approval-gated apply-to-source operation, Git worktree/commit workflow, local command/tool registry, build/test execution, test-result analysis, automatic repair loop, backup/rollback action or pause/resume mechanism. The separate remote repository pipeline and its Docker check runner do not implement these stages for locally registered projects.

## Research application

The source comparisons and license notes are in [Phase 4 research](PHASE4_RESEARCH.md). The implementation adopts bounded task state, typed operation validation, event records, explicit source disclosure, isolated workspaces and diff review. No upstream source was copied for that implementation.
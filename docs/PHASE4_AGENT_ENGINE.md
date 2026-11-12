# Phase 4 local AI Agent engine

**Status date:** 2026-11-12  
**Current maturity:** local change proposal and review; not a full autonomous development loop.

## Implemented path

1. Register a local folder through the native picker.
2. Select a project, configure a provider in the local service environment, enter a request and review the disclosure.
3. Confirm disclosure before sending the prompt and selected context.
4. NEXUS copies eligible project files into a bounded, task-private workspace and records its baseline.
5. A single in-process worker submits context to the configured provider and accepts validated `create`/`replace` file operations.
6. The operations are applied only to the task workspace. The task stores status, provider metadata, usage, changed paths, rationale and bounded events; the UI shows before/after diffs.
7. Cancel is available for a queued/running task. Retry creates a new task and requests fresh source disclosure.

The UI smoke exercised this path with a local fixture provider and a Chinese/space-path fixture project. It generated two proposed files, showed the changed code and usage, excluded a secret-shaped fixture and an ignored file from provider context, and verified that the registered source project remained unchanged.

## Input, context and workspace limits

- Prompt: at most 8 KiB.
- Queue: at most 8 queued/running tasks in this process.
- Provider context: up to 20 UTF-8 files; the UI reports a 120 KiB post-redaction source cap.
- Workspace: 20,000 entries, 4,000 files, 256 MiB total, 16 MiB per file and depth 16.
- Proposed operations: at most 30 operations, 512 KiB per operation and 5 MiB per batch.
- File reads: at most 20 files and 2 MiB per request.
- `.gitignore`: bounded to 64 files, 256 KiB and 2,048 rules; supported patterns are applied case-insensitively on Windows. Unsupported or unsafe patterns fail closed.
- Common dependency/build directories, symlinks, secret-shaped names/extensions, reserved Windows device names, traversal and unsafe paths are rejected or excluded.

These are application limits, not an operating-system security sandbox. Redaction and filename rules are heuristic; review what is disclosed and use providers approved for the source you send.

## Provider configuration

The desktop service inherits provider settings from its launch environment. The default single-provider configuration uses:

```env
AI_BASE_URL=https://provider.example/v1
AI_API_KEY=replace-with-a-provider-key
AI_MODEL=your-model-id
AI_PROVIDER_KIND=openai-compatible
AI_DEFAULT_PROVIDER=default
AI_REQUEST_TIMEOUT_MS=90000
AI_MAX_RETRIES=2
```

Do not put a real key in source control, the renderer, issue reports or screenshots. The UI reports configured provider IDs/model/host metadata; this acceptance run did not validate the provider's real API, account, billing or model quality. Provider-specific multi-provider registry and routing settings are documented in `.env.example` and `server/services/ai-provider.mjs`.

## What this engine does not do yet

| Capability | Status |
|---|---|
| Analyze and propose bounded local code edits | **Implemented** in the task-private copy. |
| Apply a reviewed proposal to the registered project | **Not implemented.** No source folder mutation endpoint or approval flow exists. |
| Run a local command, build, linter or test | **Not implemented** by the desktop Agent. |
| Interpret failures and automatically repair | **Not implemented.** |
| Delete files, stage/commit Git changes or push | **Not available** in this Agent workflow. |
| Backup and restore the selected source project | **Not implemented.** |
| Durable queue, pause/resume or crash recovery | **Not implemented.** In-flight tasks are marked `Interrupted` after service restart. |
| External provider end-to-end verification | **Not tested.** Only a loopback fixture was used. |

Do not treat `Succeeded` as “the project was changed” or “the proposed code passes tests.” It means the bounded operations were generated and saved in the isolated workspace.

## API and state

The local API provides config, list/create task, task detail/diff, cancel and retry routes under `/api/local-agent/*`. The authenticated desktop bridge is required when desktop mode has enabled the local API token. Tasks and events are stored in the versioned `local-agent-tasks.json` document; task workspaces are separate directories under app data.

For the host/data boundary, see [architecture](PHASE4_ARCHITECTURE.md). For threat boundaries, see [security](PHASE4_SECURITY.md). The separate remote job Docker runner is described in [the sandbox boundary](PHASE4_SANDBOX.md). For future work, see [delivery gaps](PHASE4_DELIVERY_REPORT.md).
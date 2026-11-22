# PHASE 6 Architecture — Autonomous Agent Development Engine

Date: 2026-11-13 · Baseline: v0.2.1 → v0.3.0 (PHASE 6A delivered)

PHASE 6 turns PROJECT NEXUS from a desktop manager with single-pass AI
proposals into a real autonomous development engine: the agent plans, calls
tools, edits files in an isolated workspace, runs builds/tests, repairs its own
failures, reviews its diff, and hands a reversible change set to the user.

## 1. Component map

```
Electron main (desktop/main.mjs)
  ├─ provider key vault  (safeStorage/DPAPI-encrypted at rest)
  ├─ IPC: desktop:provider-keys:set|delete|status
  └─ syncs decrypted keys to the service over the authenticated loopback API
        │
        ▼
Local service (server/index.mjs, Express, loopback-only, bearer token)
  ├─ /api/local-agent/providers*        persistent provider registry (no keys at rest)
  ├─ /api/local-agent/provider-keys     key injection from the main process only
  ├─ /api/local-agent/tasks*            task store + queue (PHASE 4 store, extended)
  ├─ /api/local-agent/tasks/:id/approvals/:approvalId/resolve
  ├─ /api/local-agent/tasks/:id/rollback
  ├─ /api/local-agent/tasks/:id/apply
  ├─ /api/local-agent/projects/:id/insights
        │
        ▼
Agent runtime (server/services/agent/)
  ├─ runtime.mjs        the loop: plan → act → observe → verify → repair → review
  ├─ tools.mjs          34-tool registry with permission levels + schemas
  ├─ approval.mjs       persisted approvals, policies, host-enforced decisions
  ├─ executor.mjs       parameterized command execution (no shell string concat)
  ├─ context.mjs        bounded task-context selection (budget + redaction)
  ├─ indexer.mjs        incremental project index (files/symbols/imports/manifests)
  ├─ workspace-worktree.mjs   unified workspace adapters (worktree | copy)
  └─ task-executor.mjs  pipeline glue + rollback + confirmed apply
```

The renderer never sees provider API keys, never talks to the model, and never
executes anything itself — it renders persisted task state and posts decisions
(approve/deny, rollback, apply) back to the service.

## 2. The runtime loop

1. **Planning turn** — the model receives the system prompt (rules + tool
   catalog + workspace mode), the task prompt, and a bounded redacted context
   bundle, and must return `{"thought","plan":[…],"first_tool":{…}}`.
2. **Execution loop** (bounded by `maxIterations`=40, token budget 600k,
   wall clock 25 min) — each turn returns exactly one JSON action; native
   OpenAI-style `tool_calls` are accepted and normalized as a bonus. One
   corrective retry follows an unparseable response; three strikes fail the
   task with `AGENT_MODEL_UNPARSEABLE`.
3. **Approval gate** — before executing, the tool's effective permission
   (`permissionFor(args)` for dynamic cases like `run_command`) is checked
   against the task's policy. `high` always pauses the task (status `Paused`,
   persisted pending approval); the user's decision arrives via the API and
   the loop resumes. Denial is an observation to the model, never a retry
   trigger for the same action.
4. **Verification** — after the model finishes, the runtime runs the project's
   own `build`/`test` scripts inside the workspace. Failures enter a bounded
   repair sub-loop (`maxRepairAttempts`, hard cap 4) that feeds the failing
   output back to the model; re-verification repeats until pass or budget.
5. **Independent review** — a separate model call re-reads the final diff and
   returns severity-ranked findings (CRITICAL…INFO). Review cannot modify
   anything.
6. **Delivery** — the task record persists plan, tool-call history, usage,
   cost, verification and review. The change set stays in the isolated
   workspace until the user either rolls back or applies it.

## 3. Isolation model

- **Git projects (default, `auto`)**: a dedicated `git worktree` on branch
  `nexus-agent/<taskId>`, created from HEAD in
  `<dataDir>/agent-workspaces/agent/worktree/`. The user's working tree,
  including uncommitted changes, is never touched. Diff = `git diff --cached
  HEAD` after staging inside the worktree only. Rollback = reset + clean +
  remove worktree + delete branch.
- **Non-git projects**: the PHASE 4 bounded snapshot copy (baseline manifest,
  gitignore policy compilation, symlink refusal, byte/count ceilings), now
  extended with bounded delete + baseline restore.
- **Apply to project**: explicit `POST …/apply {confirm:true}` only. Refuses
  when the original tree is dirty (protects uncommitted user work), backs up
  every overwritten original under `agent-workspaces/agent/apply-backup/<taskId>/`,
  then writes the workspace content into the project. Apply never commits,
  pushes, or publishes.
- **Commands** run inside the workspace root only, through the parameterized
  executor: tokenized argv, `cmd.exe` wrapper only for Windows `.cmd/.bat`
  launchers with fully quoted metacharacter-free arguments, credential-bearing
  environment variables stripped from the child env, output capped, timeouts
  kill the process tree (`taskkill /T /F`).

## 4. Security invariants (unchanged or strengthened)

- Renderer sandbox/context isolation unchanged; the preload bridge grew three
  key-vault methods, all of which only write or report counts, never return key
  material.
- API keys: DPAPI-encrypted at rest in the main process vault; decrypted once
  per change into service process memory; never persisted by the service,
  never logged (secret redaction runs on every error path and observation).
- The model cannot self-approve: approvals resolve only through the
  authenticated API from the UI.
- Secret-like paths (.env, keys, credentials) are blocked at every layer
  (workspace, tools, context, diff).
- The model is instructed — and the review re-checks — that deleting tests,
  weakening assertions, or disabling checks to fake a pass is forbidden; test
  scripts always execute for real in the workspace.

## 5. Data model changes

- `local-agent-tasks.json` (schemaVersion 1, unchanged on disk): tasks of type
  `local-agent-runtime` carry `plan`, `approvals[]`, `pendingApprovalId`,
  `workspace {mode,branch}`, `runtimeResult {iterations, repairAttempts,
  verification, review, usage, costUsd, finalMessage, runtimeVersion}`,
  `toolCallCount`, `disclosedPaths`, `usage`, `costUsd`. The PHASE 4
  `local-agent` type and its one-shot flow remain for compatibility.
- `ai-providers.json` (new, schemaVersion 1): provider metadata without keys.
- `agent-indexes/<projectId>.json` (new): incremental project index cache.
- `provider-keys.json` (new, in userData): safeStorage-encrypted key vault.

## 6. Renderer

The Agent page keeps the PHASE 5 design system and adds: provider manager
(CRUD + encrypted key entry + live connectivity test), runtime task controls
(engine, approval policy, workspace mode), project understanding panel,
plan/timeline/verification/review sections, per-task approval cards, and
rollback/apply actions. All new strings ship in all ten languages (i18n
coverage 100%, deep audit clean).

## 7. What is deliberately not in 6A

- Docker-isolated execution mode (interface reserved in the executor).
- Multi-agent role orchestration (Planner/Developer/Reviewer/Tester) — the
  review stage is the first independent role; the rest lands in 6D.
- Streaming token output to the UI (polling persisted state today; the event
  log is the integration point).
- Native tool-calling per provider dialect (the JSON protocol is universal;
  OpenAI-style tool_calls are accepted when a provider emits them).
- Cost display without configured pricing shows tokens only — never invented
  prices.

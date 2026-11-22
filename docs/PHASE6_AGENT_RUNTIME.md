# PHASE 6 Agent Runtime — Design and Behavior

Date: 2026-11-13 · Module: `server/services/agent/runtime.mjs`

## 1. Responsibility

One function, `runAgentTask({task, project, provider, adapter, index,
contextBundle, taskStore, dataDir, signal, options})`, executes a complete
autonomous development task and returns a structured result that the task
store persists verbatim.

## 2. Protocol

The model must answer with exactly one JSON object per turn:

```json
{"thought": "brief reasoning", "tool": {"name": "edit_file", "args": {"path": "src/a.js", "oldText": "…", "newText": "…"}}}
```
or, to finish:
```json
{"thought": "brief reasoning", "final": "summary for the user"}
```

The planning turn instead returns `{"thought","plan":[…],"first_tool":{…|null}}`.
Markdown fences are tolerated (stripped). OpenAI-style native `tool_calls`
blocks are normalized into the same shape when a provider emits them.
Unparseable output triggers one corrective user message; three consecutive
strikes fail the task (`AGENT_MODEL_UNPARSEABLE`).

## 3. Budgets and hard stops (defaults)

| Control | Default | Behavior |
| --- | --- | --- |
| `maxIterations` | 40 | tool-calling turns; exceeded → stop with an explicit note |
| `tokenBudget` | 600,000 | cumulative usage; exceeded → `AGENT_TOKEN_BUDGET_EXCEEDED` |
| `wallClockMs` | 25 min | `AGENT_WALL_CLOCK_EXCEEDED` |
| `maxRepairAttempts` | 2 (cap 4) | bounded diagnose→fix→re-verify loops |
| `approvalTimeoutMs` | 10 min | unresolved approval → denied/expired |
| `historyBudgetBytes` | 240 KB | oldest tool observations compressed to stubs |
| consecutive tool failures | 6 | `AGENT_TOOL_FAILURE_STREAK` (protects the budget) |

Cancellation via `signal` is checked before every model call, tool execution
and approval poll (`AGENT_CANCELLED`).

## 4. Verification and repair

After the model finishes, `autoVerify` runs the project's real scripts
(discovered from `package.json`-style manifests): `build` then `test`, each
with a 5-minute ceiling and captured output tails. A failed verification:

1. appends the failing output to the conversation,
2. instructs the model to fix the root cause (never weaken tests),
3. loops at most `maxRepairAttempts` times with re-verification after each,
4. leaves the task `Failed` with the last verification summary when exhausted.

The task status reflects honesty: `Succeeded` only when either no scripts were
declared (verification attempted=false) or every attempted script passed.

## 5. Independent review

A separate provider call reviews the final unified diff with its own system
prompt and returns `{findings:[{severity, path, line, issue, suggestion}],
overall, verdict}`. Severities are validated against the fixed set
CRITICAL/HIGH/MEDIUM/LOW/INFO and sorted by weight. The review has no write
access; its findings are persisted and rendered in the UI.

## 6. Persistence contract

Every meaningful step is appended to the task's event log (capped at 200):
`started, workspace_created, index, context, phase, plan, tool_call,
model_retry, approval_requested/settled/expired, verification, repair_start,
repair_tool, review, final, completed/failed`. Task patches persist `plan`,
`usage`, `costUsd`, `toolCalls`, `phase`, and the final `runtimeResult` —
enabling the UI timeline, crash forensics, and the restart recovery path
(Running→Interrupted on service start, workspace revalidated on demand).

## 7. Failure semantics

| Condition | Task status | Code |
| --- | --- | --- |
| No configured provider | Blocked before run | `AI_NOT_CONFIGURED` |
| Model HTTP/timeout errors | Failed (retried ≤2 with backoff inside `invokeAIProvider`) | `AI_TIMEOUT` / provider status |
| Unparseable output ×3 | Failed | `AGENT_MODEL_UNPARSEABLE` |
| Budgets exceeded | Failed (explicitly flagged `timedOut` / `tokenExhausted`) | `AGENT_*_EXCEEDED` |
| User cancellation | Cancelled | `AGENT_CANCELLED` |
| 6 consecutive tool failures | Failed | `AGENT_TOOL_FAILURE_STREAK` |
| Verification still failing after repairs | Failed (with full diagnosis trail) | — |

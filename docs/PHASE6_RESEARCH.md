# PHASE 6 Research — Autonomous Agent Execution Architectures

Date: 2026-11-13 · Baseline: v0.2.1 · Scope: architecture research that feeds the PHASE 6 implementation.

This report studies how mature open-source coding agents solve the agent loop, tool design, context
management, safety, and recovery. It ends with the concrete design decisions adopted by PROJECT NEXUS.
No incompatible-licensed code was copied; patterns are reimplemented from scratch in this repository.

## 1. Projects studied

| Project | License | Core pattern worth adopting |
| --- | --- | --- |
| OpenHands (formerly OpenDevin) | MIT | Event-stream backbone (`Action`/`Observation` events are the source of truth); sandboxed runtime executes every action; agents, runtimes and UI communicate only through the stream. The official SDK runs the whole loop in-process (LLM calls, tool invocation, event callbacks, state updates). |
| SWE-agent (Princeton) | MIT | The **Agent–Computer Interface (ACI)**: purpose-built editing tools instead of a raw shell; a **linter runs after every edit and the edit is rejected if it breaks syntax**; compact, actionable observations instead of raw dumps; guardrails (argument limits) over freedom. |
| Aider | Apache-2.0 | **Search/replace edit format** with strict validation and auto-retry on malformed blocks; git-integrated: every AI change becomes a commit, `/undo` reverts it; repo map built from a tree-sitter symbol graph, ranked by relevance (BM25 + PageRank-ish graph scoring). |
| Continue | Apache-2.0 | IDE-integrated context providers ("@file", "@codebase"); per-step permission prompts; deterministic tool execution on the extension host, never in the webview. |
| Cline | Apache-2.0 | Strict JSON tool schema per step (`read_file`, `write_to_file`, `replace_in_file`, `execute_command` …); **explicit approve/reject of every tool call and command** with "remember my choice" scoping; diff view per edit; checkpoint snapshots enabling per-step restore. |
| Roo Code | Apache-2.0 | Multiple agent modes (architect/code/ask/debug) with mode-scoped toolsets; granular auto-approve settings ladder (read → edit → command → max requests). |
| Open Interpreter | AGPL-3.0 | Code-execution-first loop with OS-level safety feedback; confirms code before running; teaches: always separate "the model's proposal" from "the executor's result". (Pattern only — AGPL code is not copied.) |
| Codex CLI / cloud agents | Apache-2.0 | Sandbox-first execution (network-off by default), approval modes (suggest / auto-edit / full-auto), structured final messages with an explicit "not verified" vocabulary. |
| LangGraph | MIT | Graph-of-steps orchestration with **checkpointable state**, per-node retry, and human-in-the-loop interrupts — the model for our pause/approve/resume design. |
| MCP (Model Context Protocol) | MIT (spec) | Tool = name + JSON Schema input + typed result; servers advertise capabilities; permissioning stays on the host side. We adopt the schema discipline and the "host enforces permissions" rule. |

Primary sources: [OpenHands SDK agent architecture](https://docs.openhands.dev/sdk/arch/agent),
[OpenHands SDK paper (arXiv 2511.03690)](https://arxiv.org/pdf/2511.03690),
[OpenHands platform paper (OpenReview)](https://openreview.net/forum?id=OJd3ayDDoF),
[SWE-agent ACI background](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md),
[SWE-agent paper (arXiv 2405.15793)](https://arxiv.org/html/2405.15793v2),
[Cline repo](https://github.com/cline/cline), [Roo Code repo](https://github.com/RooCodeInc/Roo-Code),
[Aider repo](https://github.com/Aider-AI/aider), [LangGraph repo](https://github.com/langchain-ai/langgraph),
[MCP specification](https://modelcontextprotocol.io/specification).

## 2. Cross-project findings

### 2.1 The agent loop is an event loop, not a chat
Every mature system separates: **model reasoning → structured action → sandboxed execution →
observation → next iteration**. OpenHands persists this as an append-only event stream; Cline as
step messages; LangGraph as checkpointed state. The runtime must own iteration limits, budgets and
cancellation — never trust the model to stop itself.

**Adopted:** `server/services/agent/runtime.mjs` runs a bounded loop (`maxIterations`, token budget,
wall-clock budget, retry budget). Every model turn, tool call, tool result, approval and phase change
is appended to the task's event log (persisted in the local-agent task store), which is our
event-stream equivalent and doubles as the UI timeline and the crash-recovery journal.

### 2.2 Editing tools must fail fast and give compact feedback
SWE-agent's central result is that interface design changes outcomes more than model choice: their
edit command runs a linter and *rolls back* syntactically broken edits, returning the error as the
observation. Aider validates its search/replace blocks and retries with a corrective prompt.

**Adopted:** `edit_file` requires an exact unique `oldText` match, reports match counts on failure,
and runs a lightweight syntax sanity check for JS/TS/JSX/TSX/JSON (brace/paren balance + JSON.parse)
with a non-fatal warning in the observation. Observations are truncated to a bounded window with
byte counters, never raw full-file dumps.

### 2.3 Native tool calling with a universal JSON fallback
OpenAI-compatible endpoints, Anthropic and Gemini all support native tool/function calling, but
many OpenAI-*compatible* proxies and local runtimes (Ollama/LM Studio models) do not reliably.
Cline and Open Interpreter instead use a strict textual protocol; OpenHands uses LiteLLM's
normalized tool interface.

**Adopted:** dual protocol. The system prompt always declares the strict JSON contract
`{"thought": str, "tool": {"name": str, "args": object}}` or `{"thought": str, "final": str}`.
Providers that declare `capabilities.tools` also receive native tool schemas, and the runtime
parses native `tool_calls`/`tool_use` blocks first; if a provider errors on the tools parameter or
returns neither native calls nor parseable JSON, one corrective retry is issued before failing.
This keeps every provider usable — verified per provider, never assumed.

### 2.4 Context is a budget, not a dump
Aider's repo map (tree-sitter symbols + graph ranking) and Continue's context providers both solve
the same problem: choose a small, relevant, structured context under a byte budget. SWE-agent
windows file views.

**Adopted:** `server/services/agent/context.mjs` combines: manifest/config files first
(package.json, tsconfig, pyproject…), files whose path/name matches prompt keywords, symbol-index
hits, and import-neighbor expansion, all under a configurable byte budget (default 120 KB) with
per-file caps and redaction. The index (`indexer.mjs`) caches per-file mtimes/sizes/hashes so
re-indexing after agent edits is incremental.

### 2.5 Approval design: level-based, host-enforced
Cline asks for every tool call by default with per-call scoping; Roo Code exposes an auto-approve
ladder; Codex has suggest/auto-edit/full-auto; MCP puts enforcement on the host. The consistent
rule: **the host never grants a permission the user did not configure, and the model cannot
self-approve.**

**Adopted:** tools carry `permission: low | medium | high`. Approval policy per task:
`supervised` (medium+high ask), `standard` (medium auto inside workspace, high asks),
`workspace-auto` (medium+high ask only outside strict workspace boundary). High-risk classes
(delete_file bulk, install_dependencies, network commands, anything outside the workspace,
git push/PR/publish) always require a live approval; approvals are persisted, and the runtime
pauses while awaiting them (LangGraph's interrupt pattern) with a denial timeout.

### 2.6 Workspace isolation: git worktree first, bounded copy as fallback
OpenHands/SWE-agent run inside containers; Codex sandboxes the filesystem; Cline snapshots the
workspace for per-step restore. Git worktrees give us first-class isolation *and* real git diffs
for projects under version control, at zero copy cost.

**Adopted:** `workspaceMode: auto | worktree | copy`. Git projects prefer a dedicated
`nexus-agent/<taskId>` worktree (created from HEAD, changes reviewed via `git diff`, rollback =
remove worktree + delete branch). Everything else uses the existing hardened copy workspace
(`local-agent-workspace.mjs`: symlink refusal, gitignore policy compilation, baseline manifest,
byte/count limits) which PHASE 4 already shipped with tests. Command execution is confined to the
workspace root; the original project directory is read-only to the agent.

### 2.7 Repair loops need hard stops
All studied systems cap repair attempts and escalate to the user instead of burning tokens
(SWE-agent's submission budget, OpenHands max_iterations, LangGraph recursion limits).

**Adopted:** after tests fail, the runtime enters `diagnose → repair → verify` sub-loop with
`maxRepairAttempts` (default 2, hard cap 4). On exhaustion the task finishes `Failed` with a
structured problem report (failing command, output tail, files touched, last model analysis).
The runtime is forbidden from deleting tests, editing test expectations to fake passes, or
disabling checks: tool results that suggest such edits are flagged in review.

### 2.8 Cost and honesty accounting
Codex's "not verified" vocabulary and our own PHASE 4 redaction rules set the standard: every
model response records provider, model, token usage and estimated cost when pricing is configured;
unpriced usage is shown as tokens only. Findings without execution evidence are labelled as such.

## 3. Rejected alternatives

- **Container-only execution (Docker as default):** real, but Windows users without Docker would
  lose the entire feature. PHASE 6A uses the hardened workspace + restricted command allowlist;
  Docker mode remains a future add-on (tracked in PHASE6_ARCHITECTURE.md).
- **Tree-sitter symbol extraction:** high-value but adds a native dependency chain to an
  Electron/NSIS build. Phase 6A uses a fast regex/brace-balance indexer for JS/TS/Python with the
  interface designed so a tree-sitter backend can slot in later.
- **Fully autonomous multi-agent immediately:** research (and LangGraph practice) shows the
  coordinator must first be stable single-agent. Multi-agent roles (Planner/Developer/Reviewer/
  Tester/Researcher) are specified in PHASE6_MULTI_AGENT.md but land after 6A hardening.
- **Streaming model output to UI:** adds transport complexity across the Electron IPC boundary;
  polling the persisted event log (existing PHASE 4 pattern) gives real backend state without
  simulated progress. Streaming is a later optimization, not fake progress today.

## 4. Licensing notes

- Patterns implemented from scratch; no source copied from AGPL projects (Open Interpreter).
- MIT/Apache projects were consulted for behavior and prompt-shape ideas only; our prompts, code
  and schemas are original.
- New runtime dependencies added in PHASE 6: **none** (Node built-ins only), keeping the
  electron-builder footprint and license surface unchanged.

## 5. Requirements traceability (research → code)

| Requirement (PHASE 6 spec) | Where it lands |
| --- | --- |
| Agent 循环 / 迭代控制 / 预算 | `server/services/agent/runtime.mjs` |
| 工具调用 + 校验 | `server/services/agent/tools.mjs` (registry, schemas, permission levels) |
| 上下文收集 / 压缩 | `server/services/agent/context.mjs`, `indexer.mjs` |
| 任务规划 | planner phase in `runtime.mjs` producing persisted plan steps |
| 长任务中断恢复 | task store events + `recoverRunning` + workspace revalidation |
| 错误分析 / 自动修复 | repair sub-loop in `runtime.mjs` |
| 工作区隔离 | `workspace-worktree.mjs` + existing `local-agent-workspace.mjs` |
| 用户审批 | `server/services/agent/approval.mjs` + desktop approval cards |
| Git 集成 | git tools + worktree adapter + diff/apply endpoints |
| 成本统计 | usage normalization + provider pricing (existing) extended to per-turn records |

# PHASE 6 Multi-Agent Collaboration — Current State and Design (6D target)

Date: 2026-11-13 · Status: single-agent shipped in 6A; role orchestration specified for 6D.

## 1. What exists in 6A already

The 6A runtime is not "one agent pretending to be many": it already contains
**independent role boundaries** enforced structurally:

- **Planner role** — the planning turn produces the persisted plan; it cannot
  execute anything until the plan is recorded.
- **Developer role** — the execution loop with its tool permissions.
- **Reviewer role** — a structurally separate provider call with its own
  system prompt, no write access, and severity-ranked findings. Its verdict
  (`approve | request_changes`) is persisted and shown to the user.
- **Verifier role** — `autoVerify` executes the project's real build/test
  scripts outside the conversation loop, so "tests pass" is never the
  developer grading its own homework.

Multi-agent behavior therefore has a real execution record today (plan events,
review events, verification results), not just role names in a UI.

## 2. 6D design (specified, not yet implemented)

Coordination model: a **task coordinator** extends the current task store with
role-scoped sub-tasks. Roles are instances of the same runtime with different
system prompts, tool scopes and model routing:

| Role | Tool scope | Typical model routing |
| --- | --- | --- |
| Planner | read-only (index/context tools) | long-context/strong reasoning |
| Developer | full file + exec tools | coder models |
| Reviewer | read-only + get_file_diff | strong reasoning, low temperature |
| Tester | exec tools + test authoring tools | coder models |
| Researcher | network-read research tools (sandboxed) | long-context |

Rules carried over from the research phase:

1. Roles communicate through structured task records (plan items, findings,
   test reports), never through shared free-form scratch files.
2. Concurrent file mutation by two roles is prevented by ownership: a plan
   item assigns file paths; the coordinator serializes conflicting items and
   pauses with an explicit conflict event.
3. The pipeline order stays: 规划 → 开发 → 审查 → 测试 → 修复 → 验收
   (plan → develop → review → test → repair → acceptance), with a bounded
   number of full cycles.
4. Each role may run on a different provider/model via the existing routing
   table (`understanding / planning / coding / review / error-analysis /
   testing / documentation`), with per-task overrides and safe fallbacks that
   are logged, never silent.
5. All role hand-offs are persisted events; the UI renders the same timeline
   with role attribution.

The 6A runtime deliberately kept the coordinator interface (`runAgentTask`
taking explicit provider/adapter/context/taskStore dependencies) so 6D
composes roles without rewriting the core loop.

# Phase 4 Agent-Engine Research

**Research snapshot:** 2026-11-12  
**Purpose:** Compare public agent implementations for design guidance for the NEXUS local AI development engine.

The GitHub links below point to upstream `main` branches and were not pinned to commit SHAs. They describe the source and repository status observed on the snapshot date; branch contents and project status can change.

## Reviewed projects

| Project and inspected evidence | Design findings | Declared license and observed repository state |
|---|---|---|
| **OpenHands SDK** — [SDK repository](https://github.com/OpenHands/software-agent-sdk), [agent loop](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/agent/agent.py), [local conversation](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py). Also reviewed the current [OpenHands application repository](https://github.com/OpenHands/OpenHands). | The SDK separates typed agent/tool contracts from conversation events and workspace/runtime concerns. Its agent loop has iteration bounds; local conversations persist events and support resumption. | SDK: MIT. `OpenHands/OpenHands` now identifies as the Agent Canvas frontend/orchestration repository; the Python agent SDK is maintained separately in `OpenHands/software-agent-sdk`. Do not use the former repository name as evidence that its UI contains the current SDK runtime. |
| **SWE-agent** — [repository and README](https://github.com/SWE-agent/SWE-agent), [agent loop](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/agents.py), [single-run entry point](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/run/run_single.py). | Its action/observation loop records trajectories and separates agent behavior from the execution environment. Tool parsing and bounded retries help make model output failures observable. | MIT. The README says development effort has shifted to mini-SWE-agent, recommends it for future use, and still describes SWE-agent as maintained by the research team. This is a shift in emphasis, not an archive claim. |
| **Aider** — [repository](https://github.com/Aider-AI/aider), [base coder](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py), [repository map](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py), [license](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt). | A token-budgeted repository map and selected-file context help control prompt size. Edits are represented through a diff-aware coding workflow, with optional lint/test and Git steps. | Apache-2.0. No archive or read-only notice was observed in the reviewed repository; this review does not establish a maintenance cadence. |
| **Continue** — [repository and README](https://github.com/continuedev/continue), [typed core contracts](https://github.com/continuedev/continue/blob/main/core/index.d.ts), [CLI chat command](https://github.com/continuedev/continue/blob/main/extensions/cli/src/commands/chat.ts). | Typed tool-call status and chat-history handling make tool execution and context compaction explicit parts of the conversation lifecycle. | Apache-2.0. The upstream README says the project is no longer actively maintained, is read-only, and ended at 2.0.0. GitHub does not mark the repository archived, so this report uses the README's wording rather than calling it archived. |
| **Cline** — [repository](https://github.com/cline/cline), [agent runtime](https://github.com/cline/cline/blob/main/sdk/packages/agents/src/agent-runtime.ts), [agent SDK tools](https://github.com/cline/cline/tree/main/sdk/packages/agents/src). | The SDK uses registered, typed tools and lifecycle events/hooks, with bounded iterations, cancellation and state snapshots. These provide useful boundaries between model requests and host actions. | Apache-2.0 for the reviewed agents SDK/repository. No archive or read-only notice was observed in the reviewed source; no maintenance cadence is inferred. |
| **Roo Code** — [repository](https://github.com/RooCodeInc/Roo-Code), [task state](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task/Task.ts), [provider/task coordination](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/webview/ClineProvider.ts). | Task lineage and persisted task/history state support resumable work and checkpoints. | Apache-2.0. The official repository says it was archived on **May 15, 2026**. Its source remains useful as a historical design reference, not as evidence of a maintained upstream. |
| **Open Interpreter** — [current repository and README](https://github.com/OpenInterpreter/open-interpreter), [turn processing](https://github.com/OpenInterpreter/open-interpreter/blob/main/codex-rs/core/src/session/turn.rs), [tool registry](https://github.com/OpenInterpreter/open-interpreter/blob/main/codex-rs/core/src/tools/registry.rs). | The current repository is a Rust implementation based on Codex. Its turn processing and tool registry can illustrate a Codex-style interaction surface, but do not constitute an independent architecture comparison. | Apache-2.0. The README identifies this project as a fork of OpenAI Codex and says the original Python project is at `endolith/open-interpreter`; conclusions here concern the current Rust repository. |
| **OpenAI Codex CLI** — [repository](https://github.com/openai/codex), [turn processing](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs), [tool registry](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/registry.rs), [execution policy](https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs). | A typed tool registry and explicit turn loop are paired with command-execution policy, sandboxing and approval boundaries. The repository is a useful reference for the public CLI implementation. | Apache-2.0 for the public repository. This does not describe private Codex service internals. |

## Application to NEXUS

Current NEXUS boundaries relevant to this research:

- [`server/services/ai-provider.mjs`](../server/services/ai-provider.mjs) configures providers from environment-backed settings, supports task-role routing, bounds retries/timeouts and normalizes usage. Provider credentials remain server-side.
- [`server/services/agent-workspace.mjs`](../server/services/agent-workspace.mjs) creates managed workspaces for GitHub repository jobs, prepares a task branch and supports patch/diff review. Remote push and pull-request actions are separate operations.
- [`server/services/sandbox-runner.mjs`](../server/services/sandbox-runner.mjs) runs selected build/test profiles in Docker with networking disabled and resource/time limits. Supported framework profiles remain limited.
- [`server/services/local-projects.mjs`](../server/services/local-projects.mjs) scans explicitly registered local folders for bounded file and project-marker information. This inventory scan is read-only.
- The local Agent path is integrated through [`server/services/local-agent-tasks.mjs`](../server/services/local-agent-tasks.mjs), the `/api/local-agent/*` routes in [`server/index.mjs`](../server/index.mjs), and the desktop API/UI in [`src/api.ts`](../src/api.ts) and [`src/desktop/Workstation.tsx`](../src/desktop/Workstation.tsx). It requires explicit source-disclosure consent, sends a prompt and up to 20 eligible files (capped at 120 KiB after redaction) to a configured provider, and stores generated create/replace changes in a task-private workspace for diff review. It does not write to the registered source folder, execute commands, run tests, or apply Git changes. Queued tasks are marked interrupted after a service restart rather than resumed; the worker is an in-process queue.

The research suggests these next design steps, subject to NEXUS's existing security boundaries:

1. Give every tool a typed input/output contract and a policy class: `READ_ONLY`, `LOCAL_MUTATION`, `BUILD_TEST`, or `REMOTE_WRITE`.
2. Persist run state as bounded events and checkpoints, including cancellation, retry counts, tool results and restart/resume behavior. Keep model iteration, time, output and cost budgets explicit.
3. Assemble repository context under a token budget from a bounded tree/map and selected files. Preserve path checks, secret exclusions, symlink rejection and size limits.
4. Keep edits in task-private workspaces. Produce a reviewable diff and verification evidence before any approval-gated write; keep build/test execution isolated from the host.
5. Treat remote writes as a distinct, auditable action with explicit authorization. A successful local patch or sandbox run does not imply that a branch, pull request or release was written remotely.

These are research-informed design recommendations. NEXUS has an integrated local generation and diff-preview path, but this source review does not establish that its full autonomous development workflow, command execution, test-and-repair loop, source-folder apply/rollback, or durable worker recovery is implemented.

## License and reuse boundary

No third-party source was copied into NEXUS for this research, and no dependency was added. The licenses above are upstream declarations for the reviewed repositories; they are not a blanket authorization to reuse arbitrary files. Before any future code reuse, verify the exact file's license and notices, bundled or vendored components, dependency terms, attribution requirements and compatibility with the intended distribution. The NEXUS package is marked private and no root `LICENSE` or package `license` field was present in the inspected workspace; neither fact changes the separate terms of third-party code.

## Primary repositories

- [OpenHands application](https://github.com/OpenHands/OpenHands) and [OpenHands software-agent SDK](https://github.com/OpenHands/software-agent-sdk)
- [SWE-agent](https://github.com/SWE-agent/SWE-agent)
- [Aider](https://github.com/Aider-AI/aider)
- [Continue](https://github.com/continuedev/continue)
- [Cline](https://github.com/cline/cline)
- [Roo Code](https://github.com/RooCodeInc/Roo-Code)
- [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter)
- [OpenAI Codex CLI](https://github.com/openai/codex)

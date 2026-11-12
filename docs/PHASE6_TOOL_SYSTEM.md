# PHASE 6 Tool System — Registry, Permissions and Safety

Date: 2026-11-13 · Module: `server/services/agent/tools.mjs` (+ `executor.mjs`, `approval.mjs`)

## 1. Registry model

Every tool declares: `name`, `description`, `permission` (`low|medium|high`),
an input schema (validated server-side: types, required fields, max lengths,
newline bans for shell-ish values), an optional `permissionFor(args)` for
dynamic risk (used by `run_command`), and a handler bound to a tool context.
Unknown arguments are rejected; observations are compact JSON capped at
32 KB. 34 tools ship in 6A:

| Group | Tools | Default permission |
| --- | --- | --- |
| File | read_file, list_directory, search_files, search_code, create_file, write_file, edit_file, delete_file, move_file, get_file_diff | low ×4, medium ×5, high ×1 (delete_file) |
| Project | inspect_project, inspect_dependencies, inspect_project_config, inspect_entry_points, inspect_tests, inspect_routes, inspect_api | low ×7 |
| Git | git_status, git_diff, git_log, git_branch, git_create_branch, git_checkout, git_commit, git_restore | low ×4, medium ×4 |
| Execution | run_command, run_tests, build_project, install_dependencies, run_linter, run_typecheck | medium (run_command: medium only for allowlisted programs, otherwise high), high ×1 (install_dependencies) |
| Helper | report_progress, request_approval, save_checkpoint | low ×2, medium ×1 |

## 2. Permission → approval mapping

Approval policy per task (`supervised | standard | workspace-auto`):

- `high` **always** requires a live user approval, under every policy.
- `supervised`: every non-low tool pauses for approval.
- `standard` (default): medium tools run inside the isolated workspace
  automatically; `run_command` still escalates to high whenever the requested
  program is not on the allowlist (curl, powershell, regedit, …).
- Approvals are persisted in the task record; the task status becomes
  `Paused` while waiting and returns to `Running` after resolution. The model
  receives "the user did not approve this action" as an observation and is
  instructed to adapt rather than retry.

## 3. Editing safety

- `edit_file` requires an exact, unique `oldText` match; zero matches →
  `TOOL_EDIT_NO_MATCH`, multiple → `TOOL_EDIT_AMBIGUOUS`. Line endings are
  matched and preserved (CRLF/LF detection), a real-world correctness detail
  for Windows repositories.
- After every create/write/edit, a lightweight syntax sanity check runs for
  JS/TS/JSX/JSON (bracket balance / JSON.parse). A warning is attached to the
  observation — the SWE-agent pattern of failing fast on broken edits without
  a hard block.
- Whole-file writes are capped (512 KB per file, per-call and batch limits);
  secret-like paths are rejected at the tool layer with `TOOL_PATH_SENSITIVE`.

## 4. Command execution (`executor.mjs`)

- Tokenizer handles quotes; rejects `& | < > ^ % $ \` " '` and newlines inside
  arguments before anything spawns (`COMMAND_METACHARACTER`).
- Windows: `.exe/.com` spawn directly (`shell: false`). `.cmd/.bat` shims
  (npm, pnpm, …) are routed through `cmd /d /s /c` with the full command line
  wrapped in an extra quote pair — the only way to launch Node toolchain
  shims since Node's CVE mitigation forbids direct .cmd spawning.
- Child environment is built from an allowlist of safe variables; anything
  matching `GITHUB*/GH_TOKEN/AI_API_KEY/NEXUS_LOCAL_API_TOKEN/ZCODE_*/…API
  KEY/SECRET/TOKEN/PASSWORD…` patterns is stripped, so a command printing its
  environment cannot exfiltrate host credentials into model-visible output.
- Timeouts kill the whole process tree (`taskkill /PID x /T /F`); output is
  capped per stream (default 256 KB, marked `truncated`); an AbortSignal
  cancels mid-run.

## 5. Auditability

Every tool call is recorded twice: in the runtime's in-memory result
(`toolCalls[]`, persisted on the task) and as a task event with the tool name,
ok/failed flag, error and compact arg/result summaries. User approvals add
`approval_requested` / `approval_resolved` events including who decided.

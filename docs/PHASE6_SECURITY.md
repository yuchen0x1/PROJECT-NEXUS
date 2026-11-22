# PHASE 6 Security — Keys, Approvals, Isolation, Injection

Date: 2026-11-13 · Scope: everything added in PHASE 6A.

## 1. API key lifecycle

| Stage | Mechanism |
| --- | --- |
| Entry | Renderer sends the key once over IPC (`desktop:provider-keys:set`); it is never stored in renderer state beyond the input field. |
| At rest | Electron `safeStorage` (Windows DPAPI), written to `<userData>/provider-keys.json` as latin1 ciphertext. No plaintext key ever touches disk. |
| Hand-off | The main process decrypts and POSTs keys to the local service over `http://127.0.0.1:<port>/api/local-agent/provider-keys` with the per-launch bearer token. |
| Service runtime | Keys live in a process-memory map only (`provider-store.setRuntimeProviderKeys`). `ai-providers.json` stores metadata exclusively; the renderer-facing provider API returns only `hasApiKey` booleans. |
| Logs/errors | `redactSecrets` scrubs token-shaped strings and key/value pairs from every error path, observation and report; the child-command environment strips credential variables wholesale. |
| Deletion | `desktop:provider-keys:delete` removes the vault entry and the in-memory key. |

Trust boundary: `providerUrl` requires HTTPS except localhost — a key cannot
be sent to an arbitrary HTTP host. Connectivity tests always run through the
same redaction pipeline.

## 2. Approval integrity

- Approvals are server-side records inside the persisted task; the model can
  create a request (`request_approval` tool) but has **no** path to resolve
  one. Resolution requires an authenticated API call from the desktop UI.
- `high` risk cannot be auto-approved by any policy setting. `run_command`
  computes risk dynamically: any program outside the allowlist (npm, node,
  git, python, cargo, dotnet, pytest, …) becomes high risk → live approval.
- Approval timeouts (default 10 min) auto-expire to `expired`, which the
  runtime treats as a denial.

## 3. Path and workspace safety

- All file tools normalize paths: no `..`, no absolute paths, no reserved
  Windows names, no secret-like segments (.env*, id_rsa, *.pem/key/p12,
  credentials.json, .ssh/.aws), no symlink traversal (lstat checks at every
  component, realpath containment after resolution).
- The worktree adapter re-validates every operation path against the worktree
  root and blocks the same secret-like set. The copy adapter inherits the
  PHASE 4 policy engine (gitignore compilation, byte/entry/depth ceilings).
- Task workspaces are per-project and per-task directories; two tasks can
  never share a writable root, and cross-project writes have no valid path
  expression (relative paths only, contained by realpath checks).

## 4. Command injection

Commands are tokenized into argv (never `shell: true` except the managed
cmd.exe shim for .cmd/.bat launchers, where arguments are pre-validated to be
metacharacter-free and fully quoted). Escalation attempts like `node a &
whoami`, `$(whoami)`, backticks, redirects and pipes are rejected before any
process starts (`COMMAND_METACHARACTER` / `COMMAND_INVALID`). git tool
arguments are themselves validated (branch names, checkout targets, commit
messages) with newlines/quotes stripped or rejected.

## 5. Renderer/IPC invariants (unchanged from PHASE 4/5, verified by tests)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  window-open denied, navigation restricted to the local service origin.
- The preload bridge exposes a frozen, minimal API; direct unauthenticated
  API access from the renderer is rejected (desktop smoke test asserts this).
- The service binds 127.0.0.1 only; CORS stays empty in desktop mode; the
  bearer token is regenerated per launch.

## 6. Model-output hardening

- Operations and tool arguments are schema-validated; unknown fields rejected.
- The system prompt forbids deleting tests, weakening assertions, disabling
  checks, touching secrets, network commands, and out-of-scope refactors.
- The independent review stage re-reads the final diff with instructions to
  flag exactly these violations, and its findings are rendered to the user
  before the apply decision.
- Apply-to-project is the only path that writes outside the workspace; it
  requires `confirm: true`, a clean project tree, and keeps a byte-level
  backup of every overwritten original.

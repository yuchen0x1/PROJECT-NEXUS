# Phase 4 sandbox boundary

**Status date:** 2026-11-12

## Desktop Agent

The Windows Local Agent does **not** execute generated code or project commands in this phase. It creates and edits a bounded task-private copy, then shows a diff. No Docker container is started for a local Agent task. Consequently there is no local build/test result or automatic repair result to report.

## Existing repository job runner

The separate `server/services/sandbox-runner.mjs` is used for framework checks in the remote-repository integration pipeline. It is not wired to locally registered project Agent tasks. Its current defaults are:

- A managed workspace is path-checked beneath the configured workspace root before launching Docker.
- Electron/Web: `node:22-alpine`; Python: `python:3.12-alpine`; .NET: `mcr.microsoft.com/dotnet/sdk:8.0`; Tauri has no runner image.
- Container options include `--network=none`, 2 GiB memory, 2 CPUs, 256 PIDs, all Linux capabilities dropped, `no-new-privileges`, and UID/GID `10001:10001`.
- A random container name, `--rm`, process cancellation, a default 10-minute timeout, and an in-memory output cap of 100,000 characters are used.
- Workspace is bind-mounted at `/workspace` and is **not** mounted read-only. The Docker daemon and host kernel remain part of the trust boundary; this is not an absolute security sandbox.
- Node checks use `npm ci --offline`; Python checks compile and run `pytest` when tests are found; .NET uses `dotnet test --no-restore`. Missing test/build evidence is reported as PARTIAL rather than PASS.

The runner has no built-in dependency download path for offline checks. Supported framework profiles are limited; an unsupported framework returns `BLOCKED`.

## Host check in this delivery

The host had Docker CLI `29.9.3`, but `docker info` failed with exit code `1` because `//./pipe/dockerDesktopLinuxEngine` was unavailable. No container build/test was run during Phase 4 acceptance. Do not interpret the CLI being present or the runner code as proof the daemon, images, profiles or a target project's tests work.

## Future local execution gate

Before connecting local Agent tasks to any executor, add a fixed command/profile allowlist, visible command/worktree disclosure and approval, canonical working-directory checks, process-tree cancellation, bounded time/output/resources, environment redaction, per-task audit events, and safe workspace cleanup. Keep the network disabled by default, verify actual mount permissions, and test graceful cancellation and rollback. Docker Desktop/daemon state must be detected as a live prerequisite; the service must report BLOCKED when it is unavailable.
# Security model

## Current controls

- GitHub and AI credentials remain server-side; task errors redact configured credential strings.
- The scanner uses bounded GitHub reads pinned to a commit SHA and validates pagination links against the configured API origin.
- AI input is limited to selected source files; secret-like paths and common credential patterns are filtered/redacted.
- Model file operations are bounded and checked against workspace path traversal, symlink, file-size and operation-count rules.
- Target checks use Docker with no network, resource limits, dropped capabilities and no-new-privileges.
- Remote branch/PR writes are disabled by default. When enabled, the route requires non-header role mode, a configured Administrator role, a passing check, changed files and exact repository/branch confirmation. It creates a draft PR only; it does not merge or publish a release.
- Webhooks use HMAC verification and delivery ID deduplication. Intake, task execution and audit storage remain in-process/local JSON.
- `data/state.json` is git-ignored and schema upgrades are additive and atomic.

## Deployment boundary and known gap

The application currently has **no per-user authentication**. `NEXUS_ROLE` is a process-wide identity setting shared by every caller, and source disclosure/repository/branch confirmations are request/UI intent rather than caller authentication. Integration report and job APIs contain source paths, patches, logs and test output. Do not expose the service to an untrusted network.

The API binds to `127.0.0.1` by default. Compose maps the service to host loopback by default. Keep `NEXUS_ENABLE_REMOTE_WRITES=false`. Any deployment that changes these network boundaries needs an authenticated proxy and network restrictions; before shared use, the app also needs real user sessions and per-user role enforcement.

## Limits

- Secret redaction is heuristic; it cannot guarantee that all sensitive content is removed from source sent to a model.
- Static presence of a signing option, digest or secure URL does not verify signatures or publisher identity.
- Docker sandboxing depends on a correctly configured Docker daemon. Offline dependency restore can fail, and unsupported runtimes return BLOCKED.
- In-process queues and locks do not coordinate multiple server processes.
- The default process role supports local single-user operation only; it is not an access-control boundary for a public service.

See [UPDATE_SECURITY.md](UPDATE_SECURITY.md) for the update evidence model and [DEPLOYMENT.md](DEPLOYMENT.md) for bind and configuration settings.

## Phase 4 native desktop boundary

The Windows host adds a loopback-only local service, random per-launch bearer token, Electron preload bridge and task-private workspace for local Agent proposals. Source disclosure, heuristic redaction, file/path limits and remaining risks are detailed in [PHASE4_SECURITY.md](PHASE4_SECURITY.md). These application controls are not a hostile-code sandbox; the desktop Agent currently does not execute generated code or project commands. The Phase 4 installer is unsigned and no signed update loop is verified.
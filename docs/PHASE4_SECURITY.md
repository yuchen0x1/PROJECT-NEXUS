# Phase 4 local desktop and Agent security

**Status date:** 2026-11-12

## Current protections

- Electron uses context isolation, a narrow preload bridge, a local application origin and navigation/popup restrictions. The renderer does not receive the local API bearer token.
- Each desktop launch creates a random 32-byte API bearer token and starts the API on loopback with an ephemeral port. The desktop main process adds the token to bridge requests. The installed smoke verified bridge health `200` and direct unauthenticated renderer health `401`.
- User-selected project folders are registered by canonical path. Scanning is read-only and bounded; symlinks are skipped/rejected on project and workspace paths.
- Model changes are written only into a per-task workspace under app data. The baseline is separate. The registered source folder is not modified by this feature.
- The provider request requires an explicit UI disclosure confirmation. Eligible source count/bytes are capped, common generated/dependency directories are skipped, `.gitignore` exclusions are applied, and secret-shaped paths are omitted. Provider keys stay in the local service process and are not sent to the renderer.
- Prompt, queue, file count, workspace size/depth, operation count/bytes, task history and event history have explicit bounds.
- Window and service errors are logged to the per-user log directory with credential redaction in relevant provider errors.

## Limits and risks

- **Source redaction is heuristic.** It cannot guarantee removal of secrets in arbitrary source text, comments, encoded content or novel formats. Explicit confirmation is not a guarantee of privacy; provider policy and retention apply after transmission.
- Workspace copying and API checks are application-level containment, not a hostile-code sandbox. The Agent does not execute model-generated code or project commands in this phase, which reduces execution risk but also means no local build/test capability exists.
- Local Windows user access controls the process and its files. The desktop bearer token protects the renderer-to-local-service boundary; it is not a multi-user authorization system for a shared remote server.
- The web/server deployment's role is process-wide, not per-user authentication. Keep remote deployment on a trusted network boundary and keep remote writes disabled unless separately reviewed.
- The shipped NSIS installer is **unsigned** (`Get-AuthenticodeSignature`: `NotSigned`). The displayed publisher/company metadata is not proof of a trusted signing identity.
- No signed auto-update metadata/feed, release signature verification, staged rollout or update/rollback cycle was tested.
- No clean Windows VM, malware scan, code-signing certificate, Windows Defender reputation or third-party penetration test was available in this acceptance evidence.

## Review guidance

Before sending source, inspect the selected project and the disclosure list. Do not configure a provider with source you are not permitted to transmit. Treat provider output as untrusted proposed data. Review every path and diff manually; do not use the word “applied” unless a future, separately tested approval-gated write path actually modifies the selected project.

See [Agent limits](PHASE4_AGENT_ENGINE.md), [installation evidence](PHASE4_WINDOWS_INSTALL.md) and the existing [deployment boundary](SECURITY.md).
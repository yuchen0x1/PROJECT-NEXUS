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


## Legacy workflow dispatch and release writes

The legacy project APIs use the same opt-in and trusted-role policy as remote branch/PR creation. This applies to both PAT and GitHub App installation credentials; configuring credentials alone does not authorize a write.

| Operation under `/api/projects/:projectId` | Minimum process role | Additional boundary |
| --- | --- | --- |
| `POST /build` (Actions dispatch) | Operator | Remote writes enabled; non-header role mode |
| `POST /releases` | Operator | Creates a draft only, regardless of a supplied publication flag |
| `PATCH /releases/:releaseId` | Operator | Draft metadata only; publication state is never forwarded |
| `POST /releases/:releaseId/assets` | Operator | Uploads to drafts only |
| `POST /releases/:releaseId/publish` | Administrator | Literal JSON `confirm: true`; the only legacy release API that publishes |

All five routes require remote writes to be explicitly enabled and `NEXUS_ALLOW_ROLE_HEADER` to be off. The effective switch is the saved `settings.remoteWritesEnabled` boolean when present, otherwise `NEXUS_ENABLE_REMOTE_WRITES=true`. A saved `false` overrides an environment opt-in; a saved `true` remains enabled even if the environment fallback is false. Administrators can change the saved switch through the authenticated desktop setup/settings flow. Keep both the saved switch and environment fallback off unless remote work is intended.

Requests denied at intake return `REMOTE_WRITES_DISABLED`, `UNTRUSTED_ROLE_MODE`, or `INSUFFICIENT_ROLE` before scheduling tasks or contacting GitHub. Only the listed role names grant permissions; an unknown or empty configured role grants none. Workflow/run/release reads remain available when writes are disabled.

All five actions recheck the live switch immediately before starting the mutation request, after any GitHub App token refresh, release preflight read, or local state save. If the switch is off at that point, queued tasks fail with `REMOTE_WRITES_DISABLED` and synchronous edit/upload requests return HTTP 403 with the same code. Disabling writes does not cancel requests already handed to the HTTP client or undo workflows and releases already started on GitHub.

Generic release editing rejects any supplied `draft` value other than literal `true` with `RELEASE_PUBLISH_REQUIRED`; accepted `draft: true` is a compatibility no-op, not a forwarded field. Metadata editing and asset upload reject a non-draft release with `RELEASE_NOT_DRAFT`. Uploads must target the requested repository and release on the configured `GITHUB_UPLOADS_URL` origin and base path. Legacy mutation requests do not follow redirects. Clients that previously edited published releases must use a separate, externally reviewed release-management process. The Release Center now asks for repository/tag confirmation before submitting publication, and the API client requires its caller to supply confirmation rather than manufacturing it.

These are legacy endpoint guards, not a replacement for the separate hosting/autonomy delivery policies. Actions workflows execute with their own repository-configured permissions and may themselves perform writes; review which workflows Operators can dispatch. Draft-state preflight reads are not atomic with GitHub mutations, so concurrent external publication can race with an edit or upload. No live GitHub write is needed to validate these controls: the regression suite uses disposable state and loopback GitHub/upload stubs.

## Desktop AI provider credentials

Desktop AI keys are encrypted with Electron `safeStorage` and stored separately from provider metadata. The vault persists an opaque, versioned SHA-256 binding over provider identity, protocol, configuration generation, and the full normalized destination URL; it does not persist that URL in the binding. This digest binds ciphertext to a destination but is not encryption or authentication. Stored provider base URLs reject user information, query strings, and fragments; use the separate API-key field instead.

Existing v1 vault entries have no trusted destination binding. They are deliberately not auto-bound: their ciphertext is preserved on disk, but the affected key must be re-entered to use it. While a delete's vault write or atomic rename fails, deletion fails and the existing credential remains active; retry the delete after the disk issue is resolved. Once revocation is confirmed, new network attempts from already-resolved work are rejected, but a request already sent to a provider cannot be recalled.

For compatibility, inference URL validation for environment-configured providers is unchanged in this patch. It still uses the inference URL validator, while model discovery rejects URL user information, queries, and fragments. Aligning those environment-path policies is deferred to a separately scoped compatibility change.


## Windows publication trust boundary

The GitHub Actions workflow separates read-only compilation from a publication job with `contents: write`. Publication uses default-branch dispatch, not code supplied by a newly pushed tag. Signing credentials belong in a branch-restricted environment, never at repository scope; pull requests receive neither those secrets nor a publication job. Public releases require a pinned Authenticode signer, the original tag commit and four matching remote artifact digests. The API checks do not replace protected tags or immutable releases, and neither a digest nor a signature proves data migration or rollback. See [release management](RELEASE_MANAGEMENT.md).


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
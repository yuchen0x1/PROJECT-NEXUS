# API reference

The Express API listens on port `4317`. JSON request bodies are limited to 1 MiB except the raw GitHub webhook body, which is limited to 5 MiB. Routes that call GitHub return a setup or permission error when credentials are missing.

## Core and GitHub routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Process health |
| GET | `/api/auth/context` | Configured single-server role context |
| GET | `/api/github/status` | GitHub connection and permission summary |
| GET | `/api/github/app/config` | App configuration and installation status |
| GET | `/api/github/app/install-url` | Generate a GitHub App installation URL |
| GET | `/api/github/app/callback` | Verify and record an installation |
| POST | `/api/github/app/installations/:installationId/sync` | Paginated installation repository sync |
| POST | `/api/github/webhook` | Verify HMAC and enqueue a GitHub webhook delivery |
| GET | `/api/overview` | Metrics, projects, task pulse and activity |
| GET | `/api/projects?query=&group=` | Filter tracked repositories |
| POST | `/api/tasks/sync-repositories` | Queue an authenticated GitHub repository sync |
| POST | `/api/projects/:projectId/scan` | Read repository root files for stack hints |
| GET | `/api/projects/:projectId/workflows` | List GitHub Actions workflows |
| GET | `/api/projects/:projectId/runs` | List recent workflow runs |
| POST | `/api/projects/:projectId/build` | Dispatch a workflow for an explicit ref |
| GET | `/api/releases?projectId=` | Read tracked repository releases |
| POST | `/api/projects/:projectId/releases` | Create a semantic-versioned draft |
| PATCH | `/api/projects/:projectId/releases/:releaseId` | Edit a release |
| POST | `/api/projects/:projectId/releases/:releaseId/publish` | Publish after role and confirmation checks |
| POST | `/api/projects/:projectId/releases/:releaseId/assets` | Upload a release asset and record SHA-256 |
| GET | `/api/tasks` | Read task state |
| GET | `/api/audit-logs` | Read audit records (Administrator role check) |
| GET | `/api/settings` | Read non-secret runtime settings |
| GET | `/api/ai/providers` | List non-secret provider/model capability and routing status |
| POST | `/api/ai/diagnose` | Execute a bounded diagnostic request when a provider is configured; otherwise return an explicit blocked response |

## Phase 3 integration routes

| Method | Route | Purpose and gate |
|---|---|---|
| GET | `/api/integrations/adapters` | List adapters, AI config status and remote-write flag |
| GET | `/api/integrations/security` | Aggregate scan evidence and security configuration status |
| GET | `/api/integrations/schedule` | Read recurring scan schedules |
| PUT | `/api/integrations/schedule` | Set enabled state and interval (6–720 hours); Administrator role check |
| GET | `/api/integrations/reports?projectId=&limit=` | List saved scan reports; limit is clamped to 1–100 (default 50) |
| GET | `/api/integrations/reports/:reportId` | Read one report |
| GET | `/api/integrations/jobs?projectId=` | List up to 100 recent jobs |
| GET | `/api/integrations/jobs/:jobId` | Read job, corresponding task and report |
| POST | `/api/integrations/scans` | Queue scans for all tracked projects or `projectIds` (maximum 100); Operator role check |
| POST | `/api/projects/:projectId/integration-scan` | Queue one repository evidence scan; Operator role check |
| POST | `/api/integrations/jobs` | Queue AI changes from `reportId`; requires `confirmSourceDisclosure: true` and Operator role |
| POST | `/api/integrations/jobs/:jobId/cancel` | Cancel a Pending or Running job; Operator role check |
| POST | `/api/integrations/jobs/:jobId/retry` | Retry a Failed, Blocked or Cancelled job; AI retries require `confirmSourceDisclosure: true` |
| POST | `/api/integrations/jobs/:jobId/pull-request` | Push a review branch and open/reuse a draft PR; disabled by default and gated as below |

The AI job body is `{ "reportId": "...", "confirmSourceDisclosure": true }`. A provider must be configured with `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`; otherwise a blocked job is recorded without generated changes.

The PR route requires `NEXUS_ENABLE_REMOTE_WRITES=true`, `NEXUS_ALLOW_ROLE_HEADER` disabled, the configured server role to pass Administrator checks, a review-ready job with passing isolated checks and changes, and `{ "confirm": true, "confirmRepository": "owner/repo", "confirmBranch": "nexus/auto-update-..." }`. It pushes a branch and opens a draft PR; it does not merge or publish a release.

## Important boundaries

The role is configured at process level; it is not an authenticated per-user identity. The API defaults to loopback binding. Do not expose it to an untrusted network or enable remote writes in a shared deployment until authentication and per-user authorization are added. Source disclosure and repository/branch confirmation are application prompts, not identity proofs.

Scan output is bounded and static. `truncated` reports tree limits. A configured signing key, manifest, digest or HTTPS URL is evidence only; signatures, package installation and old-client update success remain unverified.

## Autonomy production routing boundary

`server/index.mjs` registers autonomy **before** the terminal API 404 and SPA/static fallbacks. The registered HTTP surface is an explicit read-only allowlist: only the following GET routes (and Express's corresponding HEAD requests) are available under `/api/autonomy`, with the existing local-session, origin and rate-limit middleware plus a minimum configured `Viewer` role:

- `/health`, `/overview`, `/control/status`
- `/repositories`, `/adapters`, `/tasks`, `/findings`, `/sessions`
- `/peers`, `/proposals`, `/audit`, `/readiness`

This includes all ten requests in `AutonomyCenter.load` (initial load and refresh), not just overview. Reads return existing stored data/readiness diagnostics; they do not probe or launch desktop clients, schedule work or contact GitHub. `/overview` reports `apiAccess: "read-only"`; the UI shows that state, preserves Refresh, and hides actions that are not available.

Desktop hosts and non-loopback listeners require `NEXUS_LOCAL_API_TOKEN`. Only standalone listeners configured for loopback and reached over a loopback socket allow reads without that token. Do not publish a token-free loopback listener through a reverse proxy. The role remains process-level; it does not identify individual users.

**Blocked in production, including for Administrator:** all autonomy POST/PATCH/PUT/DELETE and other non-read requests return `403 AUTONOMY_READ_ONLY`. This covers control/settings and immediate actions; repository add/update/remove/sync/issue assessment; security scans/task generation; task creation and lifecycle actions; desktop probing/window discovery/launch; session resolution; research; and all delivery operations (commit/push, PR including verified-task PR, merge, release and notification). This fix restores viewing, not authorization to execute those actions. Explicit confirmation fields, a role header or a persisted remote-write flag cannot bypass the boundary. Re-enabling any action requires separately integrated role **and** action-specific intent/consent controls.

`POST /api/autonomy/webhook` is also blocked; it has no HMAC verification and must not be exposed. Only the existing raw-body `POST /api/github/webhook` HMAC path remains available, subject to its unchanged local-session/origin requirements, signature validation and delivery deduplication. It is not newly connected to the autonomy monitor.

Other autonomy GETs remain unavailable (`404 API_NOT_FOUND`), including `/security/tools` (executes external programs), `/delivery/:repoId/status` (may contact GitHub), task detail/package reads and other endpoints outside the allowlist. The existing background ticker/recovery behavior is unchanged; this HTTP boundary is not a shutdown switch for previously configured work.

Regression: `npm test -- tests/unit/autonomy-routing.test.mjs --maxWorkers 1` starts the real production entrypoint with temporary synthetic state, exercises the frontend's entire read batch, session/origin/role rejection, blocked mutations for all three configured roles, and raw-body HMAC verification/deduplication. With Playwright Chromium installed, run `npm run build && node tests/autonomy-browser.mjs` to verify real navigation, persisted fixture records, a completed refresh, and hidden controls. Browser screenshots are saved under `test-results/autonomy-browser/`. No live services or remote writes are used.

## Autonomy phase-two handler inventory (not enabled in production)

The following describes module-level implementations, **not** additional production endpoints. The read-only allowlist above takes precedence over the handler-level gates below.

| Method | Route | Purpose and gate |
|---|---|---|
| GET | `/api/autonomy/security/tools` | Detect CodeQL, Semgrep, Gitleaks and Trivy versions and installation state |
| POST | `/api/autonomy/security/scan` | Run local plus optional external scans; saves a report and finding history. Set `repoId` or an explicit `root`; external tools are enabled by default |
| GET | `/api/autonomy/security/scans` | Read persisted scan reports and historical comparisons |
| POST | `/api/autonomy/security/scans/:id/tasks` | Convert saved findings into an idempotent NEXUS security-fix task |
| GET | `/api/autonomy/delivery/:repoId/status` | Read branch, PR, Review, checks and Actions evidence from GitHub |
| POST | `/api/autonomy/delivery/:repoId/commit-push` | Commit and push an isolated `nexus/auto/*` worktree; requires remote writes and `confirm: true` |
| POST | `/api/autonomy/delivery/:repoId/pull-request` | Create or reuse a draft PR; requires remote writes and `confirm: true` |
| POST | `/api/autonomy/delivery/:repoId/merge` | Merge only when repository `autoMerge` and the runtime remote-write gate are enabled |
| POST | `/api/autonomy/delivery/:repoId/release` | Create a stable `vX.Y.Z` GitHub Release; repository `autoRelease`, remote writes and explicit confirmation are required |
| POST | `/api/autonomy/delivery/:repoId/notify` | Send a bounded JSON notification to the configured HTTP(S) channel after explicit confirmation |

Remote write operations return a machine-readable gate error while the default `remoteWritesEnabled` setting is false. A successful draft PR or release creation response is recorded separately from merge or publication confirmation.

## AI provider configuration

`GET /api/ai/providers` returns provider ids, task routes, model capabilities and non-secret health metadata. API keys are never returned. `POST /api/ai/diagnose` accepts `{ "prompt": "...", "context": {}, "providerId": "optional" }`; it performs a bounded real request only when a provider is configured and the caller has the Operator role. Without credentials it returns `424 AI_NOT_CONFIGURED` instead of synthetic output.

The registry is configured with `NEXUS_AI_PROVIDERS_JSON` and `NEXUS_AI_ROUTING_JSON`, or the legacy `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` variables. Supported request formats are OpenAI-compatible, Ollama, Anthropic and Gemini; all providers are subject to HTTPS/local URL validation, timeout, cancellation and bounded retry policy.

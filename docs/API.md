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

## AI provider configuration

`GET /api/ai/providers` returns provider ids, task routes, model capabilities and non-secret health metadata. API keys are never returned. `POST /api/ai/diagnose` accepts `{ "prompt": "...", "context": {}, "providerId": "optional" }`; it performs a bounded real request only when a provider is configured and the caller has the Operator role. Without credentials it returns `424 AI_NOT_CONFIGURED` instead of synthetic output.

The registry is configured with `NEXUS_AI_PROVIDERS_JSON` and `NEXUS_AI_ROUTING_JSON`, or the legacy `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` variables. Supported request formats are OpenAI-compatible, Ollama, Anthropic and Gemini; all providers are subject to HTTPS/local URL validation, timeout, cancellation and bounded retry policy.

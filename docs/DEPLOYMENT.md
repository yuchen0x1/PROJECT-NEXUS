# Deployment

## Local development

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The API binds to `127.0.0.1:4317` by default. Set `NEXUS_HOST` only when the deployment needs a different interface. The Vite development server proxies `/api` to the local API.

## Docker Compose

```powershell
Copy-Item .env.example .env
docker compose up --build
```

The container listens on `0.0.0.0:4317` internally; Compose publishes `127.0.0.1:4317` on the host by default. State is stored in the `nexus-data` volume and health is checked through `/api/health`. If changing the published address, put the service behind an authenticated, TLS-terminating proxy and limit network access.

## Configuration

- `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_API_URL`: repository and GitHub Actions access.
- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`: GitHub App and signed webhook configuration.
- `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_PROVIDER_KIND`: legacy/default provider for actual model calls; Ollama may omit an API key when bound to a trusted local endpoint.
- `NEXUS_AI_PROVIDERS_JSON`, `NEXUS_AI_ROUTING_JSON`, `AI_DEFAULT_PROVIDER`, `AI_REQUEST_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_INPUT_COST_PER_1M`, `AI_OUTPUT_COST_PER_1M`: optional provider registry, task routing, retry and cost metadata. Keep provider keys server-side.
- `NEXUS_CORS_ORIGINS`: comma-separated browser origins; defaults to the local Vite origins (`http://127.0.0.1:5173,http://localhost:5173`).
- `NEXUS_ROLE`: process-level role in single-server mode; this is not per-user authentication.
- `NEXUS_ALLOW_ROLE_HEADER`: development role simulation only; remote PR writes explicitly fail closed when enabled.
- `NEXUS_ENABLE_REMOTE_WRITES`: must be explicitly set to `true` before the PR route can push a branch or create a draft PR. Keep false by default.
- `NEXUS_HOST`, `PORT`, `NEXUS_STATE_FILE`: bind address, port and optional state file path.

## State upgrade

Back up `data/state.json` while the service is stopped. Startup migrates schema v1/v2 additively to v3, preserving existing collections. Invalid or unsupported state fails closed. See [STATE_MIGRATIONS.md](STATE_MIGRATIONS.md).

## Operational limits

Scans, schedules, task state and locks are managed by one Node process. The JSON file is not a multi-writer database. Use a single instance until a durable database, queue and distributed locking design is separately implemented.

AI target checks run in Docker with network access disabled, dropped capabilities and resource limits. Dependency restoration may fail without a prepared offline cache. A check that cannot restore dependencies is reported as blocked/failed; it must not be treated as a passing test.

No signing service, update server, release CDN or old-client integration is configured by this repository. A scan report does not establish that a deployed client can update.

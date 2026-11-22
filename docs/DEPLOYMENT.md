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

### Restarting with an existing volume

Run only one NEXUS service against the volume. Do not depend on unattended Compose restarts: the persistent host lease survives a stop, but a restarted container may use a new PID namespace and reuse the former owner's numeric PID. Repeated restarts will not safely resolve `LEASE_HELD` in that case.

For a planned restart or container replacement, stop the service and disable automatic restarts first. Verify from the Docker host that the old container has exited and no other running container or host process can access either state path. Back up the volume and any separate state path. Only then use an offline maintenance mount (without starting the NEXUS entrypoint) to archive the lease files as described in [Recovering a blocked startup](#recovering-a-blocked-startup), and start one service again. If exclusive ownership cannot be verified, leave the leases in place. Do not remove the volume or use `docker compose down -v` as a recovery step.

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

Back up the data directory and any external `NEXUS_STATE_FILE` while the service is stopped. Startup applies supported state migrations; invalid or unsupported state fails closed. See [STATE_MIGRATIONS.md](STATE_MIGRATIONS.md).

**Stop every older NEXUS host before upgrading or rolling back.** Do not run mixed versions against the same state file or data directory. Older hosts can open and recover Autonomy state before checking their lock, and may only lock their configured state file.

### Recovering a blocked startup

The host leases `state.json.host.lock` inside `NEXUS_DATA_DIR` (default: `data/`). A custom `NEXUS_STATE_FILE` also uses `<state-file>.host.lock`. A live owner blocks startup even if its listener has closed. Once a host reaches readiness, it leaves those files in place on shutdown, including a normal stop. The next start can reclaim a valid lease only after confirming that its owner PID no longer exists. These leases are for a local filesystem and hosts in the same OS PID namespace; do not share the paths across machines or separate PID namespaces.

An empty or malformed lease, or a leftover `.reclaim` file from an interrupted reclamation, can block automatic recovery. Do not remove locks just because they are old or the API is unresponsive. Stop all NEXUS hosts, disable automatic restarts, and verify no host or startup process is using either path. If you cannot verify that, leave the locks in place. Once verified, back up the data and move only the affected `.host.lock` and its `.reclaim` companion aside for inspection, then start a single host. Do not delete the state file, database, or worktrees to clear a lease.

## Operational limits

Scans, schedules, task state and locks are managed by one Node process. The JSON file is not a multi-writer database. Use a single instance until a durable database, queue and distributed locking design is separately implemented.

The lease prevents a replacement NEXUS host from starting while the old host process is alive. It does not guarantee a graceful drain: admitted HTTP handlers, detached jobs, Evolution workers and scheduler admissions may still be unfinished at process exit. A stopped listener or a successful exit does not confirm that final task state was persisted, subprocesses finished, or external effects were reconciled. Check interrupted work and external effects before retrying.

AI target checks run in Docker with network access disabled, dropped capabilities and resource limits. Dependency restoration may fail without a prepared offline cache. A check that cannot restore dependencies is reported as blocked/failed; it must not be treated as a passing test.

No signing service, update server, release CDN or old-client integration is configured by this repository. A scan report does not establish that a deployed client can update.

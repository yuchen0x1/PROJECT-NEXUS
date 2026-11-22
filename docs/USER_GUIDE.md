# Windows desktop workstation and local Agent

1. Install the Windows x64 NSIS package. The package is unsigned; review [the install report](PHASE6_DELIVERY_REPORT.md) before distributing it.
2. Launch PROJECT NEXUS. The native app starts its packaged local service and stores settings, logs, project registration, task state and Agent workspaces under `%LOCALAPPDATA%\PROJECT NEXUS`.
3. Open **Local projects** and choose a project folder. Registration and marker scanning do not modify project files.
4. Open **Environment** to inspect detected tools. The scanner checks executable paths and selected version probes; it does not install tools or change `PATH`.
5. To use **AI Agent**, configure a provider on the AI Agent page: add a provider (name, API format, base URL, model), paste the API key once (it is encrypted with Windows DPAPI and never shown again), and press **Test connection**. Legacy environment variables (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`) still work for server deployments.
6. Select a registered project, write the request, inspect the source disclosure and confirm before sending. The configured provider receives the prompt plus a bounded, redacted context selection (up to 24 files / 120 KiB). Redaction is heuristic; inspect project content and provider policy first.
7. **Task engine** — "Autonomous agent" runs a real multi-turn loop: it plans, reads and edits files inside an isolated git worktree (bounded snapshot copy for non-git projects), runs the project's own build/test scripts, repairs bounded failures, and has its diff independently reviewed. "Single-pass proposal" is the Phase 4 engine (a proposal only, no commands).
8. **Approval policy** — Supervised asks before every write; Standard auto-runs workspace writes and asks for risky actions (deletes, dependency installs, non-allowlisted commands); Workspace-auto only asks for actions outside the workspace. High-risk actions always pause the task with an approval card — the model can never approve itself.
9. When the task finishes: review the **plan, tool timeline, verification output and review findings**, then either **Roll back workspace** (everything returns to the start state) or **Apply to project** (requires a clean project tree, confirms explicitly, backs up every overwritten original, and never commits — you review in your own git).
10. Use Cancel for a queued/running task. Retry creates a new task and requires fresh disclosure consent. If the app exits mid-task, it is recorded as Interrupted and the workspace is kept for you to re-run, roll back, or apply.

## Appearance, language and settings (Phase 5)

1. Open **Settings** (gear icon in the top bar, or the Settings entry in the activity bar). Settings are stored per Windows user in `%LOCALAPPDATA%\PROJECT NEXUS\desktop-settings.json` and survive upgrades.
2. **Interface language**: pick one of the ten shipped languages (简体中文, 繁體中文, English, 日本語, 한국어, Français, Deutsch, Español, Português (Brasil), Русский). The entire application switches immediately — no restart. The first launch follows the Windows display language; a manual choice always wins afterwards.
3. **Theme**: Dark, Light, or Match Windows. "Match Windows" follows the system setting in real time. The sun/moon button in the top bar toggles dark/light directly.
4. **Reduce motion** minimizes animations across the workstation.
5. **Agent reply language** (Settings → AI Agent): choose whether the Agent's explanatory text follows the interface language, follows the language of your request, or uses one fixed language. Code, commands, identifiers and file paths are never affected.
6. **Start with Windows** can be toggled under Settings → Startup.
7. Press `Ctrl+K` anywhere to open the **command palette**: search pages, projects, actions and languages, then run them with Enter. The bell icon opens the **notification center** with unread activity and Agent task results. The bottom **activity log** drawer can be expanded and resized by dragging its top edge. The activity bar collapses to icons with the button at its bottom.

**Troubleshooting the Agent**: "Provider required" means no provider has a saved key — add one on the AI Agent page. A `Failed` task is honest: open its events to see the failing tool/verification output; tests are never faked and the review flags verification failures as CRITICAL. Model quality matters — small local models may loop; the runtime detects repetition and enforces budgets. See [Phase 6 security](PHASE6_SECURITY.md) and [architecture](PHASE6_ARCHITECTURE.md).

---
# User guide

## Connect and manage repositories

1. Copy `.env.example` to `.env` and configure a GitHub token or GitHub App.
2. Start with `npm run dev` or Docker Compose. The default API and Compose host bind use loopback.
3. Open Overview and select **Sync GitHub** to import repository metadata.
4. Use Projects to inspect repositories and Build Center to inspect workflows, runs or dispatch a selected workflow/ref.
5. Release Center reads real releases. Draft, publish and asset actions can write to GitHub and require the configured role and confirmation checks.

## Scan update capability

1. Open Repository Scanner and select one project or start a workspace scan.
2. A running task records the current step and progress. Active scans for the same repository are reused.
3. Open Integration History to select the saved commit-pinned report. Review the detected framework, evidence paths, read errors, scan limits and missing checks.
4. Android/iOS markers appear as unsupported until a dedicated adapter exists. A report score is based on static evidence; it does not prove an installed update.
5. In Repository Scanner, an Administrator can enable recurring scans at an interval from 6 to 720 hours. Scheduling runs inside the current server process.

## Prepare an AI change proposal

1. Configure `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` on the server and ensure GitHub clone access is available.
2. Run a repository scan and open AI Integration Pipeline.
3. Select its report and approve the source-disclosure prompt. Selected source files are sent to the configured provider after redaction; this is not a guarantee that all secrets are removed.
4. Track progress, logs, changed paths, diff, patch and test output in AI Pipeline or Task Center.
5. Review the generated patch before taking any remote action. A sandbox check may fail or be blocked if Docker or offline dependencies are unavailable.
6. Use Cancel for a running job. Use Retry for a Failed, Blocked or Cancelled job. Retrying an AI job asks for source-disclosure confirmation again.

## Open a draft PR

Remote writes are disabled unless `NEXUS_ENABLE_REMOTE_WRITES=true`. The application has process-level role configuration, not per-user authentication. Do not expose the service to an untrusted network. A draft PR additionally requires the configured Administrator role, header-role simulation disabled, passing isolated checks, a non-empty change set, and confirmation of the exact repository and generated branch. This action pushes a branch and opens a draft PR; it does not merge or publish.

## Review security evidence

Adapter Center lists the supported evidence adapters. Update Security shows scan findings and runtime configuration. Signing indicators, HTTPS configuration and digest references are not cryptographic verification. The current app does not verify a release signature or complete an old-client update cycle.

Security Center shows audit events for operations that record them. Settings and API responses do not reveal GitHub/AI secret values.

# Windows desktop workstation and local Agent

1. Install the Windows x64 NSIS package. The Phase 4 package is unsigned; review [the install report](PHASE4_WINDOWS_INSTALL.md) before distributing it.
2. Launch PROJECT NEXUS. The native app starts its packaged local service and stores settings, logs, project registration, task state and Agent workspaces under `%LOCALAPPDATA%\PROJECT NEXUS`.
3. Open **Local projects** and choose a project folder. Registration and marker scanning do not modify project files.
4. Open **Environment** to inspect detected tools. The scanner checks executable paths and selected version probes; it does not install tools or change `PATH`.
5. To use **AI Agent**, configure `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` in the environment inherited by the local service, then restart the application. Provider registry/routing options are in `.env.example`.
6. Select a registered project, write the request, inspect the source disclosure and confirm before sending. The configured provider receives the prompt plus up to 20 eligible UTF-8 files, with the UI-disclosed 120 KiB post-redaction cap. Redaction is heuristic; inspect project content and provider policy first.
7. Review the proposed diff in the task-private workspace. **Succeeded** means a proposal was generated in that workspace; it does not mean the selected source project changed or that the code passed tests.
8. Use Cancel for a queued/running task. Retry creates a new task and requires fresh disclosure consent.

The current desktop Agent cannot apply the diff to the selected folder, run commands/builds/tests, use Docker for this local task, perform automatic repair, commit Git changes or publish. See [Phase 4 Agent engine status](PHASE4_AGENT_ENGINE.md) and [delivery gaps](PHASE4_DELIVERY_REPORT.md).

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

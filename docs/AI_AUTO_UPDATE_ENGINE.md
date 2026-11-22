# AI auto-update integration engine

## Workflow

The Phase 3 engine prepares a local, reviewable change proposal from a stored update scan report:

1. The caller selects a report and confirms selected repository source may be disclosed to the configured AI provider.
2. NEXUS creates a per-job clone under `data/agent-workspaces/` and checks out a generated branch. In-process repository locks prevent overlapping jobs for one repository in that server instance.
3. The engine reads a bounded set of report-selected files, skips secret-like paths and redacts common credential patterns, then routes the request through the server-side provider registry (OpenAI-compatible/Ollama/Anthropic/Gemini request formats).
4. The provider must return a JSON array of bounded create/replace/delete operations. NEXUS validates operation names, paths, symlinks, file sizes, and operation count before applying them only inside that workspace.
5. A Docker runner attempts a framework-specific test/build command with no network, resource limits and reduced capabilities. Missing Docker, unsupported frameworks or dependency restore problems are not a pass.
6. NEXUS stores the changed file list, diff/patch, output and result in the integration job. The user reviews those results locally.
7. A separate PR request can push the branch and open/reuse a draft PR only when remote writes are enabled and all route gates pass. NEXUS does not merge or publish.

## Safety boundaries

- The repository source and AI response are untrusted. The model is told to treat source contents as data, but that prompt is not a security boundary.
- Secret filtering is heuristic. Review provider data handling and the exact disclosed paths before confirming.
- File operations are capped at 30, and generated file contents at 512 KiB each. Paths cannot target `.git`, absolute paths, traversal segments, symlinks or secret-like names.
- Workspaces are separated by repository/job path. Locks and in-memory workspace mappings do not survive a restart or coordinate multiple server instances.
- Build commands are selected by the detected framework rather than executed directly from arbitrary model output. Requested model tests are recorded but are not executed as supplied shell commands.
- The Docker sandbox has no network, so package restoration may block builds unless dependencies are already available. Only an actual zero-exit check with expected test/build evidence is PASS.
- PR creation is a separate external write. Default configuration disables it. Role checks use a process-level role, not authenticated user identity; keep the API on the trusted local boundary.

## Current status

The provider registry, routing and diagnostic call are implemented, but this delivery had no AI credentials and did not call a model or generate changes. The provider path, Docker runner, clone behavior and GitHub PR creation therefore lack live end-to-end validation. These limitations are reported as BLOCKED/PARTIAL in [PHASE3_TEST_REPORT.md](PHASE3_TEST_REPORT.md).

# PHASE 6 Delivery Report — Autonomous AI Development Engine (PHASE 6A)

Date: 2026-11-13 · Version: **v0.3.0** · Baseline: v0.2.1

## 1. What shipped

PROJECT NEXUS v0.3.0 turns the Windows workstation into a working autonomous
development engine: register a local folder, describe a change, and the agent
plans, calls real tools inside an isolated git worktree (or bounded copy),
runs the project's own build/test scripts, repairs bounded failures, has its
diff independently reviewed, and presents a reversible change set the user can
roll back or apply (apply = explicit confirm + clean-tree guard + backups).

Everything is implemented from scratch in this repository (no new runtime
dependencies); the architecture follows the research in
[PHASE6_RESEARCH.md](PHASE6_RESEARCH.md).

## 2. Feature inventory (PHASE 6A scope)

| Area | Delivered |
| --- | --- |
| Agent runtime | Multi-turn loop (plan → act → observe → verify → repair → review), budgets (40 iterations / 600k tokens / 25 min), cancellation, approval pauses, event-sourced task persistence, Running→Interrupted recovery |
| Tools | 34 tools: file ×10, project ×7, git ×8, execution ×6, helpers ×3 — schemas, permission levels, audit events, secret-path blocking |
| Command execution | Parameterized spawn, allowlist + dynamic `high` risk escalation, cmd.exe shim quoting fix, credential-free child env, output caps, process-tree timeouts/cancel |
| Workspaces | Worktree adapter (git) + copy adapter (non-git), unified diff/restore/apply/dispose surface, per-task isolation, apply guard + apply-backup |
| Project understanding | Incremental indexer (files/symbols/imports/manifests/entry points/tests/routes), insights endpoint + UI panel, budgeted redacted context selection |
| Providers | Persistent registry (openai-compatible/openai/anthropic/gemini/ollama), connectivity test with redaction, capability tags, task routing, cost estimation; DPAPI key vault (safeStorage) → service memory only |
| UI | Provider manager, engine/policy/mode selectors, insights panel, plan/timeline, verification panel, review findings, approval cards, rollback/apply actions; 10-language i18n at 100 % coverage, deep audit clean |
| API | `/api/local-agent/providers*`, `/provider-keys`, `/tasks` (runtime type), `/tasks/:id/approvals/:approvalId/resolve`, `/tasks/:id/rollback`, `/tasks/:id/apply`, `/projects/:id/insights`; config capabilities updated |

Not in this release (planned): Docker-isolated execution (6E), multi-agent
role orchestration beyond the built-in planner/verifier/reviewer stages (6D),
streaming token output, per-user web authentication.

## 3. Verification summary

- **Vitest**: 24 files / 124 tests, all PASS (8 new suites; zero deletions).
- **Desktop (real Electron)**: smoke, legacy agent, **new autonomous-runtime
  workbench test**, i18n acceptance, quality run — all PASS.
- **i18n**: 10/10 languages 100 %; deep audit 0 problems, 0 hardcoded strings.
- **Real-provider acceptance** (`npm run test:phase6:acceptance`, evidence:
  [PHASE6_ACCEPTANCE_EVIDENCE.md](PHASE6_ACCEPTANCE_EVIDENCE.md)) — ALL PASS
  with the operator-provided gateway (`sub.pikaqiu.shop`, model `gpt-6-luna`,
  key withheld from all logs/repos):
  connectivity → project understanding (6 files, entry point, scripts) →
  5-step plan → 13 tool calls → **4 files modified** (README.md, src/index.js,
  src/lib/calc.js, test/run-tests.js) → `npm test` PASS in the workspace →
  review verdict approve → original project byte-identical → rollback →
  second task → user-confirmed apply → `npm test` PASS in the original
  project → multi-project isolation (witness project untouched) → mid-run
  cancellation leaves everything intact.
- Earlier honest failures: a 7B local model (Ollama) could not complete the
  multi-file task and the run recorded a truthful Failed verdict; those runs
  hardened the runtime (argument-shape normalization, NO_MATCH teaching
  excerpts, repeated-call loop guard, verification-aware review). The local
  model service was **uninstalled at the operator's request** afterwards; no
  local-model requirement remains in the product.

## 4. Windows installer validation (real execution)

| Check | Result |
| --- | --- |
| Build | `npm run desktop:package:win` → `release/PROJECT-NEXUS-0.3.0-win-x64-setup.exe` (133.5 MB, unsigned) |
| Install | NSIS `/S` silent install succeeded → `PRODUCTVERSION 0.3.0.0` verified on the installed exe |
| First launch | `tests/installed-package-smoke.mjs` against the installed exe: workstation rendered, disposable-profile dataPath, authenticated bridge API 200 / direct renderer API 401, state + logs written under the profile — PASS |
| Settings retention | `deleteAppDataOnUninstall: false`; user data lives outside the install dir (`%LOCALAPPDATA%\PROJECT NEXUS`), untouched by install/uninstall |
| Uninstall | `/S /currentuser` → exe, Start-menu + Desktop shortcuts and registry entry all removed; app data retained |

SHA-256 (real, computed at delivery):

```
45eaf94109b12a832e4447327c25dfacb2e123df4a28ccb081f69e91d1035649  PROJECT-NEXUS-0.3.0-win-x64-setup.exe
cfff4a828e0b795f371199f6f11fab9c30836aabdb3317dada519822feccea5c  PROJECT-NEXUS-0.3.0-win-x64-setup.exe.blockmap
```

## 5. Security review (summary — details in PHASE6_SECURITY.md)

- Keys: DPAPI at rest, service memory at runtime, redaction on all output
  paths, denylisted env for child processes; no key material in the renderer,
  logs, repo, or provider API responses.
- Approvals: model cannot self-approve; `high` always requires a live user
  decision; approvals persist across restarts.
- Paths: realpath containment, symlink refusal, reserved-name and
  secret-pattern rejection at workspace, tool and diff layers.
- Commands: no shell string concat, metacharacter rejection, process-tree
  kills, output caps.
- Renderer isolation unchanged and re-verified by the packaged-app smoke test
  (401 without the session token).

## 6. Known limitations (honest)

- Review/build quality depends on the model behind the provider; smaller
  models can loop — the runtime now detects and steers, and hard budgets bound
  the damage, but model capability is not a product guarantee.
- `install_dependencies` is approval-gated and command-construction tested,
  but a full network-enabled install was not exercised in the acceptance run
  (NOT TESTED end-to-end).
- Docker execution, multi-agent orchestration, streaming UI, and per-user web
  auth are NOT IMPLEMENTED (6B–6F scope).
- The acceptance apply step writes to the user's project only after explicit
  confirmation; it does not create commits — the user reviews in their own git.

## 7. Delivery artifacts

- Source: this repository, `main` branch, version 0.3.0.
- Installer + blockmap + SHA-256 above.
- Docs: PHASE6_RESEARCH / ARCHITECTURE / AGENT_RUNTIME / TOOL_SYSTEM /
  PROJECT_INDEX / SECURITY / WORKSPACE / MULTI_AGENT / TEST_REPORT /
  ACCEPTANCE / ACCEPTANCE_EVIDENCE / DELIVERY_REPORT (this file); README and
  CHANGELOG updated.
- Screenshots: `docs/screenshots/phase6/agent-runtime-workbench.png` (real
  Electron run) alongside the PHASE 4/5 sets.

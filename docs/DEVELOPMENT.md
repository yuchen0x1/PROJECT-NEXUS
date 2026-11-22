# Development and acceptance matrix

Status reflects local code and checks available on 2026-11-12. `PASS` means the stated local check ran successfully. `PARTIAL` means part of the workflow exists but end-to-end acceptance is incomplete. `BLOCKED` means an external credential or runtime prevented validation.

| Capability | Status | Evidence / boundary |
|---|---|---|
| React/Vite UI and Express API | PASS | Production frontend build and API fixture tests pass. |
| Existing repository, build, release and settings surfaces | PARTIAL | Routes remain present; connected GitHub regression was not run in this delivery. |
| GitHub repository sync | PARTIAL | Bounded multi-page token/App flows exist; no live account sync was run. |
| GitHub App configuration and installation flow | PARTIAL | Routes are implemented; live App credentials/installation were not exercised. |
| Webhook HMAC and duplicate-delivery handling | PARTIAL | HMAC/fixture behavior exists; execution and retries remain in-process. |
| Release draft, edit, publish and asset endpoints | PARTIAL | Guarded routes remain; no remote write was run in this delivery. |
| Update scanner and assessment history | PASS locally / PARTIAL live | Five framework adapters, bounded scanner, report APIs and fixture tests exist. A read-only run scanned 24/24 connected repositories with zero failures or truncated reports; results used temporary schema-v3 state and were not written to the live state file. |
| Android/iOS evidence | PARTIAL | Scanner identifies evidence and marks it unsupported; no dedicated updater adapters exist. |
| Adapter Center and Update Security Center | PASS locally | Screens connect to API status and saved reports; no signature is cryptographically verified. |
| AI change generation | BLOCKED | Real provider credentials were unavailable; no AI-generated change was produced. |
| Isolated workspace and file-operation validation | PASS locally / PARTIAL runtime | Path, symlink and operation guards are implemented. Docker target-project checks may block without offline dependencies. |
| AI change job UI, progress, retry and cancellation | PARTIAL | Persisted in-process jobs and controls exist; long-lived durable workers are not provided. |
| Branch push and draft PR | BLOCKED live | Code requires remote-write config, non-header role mode, Administrator role, passing checks and exact repo/branch confirmation. No remote action was attempted. |
| Recurring scans | PARTIAL | Persisted schedule and bounded in-process polling exist; no restart-safe distributed scheduler or schedule timing test was run. |
| State schema v2 to v3 | PASS on disposable fixture | 24-project fixture migration preserved projects, tasks, activity, installations, webhook events, update configs and audit records. Live state was not migrated. |
| Authentication and multi-user authorization | BLOCKED | Role is process-level configuration, not a verified caller identity. Keep service on loopback/private trusted boundary. |
| Cryptographic signature / old client update loop | BLOCKED | No key verification, update installation, or old-client launch evidence is collected. |
| Build, typecheck, and unit/API tests | PASS | `npm test` (5 files, 18 tests), `npx tsc --noEmit`, production build to a temporary output directory, JavaScript syntax checks, and `npm audit` against the public npm registry passed; see [PHASE3_TEST_REPORT.md](PHASE3_TEST_REPORT.md). |
| Browser screenshots | PASS | Seven screenshots were captured from a running application with Node Playwright and an isolated fixture. Python Playwright was unavailable. |

The pre-Phase-3 state and findings are retained in [PHASE3_BASELINE_AUDIT.md](PHASE3_BASELINE_AUDIT.md). It is a historical baseline, not a current status report.

The current delivery boundary and remaining blocked end-to-end checks are recorded in [PHASE3_DELIVERY_REPORT.md](PHASE3_DELIVERY_REPORT.md).

## Windows desktop build and acceptance

- Build the production UI: `npm run build`.
- Run unit and API tests: `npm test`.
- Check TypeScript: `npx tsc --noEmit`.
- Run native Electron startup smoke: `npm run test:desktop`.
- Run the local Agent UI flow against its loopback fixture provider: `npm run test:desktop:agent`.
- Build a Windows x64 NSIS installer: `npm run desktop:package:win`; pass `-- --config.directories.output=<new-folder>` to preserve prior artifacts.
- For installed-package and uninstall acceptance, follow [Phase 4 Windows installation](PHASE4_WINDOWS_INSTALL.md). The Phase 4 installer is unsigned, and the desktop Agent only generates an isolated proposal; see [Phase 4 delivery status](PHASE4_DELIVERY_REPORT.md).
# Phase 2 competitor research

Research date: 2026-11-12. The implementation uses the public API and interaction patterns of these projects; it does not copy their source code.

| Implementation | What was checked | Decision for NEXUS |
|---|---|---|
| GitHub Apps and REST API | Installation access tokens, permission scopes, releases, Actions, webhook delivery headers | Keep legacy token compatibility, add installation records, scope checks, HMAC verification, and explicit high-risk actions. |
| Probot | App event routing and installation-aware handlers | Keep provider events behind a small adapter so future App installation events do not leak into UI code. |
| semantic-release | Conventional versioning and CI-driven release lifecycle | Use semver validation and preserve draft → checks → confirmation → publish. |
| Changesets | Human-readable release intent and multi-package versioning | Treat generated notes as editable evidence, never as an automatic truth source. |
| Release Drafter | Draft release accumulation from merged changes | Add draft endpoints first; generated notes remain editable before publishing. |
| GitHub CLI | Explicit commands for release creation and workflow dispatch | API actions need explicit target repository, ref, and confirmation. |
| electron-builder / electron-updater | `latest.yml`, blockmaps, provider URLs, signed update assets | Detect package/config/manifest signals separately and report missing signatures as BLOCKED. |
| Tauri updater | Signed update JSON and framework-specific public key configuration | Do not share Electron metadata assumptions with Tauri. |
| Velopack | Windows package channels and release artifacts | Model stable/beta/dev channels independently from framework detection. |
| Sparkle | Appcast feeds, EdDSA signatures, macOS update flow | Treat feed URL, asset, and signature as separate checks. |
| WinSparkle | Windows appcast and signature expectations | Keep platform-specific metadata in the scanner result instead of one generic PASS flag. |
| BullMQ | Durable queue jobs, retries, and worker separation | Current JSON task runner gains retry metadata and event jobs; Redis remains a production follow-up. |
| PostgreSQL | Relational constraints and indexed historical records | Preserve JSON data with versioned migration first; add a relational repository later. |

## Development consequences

- Every external event gets an idempotency key and a durable lifecycle.
- Every release write is role checked and confirmation guarded.
- Update readiness is a set of evidence checks, not a single filename check.
- A digest proves file integrity; a signature proves publisher authenticity. The UI reports them separately.
- Provider adapters return normalized data, while provider-specific paths stay in the backend.

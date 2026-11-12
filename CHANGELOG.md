# Changelog

## Unreleased — 2026-11-12

- Added the Ultimate audit, architecture, roadmap, implementation, test, security, deployment, and user documentation.
- Hardened GitHub App installation callbacks with one-time, expiring state validation.
- Fixed GitHub App-only project operations that were incorrectly blocked when no legacy token was configured.
- Added the first extensible AI provider/router foundation and diagnostic surface; real model calls remain credential- and policy-dependent.
- Preserved the existing Phase 1–3 behavior and live `data/state.json`; no release, push, schema migration, or production deployment was performed.

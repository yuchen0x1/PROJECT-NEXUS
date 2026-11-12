# Architecture decisions

## ADR-001: modular monolith first

The first version uses one Node process and a Vite-built React client. This keeps local setup and Docker deployment small while preserving API, adapter, persistence, and task boundaries for later extraction.

## ADR-002: server-side GitHub credentials

GitHub tokens are read from environment variables. The browser receives only connection status and a redacted capability summary. Tokens are never persisted in project state or returned by an API response.

## ADR-003: live data or explicit empty state

Repository, workflow, run, and release surfaces call GitHub when configured. Without credentials, the interface shows a blocked setup state. This avoids misleading operators with demo data.

## ADR-004: JSON persistence for the bootstrap

The empty workspace does not assume PostgreSQL or Redis are available. A small JSON state file makes task state survive page refreshes and is easy to replace with a repository interface in the next milestone.

## ADR-005: no silent high-risk publishing

This milestone reads releases and dispatches Actions workflows. It does not publish or delete releases, overwrite assets, alter default branches, or deploy production targets.

## ADR-006: design language

The console uses a deep blue-black base, restrained cyan signal color, violet AI accent, Space Mono for operational labels, and DM Sans for readable product copy. Cards are used for meaningful bounded records, while lists carry execution history and status.

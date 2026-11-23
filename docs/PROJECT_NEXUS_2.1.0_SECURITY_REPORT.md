# PROJECT NEXUS 2.1.0 Security Report

## Controls added

### Identity and action intent

The local principal is explicit (`NEXUS_PRINCIPAL_ID`, role and source metadata). A role alone does not authorize a mutation. Every Autonomy mutation is mapped to a risk-ranked action and must carry an active, expiring, exact-scope intent. `once` grants are consumed at first use, and narrower branch/path/PR/tag grants cannot be widened by omitting a request dimension. Grant/use records are stateful for expiry, completion and revocation; every grant, use, completion, failure and revoke is also captured in the append-only audit log. High-risk PR, merge, release and destructive repository actions do not inherit lower-risk grants.

### Sensitive files and output

The shared policy blocks `.env`, credential/private-key files, certificate formats, cloud credential directories, user state databases and secret-like names. Content detection covers GitHub/OpenAI/AWS/Slack credentials, private keys, connection strings, bearer tokens and assigned secret values. Diff review, local Agent workspaces, AI provider disclosure/output validation and redaction use the same policy; environment references such as `process.env.GITHUB_TOKEN` are not treated as leaked values.

### Backup and recovery

Backups are versioned and checksummed. SQLite backups run `integrity_check` and WAL checkpointing before copy. Restore verifies the manifest and staged bytes before replacing live state, rejects paths outside the backup directory, and rolls back earlier live replacements if a later write fails. Tampering and unsupported manifests fail closed. Live `autonomy.db` restore is explicitly restart-gated.

## Verification

- `npm audit --package-lock-only --registry=https://registry.npmjs.org --ignore-scripts`: **PASS**, 0 vulnerabilities (the configured mirror returned a non-implemented audit endpoint).
- i18n/CSS audit: **PASS**, 0 hardcoded UI strings and 0 non-token CSS findings.
- New sensitive/intent/backup tests: **PASS**.
- Existing production autonomy routing tests: **PASS**; no external fixture writes observed.

## Open risks / blockers

- The production application remains read-only for Autonomy mutations until an Administrator creates an exact intent. This is intentional, not a failure.
- No Authenticode certificate or signing environment exists; public v2.0.0 installer remains unsigned.
- Trivy database, CodeQL and Semgrep deep scans were not available in this environment.
- Real multi-user identity isolation and remote credential lifecycle still require a dedicated deployment/authentication design; the local principal is not a general internet-facing auth system.

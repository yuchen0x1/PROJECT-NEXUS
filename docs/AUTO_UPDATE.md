# Repository update scanner

The Repository Scanner reads real GitHub repository trees. It resolves the default branch to a commit SHA and records evidence from that fixed commit. Reads are bounded by tree request count, file count, selected file count and file size. GitHub pagination links are followed only when they remain on the configured API origin.

## Evidence and assessment

The adapters inspect Electron, Tauri, Python desktop, .NET and Web/PWA files. The scanner also identifies Android and iOS project markers, but reports those platforms as `UNSUPPORTED` because dedicated adapters are not implemented.

Reports include:

- repository, default branch, pinned commit and scan timestamp;
- detected framework components and application roots;
- selected evidence paths, read errors and scan limits;
- updater code, version, download/install, workflow, manifest, signing configuration, digest, channels, recovery, HTTPS and test-command signals;
- a score, missing checks, framework recommendation and readiness status;
- explicit `truncated` state when scan bounds prevent a complete tree read.

The score summarizes textual/configuration evidence. A `READY_FOR_TEST` result is not a successful update test. A setting or key reference is not a cryptographically verified signature. NEXUS sets signature verification and old-client update verification to false because this workflow does not verify a signed package, install it into an old client, or confirm successful launch.

## Running scans

Use Repository Scanner to scan an individual project or a selected/batch set. The recurring schedule can be set by an Administrator process role to intervals from 6 to 720 hours. Active scans for a repository are reused instead of duplicated, and scan concurrency is capped at four in the current process.

Scan jobs, reports and schedule configuration are stored in schema v3 JSON. Jobs can be inspected, cancelled or retried in Task Center/Integration History. Queues and locks are in-process; they are not a multi-worker production scheduler.

No real connected repository scan was run for the current Phase 3 delivery. See [PHASE3_TEST_REPORT.md](PHASE3_TEST_REPORT.md) for what was verified locally.

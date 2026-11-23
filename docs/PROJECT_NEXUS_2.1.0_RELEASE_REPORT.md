# PROJECT NEXUS 2.1.0 Release Report

## Current status

**Not released.** Work is on `codex/2.1.0-upgrade` (implementation `a5779b9`, evidence follow-up `ff55608`); draft [PR #24](https://github.com/yuchen0x1/PROJECT-NEXUS/pull/24) is open. No `v2.1.0` tag, GitHub Release or public installer was created in this cycle.

## Baseline checked

- Public `v2.0.0` Release exists with installer, blockmap, `latest.yml` and `SHA256SUMS.txt`.
- `main` protection requires the `Windows checks` workflow and blocks force-push/delete; tag ruleset protects `v*` tags.
- Existing v2.0.0 asset digests were read from GitHub API; this report does not treat them as v2.1.0 evidence.
- PR #24 required checks passed: [Windows checks run 45102298279](https://github.com/yuchen0x1/PROJECT-NEXUS/actions/runs/45102298279) and [package run 45102298299](https://github.com/yuchen0x1/PROJECT-NEXUS/actions/runs/45102298299). The package run verified an unsigned PR candidate, update metadata and packaged desktop smoke; its publication job was skipped.

## Release gates still required

1. **Done:** Commit the verified implementation and open draft PR #24 from the independent branch.
2. **CI done:** Required Windows CI and PR packaging passed; review the real diff before merge.
3. Run a dedicated test-repository AI loop with temporary least-privilege credentials, or record the user-approved BLOCKED decision.
4. Run Windows x64 install/upgrade/rollback evidence in a disposable VM.
5. Configure and verify Authenticode signing, or explicitly publish an unsigned candidate rather than calling it signed.
6. Build release assets in the workflow, generate `SHA256SUMS.txt`, download them publicly and compare API digests.
7. Only then create the annotated `v2.1.0` tag and Release; update README/CHANGELOG with the final evidence.

Until these gates are satisfied, the correct state is **development branch**, not “正式发布”.

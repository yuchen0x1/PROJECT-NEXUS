# PROJECT NEXUS 2.1.1 Release Report

**Date:** 2026-11-23
**Result:** merged to `main`, tagged, **not publicly published** — blocked by the
Authenticode gate. No claim of a public release is made.

## Delivered to main

| Item | Evidence |
| --- | --- |
| Pull request | [#25](https://github.com/yuchen0x1/PROJECT-NEXUS/pull/25) — merged |
| Merge commit on `main` | `36d5f02` |
| Tag | `v2.1.1` → `36d5f02` (annotated, `refs/tags/v2.1.1` on origin) |
| Required checks | Windows checks **SUCCESS**, package **SUCCESS**, publish **SKIPPED** (PR run) |
| Version consistency | `package.json`, `package-lock.json` and tag all `2.1.1` |

## Verified build (verify-only dispatch, run 45143172887)

Dispatched from `main` against tag `v2.1.1` with `verify_only=true` and
`verify_signature=false`, on commit `36d5f02`. Result: **SUCCESS**.

Downloaded artifact `windows-update-v2.1.1` (123,062,874 bytes archived) and
re-verified locally:

| Asset | Size | Check |
| --- | --- | --- |
| `PROJECT-NEXUS-2.1.1-win-x64-setup.exe` | 122,924,812 B | SHA-256 matches `SHA256SUMS.txt`; SHA-512 matches `latest.yml` |
| `PROJECT-NEXUS-2.1.1-win-x64-setup.exe.blockmap` | 129,440 B | present, matches CI |
| `latest.yml` | 371 B | `version: 2.1.1`, size and sha512 agree with the installer |
| `SHA256SUMS.txt` | 104 B | recomputed digest is identical |

Installer SHA-256: `1ceb09208e03231c20969b35ea80585c1a8fe64a282ad68016c20a774d1d3452`

## Publication attempt and blocker

Publish dispatch run [45143901789](https://github.com/yuchen0x1/PROJECT-NEXUS/actions/runs/45143901789)
failed in `package → Require the trusted Windows signer for public releases`:

```text
EXPECTED_SIGNER: (empty)
Configure the WINDOWS_SIGNER_SHA256 repository variable before publishing.
```

Local verification confirms the built installer reports
`Get-AuthenticodeSignature → NotSigned`, and no `WINDOWS_CSC_LINK`,
`WINDOWS_CSC_KEY_PASSWORD` or `WINDOWS_SIGNER_SHA256` secrets/variables exist in
this repository. Only the `windows-release-verification` environment exists; the
`windows-release-signing` and `windows-release-publication` environments have not
been created.

**No release exists for `v2.1.1`.** `gh api repos/.../releases/tags/v2.1.1`
returns 404. The tag is pushed, but a tag push does not publish.

## Decision taken

The signing gate was **not** weakened, bypassed, or made optional by this
change. Publishing an unsigned installer is an explicit product decision that
requires repository-owner authorisation plus the environment protections in
`docs/RELEASE_MANAGEMENT.md`. Until then the correct state is: **tagged,
verified build, unpublished**.

## Remaining steps to publish

1. Configure an Authenticode certificate or explicitly authorise an unsigned
   candidate (that requires a reviewed change to the workflow and release
   notes, not a local override).
2. Create the `windows-release-signing` and `windows-release-publication`
   environments, restricted to the default branch, with required reviewers.
3. Store `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` and
   `WINDOWS_SIGNER_SHA256` in the signing environment.
4. Re-dispatch with `verify_signature=true` to prove the gate, then dispatch
   with `verify_only=false` to publish.
5. Read back the four assets and their API digests, and confirm GitHub serves
   `v2.1.1` as latest.

## Evidence boundaries

- Windows clean install, upgrade, interrupted update, rollback and user-data
  retention are **NOT TESTED** (no disposable VM).
- The built artifact is a CI-verified candidate, not a public download.

# PROJECT NEXUS 2.1.1 Release Report

**Date:** 2026-11-23
**Result:** merged to `main`, tagged, **published as an unsigned build** under an
explicit owner waiver. Publisher identity is **not** verified.

## Delivered to main

| Item | Evidence |
| --- | --- |
| Pull request | [#25](https://github.com/yuchen0x1/PROJECT-NEXUS/pull/25) — merged |
| Merge commit on `main` | `36d5f02` |
| Tag | `v2.1.1` → `36d5f02` (annotated, `refs/tags/v2.1.1` on origin) |
| Waiver pull request | [#28](https://github.com/yuchen0x1/PROJECT-NEXUS/pull/28) — merged as `0021b01` |
| Required checks | Windows checks **SUCCESS** (`45156706321`), package **SUCCESS**, publish **SUCCESS** (`45156847308`) |
| Version consistency | `package.json`, `package-lock.json` and tag all `2.1.1` |

## Published release

| Field | Value |
| --- | --- |
| Release | [v2.1.1](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v2.1.1) |
| `published_at` | 2026-11-23T10:35:55Z |
| Pre-release | `false` — `releases/latest` resolves to `v2.1.1` |
| Publishing run | [45156847308](https://github.com/yuchen0x1/PROJECT-NEXUS/actions/runs/45156847308) — `package` **SUCCESS**, `publish` **SUCCESS** |
| Source marker in body | `<!-- project-nexus:desktop-source=36d5f0235ee55763821d73d38bd117a7db99b7e5 -->` |
| Signature | `Get-AuthenticodeSignature` → **`NotSigned`** |

The release body is the tagged `docs/releases/v2.1.1.md` and carries the
unsigned warning.

### Public assets (verified against the public download and the GitHub API digest)

Downloaded into `%TEMP%\nexus-v211-public`; sizes match both the API and the
re-download, and every SHA-256 below equals the `digest` returned by the API:

| Asset | Size | SHA-256 |
| --- | ---: | --- |
| `PROJECT-NEXUS-2.1.1-win-x64-setup.exe` | 122,924,812 B | `128604c1f0766f1264934222a0e3b3c0511d0a12f6d402621e125c64576c2376` |
| `PROJECT-NEXUS-2.1.1-win-x64-setup.exe.blockmap` | 129,492 B | `a4d8b59fdacb9cbaafd65454861f20d0cde187c6b345bd6fbd2e7ef856555f8e` |
| `latest.yml` | 371 B | `29e0d419cff14714ec8640a8a33afbecb42e09b2eeb2c9ca8f220ae09d701b2e` |
| `SHA256SUMS.txt` | 104 B | `0bc11a3202e9a1c59409b51cb0362e27eda169e3f890039a7506e0c7d8d7e5f6` |

- `SHA256SUMS.txt` matches the measured installer digest.
- `latest.yml` carries the measured size and sha512
  `T0Jk1wMwmR9mL9KEOtsrZjS7IlbfXHT8JnU6imRLG8zEHDV93wk7bBtv3yvXmPxTCaEPE58rxJlDvavKWkBcJg==`.
- The auto-update feed is therefore internally consistent with the published
  installer.

Builds are not byte-reproducible: the verify-only run `45143172887` produced a
different installer digest (`1ceb09208e…`). Only the published artifact digests
above are authoritative.

## How the Authenticode gate was handled

The gate was **not** weakened, bypassed or made optional.

1. The first publication attempt ([run 45143901789](https://github.com/yuchen0x1/PROJECT-NEXUS/actions/runs/45143901789))
   was correctly blocked in `package → Require the trusted Windows signer for
   public releases`, because no `WINDOWS_SIGNER_SHA256` variable and no
   Authenticode certificate exist in this repository.
2. PR #28 added an **explicit, opt-in** waiver input, `publish_unsigned`. The
   default publication path still requires a valid Authenticode signature.
3. The waiver itself is fail-closed:
   - `package` requires `Get-AuthenticodeSignature` to report exactly
     `NotSigned`; a partially or invalidly signed build is rejected.
   - The tagged `docs/releases/v2.1.1.md` must contain the word *unsigned*, and
     the publish job re-checks this against the tag, not against `main`.
   - The waived run uses `windows-release-verification`, never the signing
     environment, and records `UNSIGNED_WAIVER_APPROVED=true`.
   - The four published assets and their digests are unchanged by the waiver.

Documented in `docs/RELEASE_MANAGEMENT.md` → *Publishing without an Authenticode
certificate*.

## Evidence boundaries

Verified here:

- Tag → commit mapping, release publication state, `releases/latest`,
  non-prerelease flag.
- Four assets present, size + SHA-256 identical between the public download and
  the API digest; `latest.yml` sha512/size agree with the installer.
- Release body contains the unsigned warning and the `desktop-source` marker.
- `npm run check` (81 files / 544 tests), `i18n:audit` (0 problems),
  `test:desktop:centers`, `test:desktop:i18n`, and all pull-request CI runs.

**NOT verified — no claim is made:**

- Windows clean install, upgrade from 2.0.0/2.1.0, interrupted update, rollback
  and user-data retention: **NOT TESTED** (no disposable Windows VM).
- 24-hour soak, real AI provider write loops, deep Trivy / CodeQL / Semgrep
  scans: unverified, as recorded in the 2.1.0 and 2.0.0 reports.
- Publisher identity: **unverified**. The installer is unsigned, so SmartScreen
  may warn on first run and no Authenticode chain exists.

## Follow-up

- `Sync release to README` run `45157587452` failed with HTTP 409
  (`Required status check "Windows checks" is expected`): the workflow tries to
  commit to `main` directly, which branch protection forbids. The README release
  card is therefore updated through a pull request; afterwards the workflow is a
  no-op because the content already matches.
- Configure an Authenticode certificate and the
  `windows-release-signing` / `windows-release-publication` environments before
  the next release, then dispatch with `verify_signature=true` and
  `publish_unsigned=false`.

# Release management

Release writes follow this lifecycle:

`draft → checks → confirmation → published`

Draft creation and editing require Operator permission. Publishing requires Administrator permission and an explicit `confirm=true` request. Existing releases cannot be overwritten by a create request with the same tag. Assets are tracked with their source filename, size, digest, and upload result.

The current API uses GitHub Releases as the source of truth. A local draft record is kept in task and audit history so failed operations remain visible.

## Windows application delivery

The repository's [Release Windows desktop workflow](../.github/workflows/release-desktop.yml) is separate from the workstation's GitHub release API. Do **not** manually create an empty public Release for a tag that the workflow owns.

1. Bump both package and lockfile versions, add `docs/releases/vX.Y.Z.md` with `# vX.Y.Z · Title`, and merge the reviewed patch to the default branch. Wait for the required checks and package validation.
2. Before publishing, protect the default branch and stable tag creation/updates/deletion, enable immutable releases, and restrict the `windows-release-signing` and `windows-release-publication` environments to the default branch with appropriate approvals. Keep the Windows signing secrets in the signing environment, not as repository-wide secrets.
3. Tag the exact reviewed default-branch commit and push the tag. A tag push alone does **not** publish. Dispatch the workflow from the default branch for the existing tag. Dispatch is **verify-only** by default; enable `verify_signature` to exercise the same signature gate without publishing. Pull requests build unsigned candidates and cannot publish or use the signing certificate.
4. Configure `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` and `WINDOWS_SIGNER_SHA256` (SHA-256 fingerprint of the intended Authenticode certificate) in `windows-release-signing`. The installer and the unpacked executable must both be validly signed by that certificate.
5. The publish job consumes the package job's artifact, checks the tag and version order, and verifies the size and SHA-256 of the installer, matching blockmap, `latest.yml`, and `SHA256SUMS.txt` against GitHub before it publishes the draft. Its final read-back validates all four assets and the tag SHA. Ensure GitHub's release page shows the verified release.

### Publishing without an Authenticode certificate

If the repository has no signing certificate, the default publication path fails
**by design**. Do not remove or relax that gate to get a release out. Instead the
owner may publish an explicitly unsigned preview with the `publish_unsigned`
waiver:

1. The tagged `docs/releases/vX.Y.Z.md` must contain the word *unsigned* and must
   state that the publisher identity is unverified. Both the package job and the
   publish job refuse to continue when it is missing.
2. Dispatch with `verify_only=false`, `publish_unsigned=true`. The package job
   requires `Get-AuthenticodeSignature` to report exactly `NotSigned`; a valid
   signature would be rejected as an inconsistent request.
3. The waived run uses `windows-release-verification`, never the signing
   environment, and records `UNSIGNED_WAIVER_APPROVED=true` in the run.
4. The four verified assets and their digests are unchanged; the release body is
   the tagged notes, which carry the unsigned warning.

An unsigned build is weaker evidence than a signed one: it proves asset
integrity (SHA-256/SHA-512) but **not** publisher identity. SmartScreen warnings
and manual hash verification are expected. Record this limitation in the
release notes and the post-release acceptance report.

### Recovery

If packaging completed and publication failed, inspect the Release first, then rerun the **failed publish job** so it receives the original installer bytes. The same workflow-owned draft and identical uploaded assets can be reused. Changed tags, mismatched notes or bytes, and non-uploaded assets block promotion; the workflow never deletes or overwrites an asset.

- After a lost publish response, a new run re-reads the public release ID, tag, notes, asset digests and Latest channel and does not republish. It may report a verified historical release if a newer stable release is now served by GitHub.
- After a `502` upload, GitHub can retain an empty `starter` asset. Inspect the exact draft and asset ID, confirm that it is a zero-byte placeholder in the expected **unpublished** draft, and obtain approval before removing that placeholder. Rerun the failed job with the original artifact; never remove an uploaded or public asset.
- If the original artifact expired, any bytes differ, or the draft cannot be safely reconciled, retain it for diagnosis and prepare a new reviewed version.

Signature and artifact consistency are not evidence of upgrading from an old client, preserving data or rolling back. Validate that separately in a disposable Windows environment before treating the update chain as stable.

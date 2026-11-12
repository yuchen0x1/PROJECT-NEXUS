# Update security evidence

The Update Security Center summarizes static evidence and runtime configuration. It does not perform package signature verification or a client update test.

## Checks reported

- HTTPS evidence for a configured update source.
- Digest or hash references in repository manifests/configuration.
- Framework-specific signing configuration indicators.
- Release pipeline and update manifest evidence.
- Version, channel, recovery and test-command signals when detected.
- NEXUS server configuration for GitHub, AI and remote writes.

These are evidence indicators. A text match for `signingConfigured` does not establish that a release was signed correctly or that a trusted public key is pinned by the client. A SHA-256 value recorded during asset upload detects later content changes only if compared with the expected trusted value; the scanner does not fetch and verify every release asset. HTTPS configuration does not prove the origin is trustworthy.

## What remains unverified

- Cryptographic signature validity and signer identity.
- Release asset integrity against a trusted expected hash.
- Rollback policy behavior in a running client.
- Update server/manifest availability from a deployed client.
- Discovery, download, verification, installation and successful startup from an older client version.

The API currently reports `signatureCryptographicallyVerified: false` and `oldClientUpdateVerified: false`. Do not mark the end-to-end update loop complete until an old client has discovered the release, validated its signature and integrity, installed the update and launched the new version with captured evidence.

High-impact remote writes are disabled by default and require explicit configuration plus a review-ready change. Process-level role checks are not user authentication; retain the loopback/private deployment boundary described in [SECURITY.md](SECURITY.md).

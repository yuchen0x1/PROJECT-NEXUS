# Update adapter reference

Adapters inspect repository source/configuration and produce evidence-based recommendations. They do not install an updater or modify a remote repository by themselves.

| Adapter | Detection | Evidence inspected | Recommendation family | Current limits |
|---|---|---|---|---|
| Electron | Electron dependency, electron-builder configuration, updater source or update manifest | `autoUpdater`/`electron-updater`, workflow, `latest*.yml`, signing configuration, version and package scripts | `electron-updater` with electron-builder/GitHub Releases | Signing is detected as configuration text only; no package signature verification. |
| Tauri | Tauri config, updater plugin or updater source | Tauri config/Cargo data, updater calls, workflow, `update.json`, public key indicators | Official Tauri updater plugin | Rust runner is not configured in the current Docker sandbox. |
| Python desktop | Python packaging manifest and desktop toolkit/packager signals | packaging files, updater terms, workflow, manifests, tests and signing indicators | Package-specific signed manifest/staged installer | Python library/service projects are marked unsupported for desktop updater assumptions. |
| .NET | `.csproj` or `.sln` files | project/source config, workflow, publish/installer, version and signing indicators | Velopack or existing MSIX/ClickOnce model | Container test command may need a prior restore; no signing verification. |
| Web/PWA | web manifest/service worker and web app files | versioned assets, service worker, HTTPS/config, workflow and scripts | HTTPS deployment with versioned assets and rollback | Browser-managed refresh is not equivalent to desktop package installation. |
| Android | Gradle files or `AndroidManifest.xml` | project tree path markers | None yet | Reported as `UNSUPPORTED`; no adapter or Play Store update validation. |
| iOS | Xcode project/workspace or Swift package markers | project tree path markers | None yet | Reported as `UNSUPPORTED`; no adapter or App Store update validation. |

Each supported adapter returns an application root, framework identifier, evidence flags, workflow/test/build hints, secret requirements and component support status. The shared assessor scores evidence and lists missing checks. A high score never substitutes for verifying a signed artifact and a real client update.

## Extending an adapter

Create a module under `server/integrations/` using `createAdapter()` from `base.mjs`. Implement conservative `detect(files)` and `inspect(files)` functions. Avoid declaring support based on a filename alone; collect path and content evidence where available. Register it in `registry.mjs`, add fixtures for positive, negative and ambiguous cases, document false-positive boundaries, and confirm the scanner limits include the evidence files required.

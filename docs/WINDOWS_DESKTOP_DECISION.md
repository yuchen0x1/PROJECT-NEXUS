# Windows Desktop Architecture Decision

**Date:** 2026-11-12  
**Decision:** Electron is the primary Windows desktop host for the first native product line.  
**Status:** Selected and implemented for the first Windows x64 desktop slice. A fresh NSIS package and installed-app smoke passed on one Windows host; signing, clean-machine qualification and the update lifecycle remain unverified.

## Product boundary

PROJECT NEXUS is a Windows AI development workstation first. The browser console remains a secondary remote-management surface. A browser session must never gain access to a desktop user's files or local command runner.

The current native slice provides the desktop window, tray lifecycle, optional sign-in startup, local development-tool inventory, explicit local-folder registration and bounded read-only scans. The desktop AI Agent can generate and preview create/replace proposals in a task-private local workspace after source-disclosure consent. It does not apply those proposals to the selected project, run local commands/builds/tests, perform automatic repair, commit/push Git changes or provide backup/rollback for the selected project.

## Repository facts used for the decision

- The product is a React/Vite renderer and a Node/Express service, with business routes and worker logic in `server/index.mjs` and `server/services/`.
- The current `src/api.ts` uses HTTP routes; Vite proxies them during web development. The backend already owns GitHub, AI provider, task and JSON-state concerns.
- Existing GitHub AI change jobs clone remote repositories into managed workspaces. A separate Phase 4 local Agent proposal service now operates on explicitly registered local projects, but keeps changes in task-private workspaces and does not apply them to the source folder.
- The current Windows toolchain reports Rust `x86_64-pc-windows-msvc`, but `cl.exe` and `vswhere.exe` are not discoverable. The Tauri Windows build prerequisite is therefore missing on this host.
- The pre-existing `data/state.json` remained unchanged during Phase 4; its recorded SHA-256 is `795F1B9FDD1A27E32B909FA28C50B7DF060F18C3E57E62CDFD54BB8605A6B14F`. Desktop state is directed to `%LOCALAPPDATA%\PROJECT NEXUS`.

## Options compared

| Option | Reuse and local execution | Windows distribution and runtime | Cost / risk for NEXUS | Decision |
|---|---|---|---|---|
| **Tauri 2** | Reuses the Vite output. The existing Express/Node business service would need a packaged Node sidecar or a new Rust service layer; the sidecar would still have the signed-in user's OS privileges. Tauri command scopes help restrict WebView access but are not a sandbox for a sidecar. | Native NSIS `.exe` and MSI targets; Windows WebView2 runtime distribution options; built-in updater validates signed update artifacts. | Smaller runtime footprint is attractive. This repository would add Rust + sidecar packaging, supervision and a second process boundary. This host lacks the C++ build tools needed to compile and verify it now. | **Not selected for this increment.** Reconsider if sidecar complexity grows or Rust becomes the execution engine. |
| **Electron** | Reuses React/Vite and the existing Node code most directly. A dedicated Electron main process supervises the API worker and owns a fixed, narrow IPC bridge to the renderer. Node is bundled; the installed app does not require system Node. | Native windows, tray, sign-in startup and notifications are available. NSIS can generate an interactive per-user installer with Start Menu and desktop shortcuts. Windows updating needs an explicit updater/feed design; this configuration alone does not provide verified updates. | Larger installer and Chromium memory footprint than Tauri. Electron main/preload/renderer boundaries need strict navigation, context isolation, renderer sandboxing, API authentication and narrow IPC. | **Selected** for lowest integration risk with the existing Node service and a desktop build path that can be tested on this host. |
| **Node/Express only** | Best reuse of existing server behavior; can host the built React app. It is suitable as an internal service/worker, not as the user's standalone workstation without another native host. | Requires a separately maintained runtime/service wrapper and does not itself provide a native window, tray or native lifecycle. | A local web server alone would repeat the web-console architecture and make local-origin authentication/CSRF protection part of the product's critical path. | **Not a primary product.** Keep it as the supervised business/API worker inside the desktop product and as the separate web deployment. |

## Selected process layout

```text
Windows user
  └─ Electron main process
       ├─ native window, tray, window state, startup preference, OS dialogs
       ├─ narrow preload IPC: environment scan, folder picker, project list/scan, settings
       └─ supervised Node service process
            ├─ existing Express business/API routes
            ├─ random per-launch API bearer token; loopback-only ephemeral port
            ├─ state + workspace under %LOCALAPPDATA%\PROJECT NEXUS
            └─ existing AI/GitHub services plus the separate local Agent proposal service
```

The renderer cannot read the local API token. Its API calls pass through the preload bridge to Electron main, which validates that the request path stays under `/api/` and adds the token. The local service rejects requests without the token. IPC handlers verify the calling BrowserWindow and its origin. The window denies popups and navigation away from the local app origin.

Local folder access is separate from the shared `state.json`: a native folder picker registers canonical paths in `%LOCALAPPDATA%\PROJECT NEXUS\local-projects.json`. Scanning walks a bounded number of entries, skips symlinks and common generated/dependency directories, and records marker names only. Removing an entry removes only NEXUS metadata, never project files.

## Windows runtime and packaging

- Target: **Windows 10/11 x64 only** for the first installer. No ARM64 or 32-bit support is claimed.
- Installer target: interactive per-user NSIS `.exe`, with Start Menu and desktop shortcuts; no MSI is configured yet.
- Window: native title bar and controls; saved size/position; minimum 1100 × 700 logical pixels; close hides to tray; tray menu can reopen or exit.
- Startup: off by default; enabled only by an explicit user choice.
- Data: `%LOCALAPPDATA%\PROJECT NEXUS` for configuration, app state, local-project registry, workspaces, logs and cache; user data is retained on uninstall by default.
- Update: **not complete**. No signed update feed, code-signing identity, staged rollout, rollback, or old-client upgrade test is configured.
- Verification: a Vite build or a native development-window launch is not equivalent to a generated installer, a clean-machine installation, signing, or an update loop. Those criteria remain separate.

## Phase 4 verification status

A new x64 NSIS installer was produced at `release-phase4-fresh-20261112-retry/PROJECT-NEXUS-0.1.0-win-x64-setup.exe`, installed to a path containing spaces, launched through the packaged service and silently uninstalled with test data retained. The artifact is unsigned. Exact file hash, metadata and verification boundaries are in [PHASE4_WINDOWS_INSTALL.md](PHASE4_WINDOWS_INSTALL.md). The UI Agent was exercised with a loopback fixture provider; no external model call was verified. Detailed implementation and remaining local-Agent gaps are in [PHASE4_DELIVERY_REPORT.md](PHASE4_DELIVERY_REPORT.md).
## Follow-on architecture gates

1. Add a project-scoped Git read-only surface, with paths canonicalized again before every operation.
2. For local changes, use task-private copies/worktrees, a pre-change backup, a previewed diff, explicit per-task approval, test evidence and rollback. Do not edit the selected source directory directly.
3. Add build/test profiles from a fixed allowlist; do not accept arbitrary command, cwd, shell text, Docker flags or remote instructions as executable input.
4. Extend the implemented local proposal loop with approval-gated apply, backed-up rollback, allowlisted build/test execution, and durable task recovery.
5. Design signed update metadata and recovery separately; verify an older installed client discovers, validates, installs and launches the new version before calling update delivery complete.
6. Test Windows 10 and 11 x64 with long paths, Chinese user/project names, spaces, DPI scaling, missing tools, denied permissions, process termination, tray, notification and uninstall/data retention. Clean-machine verification requires a separate Windows image without developer tools.

## Primary references

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [Vite integration](https://v2.tauri.app/start/frontend/vite/), [Node.js sidecar](https://v2.tauri.app/learn/sidecar-nodejs/), [Windows installers](https://v2.tauri.app/distribute/windows-installer/), [updater](https://v2.tauri.app/plugin/updater/), [capabilities](https://v2.tauri.app/security/capabilities/).
- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [security](https://www.electronjs.org/docs/latest/tutorial/security), [tray](https://www.electronjs.org/docs/latest/api/tray), [startup settings](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows), [auto-updater](https://www.electronjs.org/docs/latest/api/auto-updater).
- [electron-builder NSIS configuration](https://www.electron.build/nsis/).

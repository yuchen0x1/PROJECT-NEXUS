# Phase 4 test report

**Evidence date:** 2026-11-12  
**Environment:** Windows x64 `10.0.26340`; Node `24.20.0`; npm `11.19.0`; Electron `45.3.1`; electron-builder `26.18.0`.

## Results

| Check | Status | Result |
|---|---|---|
| Focused Agent/environment suite | **PASS** | 5 files, 31 tests passed during Phase 4 implementation. |
| Full unit/API suite | **PASS** | `npm test`: 12 test files, 57 tests passed after the final UI-smoke edit. |
| TypeScript | **PASS** | `npx tsc --noEmit` exited 0 after the final UI-smoke edit. |
| JavaScript syntax | **PASS** | `node --check` over 42 JavaScript files under `server`, `desktop`, `tests` and `scripts` exited 0 after the final UI-smoke edit. |
| Vite production build | **PASS** | `npm run build`; 2,085 modules transformed. It also passed as part of the desktop UI and installer workflows. |
| Desktop Agent UI smoke | **PASS** | `npm run test:desktop:agent`; launched Electron, made one loopback fixture-provider request, rendered a two-file proposal and usage, enforced `.gitignore`/secret-shaped exclusions, and verified the registered source file was unchanged. |
| Desktop startup smoke | **PASS** | `npm run test:desktop`; launched the native BrowserWindow and verified the narrow preload bridge and unauthenticated API rejection. |
| Agent runtime screenshot | **PASS** | Captured from the actual Electron UI at [`local-agent-workflow.png`](screenshots/phase4/local-agent-workflow.png). |
| Fresh NSIS x64 package | **PASS** | Builder exited 0 on retry and wrote the artifact described in [Windows install](PHASE4_WINDOWS_INSTALL.md). An initial network timeout was followed by a cache-backed successful retry. |
| Installed package startup/API smoke | **PASS** | `node tests/installed-package-smoke.mjs` against the installed EXE; packaged UI/service, data path, authenticated bridge and unauthenticated direct request checked. |
| Uninstall and test-data retention | **PASS** | Silent uninstall exit code 0, app EXE removed and isolated test-profile state hash unchanged. |
| External AI provider generation | **NOT TESTED** | No real provider request or credentials were used. The UI/API smoke used an HTTP fixture on loopback. |
| Windows 11, clean VM, older-version upgrade, signed release/update | **NOT TESTED** | No such environment, prior installed release or signing/update configuration was used. |
| Local Agent builds/tests/command execution/auto-repair | **NOT IMPLEMENTED** | The desktop Agent only generates an isolated proposal and diff. |
| Docker daemon for container checks | **BLOCKED** | Docker CLI 29.9.3 exists, but `docker info` failed because the Docker Desktop Linux engine pipe was unavailable; no container tests ran. |

The full unit/API suite, TypeScript check and 42-file JavaScript syntax check passed after the UI-smoke selector adjustment. The desktop startup smoke also passed. Documentation-only edits followed those commands; application source did not change afterward.

## Desktop UI acceptance details

`tests/local-agent-desktop-ui.mjs` uses a Chinese/space-path test project and a local fixture provider. Assertions check one provider request, disclosure consent, generated rationale and token usage, a multi-file diff, omission of the ignored file and secret-shaped file from provider context, and unchanged source bytes/hash. The generated workspace is isolated in temporary app data and successful-run temporary files are cleaned by the script. Screenshot path: `docs/screenshots/phase4/local-agent-workflow.png`.

## Installed package acceptance details

The installer itself and test command are recorded in [Windows install and acceptance](PHASE4_WINDOWS_INSTALL.md). The smoke checks installed rendering, preload bridge data path, authenticated `/api/health` success, direct renderer `/api/health` rejection, schema-versioned state creation and startup logging. It does not exercise all tray, window, restart, shutdown or upgrade scenarios.

## Re-run commands

```powershell
npm test
npx tsc --noEmit
npm run test:desktop:agent
npm run desktop:package:win -- --config.directories.output=release-phase4-fresh-20261112-retry
```

For the installed smoke, see the `NEXUS_INSTALLED_EXE` instructions in [Windows install acceptance](PHASE4_WINDOWS_INSTALL.md). No live GitHub write, release, push or external publication was performed.
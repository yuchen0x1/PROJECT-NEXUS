# Phase 4 Windows installation and acceptance

**Build date:** 2026-11-12  
**Target:** Windows x64 NSIS, per-user interactive installer.

## Fresh installer artifact

- Path: `release-phase4-fresh-20261112-retry/PROJECT-NEXUS-0.1.0-win-x64-setup.exe`
- Size: `133,154,817` bytes.
- SHA-256: `1AB7C64C8EBEAF155E656EEF941F7B053CDF7F84469072182F09266DAFD6F85A`.
- Windows resource metadata: Company `PROJECT NEXUS`, Product `PROJECT NEXUS`, File/Product version `0.1.0`, description `Windows AI development and project operations workstation`.
- Authenticode: **NotSigned**. No signing certificate was configured; do not interpret metadata or the SHA-256 as a publisher signature.
- Icon: `desktop/assets/app.ico` contains seven 32-bit images: 16, 24, 32, 48, 64, 128 and 256 px.
- Packaging: interactive NSIS, x64, per-user (`perMachine=false`), choose-install-directory enabled, Start Menu and desktop shortcuts enabled, app data deletion disabled on uninstall.

The first packaging attempt hit `connect ETIMEDOUT ...:443`. A debug retry succeeded using the available electron-builder cache. No installer from an earlier `release-phase4-*` directory was used as the acceptance artifact.

## Install and installed-app smoke

The exact artifact above was silently installed with exit code `0` to:

`C:\Users\lenmo\AppData\Local\Programs\PROJECT NEXUS Phase4 Acceptance 20261112`

That installation path contains spaces. The installed executable reported ProductVersion `0.1.0.0` and CompanyName `PROJECT NEXUS`. `tests/installed-package-smoke.mjs` ran against that installed executable and passed:

- Workstation window rendered from packaged files.
- Preload bridge returned the expected data path under an isolated temporary `LOCALAPPDATA`.
- Authenticated bridge health returned `200`; direct renderer health returned `401`.
- Versioned app state and non-empty startup log were written under the temporary profile.

The smoke did not require a Vite/dev server or system Node to serve the application. It used the host's installed Node/Playwright only as the test harness and used a temporary `LOCALAPPDATA` to avoid touching an existing user profile.

## Uninstall and data retention

The NSIS uninstaller was run silently against that test installation and returned exit code `0`. The installed executable was removed. The test profile's `PROJECT NEXUS/state.json` remained present, with SHA-256 `C0E3BF9712CD4882837A8FD2A853218540FFCF409B59065FBC7F01D8C7265FF1` both before and after uninstall.

This is a single-build uninstall-retention check. No older version was installed, so upgrade/config migration between installed releases was **not tested**. No clean Windows image was used. The smoke harness terminates its test process tree; this does not establish graceful quit behavior for every shutdown path.

## Reproduction

Build to a fresh output folder so earlier artifacts remain untouched:

```powershell
$env:DEBUG='electron-builder'
npm run desktop:package:win -- --config.directories.output=release-phase4-fresh-20261112-retry
```

Verify the exact file before installation:

```powershell
Get-FileHash -Algorithm SHA256 .\release-phase4-fresh-20261112-retry\PROJECT-NEXUS-0.1.0-win-x64-setup.exe
Get-AuthenticodeSignature .\release-phase4-fresh-20261112-retry\PROJECT-NEXUS-0.1.0-win-x64-setup.exe
```

To run the installed package smoke, set `NEXUS_INSTALLED_EXE` to the full installed EXE path and run `node tests/installed-package-smoke.mjs`. Set `NEXUS_KEEP_INSTALLED_SMOKE_DATA=true` only when performing the documented data-retention check.

For observed tool-probe behavior and tested host limits, see [Windows environment compatibility](PHASE4_WINDOWS_COMPATIBILITY.md).

## Remaining Windows matrix

**Not tested:** Windows 11, clean VM, upgrade from an older NEXUS installation, restart persistence across an upgrade, graceful shutdown/service-child exit, tray open/exit, minimized/maximized/window-position restoration, DPI scaling, denied permissions, Defender reputation, signing, and automatic update discovery/install/rollback.
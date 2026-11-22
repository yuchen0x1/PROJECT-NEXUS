# Phase 4 Windows environment compatibility

**Evidence date:** 2026-11-12  
**Target:** Windows x64 desktop installer. This report describes one host only; it does not certify every Windows 10/11 release.

## Tested platform scope

The build/installed-app checks ran on Windows x64 OS version `10.0.26340`, with Node `24.20.0`, npm `11.19.0`, Electron `45.3.1` and electron-builder `26.18.0`. The fresh per-user NSIS installer ran from a path containing spaces. The UI Agent fixture used a project path containing Chinese characters and spaces. The installed-app smoke checked the `%LOCALAPPDATA%` data path, packaged service startup, bridge/API boundary, state/log creation, uninstall and data retention.

**Not tested:** clean Windows VM, Windows 11 stable release, Windows ARM64, Windows 10 older releases, non-ASCII Windows user-profile path, long-path limit, non-admin/denied-permission matrix, DPI scaling, multi-monitor/window restoration, tray shutdown, upgrade from an older installed version, code signing, Defender reputation, and automatic updates.

## Live tool detection on the build host

`detectDevelopmentEnvironment()` returned `COMPLETE`, `available: 16`, `total: 20`. `available` includes `SHIM_FOUND` and `PATH_FOUND`; it does not mean every listed command ran successfully.

| Tool group | Result at inspection |
|---|---|
| Git, Node.js, Python, Python launcher, pip, Java, PowerShell 7, Windows PowerShell, Rust/Cargo, .NET, Docker CLI | Executable found and version probe succeeded. |
| npm, pnpm, Yarn | `.cmd` shims found; the scanner does not execute command shims. |
| Windows Terminal | `PATH_FOUND`; version probe was skipped to avoid opening a terminal. |
| GitHub CLI, uv, Maven, Gradle | Missing from PATH. |
| Docker daemon | **Unavailable**: Docker CLI existed, but `docker info` could not connect to the Docker Desktop Linux engine named pipe. |

The observed Python executable reported Python 3.8.6 while `py.exe` reported Python 3.14.7; pip resolved under Python 3.8. A PATH hit or multiple installed versions is not a compatibility guarantee for a project. Check the project's own pinned runtime and package-manager requirements before attempting work.

## Scanner behavior

The scanner targets Windows, resolves tool executables through `where.exe`, uses bounded direct version probes, and reports missing paths, conflicting paths, shims, path-only hits and probe failures separately. It does not install software, modify `PATH`, invoke npm/pnpm/Yarn `.cmd` wrappers, or launch Windows Terminal. The inventory is informational; it does not mean the Local Agent can build/test that project. The desktop Agent currently does not execute project commands; see [Agent engine](PHASE4_AGENT_ENGINE.md).

## Reproduction

From the repository root:

```powershell
node --input-type=module -e "import { detectDevelopmentEnvironment } from './server/services/local-environment.mjs'; const r=await detectDevelopmentEnvironment(); console.log(JSON.stringify(r,null,2))"
docker info
```

The scanner and package acceptance results do not replace a project-specific compatibility test on a clean Windows machine. See [Windows installation](PHASE4_WINDOWS_INSTALL.md) and [known gaps](PHASE4_DELIVERY_REPORT.md).
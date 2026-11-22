> Archived 0.3.0 evidence. Current upgrade: [0.4.0 report](ORDERED_UPGRADE_REPORT.md).

# Windows 安装与验收 · 2026-11-13

本次产物是 v1.0 目标的 **0.3.0 本地开发预览**，不是 v1.0 稳定版。没有上传 PROJECT NEXUS 自身的新 Release。

| 项目 | 实际结果 |
| --- | --- |
| 文件 | release-v1-preview/PROJECT-NEXUS-0.3.0-win-x64-setup.exe |
| 版本 | 0.3.0 |
| 大小 | 122,077,962 字节（约 116.42 MiB） |
| SHA256 | 242572587DBEFEABEBE9680E83BB52F817F2585AD71D2DF6EAF820A61E130390 |
| Authenticode | NotSigned，未配置签名证书 |
| 类型 | NSIS / Windows x64 / 当前用户 |
| 安装结果 | PASS，安装程序退出码 0 |
| 实际安装位置 | C:\Users\lenmo\AppData\Local\Programs\PROJECT NEXUS\PROJECT NEXUS.exe |
| 原有用户配置 | PASS，7 个 JSON 文件安装前后 SHA256 一致 |
| 已安装应用冒烟 | PASS，原生窗口、Preload、认证 API 200、直接请求 401、状态与日志 |
| 新引导 | PASS，7 步、前置条件门禁、默认远程写入未勾选、Esc 关闭 |

安装前已备份原应用与加密配置，位置：

`C:\Users\lenmo\AppData\Local\PROJECT NEXUS Backups\20261113-v1-preview`

没有自动恢复备份或覆盖用户数据。安装测试在当前 Windows 机器上进行，不是全新 Windows 镜像；未执行本次产物的卸载、跨大版本升级或自动更新安装闭环。

## 普通用户

运行安装包，按向导安装并启动。点击工作台「连接 GitHub，开启仓库维护」，逐步配置。密钥保存在当前用户加密凭据库中，不需要手工建目录。开机启动需在设置中自行启用。

## 开发者与 AI 工具

```powershell
npm ci
npm run build
npx tsc --noEmit
npm test
npx electron-builder --win nsis --x64 --publish never --config.electronDist=node_modules/electron/dist --config.directories.output=release-v1-preview
$env:NEXUS_INSTALLED_EXE="$env:LOCALAPPDATA\Programs\PROJECT NEXUS\PROJECT NEXUS.exe"
node tests/installed-package-smoke.mjs
```

本次复用已安装 Electron 45.3.1，避免网络下载超时；没有安装额外大型软件。开发工具和已打包的前端库不再作为运行依赖进入安装包。最终 ASAR 624 条目、0 个 .map，无 Electron default_app.asar 样例启动器。

机读回执见 `evidence/v1-windows-artifact.json` 和 `evidence/v1-installed-smoke.log`。可用 `Get-FileHash -Algorithm SHA256` 核对实际安装包；哈希不替代发布者签名。

最终安装程序中的真实用户连接恢复另行检查通过：Provider pikaqiu / gpt-6-luna 为 configured，GitHub 为 yuchen0x1，数据路径仍为原用户目录。回执见 `evidence/v1-installed-connections.json`。检查后关闭调试会话，已正常启动安装后的应用。

# NEXUS 应用自动更新

2026-11-13：0.8.1 补齐应用自身更新。仓库中的「软件更新中心」管理关联项目；这里的更新器负责 NEXUS Windows 客户端本身。发布状态与验证记录见[0.8.1 版本说明](releases/v0.8.1.md)。

## 用户流程

1. 安装包含更新器的 Windows x64 NSIS 安装版。
2. 启动约 15 秒后检查公开的 `yuchen0x1/PROJECT-NEXUS` GitHub Release，之后每 4 小时检查一次；设置页提供「检查更新」。
3. 发现更高的正式版本后，在当前页面顶部显示「立即更新」与「稍后」。不自动下载，不在用户普通退出时偷偷安装。
4. 点击「立即更新」后下载并核验 SHA512；若安装版配置了发布者信息，electron-updater 也会执行 Authenticode 验证。下载或验证失败不会启动安装器。
5. 下载完成后保存窗口状态，通过现有退出协议停止后台工作并落盘；调用 NSIS 静默安装，安装完成后重新打开应用。正在执行的任务会停止，不能保证任意任务自动续跑。
6. 安装器启动失败时尝试恢复本地服务并显示重试。Windows 系统策略或安装条件可能阻止静默安装；此时须按实际错误处理。

更新不卸载或清空 `%LOCALAPPDATA%\PROJECT NEXUS`。开发运行、网页、smoke 会话禁用更新；更新功能只接受受信主窗口的固定 IPC 动作，渲染层不能提供更新源、命令或安装器路径。

**0.8.0 及更早的客户端没有更新器，不能通过推送新版本凭空获得更新能力。首次必须手动安装 0.8.1 或更高版本。** 后续发布必须递增版本，不能覆盖已有 Release。

## 维护者发布

普通 `git push` 只上传源码。通知客户端需要同时具备更高应用版本、公开的非草稿正式 Release、匹配的安装包和 `latest.yml`。不向正式通道推送预发布版，不允许降级。该流程采用 [electron-builder 的 GitHub 发布机制](https://www.electron.build/docs/publish/)。

1. 完成源码及发布说明，将 package.json 与 package-lock.json 递增到一个未发布的更高版本，先提交到仓库。
2. 推送同版本标签（例如应用版本为 `0.8.1`，则标签为 `v0.8.1`）。`.github/workflows/release-desktop.yml` 运行类型、lint、测试和构建，然后生成 Windows x64 安装包。
   若标签推送未生成运行，可在 Actions 的「Release Windows desktop」中手动运行，填写已有版本标签；该入口会检出所填标签，不修改标签。CLI 等价命令为 `gh workflow run release-desktop.yml --ref main -f release_tag=v0.8.1`。
3. 工作流核对安装包版本、SHA512、大小、blockmap 与内置 GitHub 更新源；先上传全部资产到草稿，再公开发布。未上传完成的草稿不会被客户端发现。工作流需允许自身的 `GITHUB_TOKEN` 写入仓库内容；无需把 GitHub Token 嵌入客户端。
4. 若失败后留下草稿，检查失败原因并清理该版本草稿后再重跑，或使用一个新的更高版本；工作流拒绝修改已经存在的 Release。
5. 手动发布时，可运行：

   ```powershell
   npm run desktop:package:win
   npm run desktop:verify-update
   ```

   将 `release/` 中的 `PROJECT-NEXUS-<version>-win-x64-setup.exe`、对应 `.blockmap`、`latest.yml`、`SHA256SUMS.txt` 一并上传到同版本 GitHub Release。不要只上传 exe。

## 签名与实际边界

当前 0.8.1 仍未签名。更新通过固定 GitHub 仓库与 HTTPS 分发，并使用 SHA512 验证完整性；**哈希不能替代发布者身份认证**。未配置发布者时，默认 electron-updater 不会验证 Authenticode 身份，不能声称具有签名更新链。

工作流可读取 `WINDOWS_CSC_LINK` 和 `WINDOWS_CSC_KEY_PASSWORD` 仓库 Secrets 配置有效 Windows 代码签名证书；electron-builder 会把发布者信息写入安装版更新配置。应先手动安装经验证的签名基线版本，再验证后续签名更新链。此改动未创建证书、未更改 Secrets、未关闭 updater 的签名或哈希验证。

自动安装后回滚到旧二进制、数据 schema 降级和完整系统故障恢复不在当前能力范围。不能将关联项目软件更新中心的校验报告当作 NEXUS 自身升级验收。

## 验证范围

自动更新初始候选的本地验证记录（2026-11-13；下列命令均退出 0）。正式 0.8.1 的产物与远端发布结果单独记入版本说明：

| 状态 | 命令 / 范围 | 结果 |
| --- | --- | --- |
| PASS | `npm run typecheck` | TypeScript 无错误 |
| PASS | `npm run lint` | 最终源码及测试脚本通过 |
| PASS | `npm test` | 56 文件、296 项通过；之后补充安装失败恢复门禁并单独复验 |
| PASS | `npx vitest run tests/unit/app-updater.test.mjs` | 最终 11 项通过，含重复操作、离线、校验失败、恢复与重试 |
| PASS | `npm run i18n:audit` | 十语言，0 problems；既有硬编码提示未在本次改动 |
| PASS | `node tests/app-update-ui.mjs` | 中文更新提示、下载进度、失败重试、稍后、新版本再提示和安装中状态，无页面异常；使用渲染层 fixture |
| PASS | `node tests/desktop.smoke.mjs` | 实际开发态 Electron 窗口、受信 IPC、设置页更新入口；更新检查在 smoke 会话禁用 |
| PASS | `npm run desktop:package:win -- --config.directories.output=release-auto-update` | 最终 Windows x64 NSIS 安装包构建成功，未签名 |
| PASS | 设置 `NEXUS_TEST_DESKTOP_EXECUTABLE` 为 `release-auto-update/win-unpacked/PROJECT NEXUS.exe` 后运行 `node tests/desktop.smoke.mjs` | 实际打包后的原生程序启动、加载依赖并显示更新入口；隔离临时数据，不执行安装 |
| PASS | `node scripts/verify-desktop-update.mjs release-auto-update` | 最终安装包版本、大小、SHA512、blockmap、内置 GitHub feed 匹配 |
| PASS | 发布工作流 YAML 解析、`git diff --check` | 语法与差异检查通过 |
| PARTIAL | GitHub Actions 发布工作流 | 本地已配置，未推送或运行远端 CI |
| PARTIAL | 代码签名与发布者认证 | 无签名证书，产物未签名；不具备已验证的签名更新链 |
| PARTIAL | 真实跨版本安装并自动打开 | 未执行，需要两个不同版本的实际安装版和新 Release |

初始本地候选目录：`release-auto-update/`。以下哈希属于当时的 `0.8.0` 本地候选，**不适用于 0.8.1 Release 安装包**，也没有覆盖远端历史版本。

- 安装包：`PROJECT-NEXUS-0.8.0-win-x64-setup.exe`
- 大小：122842383 bytes
- SHA256：`08c9f529c55813115ccc5bdd2dbcb1d0a32ebc410dabfaf69b4332c4db6b7319`
- 更新清单：`latest.yml`；另有 `.blockmap` 与 `SHA256SUMS.txt`
- 界面证据：`test-results/app-update-available.png`、`test-results/app-update-progress.png`

真实端到端通过必须有：旧安装版发现新 Release → 下载并验证 → 退出并安装 → 自动启动 → 确认运行新版本及原用户数据。单元测试、界面测试或成功打包都不能替代这一证据。

初始候选验证没有替换用户安装版或修改用户数据。0.8.1 的提交、发布及资产核验结果见版本说明。

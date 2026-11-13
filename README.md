# PROJECT NEXUS

Windows 桌面 AI 仓库运营中心。连接 GitHub 与 AI 网关，持续监控仓库，在独立 Worktree 中修复和验证问题，并按授权策略交付 PR 和版本。

**v0.8.6 本地开发预览；GitHub 最新公开安装版仍为 v0.8.2。安装包未签名，不是 v1.0 稳定版。**

## 最新更新

### v0.8.6 · 首次启动自动教学（2026-11-14，本地预览）

- 新用户首次启动会自动进入教学，逐步说明连接 GitHub、配置 AI、选择仓库、检查工具和开启托管的方法。
- 每一步显示操作说明、功能位置和完成后的结果，完成配置后继续介绍托管、任务中心、Issue 和研究的位置。
- 可点击「稍后继续」；未完成时下次启动再次引导。全部教学完成后保存状态，后续启动不再自动弹出。
- 工作台与顶部保留「一键教学」，随时重看。仅打开教学不会自动授予脚本执行或远程写入权限。

本版包含此前的更新栏布局、日志、归档筛选和仓库同步修复。尚未公开发布，现有客户端暂时不会收到本次更新。说明见 [v0.8.6](docs/releases/v0.8.6.md)，历史见 [完整发布记录](docs/releases/release-notes.md)。

## 安装和首次使用

[下载当前公开版 Windows x64 安装包](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.8.2/PROJECT-NEXUS-0.8.2-win-x64-setup.exe)，[版本说明与校验文件](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.2)。此版本为 0.x 开发预览。

1. 在 Windows x64 上运行安装程序。
2. 首次启动自动打开教学；之后也可从工作台或顶部的「一键教学」重新进入。
3. 使用 GitHub 访问令牌连接账号；已有 GitHub App 也可在远程控制台管理。
4. 输入 API 类型、Base URL 和 API Key，点击默认模型旁的「获取模型」，从下拉列表选择后保存并测试；也可手动输入模型名。
5. 勾选仓库或点击「全选」，按下一步完成工具检测、统一策略与逐仓库检查。执行代码需要明确授权所选全部可信仓库的脚本。
6. 需要远程交付时，明确允许应用按各仓库策略写入 GitHub。
7. 如果全局巡检暂停，先明确恢复，再开启托管。完成后可跟随定位教学，或立即检查 Issue。

用户不需要手工创建密钥目录；缺少工具只检测，不自动安装 Ollama、Docker 或本地模型。安装包未签名，大小、SHA256 和验收结果见 [本版说明](docs/releases/v0.8.2.md)。

窗口关闭后可留在托盘运行。退出应用或关闭电脑后本机任务无法继续；开机启动由用户在设置中启用。后台是 Electron 管理的 Node 子进程，没有安装 Windows 系统服务。

## 策略与功能

| 策略 | 行为 |
| --- | --- |
| 观察 | 监控、分析、报告，不自动修复 |
| 自动维护 | 隔离修复，验证后按策略推送分支和创建 PR |
| 全自主 | 还允许在验证与发布检查后合并、发布和条件关闭 Issue |

仓库策略与应用远程写入开关同时生效。工具、依赖、网络、权限或验证不满足时停止并保留证据。中断交付可在任务中心核对回执，后续处理仍需人工评估；尚不提供精确步骤自动续跑。

主要能力包括本地项目管理、开发环境检测、多轮 Agent Runtime、文件/Git 工具、预算和审批、测试/构建/修复循环/独立审查、Worktree 与非 Git 快照、显式应用与回滚、任务时间线、Provider 管理、GitHub App 与 Webhook、Issue 托管、安全扫描和研究。保留原有 Electron/Tauri/Web-PWA/Python/.NET 更新适配分析、十种语言和主题。

自动发布当前面向具有 package.json 且可运行 npm test 的项目：要求确切合并 SHA、与已审查提交一致的树、重新测试、安全检查和匹配版本号；资产先上传草稿，成功后发布。Electron 资产默认还需有效 Authenticode 签名。尚不是任意语言项目的通用发布器。

## 开发者运行

需要已安装的 Node.js、npm 和 Git。

    npm ci
    npm run desktop:dev

网页/API 开发使用 npm run dev。生产后端先 npm run build，再 npm start。环境模板见 .env.example；npm start 不自动加载 .env，需要时显式执行：

    node --env-file=.env server/index.mjs

不要提交真实凭据。默认 API 仅监听 127.0.0.1:4317；独立后端不具备公网多用户认证。

## 验证与构建

    npx tsc --noEmit
    npm test
    npm run build
    npm run i18n:audit
    npm run i18n:coverage
    node tests/desktop.smoke.mjs
    node tests/desktop-i18n.mjs
    node tests/desktop-quality.mjs
    node tests/desktop-perf.mjs
    npm run desktop:package:win -- --config.directories.output=release-v1-preview

真实验收脚本 tests/v1-live-acceptance.mjs 要求真实 GitHub/AI 凭据和严格命名的临时测试仓库；它会写入该仓库，不应指向业务项目。仓库的创建与删除由操作者管理。本次测试仓库已删除，回执在 docs/evidence/。

## 数据与安全

桌面数据在 %LOCALAPPDATA%\PROJECT NEXUS：state.json 为 schema v4；ai-providers.json 只保存元数据；provider-keys.json 与 github-credentials.json 保存 DPAPI 加密凭据；repositories/ 和 agent-workspaces/ 保存隔离工作区；logs/ 与任务文件保存执行证据。

状态使用原子替换、上一份有效副本和迁移前快照。短期 Installation Token 不写入状态或备份。不会自动用备份覆盖当前数据；恢复前退出应用，复制当前数据并人工核对。

本机命令具有超时、程序允许列表与凭据环境过滤，**不是 Windows 操作系统安全沙箱**。只为可信仓库开启脚本执行。研究模块读取外部项目，不执行其代码。DPAPI 不能防御同一 Windows 用户权限下的恶意程序。

## 验收与限制

0.3.0 的历史私有测试仓库验收通过了 Bug 复现、AI 修复、回归测试、构建、独立审查、推送、PR、合并、带校验资产的 Release、回复和关闭 Issue。另读取两个真实开源项目的源码与许可证，见 [历史测试报告](docs/V1_TEST_REPORT.md)。0.7.0 新增 CI 门禁下的真实交付闭环仍因 Checks API 权限受阻，不以历史成功替代本版本验收。

0.8.0 开发预览已接入研究提案到实施门禁、安全检查点续跑、独立自我维护策略、资源准入和 ESLint；官方 npm 审计为 0。完整原生隔离、签名安装/回滚、通用多语言交付、真实外部服务和 24 小时连续验收仍未完成。当前状态见 [验收矩阵](docs/TEST_ACCEPTANCE_REPORT.md)和[安全报告](docs/SECURITY_HARDENING_REPORT.md)，本版说明见 [0.8.0](docs/releases/v0.8.0.md)。

## 文档

- [架构](docs/V1_ARCHITECTURE.md)
- [交付报告](docs/V1_DELIVERY_REPORT.md)
- [测试报告](docs/V1_TEST_REPORT.md)
- [安全报告](docs/V1_SECURITY_AUDIT.md)
- [Windows 安装说明](docs/V1_WINDOWS_INSTALL.md)
- [GitHub App 配置](docs/GITHUB_APP_SETUP.md)
- [Webhook 配置](docs/GITHUB_WEBHOOKS.md)
- [历史 Phase 0 审计](docs/V1_PHASE0_AUDIT.md)

0.8.0 的新增能力、验证范围及已知限制见[版本说明](docs/releases/v0.8.0.md)。当前会话无法解密既有 GitHub / AI 凭据时，需在应用中重新连接，或回到能够解密的原 Windows 会话；原凭据文件不会被验收流程覆盖。

# PROJECT NEXUS

Windows 桌面 AI 仓库运营中心。连接 GitHub 与 AI 网关，持续监控仓库，在独立 Worktree 中修复和验证问题，并按授权策略交付 PR 和版本。

**当前软件版本 0.7.0。本工作区包含面向 v1.0 的增量实现，尚未作为 v1.0 稳定版发布。**

## 最新更新

### 0.7.0 · 项目总览关系图（2026-11-13）

- 左侧工作区新增「项目总览」，账号居中、仓库环绕，连接 AI、巡检、分析、执行、测试、交付与研究环节。
- 运行任务显示流动连线，点击节点查看任务、真实输出和交付状态；支持缩放、拖动、搜索、筛选和仓库定位。
- 状态约每 3 秒刷新，等待审批、完成或断线时停止对应流动。进入页面只查看记录，不启动任务。
- 保留多仓库批量托管、获取模型、一键教学和平铺导航。

使用方法见 [中文上手指南](docs/QUICK_START.zh-CN.md)，关系图验收见 [交付记录](docs/PROJECT_OVERVIEW_REPORT.md)，完整历史见 [发布记录](docs/releases/release-notes.md)。

## 安装和首次使用

[下载 Windows x64 安装包](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.7.0/PROJECT-NEXUS-0.7.0-win-x64-setup.exe)，[版本说明与校验文件](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.7.0)。此版本为 0.x 开发预览。

1. 在 Windows x64 上运行安装程序。
2. 启动应用，点击工作台上的蓝色「一键教学」，顶部也可进入。
3. 使用 GitHub 访问令牌连接账号；已有 GitHub App 也可在远程控制台管理。
4. 输入 API 类型、Base URL 和 API Key，点击默认模型旁的「获取模型」，从下拉列表选择后保存并测试；也可手动输入模型名。
5. 勾选仓库或点击「全选」，按下一步完成工具检测、统一策略与逐仓库检查。执行代码需要明确授权所选全部可信仓库的脚本。
6. 需要远程交付时，明确允许应用按各仓库策略写入 GitHub。
7. 如果全局巡检暂停，先明确恢复，再开启托管。完成后可跟随定位教学，或立即检查 Issue。

用户不需要手工创建密钥目录；缺少工具只检测，不自动安装 Ollama、Docker 或本地模型。安装包未签名，大小、SHA256 和验收结果见 [交付记录](docs/PROJECT_OVERVIEW_REPORT.md)。

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

仍未完成：通用多语言自动发布、竞品建议自动实施、精确步骤自动续跑、独立自我维护策略、完整资源阈值和 24 小时连续验收。跨进程宿主与仓库租约、远端回执人工核对已在后续增量中加入，见 [按序升级报告](docs/ORDERED_UPGRADE_REPORT.md)。历史依赖审计记录的 6 项打包开发依赖链中危问题尚未处理；ESLint 尚未安装。当前发布边界见 [0.7.0 版本说明](docs/releases/v0.7.0.md)，历史目标与安全记录见 [交付报告](docs/V1_DELIVERY_REPORT.md) 和 [安全报告](docs/V1_SECURITY_AUDIT.md)。

## 文档

- [架构](docs/V1_ARCHITECTURE.md)
- [交付报告](docs/V1_DELIVERY_REPORT.md)
- [测试报告](docs/V1_TEST_REPORT.md)
- [安全报告](docs/V1_SECURITY_AUDIT.md)
- [Windows 安装说明](docs/V1_WINDOWS_INSTALL.md)
- [GitHub App 配置](docs/GITHUB_APP_SETUP.md)
- [Webhook 配置](docs/GITHUB_WEBHOOKS.md)
- [历史 Phase 0 审计](docs/V1_PHASE0_AUDIT.md)

0.7.0 的新增能力、验证范围及已知限制见[版本说明](docs/releases/v0.7.0.md)。当前会话无法解密既有 GitHub / AI 凭据时，需在应用中重新连接，或回到能够解密的原 Windows 会话；原凭据文件不会被验收流程覆盖。

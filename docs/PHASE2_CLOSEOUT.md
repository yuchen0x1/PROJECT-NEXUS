# PROJECT NEXUS 第二阶段闭环记录

记录时间：2026-11-15（主机证据时间使用 UTC ISO 时间写入证据文件）。

## 已直接接入代码

- UIA 驱动新增只读控件树检查（`inspect`），支持按 AutomationId、Name、ControlType 和 ClassName 定位；适配器发送前动态解析项目、编辑框和发送控件，缺控件或客户端忙碌时进入人工接管。
- 客户端中心直接显示登录状态、项目引用、输入框/发送控件暴露情况，并对每项能力显示 `verified`、`partial` 或 `unsupported` 及证据提示。
- ChatGPT Desktop 和 WorkBuddy 保持独立能力表。每次真实探测写入 `adapter_probe_runs`，适配器状态包含登录、项目、编辑框、发送控件的证据摘要。
- 安全扫描新增 CodeQL、Semgrep、Gitleaks、Trivy 的安装探测、版本记录、Windows 执行适配、SARIF/JSON 解析、报告保存、历史差异和发现转 NEXUS 任务。缺失工具或依赖审计失败会显示 `BLOCKED`。
- 新增 GitHub delivery API：分支工作区提交推送、草稿 PR、Review/Actions/Checks 读取、受策略控制的合并、稳定版本 Release 和 HTTP 通知。远程写入默认关闭，所有写操作要求显式确认。
- 新增 `tests/autonomy-soak.mjs` 和 `npm run test:autonomy:soak`。模式默认 24 小时，支持短时主机检查；覆盖网络中断恢复、任务幂等、服务重启恢复、资源采样和 JSON 报告。
- 新增 `scripts/install-security-tools.ps1` 与 `npm run security:tools`，优先通过 Windows `winget` 安装并回报安装结果。

## 真实主机证据

- `docs/evidence/phase2-desktop-capabilities.json`（2026-11-14T22:59:42.156Z）：ChatGPT Desktop 的真实进程、MSIX、UIA 和控件证据；当前能识别登录后的个人资料入口、`PROJECT NEXUS` 项目和 Composer 编辑框，但当前客户端会话仍暴露“停止/处理中”，没有可安全触发的发送控件，因此发送能力保持 `partial`。
- WorkBuddy 5.11.3 进程和卸载信息可读，UIA 只暴露两个旧式子窗格；项目、登录、编辑框、发送和结果控件均未暴露，分别记录为 `UNKNOWN` 或 `unsupported`，没有把进程存在误报成可执行。
- ChatGPT Desktop 受当前会话“停止/处理中”限制时，替代执行通道已做真实连通性验证：本机 `codex-app-server` 为 `codex-cli 0.169.0-alpha.11.1`，官方 App Server 返回 `ok: true`、`signedIn: true`、`authMode: apiKey` 和可用模型列表。现有 `executeAgentBridgeTask` 会在独立 worktree 中执行并复用同一套 Git Diff/测试验收；本轮没有未经单独需要而启动新的 AI 改码回合。
- 当前主机 CodeQL、Semgrep、Gitleaks、Trivy 均未安装。2026-11-14T23:06:58.510Z 的真实完整扫描返回 `BLOCKED`，报告为 `test-results/security-phase2-final2/security_1794697656778_ebd4b72e.json`，并保留每个工具的安装提示；本地秘密/框架扫描仍会返回真实发现。
- GitHub CLI 已完成只读身份和 API 连通性检查；本阶段没有在未获得远程写入确认的情况下创建 PR、合并或发布 Release。

## 测试记录

- `npx vitest run --maxWorkers 4`：73 个测试文件、417 个用例全部通过。
- `npx vitest run tests/unit/autonomy-adapters.test.mjs tests/unit/security-scan.test.mjs tests/unit/security-tools.test.mjs tests/unit/github-delivery.test.mjs --maxWorkers 1`：通过。
- `npm run typecheck`、`npm run lint`、`npm run build`：全部通过；构建仅保留既有大 chunk 警告。
- `npm run test:autonomy:soak` 使用 `NEXUS_SOAK_HOURS=0.004`、5 秒采样和 2 秒重启注入完成短时真实服务检查：网络恢复、重复任务拦截、SQLite 持久化和重启恢复均通过；报告保存在 `test-results/soak-runtime/2026-11-14T22-50-03-186Z/report.json`，结论为 `PARTIAL`，因为运行时间远少于 24 小时。

## 验收状态

| 能力 | 状态 | 证据或限制 |
|---|---|---|
| ChatGPT Desktop 安装、进程、启动、UIA 窗口和项目识别 | PASS | 真实 Windows 探测和控件树记录 |
| ChatGPT Desktop 自动发送、执行状态和真实 AI 改码闭环 | PARTIAL | 当前会话忙碌且发送控件未暴露；代码会停在人工接管，不伪造成功 |
| WorkBuddy 独立适配器 | PARTIAL | 安装/进程完成；当前 UIA 树不提供项目和 Composer 控件 |
| Worktree、Git Diff、独立测试和验收门禁 | PASS | 既有运行时保留并由新任务/安全路由复用 |
| CodeQL / Semgrep / Gitleaks / Trivy | PARTIAL | 代码接入、探测、解析、报告和安装脚本完成；本机四个工具均未安装，完整扫描为 BLOCKED |
| GitHub PR / Review / Actions / Merge / Release / 通知 | PARTIAL | 真实 API 读路径和受门禁写路径完成；本轮未执行远程写入 |
| 24 小时持续运行 | NOT VERIFIED | 短时检查通过，真实 24 小时报告尚未产生 |
| 托盘、服务重启和任务恢复 | PASS | 既有 Electron/Node 运行时，加上短时重启恢复证据 |

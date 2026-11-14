# 已知限制与未完成事项（如实说明）

> 本文件刻意区分「已实现并验证」「已实现但未端到端验证」「未完成」。不以界面存在、配置存在或本地推断冒充真实运行结果。

## 1. 已实现并真实验证

- 项目身份校验：确认是 `yuchen0x1/PROJECT-NEXUS`，不是 ApkStart。
- 后台服务启动：新 `/api/autonomy/*` 与既有 `/api/*` 同时可用，旧功能未被破坏。
- GitHub 只读监控：7 个端点 HTTP 200；两轮扫描第二轮 6 个资源 304；ETag 持久化；0 重复事件。
- 桌面客户端检测：真实探测到 ChatGPT Desktop / WorkBuddy / Codex CLI 均已安装且运行，解析出真实 launcher 路径。
- Windows UI Automation：程序集真实加载；枚举 12 个顶层窗口；按进程名/标题定位 ChatGPT 与 WorkBuddy 窗口（非坐标）。
- 持久化与恢复：SQLite schema v2；服务重启后仓库、9 个游标、9 个 ETag 全部保留；JSON 降级后端可用。
- 独立验收链路、任务包脱敏、发布门禁、调度优先级/互斥/恢复/超时：55 项新增单元测试全部通过。
- 全套 `npm run check` 最终 `CHECK_EXIT=0`（typecheck / lint / **414 项测试全通过** / build）；十语言 i18n 审计 0 问题、覆盖率 100%。
- Windows NSIS 安装包构建成功并作为 [v0.9.0 正式 Release](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.0) 资产上传（118 MB，4 个资产含 `latest.yml` 与 `SHA256SUMS.txt`）；安装包未签名。

## 2. 已实现，但**未端到端真实验证**

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 向真实 ChatGPT Desktop / WorkBuddy 聊天输入框发送任务并点击发送 | 未验证 | 需要在用户已登录会话内真实操作；本次不擅自控制用户客户端。适配器 UI 路径已实现（窗口/控件识别、ValuePattern、InvokePattern），能力表如实标 `partial`，默认走人工接管 |
| AI 客户端实际修改代码 → NEXUS 收集 diff → 测试 → 自动合并/发布 的完整闭环 | 未端到端验证 | 依赖上一项与用户明确授权；各独立环节有单元测试与真实 API 验证，但没有串成一次真实远程交付 |
| 控件级 AutomationId / 可访问名称 | 未针对真实客户端标定 | 客户端界面版本差异大；驱动要求「找不到控件即停止」，并提供构造参数用于配置。错误控件绝不盲点 |
| 执行状态 UI 文本识别 | 部分 | 本机 WorkBuddy（Chromium/Electron）UIA Text 控件返回 0 行；最终判定不依赖读屏，而依赖 Git diff + 独立测试 |
| 登录状态检测 | 不支持 | 无官方接口可读；永远显示 `UNKNOWN`，需人工确认 |
| `closeSession` | 不支持 | 不主动关闭用户已登录会话 |

## 3. 明确未完成

1. **应用自动远程写入**：应用本身未自动创建 PR、未自动合并、未自动创建 GitHub Release、未推送通知。新引擎生成变更摘要、测试报告、安全检查报告、版本号、CHANGELOG 与发布门禁结论；实际写入沿用既有受 `NEXUS_ENABLE_REMOTE_WRITES` + 角色门禁保护的 `delivery-stage.mjs` 通道，需用户显式授权，默认全部关闭。
   > 澄清：v0.9.0 的 GitHub Release 是**开发者按用户明确指令、在应用外部**通过 git push + GitHub REST API 手动发布的，不属于应用自动发布能力的验证结果。该发布未改动用户工作区以外的任何远程仓库内容，也未执行 force push。
2. **外部安全工具链**：未集成 CodeQL、Semgrep、Gitleaks、Trivy、`npm audit`。当前安全扫描为规则级（密钥/CVE 关键词/危险命令/敏感路径/依赖告警事件），第 4.2 节要求的工具集成仍是待办，不宣称完成。
3. **Bug 静态扫描深度**：第 4.1 节列出的逻辑错误、空指针、异步竞争、内存泄漏等，当前通过「测试 + 构建 + lint/typecheck + diff 审查 + 既有 repository-scanner」间接覆盖，没有专门的静态分析引擎。
4. **24 小时连续运行验收**：后台 ticker、持久化恢复、退避、超时都已实现并有测试，但单次会话内未做 24 小时浸泡运行，不伪造长时运行记录。
5. **Webhook 公网接入**：`POST /api/autonomy/webhook` 已实现事件规范化与去重，但服务端默认只监听 `127.0.0.1:4317`，公网投递需用户自行配置反向代理/内网穿透与 secret。既有 `/api/github/webhook` 的 HMAC 校验可继续使用。
6. **多用户/CSRF/速率限制**：新增 API 沿用既有 loopback 单用户边界，未引入新的用户认证、CSRF token 或 API 速率限制。
7. **任意语言项目的通用发布器**：命令探测覆盖 Node/Python/Rust/Go/.NET，其他技术栈需扩展 `detectVerificationCommands`。
8. **版本号语义分析**：`classifyChange` 基于 finding 类型与新增文件数的启发式，不是对 commit message / API 变更的语义化解析。
9. **同类项目质量评分**：`peer_projects.relevance` 目前为 null；明确不使用 Trending 作为质量判断，量化相关性评分未实现。

## 4. 工程与技术限制

- `node:sqlite` 在 Node 22 是**实验特性**（输出 `ExperimentalWarning`），未来 API 可能变动；已提供同接口 JSON 降级后端。
- UIA 依赖 Windows PowerShell 5.1 与 GAC 中的 `UIAutomationClient`；无这些组件时自动降级为人工接管。
- Electron 打包时 `uia-driver.ps1` 已加入 `asarUnpack`；若目标机器执行策略限制脚本，驱动使用进程级 `-ExecutionPolicy Bypass`（不修改系统策略），仍失败则如实报告不可用。
- 新增指挥中心页面使用中/英双语文案（按界面语言切换），**不是十语言**；十语言仅覆盖导航标签。i18n 审计仍为 0 problems，但报告中有 17 条信息性英文标签与 5 条 CSS 颜色统计。
- 部分专业标签（READINESS、SCHEDULER 等）保留英文大写 kicker。

## 5. 不会做的事（设计约束）

- 不会用模拟数据冒充真实运行结果；证据文件均来自真实 API 响应或真实进程/窗口探测。
- 不会因为没有 AI API Key 就把桌面客户端模式判为不可用。
- 不会因为 Issue 被关闭就标记为已解决。
- 不会重复发送同一任务包，不会让多个 AI 同时写同一工作区，不会覆盖用户未提交修改。
- 不会把 Token、密码、密钥或私人文件发送到 AI 会话。
- 不会把 AI 的自我报告当作验收结果。
- 不会在控件无法识别时随意点击。

## 6. 建议的后续验证（需用户在真实环境执行）

1. 在指挥中心为一个仓库配置 `agentProjectRef`，用真实客户端界面确认项目控件的 `AutomationId`/`Name`，填入适配器配置。
2. 在 `observe` → `repair` 逐步放开权限，用**专用测试仓库**完成一次「任务包 → 客户端修改 → diff → 测试 → 验收」闭环。
3. 显式开启远程写入与 `autoRelease`，在测试仓库验证 PR、CI 检查、Tag 与 Release 全流程。
4. 进行一次 ≥24 小时的托盘常驻浸泡运行并检查日志与任务恢复。
5. 按第 4.2 节引入与项目技术栈匹配的安全工具链。

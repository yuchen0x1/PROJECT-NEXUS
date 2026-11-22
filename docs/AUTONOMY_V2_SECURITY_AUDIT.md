# 安全审计报告（Autonomy Runtime V2）

> 范围：本次新增的 `server/autonomy/**`、`src/desktop/AutonomyCenter.tsx`、`server/index.mjs` 接入点、`package.json` 打包配置。既有 `docs/SECURITY.md` 与 `docs/SECURITY_HARDENING_REPORT.md` 继续有效。

## 1. 审计过程中发现并真实修复的缺陷

| # | 缺陷 | 风险 | 修复 |
| --- | --- | --- | --- |
| 1 | `escapeRepoPath` 只取 split 前两段并允许 `..` 作为 repo 名 | 构造 `bad/../../etc` 可能把 API 请求导向其他路径（路径穿越） | 强制恰好两段、逐段白名单、拒绝 `.` / `..` / 含 `..` 的段；增加单测 |
| 2 | `auditPackageSecrets` 只检查已脱敏的渲染文本，永远返回 safe | 凭据可能随任务包进入 AI 会话 | 同时检查结构化原始字段与渲染文本；`buildTaskPackage` 构造期脱敏；单测覆盖 |
| 3 | PR review 证据用 `prData.review_comments >= 0` 恒真表达式 | 伪造「已审批」，可能把未解决问题标记为已解决 | 改为真实读取 `GET /pulls/:n/reviews`，只有 `APPROVED` 才算 |
| 4 | 任务超时/验收结束后 session 仍是非终态 | 客户端占用永不释放，后续任务全部 `CLIENT_BUSY` | `engine.releaseSession()` 在超时与验收后转为终态 |
| 5 | GUI 客户端用 `execFile` 启动，超时会杀掉用户已开的窗口 | 破坏用户会话 | 改为 `spawn(detached) + unref` |
| 6 | UIA 驱动 `Get-TargetWindow` 用 `$pid` 覆盖 PowerShell 只读自动变量 | 循环被异常吞掉，窗口枚举恒为空 | 改名 `$ownerPid`，改为无条件枚举 + 外层过滤 |
| 7 | 最小化窗口的 `BoundingRectangle` 为 Infinity，`ConvertTo-Json` 输出非法 JSON | UIA 能力被误判为不可用 | `ConvertTo-FiniteInt` 规范化；Node 侧解析取最外层 JSON 对象 |
| 8 | `analyzePortingOpportunity` 中 `Boolean(array).some(...)` 括号错误 | 运行时 TypeError，研究流程中断 | 改为 `(array).some(...)` |
| 9 | CI 命令正则不匹配 `- run:` 行 | 无法从工作流读取命令证据 | 正则兼容 `- ` 前缀 |
| 10 | `takeover` 从 `QUEUED` 转移被状态机拒绝 | 人工接管排队任务失败 | 状态机补充合法转移 |
| 11 | `syncResource` 首轮 ETag 被写成 `null` | 每次扫描都全量重新拉取 | 保存首个响应的 ETag；真实验证第二轮 6 个资源全部 304 |
| 12 | `db.mjs` 在建表前 `prepare()` | 服务启动崩溃 `no such table: records` | 先迁移建表，再准备语句 |
| 13 | 基线测试 `local-agent-tasks.test.mjs` 在 Windows 上 5s 超时并残留 `ENOTEMPTY`；`collaboration-engine.test.mjs` 用 30ms 定时器证明并发；`provider-store.test.mjs` 与 `agent-executor.test.mjs` 顶层 `beforeEachHelper()` 未 await | CI 不稳定、偶发 `path undefined` | 合理超时 + 带重试清理；确定性屏障同步；正式 `beforeEach` hook。四个文件单独重跑 30/30 通过 |

以上均有对应单元测试或真实运行证据，不是「记录待办」。

## 2. 凭据与敏感信息

- `GITHUB_TOKEN` 只存在于进程环境变量或既有 DPAPI 凭据存储；`tokenResolver` 在请求时解析，**不写入** `autonomy.db`、任务包、日志或证据文件。
- `redactSecrets` 覆盖 GitHub PAT、fine-grained token、`sk-*` API key、PEM 私钥、`*_KEY/TOKEN/SECRET/PASSWORD=` 赋值。
- 任务包在**构造期**脱敏，并在发送前用 `auditPackageSecrets` 双重检查（结构化 + 渲染）；`TASK_PACKAGE_UNSAFE` 直接拒绝发送。
- 真实验收脚本 `tests/autonomy-live-github.mjs` 的证据文件不含任何凭据值。
- 包下载接口 `/api/autonomy/packages/:taskId` 校验解析后路径必须在 `data/autonomy-packages/` 内，防止路径穿越。

## 3. 命令执行与注入

- 验收命令只从项目自身文件（`package.json` scripts、`pyproject.toml`、`Cargo.toml`、`go.mod`）探测，脚本名必须匹配 `^[A-Za-z0-9:_-]{1,60}$`。
- `runCommand` 使用程序白名单（`npm/npx/pnpm/yarn/node/python/python3/pytest/dotnet/cargo/go`）+ `execFile`（无 shell），拒绝其他程序；单测验证 `powershell.exe -Command Remove-Item` 被拒绝。
- CI 工作流中的 `run:` 行只作为**证据**记录，绝不执行。
- 任务包明确禁止 AI 执行 `reset --hard`、`push --force`、`clean -fd`、`branch -D` 等危险命令；diff 中出现这些命令会被 `scanDiffForSecrets` 拦截。
- UIA 驱动只接受固定 action 与命名参数，不拼接用户文本到 PowerShell 命令；长文本通过 UTF-8 文件传递。

## 4. 本地工作区与远程写入

- 原工作区脏 → 拒绝；独立 Worktree；路径逃逸校验；禁止 main/master。
- diff 审查覆盖意外删除、敏感路径、密钥与危险命令。
- 远程写入默认关闭；发布需 9 项独立门禁；不自动强推、删库、覆盖用户修改。
- 三档自动化等级与「始终需人工确认」清单见 `docs/AUTONOMY_V2_PERMISSIONS.md`。

## 5. 权限边界（如实说明）

- 本机命令执行具有超时与程序白名单，**不是 Windows 操作系统安全沙箱**。
- 默认 API 仅监听 `127.0.0.1:4317`；独立后端不具备公网多用户认证。新 `/api/autonomy/*` 沿用既有 loopback CORS 白名单与角色机制，但未新增独立的 CSRF/速率限制。
- UI Automation 可以读取同一交互会话中其他窗口的文本；驱动严格限定目标窗口与控件，且 `read-text` 只用于状态启发式。
- DPAPI 不能防御同一 Windows 用户权限下的恶意程序。

## 6. 依赖与许可证

- 本次升级**未新增任何第三方运行时依赖**（`node:sqlite` 为 Node 内置），避免引入新的供应链风险。
- 同类项目移植分析内置许可证矩阵：MIT/ISC/BSD/Apache-2.0 视为兼容（要求署名），GPL/AGPL/SSPL/BSL 与无许可证项目禁止复制源代码，只能独立重实现；不确定的许可证需人工法务复核。
- `npm audit` 未作为本次门禁重新执行；既有依赖策略不变。未集成 CodeQL/Semgrep/Gitleaks/Trivy 等外部扫描器（见已知限制）。

## 7. 审计结论

新增运行时的输入校验、凭据脱敏、命令白名单、工作区隔离、状态机与发布门禁均有实现与测试。主要残留风险集中在：控件级桌面自动化的端到端验证、外部安全工具链缺失、以及 loopback API 的单用户边界。这些在 `docs/AUTONOMY_V2_LIMITATIONS.md` 中逐条列出，未以「已完成」掩盖。

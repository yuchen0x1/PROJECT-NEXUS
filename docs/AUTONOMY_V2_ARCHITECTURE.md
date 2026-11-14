# PROJECT NEXUS 新版架构说明（Autonomy Runtime V2）

> 对应版本：v0.9.0 · 2026-11-15
> 本文描述**实际交付的代码**，不描述计划。能力边界见 `docs/AUTONOMY_V2_LIMITATIONS.md`。

## 1. 升级定位

从「AI 仓库管理面板」升级为**在 Windows 服务进程内长期运行的自主仓库研发与运维运行时**。前端只是观察与控制面板；监控、调度、恢复、验收都由 `server/index.mjs` 启动的 Node 子进程驱动，窗口最小化到托盘或关闭主窗口不会停止。

**没有删除或重写任何既有模块。** 原有 20 个页面、60+ 服务、Express 路由、`state.json` schema v4、Codex app-server 桥接全部保留。新增能力位于独立命名空间 `server/autonomy/`，通过一次注册挂到既有 Express app，并复用了既有的凭据解析、托盘常驻、崩溃自动重启与原子状态写入。

## 2. 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│ Electron 主进程 (desktop/main.mjs)                            │
│   托盘常驻 / 窗口关闭不退出 / 服务崩溃指数退避重启 / DPAPI 凭据 │
└───────────────────────┬──────────────────────────────────────┘
                        │ spawn Node 子进程
┌───────────────────────▼──────────────────────────────────────┐
│ server/index.mjs (Express, 127.0.0.1:4317)                    │
│   既有 /api/* 路由（未改动）                                    │
│   + registerAutonomyApi(app) → /api/autonomy/*                 │
│   + startAutonomyTicker(60s) ← 服务进程驱动，不依赖渲染进程      │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────┐
│ server/autonomy/  Autonomy Runtime V2                         │
│                                                               │
│  engine.mjs      编排 + 持久化调度中心（P0-P4/并发/互斥/恢复）   │
│  monitor.mjs     GitHub 增量监控 + Webhook 回退 + Issue 生命周期 │
│  intelligence.mjs 精确就绪诊断 + 同类项目情报 + 12 项移植分析    │
│  reviewer.mjs    独立验收 + 发布门禁 + 版本/CHANGELOG 生成       │
│  workspace.mjs   Git Worktree 隔离 + Diff 范围审查              │
│  task-package.mjs 结构化任务包 + 凭据脱敏                       │
│  model.mjs       统一状态机/优先级/阻断码/许可证常量             │
│  db.mjs          SQLite 持久化 + 迁移 + append-only 审计         │
│  api.mjs         REST 注册 + 后台 ticker                        │
│  desktop/                                                      │
│    adapters.mjs  Desktop Agent Adapter 统一接口 + 3 个适配器    │
│    uia.mjs       Windows UI Automation Node 桥                 │
│    uia-driver.ps1 窗口/控件识别、输入、调用、读文本、失败截图     │
└───────────────────────┬──────────────────────────────────────┘
                        │
        ┌───────────────┼────────────────┬─────────────────┐
        ▼               ▼                ▼                 ▼
   data/autonomy.db  GitHub REST   桌面 AI 客户端     本地 Git Worktree
   (SQLite v2)       API + Webhook  (ChatGPT/WorkBuddy)  (隔离分支)
```

## 3. 后台运行机制（24/7）

| 机制 | 实现位置 | 说明 |
| --- | --- | --- |
| 常驻载体 | `desktop/main.mjs` | `window-all-closed` 不退出；托盘菜单；服务子进程崩溃自动重启 |
| 服务进程 | `server/index.mjs` | `startAutonomyTicker` 每 60 秒 `engine.tick()`，`timer.unref()` |
| 与页面解耦 | `engine.mjs` | 调度状态全在 SQLite；渲染进程只发 REST 控制命令 |
| 重启恢复 | `engine.recover()` | `DISPATCHED/IN_PROGRESS/VERIFYING` → `AWAITING_HUMAN`，保留 session 现场，**不重发任务** |
| 幂等 | `model.idempotencyKey` + `eventFingerprint` | 同一 finding 集合只生成一个任务；同一 GitHub 事件只入库一次 |
| 增量 | `monitor.mjs` cursor | ETag 条件请求 → 304 直接返回；只处理 `lastSeenExternalId` 之前的条目 |
| 限流 | `backoffMs` + cursor | 429/403 按 `Retry-After`/`x-ratelimit-reset` 指数退避，最长 15 分钟 |
| 超时 | `task.timeoutAt` | 默认 30 分钟，`tick` 检测后转 `EXPIRED` 并释放客户端占用 |
| 暂停/停止 | `/api/autonomy/control/*` | 全局暂停、停止当前任务、人工接管 |

## 4. 统一任务模型

- 任务 ID `task_<uuid>`，幂等键 `sha256(repoId|kind|findingIds|source)`。
- 状态：`QUEUED → DISPATCHED → IN_PROGRESS → VERIFYING → ACCEPTED`，旁路 `AWAITING_HUMAN / REJECTED / FAILED / CANCELLED / PAUSED / EXPIRED / BLOCKED`。非法转移直接抛错（有单元测试覆盖）。
- 优先级 P0–P4：P0 密钥泄露/严重漏洞，P1 关键 Bug/构建失败，P2 普通缺陷，P3 功能移植，P4 文档界面。
- 桌面 AI 执行状态 16 态：`NOT_STARTED / STARTING / AWAITING_PROJECT_SELECTION / AWAITING_SEND / RUNNING / READING_FILES / MODIFYING_CODE / RUNNING_COMMANDS / RUNNING_TESTS / AWAITING_AUTHORIZATION / AWAITING_HUMAN_INPUT / SUCCEEDED / FAILED / TIMEOUT / CLIENT_EXITED / NEEDS_HUMAN_HANDOFF`。
- 每条状态变化写入 append-only `task_events` 与 `audit_log`。

## 5. 执行后端的分离

| 后端 | 入口 | 依赖 | 说明 |
| --- | --- | --- | --- |
| A. API 模式 | 既有 `ai-provider.mjs` | `AI_BASE_URL/AI_API_KEY/AI_MODEL` | 保留原流水线 |
| B. 桌面客户端模式 | `desktop/adapters.mjs` | 已安装、已登录的 ChatGPT Desktop / WorkBuddy | **不需要任何 AI API Key** |
| C. 混合 | `engine.mjs` 按仓库配置选择 | 两者独立 | 桌面客户端负责改代码，NEXUS 负责独立验收 |

`readiness` 把六类状态**分开报告**：`AI_API / DESKTOP_CLIENT / REPOSITORY_SCAN / MANIFEST / TASK_GENERATION / TASK_EXECUTABILITY`。只有真正阻断的条件进 `blockingCodes`；「没有任务」「扫描未完成」进入非阻断 `conditions`。`MANIFEST` 按技术栈判断：Node 需要 `package.json`，Python 需要 `pyproject.toml` 等，纯文档项目不要求 manifest。

## 6. 独立验收闭环（不信任 AI 自我报告）

1. `workspace.prepare` 检查原工作区干净 → 从 HEAD 建 `nexus/auto/<taskId>` 分支的 Git Worktree。
2. 适配器发送结构化任务包；失败或 UIA 不可用则进入人工接管。
3. `workspace.collectDiff` 收集真实 diff；`reviewScope` 检查删除、敏感路径、密钥。
4. `reviewer.verifyTask` 从 `package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod`/CI 工作流**探测**命令（不假设 `npm test` 存在），在 worktree 内用程序白名单执行。
5. `PASS` 才允许 `ACCEPTED`；`FAIL` 按 `attempts < maxAttempts(3)` 退避重派，超出进入人工队列。
6. 发布需**独立**门禁：验收 PASS + 安全扫描 PASS + 无 P0 开放项 + `autonomous` 模式 + 远程写入开关 + 仓库 `autoRelease` + 显式批准 + 内容指纹不重复。

## 7. 数据存储

`data/autonomy.db`（SQLite，schema v2）。主键为 `(collection, id)` 的 JSON 记录表 + `meta` + `audit_seq`；`audit_log` 与 `task_events` 为 append-only。若 Electron 内嵌 Node 不支持 `node:sqlite`，自动降级为同接口的原子替换 JSON 存储。既有 `data/state.json` **不迁移、不覆盖、不删除**。详见 `docs/AUTONOMY_V2_DATABASE.md`。

## 8. 前端

`src/desktop/AutonomyCenter.tsx` + `autonomy.css`，作为新增导航项「AI 自动运维」（十语言导航键）接入 `src/App.tsx`。包含首页 12 项真实指标、全局自动运维开关与 6 个立即动作、仓库监控、桌面客户端能力表、任务/会话监控、智能研究与审计日志。数据全部来自 `/api/autonomy/*`，**无演示数据**。既有 20 个页面保持不变。

## 9. 模块实现清单

| # | 指令模块 | 实现 | 主要文件 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 自动运维中心 | 全局开关、控制动作、后台 tick | `engine.mjs`, `api.mjs`, `AutonomyCenter.tsx` | 已实现 |
| 2 | 仓库监控中心 | 13 类资源、增量、退避、webhook 回退 | `monitor.mjs` | 已实现（真实 API 验收通过） |
| 3 | Bug 与问题中心 | findings 可追踪记录、Issue 9 态生命周期 | `monitor.mjs`, `model.mjs` | 已实现 |
| 4 | 安全审计中心 | 事件级安全告警、diff 密钥/危险命令扫描 | `reviewer.mjs`, `monitor.mjs` | 已实现（规则扫描；外部工具链未集成，见限制） |
| 5 | 代码质量中心 | 测试/构建/lint/typecheck 命令探测与执行 | `reviewer.mjs` | 已实现 |
| 6 | 同类项目研究中心 | GitHub Search 发现、持久化、真实 release/commit/PR 跟踪 | `intelligence.mjs` | 已实现 |
| 7 | 智能升级建议中心 | 12 项移植分析 + 许可证矩阵 | `intelligence.mjs` | 已实现 |
| 8 | AI 桌面客户端中心 | 统一适配器接口、能力检测表、真实窗口识别 | `desktop/adapters.mjs`, `uia.mjs`, `uia-driver.ps1` | 已实现；控件级自动化未端到端验证 |
| 9 | AI 任务调度中心 | 优先级/并发/互斥/去重/退避/超时/恢复 | `engine.mjs` | 已实现 |
| 10 | AI 执行监控中心 | 16 态会话状态机、任务事件、失败截图接口 | `desktop/adapters.mjs` | 已实现 |
| 11 | 本地工作区管理 | Git Worktree 隔离、脏工作区拒绝、diff 审查 | `workspace.mjs` | 已实现 |
| 12 | Git 变更审核中心 | diff 范围/删除/敏感文件/密钥检查 | `workspace.mjs`, `reviewer.mjs` | 已实现 |
| 13 | 自动测试中心 | 命令探测 + 白名单执行 + 报告 | `reviewer.mjs` | 已实现 |
| 14 | PR 管理中心 | 发布门禁、变更摘要、测试/安全报告；实际 PR 复用既有受控通道 | `reviewer.mjs`, 既有 `delivery-stage.mjs` | 门禁已实现；自动 PR 需显式远程写入授权 |
| 15 | 自动发布中心 | 版本计算、CHANGELOG、Release 记录、重复发布拦截 | `reviewer.mjs` | 门禁与记录已实现；正式发布未自动执行 |
| 16 | 版本更新日志中心 | release 记录 + notes | `reviewer.mjs`, `AutonomyCenter.tsx` | 已实现 |
| 17 | 系统运行监控中心 | `/api/autonomy/health`、store stats、tick 结果 | `api.mjs`, `engine.status()` | 已实现 |
| 18 | 自动化规则中心 | 逐仓库监控项/周期/客户端/权限/模式 | `engine.addRepository`, `/api/autonomy/repositories` | 已实现 |
| 19 | 执行历史与审计日志 | append-only 事件与审计流 | `db.mjs`, `engine.mjs` | 已实现 |
| 20 | 安全权限与人工接管 | 三档自动化、始终需人工的动作、handoff/resolve | `model.mjs`, `desktop/adapters.mjs`, `api.mjs` | 已实现 |

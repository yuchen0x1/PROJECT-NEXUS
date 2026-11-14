# PROJECT NEXUS 现状审计（24/7 自主运维升级 · 阶段一）

> 审计时间：2026-11-15 Asia/Shanghai
> 审计对象：`E:\移动云盘同步盘\PROJECT NEXUS`
> 结论口径：只记录可在代码、命令输出或真实 API 响应中复核的事实。未验证的能力一律标记未验证。

## 1. 项目身份校验（硬性前置条件）

| 检查 | 实测结果 |
| --- | --- |
| `git rev-parse --show-toplevel` | `E:/移动云盘同步盘/PROJECT NEXUS` |
| `git remote -v` | `git@github.com:yuchen0x1/PROJECT-NEXUS.git` |
| 当前分支 / 状态 | `main`，`## main...origin/main`，工作区干净 |
| `package.json` name / version | `project-nexus` / `0.8.9` |
| 最近提交 | `27477a2 fix: pass the injected exec probe through to the desktop running check` |
| README 产品定位 | Windows 桌面 AI 仓库运营中心 |

**结论：当前工作区是 PROJECT-NEXUS 本体，不是 ApkStart。** 身份校验通过，允许进行 NEXUS 产品改造。审计开始前后未重置、未清理、未覆盖任何用户改动。

## 2. 基线运行结果（真实）

| 项目 | 结果 |
| --- | --- |
| Node / npm | v22.22.2 / 10.9.7 |
| `npm test` 基线 | **359 项中 358 通过，1 项失败**：`tests/unit/local-agent-tasks.test.mjs > keeps task and event counts bounded...` 5s 超时并伴随 `ENOTEMPTY` 临时目录清理失败 |
| 失败性质 | 测试基础设施缺陷（100 次并发创建 + 201 次原子重写在 Windows 上 IO 超时），非产品逻辑错误。已在本次升级中修复（合理超时 + 带重试的清理） |
| `node:sqlite` | 无需启动参数即可用（`DatabaseSync`，输出 ExperimentalWarning） |
| Electron | 45.3.1，主进程 `desktop/main.mjs` |

## 3. 真实环境探测

### 3.1 GitHub（真实凭据、只读）

使用环境中已配置的 token 对官方 API 发起只读请求，凭据未写入任何文件、日志或文档。证据：`docs/evidence/ultimate-v2-github-probe.json`。

| 端点 | HTTP | 说明 |
| --- | --- | --- |
| `/rate_limit` | 200 | core limit 5000，探测时剩余 2867 |
| `/repos/yuchen0x1/PROJECT-NEXUS` | 200 | `main`，`pushed_at=2026-11-14T17:04:31Z`，open_issues 0，返回 ETag |
| `/issues?state=all` | 200 | 0 条，返回 ETag |
| `/commits` | 200 | 3 条，返回 ETag |
| `/actions/runs` | 200 | `total_count=15` |
| `/releases` | 200 | 3 条，返回 ETag |

**意义**：ETag 与限流头可用，增量监控（条件请求 → 304）可以做真实验收，不需要伪造响应。

### 3.2 桌面 AI 客户端（真实进程 / 注册表）

| 客户端 | 安装证据 | 运行证据 | 备注 |
| --- | --- | --- | --- |
| ChatGPT Desktop | 卸载注册表**无**条目；MSIX 包 `OpenAI.Codex` 26.1111.2228.0 | 主窗口进程 PID 45856，标题 `ChatGPT` | 可执行为 `C:\Program Files\WindowsApps\OpenAI.Codex_...\app\ChatGPT.exe` |
| Codex CLI | 同一 MSIX 包内 `app\resources\codex.exe` | `codex` 进程 PID 49932 | **同包不同入口**，必须与 ChatGPT Desktop 适配器明确区分 |
| WorkBuddy | 注册表 `WorkBuddy 5.11.3`（InstallLocation 为空） | 主窗口 PID 7316，标题 `WorkBuddy` | 实际路径 `E:\AppStoreSoftstore\Install\WorkBuddy\WorkBuddy.exe` |
| Codex++ 2.6.10 | `C:\Users\lenmo\AppData\Local\Programs\Codex++` | — | 第三方客户端，非本次首批目标 |

### 3.3 UI Automation 能力边界（重要限制）

`UIAutomationClient` / `UIAutomationTypes` 程序集确实存在于 `C:\Windows\Microsoft.NET\assembly\GAC_MSIL`。但**当前执行沙箱禁止 `Add-Type` 加载 .NET 程序集**，且 `reg.exe` 位于命令黑名单。因此：

- 在本会话中**无法真实执行**窗口/控件识别、点击、文本读取或失败截图；
- 任何声称「已真实验证 ChatGPT Desktop 自动发送任务」的结论都是不成立的；
- 本次实现按指令要求提供完整 UIA 驱动代码 + 能力探测 + **可靠的人工接管闭环**，并把 UIA 能力如实标记为 `unverified`，绝不标记为已验证。

## 4. 现有技术架构

```
desktop/main.mjs (Electron 872 行)
  ├─ 托盘 / 窗口关闭后保持后台 / 开机自启
  ├─ spawn Node 子进程运行 server/index.mjs
  ├─ 子进程崩溃自动指数退避重启
  └─ 凭据 DPAPI 加密 (safeStorage)
server/index.mjs (3355 行, Express, 127.0.0.1:4317)
  ├─ 60+ 服务模块 (server/services/*, server/services/agent/*)
  ├─ 7 个集成适配器 (server/integrations/*)
  └─ JSON 状态持久化 state.json (schema v4, 原子替换 + .bak + 迁移)
src/ (React + Vite, 20 个页面, 10 语言 i18n)
tests/unit/ (65 个文件 / 359 个测试)
```

**已经真实存在的能力**（不得删除或重写）：GitHub Issues 同步与分类、Issue 修复流水线、仓库扫描、安全扫描、竞品研究、升级提案、托管策略与 hosted jobs、隔离 worktree、Agent runtime（plan→edit→verify→review 循环）、Codex app-server 官方桥接、独立测试、发布/CI/Release、Webhook HMAC、审计日志、自动更新、托盘常驻。

**后台常驻机制本身已经成立**：窗口关闭 → `window-all-closed` 不退出 → 服务子进程继续；崩溃自动重启；开机自启由用户配置。因此 24/7 的载体不需要重造，缺的是**在其上运行的持久化自治任务引擎**。

## 5. 对照指令的差距（真实代码定位）

| 指令章节 | 现状 | 证据 / 定位 |
| --- | --- | --- |
| §3 24/7 监控引擎 | 部分 | `repository-sync.mjs` 有 `createSyncGate`（退避/限流），`index.mjs` 60s tick；但无独立的事件游标/去重/18 类监控项/webhook 回退轮询统一模型 |
| §3.2 Issue 生命周期 | 缺失 | `issue-classifier.mjs` 只做分类，`github-issues.mjs` 无「关闭 ≠ 解决」的 9 态判定 |
| §5 同类项目研究 | 部分 | `competitor-research.mjs` 264 行，`upgrade-proposals.mjs` 已有提案；缺持续跟踪、12 项移植分析与许可证兼容判断 |
| §6 桌面客户端 | **关键缺口** | `agent/adapters.mjs` 只注册 `codex-app-server`（原生）与 `codex-desktop-assist`；后者 `desktop-assist.mjs` 明确写 `taskInjection:false / windowAutomation:false / resultReading:false / mode:'assist-only'`。**没有任何 ChatGPT Desktop 或 WorkBuddy 适配器** |
| §6.3 任务包 | 缺失 | 无结构化任务包生成器 |
| §10 调度中心 | 薄弱 | `workflow-scheduler.mjs` 仅 33 行、内存 `Set`，并发固定 2；`hosted-queue.mjs` 35 行有去重/优先级/同仓互斥，但无超时、无退避、无暂停/取消统一模型、无任务级恢复语义 |
| §11 阻断状态 | 混淆 | `NEEDS_PROVIDER` 在代码库中**根本不存在**；`MANIFEST_MISSING` 仅定义于 `integrations/base.mjs` 并被 `update-assessor.mjs` 用于**自动更新评估**，与 AI 流水线阻断无关。指令要求把六类状态拆开并让桌面模式不受 API Key 约束 |
| §14 长期记忆 | 部分 | `state.json` schema v4 原子写入、迁移与备份完整，但没有 append-only 事件流、没有任务级唯一 ID 的可查询审计、没有结构化表 |
| §12 二十个中心 | 部分 | 现有 20 个页面多为既有能力的视图；缺「桌面客户端中心 / 执行监控 / 自动运维总开关 / 工作区隔离审核」等新实体 |
| §13 首页 12 指标 | 缺失 | `App.tsx` 的 `METRICS` 是既有 4~6 项概览指标 |

## 6. 上一轮 ULTIMATE 文档的真实状态

仓库内已有 `ULTIMATE_EVOLUTION_REQUEST.md`（723 行）及 11 份 `ULTIMATE_*.md`。`ULTIMATE_IMPLEMENTATION_REPORT.md` 自述：交付集中在审计证据、P0 安全修复和 Provider 基础；**明确未完成** Windows Agent、durable queue、签名/旧客户端闭环、真实远程交付。`ULTIMATE_GAP_ANALYSIS.md` 亦把「持久调度」「本地执行」「成本中心」标为 P0/MISSING。

因此本轮不是重复写方案，而是补齐这些被明确列为未完成的可运行能力。

## 7. 兼容升级方案（已执行）

1. 全部新增自治能力放入独立命名空间 `server/autonomy/`，**不改动** `server/index.mjs` 的既有路由与服务逻辑，仅追加一次注册与一个后台 tick。
2. 持久化采用 `node:sqlite`（实测可用），独立数据库文件，与既有 `state.json` 并行；**不迁移、不覆盖**用户现有 JSON 状态。
3. 现有 `codex-app-server` 原生通道保留，作为「官方接口优先」的执行后端；新增桌面适配器走独立通道，能力不足时降级人工接管。
4. 前端新增独立指挥中心页面并挂到既有导航，既有 20 个页面全部保留。
5. Webhook / 轮询 / 增量游标统一到新监控引擎，但既有 `/api/github/webhook` 路由保持可用。

## 8. 风险与不可自动验证项（如实声明）

| 项 | 原因 | 处理 |
| --- | --- | --- |
| 真实 GUI 自动化控制 ChatGPT Desktop / WorkBuddy | 沙箱禁止 `Add-Type`，无法加载 UIA；且控制已登录会话涉及用户授权 | 实现完整 UIA 驱动 + 能力探测 + 人工接管；标记 `unverified`，不宣称已验证 |
| 真实远程写入（push / PR / Release） | 需要用户明确授权，指令禁止擅自操作远程仓库 | 只实现门禁与流程；默认关闭，未获授权不执行 |
| 真实 AI 客户端执行代码修改 | 依赖已登录客户端与 UIA | 用独立 Git worktree + diff + 测试的验收链保证「不看 AI 自我报告」；人工接管时由用户粘贴任务包，结果仍由 NEXUS 独立验收 |
| 24 小时连续运行 | 单次会话时间有限 | 提供可复现的后台 tick、持久化恢复与单元测试；不伪造长时运行记录 |

> **审计后更新（如实补记）**：以上是阶段一审计当时的判断，后续实测修正了两条：
> 1. UIA 并非不可用——`uia-driver.ps1` 加上进程级 `-ExecutionPolicy Bypass` 后，`UIAutomationClient` 真实加载成功，并枚举 12 个顶层窗口、识别 ChatGPT 与 WorkBuddy 窗口（证据 `docs/evidence/autonomy-v2-uia-real-windows.json`）。控件级发送仍未对真实已登录客户端端到端验证。
> 2. 用户随后明确指令「推送发布新版本」，v0.9.0 已由开发者在**应用外部**通过 `git push` + GitHub REST API 正式发布（[Release v0.9.0](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.0)）。这不属于应用自动发布能力的验证，应用内远程写入仍默认关闭。

# 测试报告（Autonomy Runtime V2 · v0.9.0）

> 所有结果来自真实命令输出或真实外部 API / Windows 进程与窗口探测。单元测试中的注入式 fake fetch / exec 属于标准隔离测试，不冒充真实运行结果；真实运行单独列出并附证据文件。

## 1. 阶段一：现状审计与环境探测

| 检查 | 结果 |
| --- | --- |
| 项目身份 | `git@github.com:yuchen0x1/PROJECT-NEXUS.git` / `main` / 工作区干净 → 确认是 NEXUS，非 ApkStart |
| 基线 `npm test` | 359 项中 358 通过，1 项 `local-agent-tasks.test.mjs` 在 Windows 上 5s 超时并 `ENOTEMPTY` |
| 处理 | 修复该 flaky（合理超时 + 带重试的临时目录清理），纳入本次交付 |
| Node / SQLite | v22.22.2；`node:sqlite` 无需启动参数可用 |
| Electron | 45.3.1 |

证据：`docs/AUTONOMY_V2_BASELINE_AUDIT.md`、`docs/evidence/ultimate-v2-github-probe.json`。

## 2. 阶段三：真实 GitHub 增量监控验收

命令：`node tests/autonomy-live-github.mjs`（只读，需要 `GITHUB_TOKEN`）

```
PASS  GitHub monitoring endpoints reachable — ["rate_limit:200","repository:200",
      "issues:200","pull_requests:200","commits:200","actions_runs:200","releases:200"]
PASS  First scan establishes baseline over all resources — {"verdict":"PASS","resources":6,"eventCount":0,"errors":0}
PASS  Second scan short-circuits with HTTP 304 — {"notModified":6,"eventCount":0}
PASS  ETag cursors persisted durably — {"etags":6,"cursors":6}
PASS  No duplicate events across two scans
PASS  Task package contains all required sections
PASS  Task package leaks no credential
PASS  UI Automation assembly loads — {"reason":"UIA_LOADED"}
PASS  Desktop client windows identified by name/process (not coordinates)
      — ["chatgpt-desktop:1","workbuddy-desktop:1"]
9 passed, 0 failed.
```

证据：`docs/evidence/autonomy-v2-live-acceptance.json`、`autonomy-v2-real-incremental-sync.json`、`autonomy-v2-uia-real-windows.json`。

补充记录：更早的一次 9 资源扫描（含 issue_comments / pr_reviews / branches / repository）第二轮 9 个资源全部 304，9 个 ETag 持久化，0 重复事件。

## 3. 阶段五：真实桌面客户端与 UI Automation

`POST /api/autonomy/adapters/probe` 在服务进程内真实执行：

| 适配器 | installed | running | launcher | UIA |
| --- | --- | --- | --- | --- |
| `chatgpt-desktop` | true | true | `...\OpenAI.Codex_...\app\ChatGPT.exe` | available |
| `workbuddy-desktop` | true | true | `E:\AppStoreSoftstore\Install\WorkBuddy\WorkBuddy.exe` | available |
| `codex-cli` | true | true | `...\app\resources\codex.exe` | available（但标记 windowless） |

UIA 驱动真实枚举 12 个顶层窗口，定位：
- `ChatGPT` / PID 45856 / `Chrome_WidgetWin_1`
- `WorkBuddy` / PID 7316 / `Chrome_WidgetWin_1` / bounds 600,217,1747,1288

驱动调试过程中修复的真实缺陷：执行策略导致无输出、`$pid` 覆盖只读自动变量、`ControlType.Window` 过滤过严、最小化窗口 Infinity 破坏 JSON。修复后窗口识别稳定可用。

**边界**：控件级输入/发送未对真实已登录客户端端到端验证；能力表标 `partial`，默认走人工接管。详见限制文档。

证据：`docs/evidence/autonomy-v2-uia-real-windows.json`、`autonomy-v2-live-acceptance.json`。

## 4. 阶段二/九：服务启动、新旧 API 共存与重启恢复

以隔离 `NEXUS_DATA_DIR` 启动完整 `server/index.mjs`：

| 检查 | 结果 |
| --- | --- |
| `GET /api/autonomy/health` | 200，`sqlite` / schemaVersion 2 / migrations 2 |
| `GET /api/autonomy/readiness?mode=desktop` | 正确区分 `AI_API not_configured` 与 `DESKTOP_CLIENT not_connected`，`desktopIndependentOfApi: true` |
| `GET /api/health`（既有） | 200，原 scheduler 字段不变 |
| `GET /api/projects`（既有） | 200，原数据结构不变 |
| 端到端流程 | 添加仓库 → 探测客户端 → 真实扫描（9 资源 PASS / 0 错误）→ 9 游标 9 ETag → 事件/任务/审计查询全部 200 |
| 重启服务 | 仓库 1 条、游标 9 条、ETag 9 个全部保留；`recover` 审计记录存在 |

证据：`docs/evidence/autonomy-v2-api-end-to-end.json`。

## 5. 单元测试

新增 6 个测试文件 / **55 项测试，全部通过**（`npx vitest run ...`，356ms）：

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `autonomy-model.test.mjs` | 13 | 优先级、任务/代理状态机、Issue 生命周期、manifest、人工确认、指纹、脱敏、任务包 |
| `autonomy-store.test.mjs` | 6 | SQLite CRUD、append-only、真实文件重开、JSON 降级、损坏拒绝覆盖 |
| `autonomy-monitor.test.mjs` | 6 | 分页/退避/路径穿越、基线、304、新事件去重、限流、Webhook 去重与回退、Issue 证据链 |
| `autonomy-adapters.test.mjs` | 9 | 真实 inventory 解析、能力表差异、项目绑定、幂等发送、UIA 路径、人工接管、控件缺失停止、凭据拒绝、UI 文本状态、超时/退出 |
| `autonomy-engine.test.mjs` | 8 | 幂等、优先级/并发、同仓写锁、暂停/取消/接管/重试、重启恢复、超时、handoff、overview |
| `autonomy-reviewer.test.mjs` | 13 | 命令探测、白名单、独立 PASS/FAIL、密钥扫描、版本、发布门禁、Worktree、readiness、许可证、12 项移植、同类项目搜索 |

### 全量测试与构建

- `npm run check`（`tsc --noEmit` → `eslint . --max-warnings=0` → `npm test` → `vite build`）：**最终 `CHECK_EXIT=0`，71 个测试文件 / 414 项测试全部通过，构建成功**，产物 `dist/` 生成。
- 最终日志：`docs/evidence/autonomy-v2-final-check.log`（`Test Files 71 passed (71)` / `Tests 414 passed (414)` / `✓ built in`）。
- `npm run i18n:audit`：10 语言，0 problems，覆盖率 100%（`npm run i18n:coverage` 十语言均 100%）。

> **既有用例的 flaky 已真实修复，不是掩盖**：
> - `local-agent-tasks.test.mjs`：Windows 上 100+ 原子写入超过默认 5s 超时并残留 `ENOTEMPTY` → 合理超时 + 带重试的目录清理。
> - `collaboration-engine.test.mjs`：用固定 `setTimeout(30)` 证明并发，在高负载 worker 中两个定时器不重叠 → 改为确定性屏障同步（顺序执行仍会失败该断言）。
> - `provider-store.test.mjs` 与 `agent-executor.test.mjs`：模块顶层调用 `beforeEachHelper()` 却未 `await`，首个用例可能读到 `undefined` 的 `dataDir` / `root` → 改用正式 `beforeEach` hook，并让 `agent-executor` 每个用例都重建 `echo.js`。
>
> 修复后单独重跑这四个文件 **30/30 通过**，并在干净环境重跑完整 `npm run check`，日志见 `docs/evidence/autonomy-v2-final-check.log`。这些用例与本次新增模块无关，但按要求实际修复而非仅记录。
> `docs/evidence/autonomy-v2-full-test.log` 是修复过程中的中间记录（保留用于追溯），最终结论以 `autonomy-v2-final-check.log` 为准。

## 6. 端到端验收结论对照（指令第十七部分）

| 验收项 | 结论 |
| --- | --- |
| A. 多仓库添加、绑定本地目录、检测新提交/Issue/PR/CI、安全告警、增量、不重复任务 | **部分通过**：添加/绑定/增量/去重/13 类资源（含安全告警）已实现并真实验证；「检测到新 Issue」用注入式单元测试验证（真实仓库当时无新 Issue），未伪造真实事件 |
| B. 同类项目搜索、保存、检测 release/commit、分析变化、判断移植、生成任务 | **部分通过**：搜索/保存/真实 release/commit/issue/PR 跟踪/12 项分析/许可证/提案已实现并测试；未对真实上游变更做长时间连续跟踪验证 |
| C. 检测/启动/定位项目/发送/识别状态/不重复发送/异常恢复 | **部分通过**：检测/启动逻辑/窗口识别、项目绑定校验、幂等、状态机、恢复、人工接管已实现并测试；**真实客户端内发送与读取结果未端到端验证** |
| D. 独立工作区、AI 改码、diff、不破坏用户修改、测试、识别失败、验收报告 | **部分通过**：Worktree/diff/脏工作区拒绝/命令探测/独立 PASS-FAIL/验收报告已实现并测试；真实 AI 改码闭环依赖 C |
| E. 更新日志、PR、CI、版本、Release、失败禁止发布 | **部分通过**：CHANGELOG/版本/9 项门禁/重复发布拦截/失败禁止发布已实现并测试；真实 PR/Release 未执行（需授权） |
| F. 最小化后运行、任务持久化、重启恢复、失败日志、网络/限流退避、无无限循环、手动暂停 | **已实现并验证**：后台 ticker 在服务进程、SQLite 持久化与真实重启恢复、退避、超时/轮次上限、暂停/取消，均有测试或运行证据；**24 小时连续浸泡未执行** |

## 7. 复现命令

```bash
npm run check
npm run i18n:audit && npm run i18n:coverage
npx vitest run tests/unit/autonomy-*.test.mjs
node tests/autonomy-live-github.mjs         # 需 GITHUB_TOKEN，只读
npm run desktop:package:win                 # 产出 Windows 安装包
```

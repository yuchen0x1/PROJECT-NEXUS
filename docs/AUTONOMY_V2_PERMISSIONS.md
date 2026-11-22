# 自动化权限与安全策略

## 1. 三档自动化等级

设置位置：`POST /api/autonomy/control/settings` 的 `automationMode`，或逐仓库 `automationMode` 字段。

| 模式 | 允许 | 不允许 |
| --- | --- | --- |
| `observe`（默认） | 监控、扫描、分析、生成建议与任务包 | 任何代码修改、分支、测试执行以外的写入行为 |
| `repair` | 建立独立 Worktree、由桌面 AI 客户端修改代码、运行独立测试与安全扫描、生成验收报告 | 正式合并、发布、条件关闭 Issue（需人工确认） |
| `autonomous` | 在上述基础上允许低风险修复、创建 PR、按规则合并、按规则发布 | 下表中的高危动作仍需明确授权 |

`observe` 模式下 `engine.tick()` 不会创建写入型任务；`assessReadiness` 会把 `TASK_EXECUTABILITY` 标为 `restricted`。

## 2. 始终需要人工确认的动作

`server/autonomy/model.mjs` 的 `ALWAYS_REQUIRES_HUMAN`，任何模式都不能自动执行：

- 删除远程仓库
- 强制推送（`push --force`）
- 覆盖用户未提交的修改
- 删除用户数据
- 修改敏感凭据
- 处理高危安全事件（P0）
- 修改重要仓库权限
- 发布存在严重安全问题的版本

`requiresHumanConfirmation(action, mode)` 对 `observe` 返回 true（所有变更），对 `repair` 额外拦截 merge/publish/release/close_issue。

## 3. 独立权限开关

| 开关 | 位置 | 默认 |
| --- | --- | --- |
| 全局自动运维启停 | `control/start`、`pause`、`resume` | `enabled=true, paused=false` |
| 远程写入 | `settings.remoteWritesEnabled`（并沿用既有 `NEXUS_ENABLE_REMOTE_WRITES`） | false |
| 逐仓库自动修复 | `repo.autoFix` | false |
| 逐仓库自动发布 | `repo.autoRelease` | false |
| 同类项目研究 | `settings.researchEnabled` | false |
| 发布显式批准 | `evaluateReleaseGate({ explicitApproval })` | false（永不隐式给出） |

**自动合并与自动正式发布是两个独立开关**，不会因开启 `autonomous` 就自动获得。

## 4. 发布门禁（全部条件同时满足）

`server/autonomy/reviewer.mjs` 的 `evaluateReleaseGate`：

1. 独立验收 `verdict === PASS`
2. 安全扫描 `pass`
3. 无开放的 P0/关键发现
4. `automationMode === 'autonomous'`
5. 远程写入开关开启
6. 仓库 `autoRelease === true`
7. 显式 `explicitApproval === true`
8. 存在实际变更
9. 内容指纹（`baseSha + patch + changedFiles`）与上次发布不同 → 防止重复发布

任一不满足即返回 `allowed: false` 与具体 `blockers`。版本号按 `classifyChange` 决定 patch/minor/major，不在每次扫描时递增。

## 5. 本地工作区保护

- 原工作区存在未提交修改 → `USER_WORKTREE_DIRTY`，**直接拒绝**，不 stash、不 reset、不覆盖。
- 任务始终在 `<dataDir>/autonomy-worktrees/<taskId>` 的独立 Git Worktree 中，分支 `nexus/auto/<taskId>`，绝不直接使用 main/master。
- Worktree 路径经过目录逃逸校验；清理时只允许移除 NEXUS 自建目录，保留分支供审计。
- `reviewScope` 检查意外删除、敏感路径（`.env`、密钥文件、凭据文件）、diff 中的密钥与危险命令（`rm -rf /`、`git push --force`、`git reset --hard`）。
- 任务包与日志中的 Token/密钥在离开进程前脱敏。

## 6. 暂停、取消、接管与回滚

| 操作 | 接口 |
| --- | --- |
| 暂停 / 恢复全局运维 | `POST /api/autonomy/control/pause` / `resume` |
| 停止当前任务 | `POST /api/autonomy/control/stop` → 任务 CANCELLED，会话转人工接管 |
| 取消 / 暂停 / 恢复 / 重试单任务 | `POST /api/autonomy/tasks/:id/{cancel,pause,resume,retry}` |
| 人工接管 | `POST /api/autonomy/tasks/:id/takeover` |
| 会话人工处理 | `POST /api/autonomy/sessions/:id/resolve` |
| 工作区回滚 | `workspace.cleanup()` 移除自建 Worktree；既有 `rollbackAgentTask` 通道保留 |

所有操作写入 append-only `audit_log`，可经 `GET /api/autonomy/audit` 查询。

## 7. 任务循环防护

- 任务幂等键防止同一 finding 集合重复建任务。
- 验收失败最多 3 轮（`maxAttempts`），每轮指数退避；超出进入 `AWAITING_HUMAN`。
- 任务默认 30 分钟超时，超时转 `EXPIRED` 并释放客户端占用。
- 同一仓库同一时刻只允许一个写入型任务（`REPO_WRITE_LOCK`）；同一客户端同一时刻只允许一个活跃会话（`CLIENT_BUSY`）；全局并发默认 2（受 CPU 核数限制，可配置 1–8）。
- 重启恢复时把运行中任务转为 `AWAITING_HUMAN` 并保留现场，**不自动重发任务**。

## 8. 不做的事

- 不自动安装 Ollama / Docker / 依赖工具。
- 不执行仓库提供的任意 shell 命令：只运行从项目清单探测出、且落在程序白名单（`npm/npx/pnpm/yarn/node/python/pytest/dotnet/cargo/go`）中的命令；CI `run:` 行只作为证据记录，不执行。
- 不把 Token、密码、密钥或私人文件发送到 AI 会话。
- 不擅自 push、创建 PR、合并或发布 Release；未获明确授权与门禁通过时一律停止。

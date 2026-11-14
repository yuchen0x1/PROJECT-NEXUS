# Local Agent Bridge — Codex App Server 集成

> 总开发指令第六部分（本机桌面 AI 编程工具集成）的落地实现。2026-11-14 完成并通过真实端到端验收。

## 是什么

PROJECT NEXUS 与本机 **Codex**（Windows 桌面版 Codex 背后的同一官方内核）之间的正式集成通道。NEXUS 负责**发现、分析、隔离、调度、监控、验收和交付**；Codex 负责**真正的代码理解与修改**。

- 协议：OpenAI 官方 `codex app-server`（JSON-RPC 2.0 over stdio，JSONL），与 Codex VS Code 扩展 / 桌面端同一接口。
- 官方文档：https://developers.openai.com/codex/app-server/
- 客户端实现：`server/services/agent/codex-app-server.mjs`
- 执行器：`server/services/agent/bridge-executor.mjs`（任务类型 `agent-bridge`）

## 架构与执行链

```
任务创建（UI/默认 NEXUS 提供商跳过，Codex 用自身登录）
  → 隔离工作区（git worktree nexus-agent/<taskId>，失败回退有界副本）
  → 项目索引 + 上下文选点
  → 生成完整任务书（环境/目标/规则/验收要求，指令 §7.2）
  → spawn codex.exe app-server → initialize 握手 → account/read 鉴权状态
  → thread/start（cwd=隔离工作区，approvalPolicy=never，sandbox=workspace-write）
  → turn/start（sandboxPolicy.writableRoots=[工作区]）
  → 实时事件流（命令执行/文件变更/计划/用量）→ 任务事件持久化
  → turn/completed → NEXUS 独立验收：git diff + 构建测试验证 + 证据哈希
  → Succeeded/Failed；交付仍走既有的确认制 apply / rollback 端点
```

## 安全模型（指令第十三部分）

| 措施 | 实现 |
| --- | --- |
| 写入隔离 | `workspace-write` + `writableRoots` 仅含任务工作区 |
| 会话隔离 | 每任务独立 thread/turn；不接管用户已打开的 Codex Desktop 窗口或历史会话 |
| 凭据安全 | 不读取、不复制、不解密 `~/.codex/auth.json`；登录状态仅通过 `account/read` 查询，返回值剥离 email |
| 审批 | approvalPolicy=never + 服务端发起的审批请求一律 decline 并记录事件 |
| 提交保护 | 任务书明确禁止 commit/push/触碰远端；交付走 NEXUS 确认制 |
| 取消/超时 | AbortController → `turn/interrupt`；软超时默认 20 分钟（`NEXUS_AGENT_BRIDGE_TURN_TIMEOUT_MS` 可调） |
| 审计 | 任务事件、threadId、验收结果、artifactSha256 全部持久化 |

## 兼容性处理

- 启动器解析：优先 `codex.exe`（含 npm 平台包 `vendor/*/bin/codex.exe`），支持 `NEXUS_CODEX_PATH` 覆盖；`.cmd` shim 自动换壳。
- 协议版本漂移：sandbox 变体名在 Codex 构建间从 camelCase（文档示例 `workspaceWrite`）变为 kebab-case（0.167.x 实际 `workspace-write`），客户端对 `unknown variant` 错误自动以备选拼写重试一次。
- 未安装 / 未登录：任务标记 `Blocked`（`CODEX_NOT_DETECTED` / `CODEX_AUTH_REQUIRED`），UI 给出 winget 一键安装提示（`OpenAI.Codex`）。

## UI

「AI 智能体」页新增：
- 任务引擎下拉第三项 **Codex 桥接**（未检测到时禁用）。
- Codex 状态卡：版本、登录状态、「测试连接」（真实 spawn + initialize + account/read + model/list 探测，成功结果缓存 60 秒）。
- API：`GET /api/agent-bridge/status`（`?live=1` 触发真实探测）。

## 验收证据（2026-11-14，本机真机）

1. `node tests/codex-bridge-live.mjs` — 探测 PASS：codex-cli 0.167.1，握手 271ms，authMode=apiKey，模型目录 5 个。
2. `node tests/codex-bridge-live.mjs --turn` — 真实闭环 PASS：Codex 在隔离 worktree 内运行 PowerShell 探查、读取 README、以 apply_patch 创建 `bridge-result.txt`（内容 `BRIDGE_OK`）；NEXUS 实时收到 command/file_change/agent_message 事件；验收 diff=1 文件；**原始项目零改动**；threadId 与全事件链持久化。
3. `npx vitest run tests/unit/codex-app-server.test.mjs tests/unit/agent-bridge-executor.test.mjs` — 14/14 PASS（协议帧、握手、审批自动拒绝、中断、解析容错、鉴权剥离邮箱、执行器全链路含真实 git worktree）。
4. `npm run check` — typecheck + eslint（0 警告）+ 340 测试 + 生产构建 全部通过。
5. i18n 深审：10 语言 0 问题。

## 当前边界（如实声明）

- 独立会话通道：通过 App Server 创建的会话不会出现在用户已打开的 Codex Desktop 窗口里（官方不提供接管现有桌面会话的接口）；用户可在 Codex Desktop 打开同一项目查看工作区。
- 审批请求一律自动拒绝（decline），因此 Codex 不会执行需要提权的命令；如需放宽须用户显式改策略（暂未开放）。
- 每个真实 turn 消耗用户自身 Codex 额度。
- 桌面辅助通道（UI Automation 打开窗口/定位项目）尚未实现，作为后续可选项。

# PROJECT NEXUS 项目现状审计

## 2026-11-21 · 当前能力与发布证据

基线为 `origin/main` 的 `464f75b`（PR #15 已合并）；原始本地安全分支没有被改写。GitHub 主分支 CI 已成功，公开 `v0.9.4` 无资产；其 Release 工作流因同名公开 Release 已存在而在打包前失败。最近有完整四份资产的可核实版本为 `v0.9.3`。未发现 Open Issue；四个依赖 PR 未作为本轮变更合并。

| 范围 | 状态 | 核对证据／限制 |
| --- | --- | --- |
| 前端 / Express / 数据 | 已运行 | 隔离的生产模式服务在 Windows loopback 启动，`/api/health` 返回 200，React 实际渲染工作台；状态 JSON、SQLite 和 JSON 降级有现有测试。 |
| 工作台、监控与研究 | 已实现，部分验证 | 概览、导航、连接空状态可用；监控游标、事件指纹、在线研究预算有覆盖。`/api/autonomy/overview` 实测 404：API 终止 handler 抢先，指挥中心可见不代表后端可达。 |
| 持久任务、恢复与取消 | 存在缺陷 | `server/index.mjs` 先创建 Autonomy runtime、执行遗留任务恢复，随后竞争主机租约；应先取得所有权。退出路径还需补调度停止与在途任务排空验证。 |
| Worktree / Agent / Reviewer | 已实现，未完成实盘验收 | 本地 Worktree、Git 检查、状态、AI 输入边界、独立 Reviewer 和失败转人工有测试；GitHub Issue→真实桌面 AI→Review→发行整链未在本轮跑通。取消时共享路径和任务收尾需进一步验证。 |
| GitHub App / Token / Webhook | 已实现，部分验证 | CLI 只读核对权限、Release、PR、CI；应用的 App 回调和签名测试不等于 Windows 端到端安装。旧接口权限检查尚不一致，保留远端写启用阻塞。 |
| Provider 与客户端 | 已实现，部分验证 | OpenAI 兼容、其他 provider、Codex App Server 和桌面适配器有实现和 mock tests；没有以私有 AI Key 或已登录账号运行任务。密钥撤销与端点绑定为 P0，通用 MCP 接入未发现。 |
| 发布 / 更新 / 回滚 | 有功能，尚未完成验收 | 本轮候选改造分离构建和发布并添加远端摘要签名门禁；不宣称已执行公网上传、签名升级或原生回滚。 |
| 安全与性能 | 有部分证据 | 官方 npm advisory（含开发与仅运行时）为 0；不是完整安全认证。Docker daemon 不运行，CodeQL 等外部工具未验证；Windows OS 隔离及 24 小时稳定性不可宣称完成。 |

本轮风险优先级见 [路线图](UPGRADE_ROADMAP.md)，证据和恢复路径见 [交付报告](UPGRADE_REPORT.md)。下文保留上轮历史基线，不代表 2026-11-21 的覆盖结论。

- 审计日期：2026-11-16（Asia/Shanghai）
- 仓库：`yuchen0x1/PROJECT-NEXUS`
- 基线分支：`main`
- 基线版本：`0.9.2`
- 产品状态：Windows x64 开发预览；审计基线为 v0.9.2，本轮演进修改已随 v0.9.3 发布。

## 1. 产品定位与真实架构

PROJECT NEXUS 是 Windows AI 仓库研发与运维工作站。它把 GitHub 仓库、本地项目目录、AI Provider、已安装的桌面 AI 客户端和任务调度连接起来，目标是完成“监控 → 分析 → 生成任务 → 隔离执行 → 独立验收 → 受控交付”的闭环。

真实运行结构：

```text
Electron 主进程（desktop/main.mjs）
  ├─ 托盘、窗口生命周期、DPAPI/safeStorage 凭据、自动更新
  ├─ 生成 loopback API token
  └─ 启动 Node/Express 服务（server/index.mjs）
       ├─ legacy /api/*：GitHub、扫描、构建、发布、AI、项目概览
       ├─ Autonomy Runtime V2：server/autonomy/*
       ├─ 状态：data/state.json（schema v4）
       ├─ 自主运行时：node:sqlite，缺失时 JSON 降级
       └─ services/*：Agent、工作区、研究、安全、更新、交付
React/Vite 渲染层
  ├─ Web 控制台：src/App.tsx
  ├─ Electron 工作站：src/desktop/Workstation.tsx
  └─ 十语言 i18n：src/locales/*
```

基于源代码的关键证据：

| 结论 | 证据 |
| --- | --- |
| Node 服务默认只监听 loopback | `server/index.mjs:61-65` |
| Electron 与服务使用临时 token | `desktop/main.mjs:63,82,129-140` |
| API JSON body 有 1 MiB 限制，Webhook 有独立 5 MiB 限制 | `server/index.mjs:1423-1434` |
| Electron 开启 contextIsolation、sandbox、webSecurity | `desktop/main.mjs:628-644` |
| 状态文件采用迁移、临时文件、fsync、备份和原子 rename | `server/services/state-store.mjs:1-104` |
| 自主运行时优先 node:sqlite，提供 JSON 兼容后端 | `server/autonomy/db.mjs:1-10,314-333` |
| Agent 工作区、命令白名单、取消和回滚路径已存在 | `server/services/agent/*`, `server/services/local-agent-workspace.mjs` |
| 外部安全工具缺失会返回 BLOCKED，不会冒充 CLEAN | `server/services/security-tools.mjs:120-178` |
| 更新下载做 URL、大小、SHA-256、签名和 publisher 绑定检查 | `server/services/software-updates.mjs:18-150` |

## 2. 已实现能力

### 核心能力

- GitHub 仓库同步、分页、ETag/游标、Issue/PR/Review/Actions/Release 相关数据流。
- 项目扫描、技术栈识别、更新适配器、AI 集成任务。
- 本地 Agent runtime、Codex app-server bridge、桌面客户端探测和 UI Automation 辅助。
- Git Worktree/copy 隔离、变更读取、独立测试和 rollback/apply 门禁。
- Autonomy Runtime V2：任务状态机、监控、调度、审计、SQLite/JSON 存储和重启恢复。
- GitHub App 安装、Webhook HMAC、草稿 PR、发布门禁与人工确认边界。
- 本地凭据使用 Electron safeStorage；renderer 只能调用受限 preload API。
- 十语言、深浅色、教学引导、通知中心、命令面板、项目总览与自动运维指挥中心。
- 安全扫描：规则级 secrets/framework、npm lockfile audit、CodeQL/Semgrep/Gitleaks/Trivy 探测和报告解析。

### 工程基线

- 103 个 Express 路由/中间件入口（源代码统计）。
- 约 48 个主要 React 组件/页面定义。
- 74 个 Vitest 测试文件、422 个测试断言在本轮最终回归中通过。
- Windows Electron 打包、自动更新 metadata、SHA-256 清单和 GitHub Actions Release workflow 已存在。

## 3. 已发现的真实短板

### P0/P1

1. **本地服务缺少统一请求追踪和统一 API 错误边界。** 旧代码中大量 route 自己处理错误，但未知 API 路由没有结构化 404；跨模块问题难以关联日志。
2. **API 没有默认的单进程资源保护。** 服务有并发/队列控制，但 HTTP 入口没有简单的请求预算；本地误配置或自动化循环可能耗尽服务。
3. **通用安全响应头不完整。** 桌面静态页面仅在 desktop mode 设置部分 CSP/headers，API 与非 desktop 静态响应没有统一 header contract。
4. **竞品研究默认只深读 5 个候选。** 这与本项目的“全球同类研究”定位和本轮总控指令的 15 项最低要求不一致。
5. **多用户身份仍未完成。** role 是进程配置或可选 header，不是经过身份认证的用户身份；文档已明确服务必须保持 loopback/受信边界。
6. **真实签名发布和旧客户端安装/启动/回滚尚未完成。** SHA-256 不能代替发布者签名；无 Authenticode 资产时 updater 会 BLOCKED。
7. **外部安全工具链依赖主机安装。** CodeQL、Semgrep、Gitleaks、Trivy 和 npm audit 受本机工具/registry 状态影响。
8. **Docker/严格隔离和真实 AI/GitHub 写入闭环在当前会话没有可复核证据。**

### P2

- 首屏入口此前静态加载 Web 与 Electron 两个互斥应用面，构建产物出现约 685 kB 的入口 chunk 警告。
- 研究 prompt 在候选数增加后可能过大，需要总长度上限和并发池。
- `/api/settings` 只暴露单一 configured 布尔值，无法区分 PAT、GitHub App 和已安装实例。
- 现有文档分散在多个阶段报告，缺少一份当前版本的统一审计、对标、路线图和交付状态文件。

## 4. 本轮已实施修复

| 编号 | 修复 | 证据 |
| --- | --- | --- |
| EV-001 | API 请求 ID：接受安全格式，否则生成 UUID，并返回 `X-Request-Id` | `server/services/http-hardening.mjs:10-17`, `server/index.mjs:1404-1411` |
| EV-002 | API/静态响应统一安全 headers；API 默认 `no-store` | `server/services/http-hardening.mjs:20-33` |
| EV-003 | 有界单进程 API 速率限制、剩余配额和 `Retry-After` | `server/services/http-hardening.mjs:36-76`, `.env.example:32` |
| EV-004 | 未知 API 路由返回结构化 404；全局错误边界避免泄露内部错误详情 | `server/services/http-hardening.mjs:78-105`, `server/index.mjs:3300-3310` |
| EV-005 | Node HTTP request/header/keep-alive timeout 明确设置 | `server/index.mjs:3388-3390` |
| EV-006 | 竞品深读上限从 5 提升到 15；并发池固定为 3 | `server/services/competitor-research.mjs:13-14,230-241` |
| EV-007 | 研究 prompt 总长度限制为 120,000 字符，并降低单候选摘录预算 | `server/services/competitor-research.mjs:148-152` |
| EV-008 | Web/Electron 互斥入口改为 React lazy + Suspense，减少首屏无关代码 | `src/main.tsx:1-23` |
| EV-009 | settings API 区分 token、GitHub App 和 installation 状态 | `server/index.mjs:3280-3293`, `src/api.ts:552` |

## 5. 成熟度判断

**当前级别：功能完整的高级开发预览，不应标记为生产级多用户平台。**

理由：

- 功能广度和工程化明显高于普通原型：有任务状态机、持久化、隔离工作区、审计、回滚、发布门禁和多语言桌面界面。
- 生产信任链仍未闭合：发布签名、旧客户端真实更新事务、严格 Windows 隔离、真实外部安全工具、真实凭据下的长时间运行和多用户身份都没有本轮完整证据。
- 因此报告中把已实现、部分验证和 BLOCKED 外部条件分开记录。

## 6. 下一步优先级

1. 完成 Windows Authenticode 证书链、安装备份、启动健康检查和失败回滚。
2. 引入经过身份认证的本地/远程 API 边界，移除依赖可伪造 role header 的多用户假设。
3. 在独立机器或 CI runner 安装外部安全工具并保存真实扫描证据。
4. 建立 15 个候选研究的结果 schema、来源哈希、过期策略和人工复核界面。
5. 进行 Electron 真实 cold-start、内存、长时间运行和安装更新回归；记录新入口拆分前后的实际数字。


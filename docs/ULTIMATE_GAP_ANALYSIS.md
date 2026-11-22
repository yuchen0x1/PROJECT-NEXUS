# PROJECT NEXUS Ultimate Gap Analysis

> 审计日期：2026-11-12（Asia/Shanghai）  
> 审计范围：当前工作区 `C:\Users\lenmo\Desktop\PROJECT NEXUS`、代码、测试、文档与只读状态文件。  
> 结论口径：代码存在不等于线上、GitHub、Docker、签名或旧客户端闭环已验证。

## 1. 基线与保护边界

- 当前仓库没有 Git 提交历史；工作区在本次任务开始前已有 staged、unstaged 和 untracked 改动，本次工作不重置、不清理、不覆盖这些改动。
- `data/state.json` 当前仍是 `schemaVersion: 2`，包含 24 个项目和 3 个任务。本次没有手工迁移、删除或重置该文件。
- 已有实现是 React/Vite + Express 模块化单体，JSON 持久化；Phase 3 已增加扫描器、适配器、隔离工作区、任务状态和受控 Draft PR 路由。
- 真实 GitHub 写入、AI provider、Docker 目标项目构建、签名验证、旧客户端升级均不能仅凭静态代码或 mock 结果标记为完成。

## 2. 全局差距矩阵

| 领域 | 状态 | 当前证据 | 主要缺口 | 优先级 |
|---|---|---|---|---|
| 前端架构 | PARTIAL | React/Vite、Overview、Projects、Task Center 等页面存在 | 缺少独立 Workflow、AI Fix、Agent、Cost 中心；部分指标仍是简化信号 | P1 |
| 后端架构 | PARTIAL | Express 路由、服务模块、适配器注册表 | 仍是进程内调度，缺少多实例协调和 durable worker | P0 |
| API 设计 | PARTIAL | GitHub、扫描、任务、发布、更新路由存在 | 缺少统一错误契约、幂等键、分页/事件流和 agent run API | P1 |
| 存储 | PARTIAL | 原子替换 JSON、v2→v3 兼容逻辑、测试覆盖 | 进程外并发、备份/恢复、损坏检测、事件日志保留不足 | P0 |
| GitHub 接入 | PARTIAL | Token、App installation、分页、Webhook HMAC；本轮已修复一次性 state 与 App-only 路由门禁 | 权限审计、CSRF/用户身份和 rate-limit 处理仍不足 | P0 |
| AI provider | PARTIAL | Provider registry、任务路由、OpenAI-compatible/Ollama/Anthropic/Gemini 格式、重试、usage/cost 已有基础 | 缺少持久成本汇总、模型能力动态探测、完整 fallback/预算和 live credentials evidence | P0 |
| Agent 执行 | PARTIAL | 隔离 clone、文件操作约束、一次性变更提案、沙箱入口 | 缺少 plan→tool→observe→repair→verify 的持久循环、checkpoint、轨迹 | P0 |
| 本地执行 | MISSING/BLOCKED | 只有服务端工作区和 Docker runner | Windows Agent、设备认证、心跳、取消、断线恢复未实现 | P0 |
| 沙箱 | PARTIAL | network=none、资源限制、cap-drop、非 root、路径/符号链接检查 | Docker 镜像/依赖缓存未验证；宿主机/内核边界仍需额外防护 | P0 |
| 代码修改 | PARTIAL | 最多 30 个操作、相对路径、敏感文件拦截、差异输出 | 修改前备份、事务回滚、配额、审批证据不足 | P0 |
| 构建/测试 | PARTIAL | GitHub Actions dispatch；隔离 runner 定义 | 本地真实构建受镜像/离线依赖限制；缺少统一 artifacts | P1 |
| PR | PARTIAL | 远程写入默认关闭，要求角色、精确 repo/branch、PASS 检查 | 无多用户身份；未做真实远程 PR 验证 | P1 |
| Release | PARTIAL | Draft/edit/publish 路由和 asset SHA-256 记录 | 正式发布未验证；签名、审批、回滚和多平台资产编排缺失 | P1 |
| 自动更新 | PARTIAL | Electron/Tauri/Python/.NET/Web-PWA 证据适配器 | Android/iOS unsupported；签名、manifest、旧客户端安装/启动未闭环 | P1 |
| 安全 | RISK | Token server-side、Webhook HMAC、审计日志、remote-write gates、loopback CORS allowlist | 无 CSRF/速率限制/真正用户认证；进程级 role | P0 |
| 权限 | PARTIAL | Viewer/Operator/Administrator 角色门禁 | 角色来自环境或可选 header，不是可审计用户身份 | P0 |
| 调度 | PARTIAL | in-process concurrency、定时扫描、取消/重试 | 进程重启恢复、幂等、backoff、分布式锁、优先级不足 | P0 |
| 日志/监控 | PARTIAL | Task/job logs、activity、audit logs | append-only event stream、指标、trace、告警通知不足 | P1 |
| 多项目 | PARTIAL | 24 个项目、按项目报告和 workspace lock | 批量失败隔离、项目配额、跨项目资源治理不足 | P1 |
| 健康中心 | PARTIAL | Overview 指标、issue 数、扫描报告 | Actions、依赖漏洞、PR、release、API 状态未形成真实评分模型 | P1 |
| 成本管理 | MISSING | provider usage 仅在部分 job 记录 | token、价格、项目/任务成本、预算和资源告警缺失 | P1 |
| 数据库/灾备 | MISSING/PARTIAL | JSON 迁移、原子写入、备份文档 | 自动备份、恢复演练、跨进程写入、审计归档缺失；不应盲目引入 DB | P1 |
| 插件/扩展 | MISSING | 适配器注册表可作为边界 | provider、通知、workflow、agent 插件权限声明未实现 | P2 |
| 文档/交付 | PARTIAL | Phase 1–3 文档与截图 | Ultimate 文档、真实截图、部署/恢复证据待补齐 | P1 |

## 3. 竞品研究结论

本次只借鉴公开架构和行为，没有复制代码；许可证和实现边界已作为后续引入门槛。

- OpenHands：Agent、EventStream、Runtime、Sandbox、Storage 分层；Docker/Local/Remote runtime 和事件持久化适合 NEXUS 的 AgentRun 设计。
- SWE-agent/SWE-ReX：将 agent 与 sandbox 解耦，动作有 parser、黑名单、超时、重试和可序列化轨迹；适合补齐工具策略和可复现执行。
- Aider：repo-map、git diff、lint/test feedback、token/cost 计数值得借鉴，但仓库命令必须先通过 NEXUS policy/approval，不能直接执行不可信配置。
- Continue：provider/model/role/context/tool policy 可组合；NEXUS 应把模型能力和任务类型从业务逻辑中拆出。
- Temporal：event history、deterministic workflow、Activity retry、heartbeat/checkpoint 是持久调度的参考；在未引入新基础设施前先实现同等语义的 append-only run events。
- Dagger：容器、缓存、secret、trace 共用执行模型；NEXUS 的沙箱应继续保持网络默认关闭，secret 不进入日志、缓存或容器层。
- GitHub Actions/GitLab/Jenkins：concurrency、timeout、matrix、artifacts、required reviewers 是 Workflow/Release Center 的最小语义集合。
- Dependabot/Renovate：依赖 dashboard、approval 和默认不自动合并的策略适合 AI Fix Center。
- Electron/Tauri updater：签名、manifest、digest、断点下载和旧客户端验证必须拆成独立证据，不得把“配置存在”当成“升级成功”。

## 4. 推荐优先级

### P0：安全且可恢复的执行底座

1. 统一 Provider registry、任务路由、超时/重试、usage/cost 记录。
2. AgentRun 状态机和 append-only 事件/轨迹，支持 checkpoint、取消和恢复。
3. 修复 GitHub App state/CSRF 与 App-only 路由门禁；收紧 CORS、认证和速率限制。
4. 工作区事务：修改前清单/备份，失败回滚，配额和清理策略。
5. 把 in-process queue 抽象为可替换 worker 接口；在引入 PostgreSQL/Redis 前先实现幂等键、backoff 和重启恢复语义。

### P1：可验证的运维与交付

1. Project Health 真实评分（Actions、依赖、PR、release、更新、API），每个扣分项可追溯。
2. Workflow Center：条件、并发、超时、人工审批、批量失败隔离。
3. AI Fix Center：低/中/高风险策略、修复前后 diff、回归测试和 PR 门禁。
4. Release/Update evidence：SHA-256、签名、manifest、staged rollout、旧客户端安装启动记录。
5. Cost & Resource Center：模型 token/价格、项目成本、Docker 资源、预算和告警。

### P2：扩展与产品化

Windows Agent、插件系统、多用户 RBAC、通知渠道、PostgreSQL/Redis 评估、Android/iOS 适配器和高阶可视化。

## 5. 验收规则

每个能力必须记录 `PASS / FAIL / PARTIAL / BLOCKED / NOT APPLICABLE`，并关联：代码路径、命令、时间、输入、输出和外部前提。没有真实凭据、远程写入、目标设备或签名材料时，保持 BLOCKED，不用 mock 或静态页面替代。

## 参考来源

- OpenHands architecture/runtime docs：<https://github.com/All-Hands-AI/OpenHands/tree/main/docs>
- SWE-agent/SWE-ReX：<https://github.com/SWE-agent/SWE-agent>
- Aider repo map and testing workflow：<https://github.com/Aider-AI/aider>
- Continue configuration and tools：<https://github.com/continuedev/continue>
- Temporal durable execution：<https://docs.temporal.io/encyclopedia/retry-policies>
- Dagger container workflow model：<https://docs.dagger.io>
- GitHub Actions concurrency/artifacts/environments：<https://docs.github.com/actions>
- GitHub Apps/Webhooks：<https://docs.github.com/apps>
- Electron updater：<https://www.electronjs.org/docs/latest/api/auto-updater>
- Tauri updater：<https://v2.tauri.app/plugin/updater/>

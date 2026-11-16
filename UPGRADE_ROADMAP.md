# UPGRADE_ROADMAP

- 版本基线：0.9.2
- 路线图日期：2026-11-16
- 总升级点：36
- 本轮新增完成：9
- 基线已有且保留：13
- 部分完成/受外部条件阻塞：5
- 后续计划：9

状态含义：本轮完成 = 本轮有代码或配置变更并通过对应检查；基线已有 = 当前代码已实现，本轮未重复改造；部分/阻塞 = 有代码或接入，但外部条件/生产证据不足；计划 = 未宣称完成。

## P0：安全、数据和更新信任链

### EV-001 — API 请求追踪 ID（本轮完成）

- 模块：Express HTTP 入口。
- 当前问题：多路由日志无法用统一标识关联一次 UI 操作。
- 依据：server/index.mjs 原先没有统一 X-Request-Id middleware。
- 对标参考：OpenHands/OpenCode 的后台 session/event 可追踪设计。
- 改进方案：验证外部 request id 格式，否则生成 UUID；写入响应和错误体。
- 预期效果：用户可把单次失败交给日志排查，避免暴露内部堆栈。
- 文件：server/services/http-hardening.mjs、server/index.mjs。
- 难度：低；优先级：P0。
- 验收标准：合法 ID 原样回显；非法 ID 被替换；错误体含同一 requestId。
- 状态：本轮完成。

### EV-002 — 统一安全响应头（本轮完成）

- 模块：API/静态资源响应。
- 当前问题：旧逻辑只在 desktop mode 对非 API 响应设置部分 headers。
- 依据：server/index.mjs:1424 附近的 desktop-only CSP/headers 逻辑。
- 对标参考：Electron/自托管 AI 工作台的默认浏览器硬化。
- 改进方案：统一 nosniff、Referrer-Policy、X-Frame-Options、Permissions-Policy；API 禁止缓存。
- 预期效果：减少点击劫持、MIME 嗅探和旧 API 缓存风险。
- 文件：server/services/http-hardening.mjs、server/index.mjs。
- 难度：低；优先级：P0。
- 验收标准：API 和静态响应均出现安全头；不改变现有 CORS/desktop CSP。
- 状态：本轮完成。

### EV-003 — 单进程 API 速率保护（本轮完成）

- 模块：Express API。
- 当前问题：队列有并发限制，但 HTTP 入口没有统一请求预算。
- 依据：路由约 103 个，桌面/自动化可重复调用同一 loopback 服务。
- 对标参考：Renovate/n8n 的执行资源预算和后台限流思想。
- 改进方案：按 loopback peer 建立有界 fixed-window limiter，返回剩余额度和 Retry-After。
- 预期效果：降低误循环、脚本失控和局部 DoS 风险。
- 文件：server/services/http-hardening.mjs、.env.example、server/index.mjs。
- 难度：中；优先级：P0。
- 验收标准：超过默认 600 次/分钟返回 429；窗口过期恢复；Map 有界。
- 状态：本轮完成。

### EV-004 — API 未知路由与全局错误边界（本轮完成）

- 模块：Express 路由。
- 当前问题：未知 API 路由没有统一结构化 404；未捕获错误可能向客户端暴露实现细节。
- 依据：原代码在 SPA fallback 后缺少 API 404/error middleware。
- 对标参考：OpenHands/Continue 的可脚本化错误契约。
- 改进方案：加入 API_NOT_FOUND、稳定 code、requestId 和生产安全错误消息。
- 预期效果：CLI/桌面端可以可靠区分路径错误和服务失败。
- 文件：server/services/http-hardening.mjs、server/index.mjs。
- 难度：中；优先级：P0。
- 验收标准：/api/not-found 返回 404 JSON；500 不返回原始错误文本。
- 状态：本轮完成。

### EV-005 — HTTP 超时预算（本轮完成）

- 模块：Node HTTP server。
- 当前问题：请求/headers/keep-alive 超时依赖 Node 默认值，长连接边界不显式。
- 依据：原 app.listen 后没有 timeout 配置。
- 对标参考：OpenCode Windows daemon、n8n 长任务入口的显式资源边界。
- 改进方案：request 120s、headers 15s、keep-alive 5s；readiness 已有更长的 fetch timeout。
- 预期效果：缓解慢请求占用连接并使边界可审查。
- 文件：server/index.mjs。
- 难度：低；优先级：P0。
- 验收标准：启动后 server 属性为设定值；现有 75s readiness 不被提前打断。
- 状态：本轮完成。

### EV-006 — 更新安装事务、备份、启动健康检查和回滚

- 模块：Electron updater / Windows installer。
- 当前问题：SoftwareUpdates.prepareInstall 只生成 native confirmation receipt，未完成原生安装事务。
- 依据：server/services/software-updates.mjs 注释和 docs/AUTONOMY_V2_LIMITATIONS.md。
- 对标参考：electron-updater、Cline/OpenCode Windows 发布经验。
- 改进方案：签名验证后备份当前版本，启动新版本健康探针，失败自动恢复。
- 预期效果：更新失败不留下不可启动客户端。
- 文件：desktop/auto-update.mjs、server/services/software-updates.mjs、CI workflow。
- 难度：高；优先级：P0。
- 验收标准：旧版本发现、下载、验证、安装、新版本启动、失败回滚均有真实 receipt。
- 状态：计划，缺签名安装环境。

## P1：核心功能与隔离

### EV-007 — 15 个候选的竞品研究下限（本轮完成）

- 模块：competitor-research。
- 当前问题：默认只深读 5 个候选，不符合总控指令的 15 个最低研究要求。
- 依据：原 RESEARCH_MAX_CANDIDATES = 5。
- 对标参考：本轮研究的 Cline、OpenHands、OpenCode、Dify、n8n 等。
- 改进方案：默认研究目标/上限提升为 15，并保留来源、README、commit、release、issue、license evidence。
- 预期效果：报告覆盖面达到可比较的全球样本。
- 文件：server/services/competitor-research.mjs。
- 难度：低；优先级：P1。
- 验收标准：默认 run 返回最多 15 个非归档、非自身候选；无 provider 时仍输出 metrics-only。
- 状态：本轮完成。

### EV-008 — 研究并发池与 prompt 预算（本轮完成）

- 模块：竞品深读/AI synthesis。
- 当前问题：5 个候选按顺序深读；扩到 15 后会显著变慢，prompt 可能超上下文。
- 依据：原 for...of await researchCompetitor 与未设总 prompt 上限。
- 对标参考：批处理型 GitHub API 客户端和 agent research worker。
- 改进方案：并发池 3；候选摘录预算收紧；总 prompt 上限 120,000 字符。
- 预期效果：提高研究吞吐并降低超时/上下文失败。
- 文件：server/services/competitor-research.mjs、单元测试。
- 难度：中；优先级：P1。
- 验收标准：并发不超过 3；取消信号可终止；15 候选 prompt 有确定上限。
- 状态：本轮完成。

### EV-009 — GitHub App/PAT 状态分层展示（本轮完成）

- 模块：设置与连接诊断。
- 当前问题：/api/settings 只有一个 configured 布尔值，无法解释 App 与 PAT 的差异。
- 依据：server/index.mjs:3280 原响应只返回 github.configured。
- 对标参考：Continue/OpenHands 的 provider/auth readiness 分层。
- 改进方案：返回 tokenConfigured、appConfigured、installations，保留兼容的 configured。
- 预期效果：减少“App 已装但搜索需 PAT”类误解。
- 文件：server/index.mjs、src/api.ts。
- 难度：低；优先级：P1。
- 验收标准：无凭据、仅 PAT、仅 App、App installation 四种状态均可区分。
- 状态：本轮完成。

### EV-010 — Agent 工作区隔离和显式 apply

- 模块：Agent runtime / local-agent workspace。
- 当前问题：AI 修改必须防止污染原工作区。
- 依据：server/services/agent/workspace-worktree.mjs、local-agent-workspace.mjs。
- 对标参考：Cline checkpoints、mini-SWE-agent sandbox、SWE-ReX。
- 改进方案：保持 worktree/copy、脏工作区拒绝、diff/敏感文件/测试门禁和 explicit apply。
- 预期效果：降低误改、密钥泄露和不可逆覆盖。
- 文件：Agent workspace 服务、任务执行器、文档。
- 难度：高；优先级：P1。
- 验收标准：脏源工作区被拒；隔离 diff 可回滚；原目录只在批准 apply 后变化。
- 状态：基线已有，需真实长任务回归。

### EV-011 — 独立验收与结果不采信

- 模块：任务执行/交付。
- 当前问题：Agent 自报成功不能证明代码正确。
- 依据：server/autonomy/reviewer.mjs、issue-fix-pipeline.mjs、测试脚本。
- 对标参考：Aider lint/test loop、SWE-agent benchmark receipt。
- 改进方案：继续以 git diff、项目真实测试/构建、安全扫描和目标分支证据为准。
- 预期效果：减少“回答成功但代码未修复”。
- 文件：reviewer、delivery-stage、独立测试服务。
- 难度：高；优先级：P1。
- 验收标准：缺测试/构建证据不能进入 accepted 或 release gate。
- 状态：基线已有。

### EV-012 — GitHub App、Webhook HMAC 和远程写入门禁

- 模块：GitHub integration/delivery。
- 当前问题：远程写入必须区分 read、push、PR、merge、release。
- 依据：server/index.mjs GitHub App、webhook、delivery routes。
- 对标参考：n8n/Renovate 的审计和 PR 交付。
- 改进方案：保持 installation token、HMAC、明确授权、幂等 delivery effect 和人工确认。
- 预期效果：降低误写远程仓库的风险。
- 文件：server/autonomy/github-delivery.mjs、delivery-stage.mjs。
- 难度：高；优先级：P1。
- 验收标准：默认不写远程；缺授权/检查/目标分支证据时拒绝。
- 状态：基线已有，真实账号写入本轮未执行。

### EV-013 — Provider registry 与密钥脱敏

- 模块：AI Provider。
- 当前问题：多模型和本地模型需要可配置、可路由、不可泄露。
- 依据：server/services/provider-store.mjs、desktop/main.mjs:274-417。
- 对标参考：Tabby、Open WebUI、Continue 的 provider/model 管理。
- 改进方案：维持 safeStorage、服务端运行时 key、host/model/capability 摘要和路由。
- 预期效果：支持 API 与桌面 Agent 并存。
- 文件：provider-store、ai-provider、preload。
- 难度：高；优先级：P1。
- 验收标准：renderer 不读取明文 key；诊断只返回脱敏状态。
- 状态：基线已有。

### EV-014 — 发布物签名与 publisher 绑定

- 模块：应用更新。
- 当前问题：SHA-256 只能证明下载内容一致，不能证明来源。
- 依据：server/services/software-updates.mjs、artifact-signature.mjs。
- 对标参考：Cline/OpenCode Windows release、electron-builder signing。
- 改进方案：保留 Authenticode valid + expected publisher 双重检查。
- 预期效果：阻止任意签名者替换安装包。
- 文件：更新服务、CI secrets、release workflow。
- 难度：中；优先级：P1。
- 验收标准：无证书/错误 publisher 明确 BLOCKED；正确证书才进入 Verified。
- 状态：代码基线已有，正式签名资产 BLOCKED。

### EV-015 — 外部安全工具链完整接入

- 模块：security scan。
- 当前问题：CodeQL、Semgrep、Gitleaks、Trivy 和 npm audit 受主机工具/registry 影响。
- 依据：server/services/security-tools.mjs、docs/PHASE2_CLOSEOUT.md。
- 对标参考：n8n SBOM/VEX、Renovate advisory workflow。
- 改进方案：CI 固定版本镜像/工具，保存 SARIF、SBOM、历史 diff 和依赖源。
- 预期效果：从规则扫描升级为可审计的供应链扫描。
- 文件：security-tools、workflow、release artifact。
- 难度：高；优先级：P1。
- 验收标准：每个工具有版本、命令、报告、退出码和 BLOCKED 原因。
- 状态：部分完成，当前主机工具未全部安装。

### EV-016 — 严格 Windows 隔离宿主

- 模块：sandbox/agent executor。
- 当前问题：普通可信脚本仍可能访问当前用户文件和网络。
- 依据：docs/SECURITY_HARDENING_REPORT.md、WINDOWS_STRICT_ISOLATION_EXECUTION_PLAN.md。
- 对标参考：mini-SWE-agent sandbox adapter、OpenHands agent server。
- 改进方案：原生 broker 或受限容器，显式挂载、网络默认禁用、资源上限、心跳和取消。
- 预期效果：将“可信本地执行”与“严格隔离执行”区分开。
- 文件：sandbox-runner、Windows broker、CI。
- 难度：高；优先级：P1。
- 验收标准：未验证宿主时严格模式返回 BLOCKED，不降级执行；有宿主时完成真实拒网/路径测试。
- 状态：阻塞，当前环境无可复核宿主。

### EV-017 — 多用户身份与授权边界

- 模块：API auth/RBAC。
- 当前问题：NEXUS_ROLE 是进程级配置，header 角色可伪造（若开启）。
- 依据：server/index.mjs activeRole/currentRole/requireRole 与文档限制。
- 对标参考：n8n RBAC/audit、OpenHands self-host auth。
- 改进方案：本地单用户 token 与远程 OIDC/Windows identity 分层；移除可伪造角色信任。
- 预期效果：远程部署时有真实身份和最小权限。
- 文件：auth middleware、desktop session、API docs。
- 难度：高；优先级：P1。
- 验收标准：角色来自已验证 identity；header 只能作为开发 fixture。
- 状态：计划。

## P2：性能、稳定性与体验

### EV-018 — 首屏入口代码拆分（本轮完成）

- 模块：React entry。
- 当前问题：Web 与 Electron 两个互斥应用面以前同时静态进入入口 chunk。
- 依据：旧 src/main.tsx 静态 import App/Workstation；Vite 曾报告大 chunk。
- 对标参考：OpenHands/Continue 的多表面按需加载。
- 改进方案：lazy + Suspense，保留统一错误边界和加载状态。
- 预期效果：Web/Electron 首次下载无关代码减少，页面切换仍保持现有路由模型。
- 文件：src/main.tsx、src/styles.css。
- 难度：低；优先级：P2。
- 验收标准：typecheck/lint/build 通过；生产产物出现独立入口 chunk；加载时有可见状态。
- 状态：本轮完成。

### EV-019 — GitHub 条件请求和游标续查

- 模块：repository monitor/sync。
- 当前问题：多仓库轮询需控制 API 配额与重复下载。
- 依据：server/index.mjs repositoryPages/repositorySyncGate，server/autonomy/monitor.mjs。
- 对标参考：Renovate datasource cache、GitHub conditional requests。
- 改进方案：保持 ETag、304、分页游标、事件指纹和指数退避。
- 预期效果：降低延迟和 GitHub API 消耗。
- 文件：monitor、github-pagination、repository-sync。
- 难度：高；优先级：P2。
- 验收标准：重复轮询命中 304；断点续查不重复入库；限流后可恢复。
- 状态：基线已有。

### EV-020 — 任务资源治理与并发配额

- 模块：hosting/agent queue。
- 当前问题：多仓库、AI、扫描和桌面客户端之间需要公平调度。
- 依据：resource-governor.mjs、hosted-queue.mjs、collaboration-engine.mjs。
- 对标参考：n8n execution concurrency、OpenCode background subagents。
- 改进方案：全局/仓库/客户端配额、排队、暂停、取消和退避。
- 预期效果：避免单仓库占满桌面客户端或 provider。
- 文件：queue、resource-governor、autonomy engine。
- 难度：高；优先级：P2。
- 验收标准：并发上限稳定；同仓库写入互斥；取消可释放资源。
- 状态：基线已有。

### EV-021 — Worker 重启恢复与租约清理

- 模块：持久化任务。
- 当前问题：服务崩溃/重启时要避免遗留 Running/Downloading 假成功。
- 依据：recoverIntegrationWork、recoverLocalAgentTasks、SoftwareUpdates.recover。
- 对标参考：Cline checkpoint、OpenHands conversation recovery。
- 改进方案：恢复为 Blocked/Retryable，审计原因，清扫过期 workspace lease。
- 预期效果：重启后状态可解释且不会重复写入。
- 文件：server/index.mjs、runtime-checkpoint.mjs、file-lease.mjs。
- 难度：高；优先级：P2。
- 验收标准：模拟重启后未完成任务进入明确状态；重复恢复幂等。
- 状态：基线已有，需 24 小时 soak。

### EV-022 — 文件租约和原子状态写入

- 模块：state/workspace。
- 当前问题：Windows indexer/AV 可能暂时占用替换目标。
- 依据：state-store.mjs 的临时文件、fsync、rename 重试和 file-lease.mjs。
- 对标参考：Durable effects / Renovate lock discipline。
- 改进方案：保持 host lock、download lock、workspace lock，失败关闭而不是覆盖。
- 预期效果：降低双实例和状态损坏。
- 文件：state-store、file-lease、durable-effects。
- 难度：中；优先级：P2。
- 验收标准：并发保存不损坏 JSON；租约冲突可诊断；旧备份保留。
- 状态：基线已有。

### EV-023 — Issue 关闭不等于解决

- 模块：issue activity/fix pipeline。
- 当前问题：GitHub close 事件不能直接作为修复成功。
- 依据：issue-classifier.mjs、issue-fix-pipeline.mjs、README 的 9 态结论。
- 对标参考：SWE-agent issue-to-code 与独立评测。
- 改进方案：关联 PR、合并目标分支、测试、review、回归、评论和置信度。
- 预期效果：减少错误关闭与虚假修复。
- 文件：issue activity/classifier/pipeline。
- 难度：高；优先级：P2。
- 验收标准：缺任一关键证据时结论为 uncertain/blocked。
- 状态：基线已有。

### EV-024 — 项目总览与 readiness 分层

- 模块：Project Overview/Autonomy Center。
- 当前问题：配置、扫描、任务生成、桌面客户端和 provider 状态容易混淆。
- 依据：project-overview.mjs、setup-readiness.mjs、AutonomyCenter.tsx。
- 对标参考：OpenHands Canvas readiness、Continue provider setup。
- 改进方案：保持每个条件独立显示 READY/DEGRADED/BLOCKED。
- 预期效果：用户知道下一步是配置、等待、重试还是人工接管。
- 文件：project overview、AutonomyCenter、locales。
- 难度：中；优先级：P2。
- 验收标准：缺 AI API 不阻断桌面模式；缺 GitHub token 的研究明确 BLOCKED。
- 状态：基线已有。

### EV-025 — 可访问的命令面板、通知和焦点状态

- 模块：Workstation UI。
- 当前问题：复杂桌面工作站需要键盘入口、可读状态和错误反馈。
- 依据：src/desktop/Workstation.tsx、workstation.css、i18n namespaces。
- 对标参考：Cline/OpenCode command/session UX。
- 改进方案：保持命令面板、通知中心、loading/empty/error、可见 focus 和 reduced-motion。
- 预期效果：降低多任务操作成本。
- 文件：Workstation、styles、locales。
- 难度：中；优先级：P2。
- 验收标准：键盘可打开/关闭/执行命令；错误消息不只写 console。
- 状态：基线已有，需真实屏幕阅读器检查。

### EV-026 — 研究结果 provenance 与来源哈希

- 模块：competitor research persistence。
- 当前问题：报告有 URL/SHA 证据，但没有统一的来源快照指纹和过期策略。
- 依据：researchCompetitor 已保存 selected source SHA、license evidence 和 researchedAt。
- 对标参考：Renovate update confidence、SWE benchmark receipt。
- 改进方案：每个 candidate 保存 commit/tree/license hash、来源有效期、重查原因。
- 预期效果：人工审核可复核当时证据。
- 文件：competitor-research、state schema、Research UI。
- 难度：中；优先级：P2。
- 验收标准：报告可以按 SHA 重建来源；过期报告显示 stale。
- 状态：计划。

### EV-027 — 15 候选 UI/报告分页与筛选

- 模块：Research Center。
- 当前问题：候选数扩大后单列表会拥挤，报告详情难以比较。
- 依据：src/App.tsx ResearchCenter 当前一次渲染全部 candidates。
- 对标参考：Dify/OpenHands Canvas 的分层查看。
- 改进方案：候选排序、许可证筛选、活跃度筛选、分页/展开证据和 compare view。
- 预期效果：研究结论更易审阅。
- 文件：src/App.tsx、src/api.ts、git locales。
- 难度：中；优先级：P2。
- 验收标准：15 个候选可分页；每项显示来源、license、最近活动和风险。
- 状态：计划。

### EV-028 — Agent 任务 benchmark receipt

- 模块：independent testing/metrics。
- 当前问题：有单次测试结果，但缺跨项目成功率、耗时、token、重试和回归趋势。
- 依据：agent-runner.mjs、runtime.mjs、project-overview.mjs 已有事件/成本字段。
- 对标参考：SWE-agent/mini-SWE-agent benchmark、Aider test loop。
- 改进方案：统一 receipt schema，记录输入摘要、测试命令、退出码、耗时、token/cost 和回滚。
- 预期效果：可以按版本比较 Agent 质量。
- 文件：agent runtime、state/schema、overview UI。
- 难度：高；优先级：P2。
- 验收标准：每个 accepted task 有可导出的 receipt；敏感内容脱敏。
- 状态：计划。

## P3：工程化、发布和持续维护

### EV-029 — CI 版本/发布链强化

- 模块：GitHub Actions。
- 当前问题：Release workflow 已有版本、测试、构建、资产上传，但签名和外部工具证据仍是可选。
- 依据：.github/workflows/release-desktop.yml。
- 对标参考：n8n SBOM/VEX、Renovate signed release commit。
- 改进方案：锁定 action SHA/Node/npm、生成 SBOM、发布 provenance、签名材料强制校验。
- 预期效果：发布资产更可审计。
- 文件：workflow、scripts、release docs。
- 难度：高；优先级：P3。
- 验收标准：Release 失败时不创建半成品；资产、校验、SBOM、签名 receipt 同步出现。
- 状态：部分完成。

### EV-030 — registry 独立的依赖审计脚本

- 模块：security/maintenance。
- 当前问题：当前会话的 npm audit 命中镜像 registry.npmmirror.com，返回 404，无法形成有效审计结论。
- 依据：2026-11-16 npm audit --package-lock-only --json 实际结果。
- 对标参考：Renovate datasource 和 CI 固定 registry。
- 改进方案：增加 npm run security:audit，显式使用官方 registry 或受控镜像，输出 PASS/BLOCKED receipt。
- 预期效果：区分 registry 不支持、网络失败和真实漏洞。
- 文件：package.json、scripts、docs。
- 难度：低；优先级：P3。
- 验收标准：官方 registry 成功时报告 advisory；镜像不支持时明确 BLOCKED，不返回 CLEAN。
- 状态：计划。

### EV-031 — 统一 API schema/contract 生成

- 模块：server + src/api.ts。
- 当前问题：103 个路由主要靠手写客户端类型，服务字段变更容易漂移。
- 依据：src/api.ts 手工类型与 server/index.mjs 路由分散。
- 对标参考：OpenAPI-first self-hosted tools。
- 改进方案：生成只读 OpenAPI/JSON schema，CI 检查响应字段兼容。
- 预期效果：减少桌面/服务字段不一致。
- 文件：API schema、scripts、src/api.ts。
- 难度：高；优先级：P3。
- 验收标准：关键 route 有 schema；兼容变更通过，破坏变更被 CI 拒绝。
- 状态：计划。

### EV-032 — 浏览器/桌面冒烟矩阵

- 模块：Playwright/Electron tests。
- 当前问题：已有大量脚本，但真实安装版、十语言、更新和 UIA 组合矩阵仍受环境限制。
- 依据：tests/*.mjs、docs/*TEST_REPORT.md。
- 对标参考：OpenHands Playwright/Vitest、Electron release smoke。
- 改进方案：将 web dev、Electron unpacked、安装版、zh/en、缩放、更新状态纳入可重复矩阵。
- 预期效果：减少只在 source/fixture 中通过的假绿。
- 文件：tests、workflow、docs/evidence。
- 难度：高；优先级：P3。
- 验收标准：每个矩阵项有 PASS/PARTIAL/BLOCKED receipt 和截图/日志路径。
- 状态：部分完成。

### EV-033 — Windows 长时间 soak 与资源回归

- 模块：桌面服务/Autonomy ticker。
- 当前问题：已有短时 soak，24 小时真实运行未完成。
- 依据：tests/autonomy-soak.mjs、docs/AUTONOMY_V2_LIMITATIONS.md。
- 对标参考：OpenHands/OpenCode background sessions。
- 改进方案：记录内存、队列、句柄、SQLite/JSON 增长、崩溃重启和更新事件。
- 预期效果：发现长期资源泄漏和重复调度。
- 文件：soak test、metrics、docs。
- 难度：高；优先级：P3。
- 验收标准：至少 24h 运行，无未解释增长；重启后状态可恢复。
- 状态：计划，当前环境未执行。

### EV-034 — 备份恢复与迁移演练

- 模块：state/autonomy DB。
- 当前问题：已有迁移和备份代码，但跨版本恢复演练证据不完整。
- 依据：state-store.mjs、data/migrations/*、docs/STATE_MIGRATIONS.md。
- 对标参考：durable workflow systems。
- 改进方案：每个 schema 版本用 disposable fixture 做迁移、损坏恢复和回滚演练。
- 预期效果：升级不损失项目、任务和审计数据。
- 文件：migration tests、docs/evidence。
- 难度：中；优先级：P3。
- 验收标准：v1-v4 fixture 可迁移；坏 JSON 被拒绝且保留原文件/备份。
- 状态：部分完成。

### EV-035 — 十语言 key parity 和运行时缺失监控

- 模块：i18n。
- 当前问题：字典规模大，新增页面容易只补英文；本轮审计还发现 17 个既有硬编码 UI 字符串。
- 依据：scripts/i18n-deep-audit.mjs、i18n-coverage.mjs、src/locales/*。
- 对标参考：Continue/OpenHands 多表面配置文案管理。
- 改进方案：保持 key parity CI、覆盖率、运行时 missing key telemetry 和 reduced motion 文案。
- 预期效果：避免生产 UI 显示 key path。
- 文件：scripts、locales、workflow。
- 难度：中；优先级：P3。
- 验收标准：新增 key 必须在十语言有 fallback/翻译；硬编码字符串全部翻译化或登记为产品名/技术名；审计输出零缺失或明确例外。
- 状态：基线已有，需持续执行。

### EV-036 — 性能预算与发布门禁

- 模块：Vite/Electron runtime。
- 当前问题：本轮已消除此前的大入口 chunk warning，但启动/内存指标未进入发布门禁。
- 依据：本轮前构建日志约 685 kB 入口 chunk 警告；本轮构建入口约 369 kB，App/Workstation 独立分块。
- 对标参考：桌面 AI 工具的 cold-start/heap 预算。
- 改进方案：建立 chunk、冷启动、首屏、内存和页面切换阈值，超阈值只阻止 release 不阻止开发。
- 预期效果：性能退化可见且可回归。
- 文件：build script、desktop-perf、workflow、docs。
- 难度：中；优先级：P3。
- 验收标准：每版保存基线与当前数字；超过预算有明确失败原因。
- 状态：部分完成，lazy split 已完成，预算门禁未完成。


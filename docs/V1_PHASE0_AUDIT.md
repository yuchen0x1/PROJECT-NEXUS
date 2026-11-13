# PROJECT NEXUS v1.0 — PHASE 0 全面审计报告

> 此文件为本次任务开始前已有的历史审计，保留原记录。下文“源码干净”和“4 个并行代理”描述的是原审计时点，不代表本次执行方式或当前工作区状态。本次实际变更与验证以 V1_DELIVERY_REPORT.md、V1_TEST_REPORT.md 及 docs/evidence/ 为准。

审计日期：2026-11-13
审计基线：`main` @ `ae54646`（v0.3.0），工作区源码干净（未跟踪文件仅为历史构建产物）
审计方式：4 个并行审计代理完整阅读 desktop/、server/、src/、tests/ 全部源码 + 本报告综合
判定标准：PASS / PARTIAL / BLOCKED / NOT IMPLEMENTED / NOT TESTED

---

## 一、当前真实能力盘点

### 1.1 桌面壳层（Electron）

| 能力 | 判定 | 证据 |
|---|---|---|
| 窗口生命周期（创建/加载/关闭到托盘/单实例/窗口状态持久化） | PASS | desktop/main.mjs:436-454, 467-473, 500-505, 165-188 |
| 安全基线（contextIsolation/nodeIntegration:false/sandbox:true + 服务端 CSP 头） | PASS | desktop/main.mjs:446-453; server/index.mjs:927-931 |
| Preload IPC（13 个白名单通道，isTrustedFrame 门禁，无 push 通道） | PASS | desktop/preload.cjs:5-19; desktop/main.mjs:190-201 |
| 托盘后台运行（关闭窗口→隐藏到托盘，子服务继续运行） | PASS | desktop/main.mjs:467-473, 485-498 |
| 开机自启动 | PARTIAL | main.mjs:537 setLoginItemSettings 未带 `--hidden`，开机启动会弹窗而非静默托盘 |
| 子服务崩溃自动恢复 | NOT IMPLEMENTED | main.mjs:155-161 仅弹错误框，无 respawn |
| 托盘暂停/停止调度控制 | NOT IMPLEMENTED | 托盘菜单仅 Open/Exit（main.mjs:492-496） |
| 应用自身自动更新（electron-updater） | NOT IMPLEMENTED | 无依赖、无 publish 配置（package.json:80 `publish: null`） |
| 代码签名 / 深链协议注册 | NOT IMPLEMENTED | 无 signing/protocols 配置 |
| 主进程异常兜底（uncaughtException 等） | NOT IMPLEMENTED | 无任何顶层异常处理器 |

### 1.2 服务端（Node.js）

| 能力 | 判定 | 证据 |
|---|---|---|
| HTTP API（47 条路由，角色门禁 + 审计） | PASS | server/index.mjs:953-1806 |
| AI Provider 层（5 种 provider、重试/退避/超时、模型路由、成本核算、密钥 DPAPI+内存态） | PASS | ai-provider.mjs:227-261; provider-store.mjs:200-212 |
| Agent 引擎多轮工具循环（34 工具、预算控制 40 迭代/600k token/25min、修复循环、独立审查） | PASS | agent/runtime.mjs:169-634; agent/tools.mjs |
| 工具权限与审批门禁（low/medium/high、supervised/standard/workspace-auto、模型不可自批） | PASS | agent/approval.mjs; runtime.mjs:263-330 |
| Git Worktree 隔离 + 非 Git 快照隔离（baseline sha256、.gitignore 引擎、symlink 拒绝） | PASS | agent/workspace-worktree.mjs; local-agent-workspace.mjs |
| 命令执行安全（shell:false、元字符拒绝、凭据环境剥离、树杀） | PASS | agent/executor.mjs:30-215 |
| 任务持久化（9 态状态机、原子写、事件流） | PASS | local-agent-tasks.mjs:10-189 |
| 崩溃恢复（Running→Interrupted 检测） | PARTIAL | 检测存在（local-agent-tasks.mjs:161-167）但**无任何恢复执行路径**，`Interrupted→Queued` 是死代码；会话/计划状态不保留 |
| GitHub 连接（PAT/GITHUB_TOKEN、GitHub App JWT、Installation Token） | PASS | index.mjs:136-221 |
| GitHub 读操作（仓库列表/contents/Actions/Releases/PR 列表） | PASS | index.mjs:376-397, 1585-1642, 1767-1780 |
| GitHub 写操作（draft release/PATCH/publish/资产上传/PR 创建，双重门禁） | PARTIAL | index.mjs:1491-1500, 1696-1765；无版本号管理，资产上传受 1MB JSON 限制 |
| **Issue 操作（读/评论/关闭/标签）** | **NOT IMPLEMENTED** | 全库 grep `/issues` 零命中 —— 这是 v1.0 自主运维闭环的最大缺口 |
| Webhook 接收（HMAC 验证 + delivery 去重 + 持久化） | PARTIAL | index.mjs:1284-1300, 351-358；但处理只盖章 lastWebhookAt，**无事件驱动自动化** |
| 定时轮询调度 | PARTIAL | 仅 60s tick 的集成扫描调度（index.mjs:1857-1859），间隔 6-720h；**无 Issue/仓库状态轮询、无 15m/30m/1h/2h 粒度** |
| 单仓库任务锁 | PARTIAL | 集成 job 有内存锁（agent-workspace.mjs:105-107）；本地 agent 队列**全局单 worker 串行**（index.mjs:618-633），无按仓库并行，无持久化锁 |
| 审批等待阻塞整个队列 | BUG | 单 worker 内轮询 10 分钟（runtime.mjs:271-291），一个 Paused 任务卡死全部后续任务 |
| `applyAgentTaskToProject` 接受 Paused 任务 | BUG | task-executor.mjs:211 —— 审批中任务可被套用 |
| 集成扫描入队/去重竞态 | BUG | index.mjs:713-726, 1290-1297 检查与写入非原子 |
| 工作区 GC（worktree/分支/apply-backup 清理） | NOT IMPLEMENTED | dispose 函数存在但无调用方，工作区无限累积 |
| 状态备份/轮转 | NOT IMPLEMENTED | 仅原子写，无备份副本；Installation Token 明文落盘（index.mjs:176-180） |
| 存储迁移（v1→v3 增量、fail-closed） | PASS | state-store.mjs:20-73 |

### 1.3 渲染层（React UI）

| 能力 | 判定 | 证据 |
|---|---|---|
| i18n（i18next、10 语言 × 14 命名空间 × 915 键完全对齐、无硬编码 CJK） | PASS | src/i18n/*; locales/ |
| 主题（dark/light/system、CSS 变量驱动、reduced-motion） | PASS | src/theme.css:55-138; i18n/settings.tsx:75-145 |
| 总览控制台 | EXISTS | Workstation.tsx:991-1096（工作台）+ App.tsx:143-152（remote Overview） |
| GitHub 连接入口 | PARTIAL | 真实 GitHub App 安装流存在（App.tsx:342）但深藏 remote 页；**总览横幅"Open setup"按钮无 onClick（死按钮）** App.tsx:146 |
| 仓库自主托管管理 | MISSING | 无托管策略/巡检/开关 UI |
| AI 配置向导 | PARTIAL | 手工表单 + 真实连接测试（Workstation.tsx:1680）但无分步向导 |
| 自动维护中心 | PARTIAL | 仅 AutoUpdate 页（App.tsx:191-202） |
| 安全与质量中心 | PARTIAL | SecurityCenter 仅 3 张静态卡（App.tsx:346-352） |
| 竞品研究中心 | MISSING | grep competitor/research/竞品 零命中 |
| 版本发布中心 | PARTIAL | Release Center 真实（App.tsx:171-189）但无版本号/资产 SHA256 全流程 |
| 任务中心 + 执行时间线 | PARTIAL | 本地任务有事件时间线/审批/diff（Workstation.tsx:1551-1561）；remote job 的 run.events 后端有数据但 UI 未渲染 |
| 首次使用向导（7 步） | MISSING | grep wizard/onboard 零命中 |
| UI 缺陷 | BUG | App.tsx:146 死按钮；App.tsx:157 分组筛选无 onClick；App.tsx:244 硬编码"verified 0"；App.tsx:115 硬编码头像"LN"；StatusPill 用翻译文本做英文状态匹配（多语言下降级）；App.tsx:91 搜索框每键全量刷新；Workstation.tsx:440/1679/1682 缺 catch 的 unhandled rejection |

### 1.4 测试 / 构建 / 工程

| 能力 | 判定 | 证据 |
|---|---|---|
| 单元测试（24 套件 / 124 测试，覆盖全部 services + agent 子系统） | PASS | tests/unit/* |
| Phase 6 验收（真实 AI 闭环：insights→runtime 任务→验证→审查→rollback/apply→隔离证人→取消场景） | PASS（对其覆盖范围） | tests/phase6-acceptance.mjs:95-378 |
| 桌面真机测试（Electron+CDP：smoke/agent UI/i18n/quality/安装包冒烟） | PASS | tests/desktop*.mjs |
| 规格书 A–I 验收矩阵覆盖 | PARTIAL | 已覆盖 C 的本地版/G/I/H(仅取消)；**A（真实 GitHub 连接验收）、C（Issue 闭环）、D（发布闭环）、E（竞品研究）无任何测试** |
| TypeScript 严格检查 | PASS | `npx tsc --noEmit` exit 0（server/desktop/tests 为无类型 JS） |
| ESLint | NOT IMPLEMENTED | 无配置无脚本 |
| CI（GitHub Actions）/ Dependabot | NOT IMPLEMENTED | 无 .github 目录 |
| 依赖锁定 | PARTIAL | 多数依赖 `"latest"`（不可复现构建），仅 electron/electron-builder/i18next/react-i18next/playwright 有版本 |
| 构建链（vite→dist、Express 托管、electron-builder NSIS x64） | PASS | vite.config.ts; package.json:53-90 |
| 文档准确性 | PARTIAL | README:59/92 两处陈述已被 Phase 6 推翻（旧文案未更新）；DEVELOPMENT.md 测试数字过时 |

---

## 二、v1.0 目标差距总表（按规格书 PART 对照）

| 规格 PART | 现状 | 差距定级 |
|---|---|---|
| PART 2.2 后台自治调度服务 | 托盘+关窗续跑已有 | 缺崩溃恢复/静默自启/暂停控制/服务独立性 → **PARTIAL** |
| PART 3 云端+按需工作区 | 本地项目 worktree 完整；远程仓库克隆按 job 一次性 | 缺托管仓库缓存复用/仓库元数据管理 → **PARTIAL** |
| PART 4 GitHub 监控 | webhook 壳子 + 扫描调度 | 缺 Issue 同步/分类/事件驱动触发 → **主要缺口** |
| PART 5 Issue→修复闭环 | 引擎完备，但**没有 Issue 输入端** | Issue 读取→修复→PR 全链路 → **主要缺口** |
| PART 6 安全质量治理 | 集成扫描 + sandbox 有基础 | 缺定期安全扫描编排/风险分级 → **PARTIAL** |
| PART 7 竞品研究 | 无 | **NOT IMPLEMENTED** |
| PART 8 全自动发布 | GitHub API 写通道 + 双门禁已有 | 缺版本号管理/changelog 生成/大资产上传 → **PARTIAL** |
| PART 9 Issue 回复与关闭 | 无 Issue API | **NOT IMPLEMENTED** |
| PART 10 24h 调度 | 全局串行队列 | 缺按仓库并行/持久化锁/优先级队列/恢复执行 → **主要缺口** |
| PART 11 环境检测 | local-environment.mjs 检测 6+ 工具 | 需扩展项目类型识别 → **PARTIAL** |
| PART 12 UI 重构 | i18n/主题达标；页面结构差距大 | 缺向导/托管/研究页 + 死按钮修复 → **主要缺口** |
| PART 13 三种策略 | approval policy 3 档已有 | 需映射到仓库托管策略 → **PARTIAL** |
| PART 14 可视化时间线 | 本地任务时间线已有 | 需托管任务全景时间线 → **PARTIAL** |
| PART 15 安全审计 | 密钥面较好 | 缺 installation token 加密/工具结果脱敏 → **PARTIAL** |
| PART 16 数据结构 | state.json 单存储原子写 | 需新增托管/巡检/研究实体 + 备份 → **PARTIAL** |
| PART 17 自我维护 | 引擎可作用于任意本地项目（含自身） | 需独立策略配置 → **PARTIAL** |
| PART 18 长期运行 | 日志轮转/超时/上限部分有 | 缺工作区 GC/资源阈值/健康检查 → **PARTIAL** |
| PART 20 A–I 验收 | I/G/局部 C/H 有 | A/C/D/E/F/H 大部分缺 → **主要缺口** |

## 三、审计结论与实施顺序

结论：**地基优秀，屋顶缺失。** Agent 引擎、安全隔离、provider 层、存储、测试文化、i18n 都达到 v1.0 要求的工程质量；缺失的是"自主运维平台"的上层闭环 —— GitHub Issue 输入端、事件驱动调度、按仓库自治、交付自动化、竞品研究、以及面向这些能力的全新 UI。

实施顺序（在现有架构上增量叠加，不推倒重写）：

1. **PHASE 1 仓库托管层**：扩展 state schema（v4：托管策略/仓库元数据/工作区状态），新增 `repo-workspace.mjs`（托管仓库缓存克隆 + worktree 复用）。
2. **PHASE 2 事件与监控**：新增 `github-issues.mjs`（Issue API 全套），扩展 webhook 处理器为事件驱动，新增 `hosting-scheduler.mjs`（15m–2h 分仓库轮询）。
3. **PHASE 3 Issue 修复闭环**：`issue-fix-pipeline.mjs` 接入现有 runtime（分析→worktree→修复→测试→审查→push→PR→评论→按策略关闭）。
4. **PHASE 4 安全质量**：定期巡检编排 + npm audit/code 扫描适配 + P0–P4 风险分级入库。
5. **PHASE 5 竞品研究**：`competitor-research.mjs`（GitHub Search + 真实源码读取 + AI 差距分析 + 许可证检查）。
6. **PHASE 6 交付自动化**：版本号管理 + changelog 生成 + 流式资产上传（绕开 1MB JSON）+ 发布前检查清单。
7. **PHASE 7 调度强化**：按仓库并行 + 持久化任务锁 + 优先级队列 + Interrupted 恢复执行 + 修复 5 个已知 BUG（审批阻塞/Paused 可 apply/入队竞态/GC/服务崩溃恢复）。
8. **PHASE 8 UI**：新导航（总览/GitHub/托管/维护/安全/研究/发布/任务/设置）+ 7 步向导 + 修复 UI BUG + 全量 10 语言翻译。
9. **PHASE 9 验收**：规格书 A–I 真实验收 + 全量回归 + 安装包 + 交付报告。

## 四、已知阻塞项

- 规格书测试 A/C/D/E 需要真实 GitHub 凭据与测试仓库：环境 `GITHUB_TOKEN` 已验证具备 repo 读 + release 写权限（v0.2.1/v0.3.0 资产发布成功），Issue 写权限待实测 → 不构成完全阻塞，实测后按结果更新。
- AI 凭据：pikaqiu 网关已验证（gpt-6-luna 连通 2026-11-13）。
- 代码签名证书：无 → 安装包保持无签名，交付报告中如实标注。

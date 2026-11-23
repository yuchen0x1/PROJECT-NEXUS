# PROJECT NEXUS v2.0.0 发布后生产级验收

**验收日期：** 2026-11-23（Asia/Shanghai）
**验收分支：** `codex/post-release-acceptance`
**验收范围：** 已公开的 `v2.0.0`，不把模拟、fixture、导航可达性或静态资产检查当作业务端到端证据。

## 1. 真实发布状态

| 项目 | 真实结果 |
| --- | --- |
| GitHub 默认分支 | `main` → `57afa79cbd332b5311a6d061705b39ee5e9762be` |
| 稳定 Tag | `v2.0.0`（annotated tag `e614fb385ebce6e72680cdd7bb0602b071f89183`），解析到提交 `5190e48884b1aa245d9b28fc62b59d27b8898605` |
| GitHub Release | [v2.0.0](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v2.0.0)，Release ID `454870510`，已发布（非 draft、非 prerelease） |
| 版本信号 | `package.json` 与 `package-lock.json` 均为 `2.0.0`；Electron `45.3.4`；electron-builder `26.18.0` |
| 合并链 | PR #21（`feat/2.0-nine-centers`）经 CI 后合并；PR #22 发布文档经 CI 后合并；随后 `sync-release-readme` 生成 `57afa79` |
| Release 工作流 | `Release Windows desktop` run `45090322135` 成功；`CI` run `45089957475` 成功；README 同步 runs 成功 |
| 本地工作区 | 本报告及回归修复均在独立分支提交；不覆盖 `main`、不强制推送 |

### 公开资产核验

GitHub API 返回的资产与公开下载再次核对，摘要均为 SHA-256：

| 资产 | 大小 | SHA-256 | 签名/状态 |
| --- | ---: | --- | --- |
| `PROJECT-NEXUS-2.0.0-win-x64-setup.exe` | 122,909,622 B | `cdb495bf8e33e5440a3eb359a55392ead6a2b515489cdba3203f0e6326d13513` | `NotSigned` |
| `PROJECT-NEXUS-2.0.0-win-x64-setup.exe.blockmap` | 129,575 B | `33d869f61f694f03adead8f42bd7ced4d372716c4be4e43f45d5b02ddb3e10f4` | uploaded |
| `latest.yml` | 371 B | `621fafff8867ccdceed553e0871b4f419b0015487b2f77fd32fef71f17c7cc9c` | uploaded |
| `SHA256SUMS.txt` | 104 B | `f4636cd9c22494711f91160aecf0963bdcb88ded1d9d344881255b3382b974e3` | uploaded |

安装包已下载并与 `latest.yml`、blockmap、`SHA256SUMS.txt` 及 GitHub API `digest` 一致。摘要只证明字节一致性，不证明签名、安装、升级或回滚。

## 2. 验收状态矩阵

状态含义：**PASS** 只覆盖表中写明的真实范围；**FAIL** 表示实际命令发现缺陷或环境失败；**BLOCKED** 表示安全策略、权限或外部凭据阻止执行；**NOT TESTED** 表示当前没有声称验证。

| 能力 | 状态 | 真实证据与边界 |
| --- | --- | --- |
| Electron 启动、渲染、关闭测试进程 | **PASS** | `npm run test:desktop`、`npm run test:desktop:quality` 在真实 Electron 45.3.4 上通过；测试进程关闭不等同于所有托盘/崩溃退出路径均已验证 |
| Electron 优雅退出、托盘与窗口恢复 | **NOT TESTED** | 没有把测试进程终止当作完整生命周期验收 |
| 本地服务启动、loopback/API 边界 | **PASS** | 桌面 smoke、真实 `/api/settings` 与 preload/API 保护通过 |
| 服务异常退出后的自动恢复 | **NOT TESTED** | 24 小时运行和进程故障注入尚未完成 |
| SQLite 读写、迁移、ETag 游标持久化 | **PASS** | `npm test` 的 store/monitor 回归；只读 live acceptance 显示 backend `sqlite`、两次扫描、6 个 ETag 游标 |
| 数据备份、损坏恢复、跨版本还原 | **NOT TESTED** | 尚未在独立安装目录执行备份恢复演练 |
| GitHub 身份验证与只读 API | **PASS** | `node tests/autonomy-live-github.mjs` 的 7 个真实 REST 端点均返回 200；凭据值未写入证据 |
| GitHub 仓库扫描 | **PASS（有界）** | 真实仓库 6 类资源、ETag 304、事件去重通过；完整 13 类资源矩阵未声称完成 |
| GitHub 写入、分支、PR、合并 | **BLOCKED** | 生产 autonomy API 明确返回 `403 AUTONOMY_READ_ONLY`；没有批准的测试仓库和一次性写入授权，不绕过该边界 |
| AI Provider 真实连通性与模型调用 | **BLOCKED** | 当前没有可用于本次验收的 AI Provider 凭据/模型配置 |
| Agent 任务执行、代码修改、Diff | **NOT TESTED（真实 AI）** | 本地单元/fixture 只验证边界和任务包，不能替代真实模型驱动修改 |
| Worktree 隔离与敏感文件保护 | **PASS（单元/fixture）** | workspace、路径、敏感文件和任务包测试通过；真实 AI 任务未运行 |
| AI 驱动的测试执行与失败恢复 | **BLOCKED** | 受 AI 凭据、远程写只读策略和测试仓库缺失共同阻塞 |
| Release 构建与公开发布 | **PASS（GitHub workflow）** | run `45090322135` 真实生成并上传四项资产；本地 `npm run desktop:package:win` 曾因外部 `public-ip` 下载超时而失败，不能宣称本地打包通过 |
| 自动更新 manifest、blockmap、摘要一致性 | **PASS（资产级）** | 公开下载与 API digest 一致；没有把资产检查描述成安装升级 E2E |
| 全新安装、配置保存、数据持久化 | **NOT TESTED** | 只下载/检查安装包，未在 disposable Windows 安装目录运行安装器 |
| 旧版升级、更新中断、失败恢复、回滚、卸载重装 | **NOT TESTED** | 没有旧版安装、签名更新或恢复演练 |
| 安全策略、敏感文件与依赖 | **PASS（已执行范围）** | `npm audit --package-lock-only --ignore-scripts` 0 vulnerabilities；`exposure_scan.py dist --profile web` 100/A；Gitleaks 的 33 条启发式结果均为 fixture/placeholder/evidence，未确认 live secret |
| Trivy/CodeQL/Semgrep 深度扫描 | **BLOCKED** | Trivy 漏洞库下载超时；CodeQL/Semgrep 安装通过 `winget` 失败，未伪造扫描通过 |
| 调度去重、并发门控、取消/重试单元行为 | **PASS（单元）** | `npm run check` 内含 autonomy、queue、hosting、durability 回归 |
| 网络中断、API 限流、Provider 超时、数据库异常 | **NOT TESTED（长时）** | 仅有短路 fixture/单元覆盖，未完成生产级故障注入矩阵 |
| 24 小时持续运行与调度器重启 | **NOT TESTED** | 浸泡脚本已保留并可重复运行，但本次被只读安全边界提前阻塞 |

## 3. 实际执行命令

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **PASS** — 78 个测试文件、524 个测试，typecheck、lint、build 全部通过 |
| `npm run i18n:coverage` | **PASS** — 10 个 locale 均为 100% |
| `npm run i18n:audit` | **FAIL（既有缺口）** — locale 资源 `problems: 0`，但命令因 17 个硬编码 UI 字符串退出 1；扫描器另报告 4 组 CSS 颜色 |
| `npm run test:desktop:centers` | **PASS** — 9 中心、21 叶子、命令面板、主题、语言与真实 Settings API |
| `npm run test:desktop` | **PASS** — Electron 启动、preload/API 保护、更新桥接、设置持久化 |
| `npm run test:desktop:quality` | **PASS** — 损坏设置恢复、非法语言、150% 缩放、布局、通知、持久化 |
| `npm run test:desktop:perf` | **PASS** — 冷启动 979 ms、Projects→Workbench 65 ms、语言切换 144/45 ms、renderer heap 10/15 MB、394 DOM nodes |
| `node tests/autonomy-live-github.mjs` | **PASS 9/9（只读）** — 真实 GitHub GET 与真实 Windows UI Automation 发现；本次发现 ChatGPT Desktop 1 个窗口，WorkBuddy 未运行但不影响只读探测；没有远程写入 |
| `npm audit --package-lock-only --registry=https://registry.npmjs.org --ignore-scripts` | **PASS** — 0 vulnerabilities |
| `npm run test:autonomy:soak` | **BLOCKED** — 生产 API 返回 `403 AUTONOMY_READ_ONLY`；修复后的脚本写入 `status: BLOCKED` 报告并返回退出码 2，不再误报 FAIL |

## 4. 本轮实际修复

1. `tests/desktop-quality.mjs` 的损坏设置回归断言原本只等待 `.nx-page-heading h1`；真实恢复路径先渲染 onboarding/remote 内容，导致测试误报超时。断言现等待真实可见的 heading 或 `.nx-remote-content`，并已通过 `npm run test:desktop:quality`。
2. `tests/autonomy-soak.mjs` 现在识别生产安全边界 `AUTONOMY_READ_ONLY`，生成可机器读取的 `BLOCKED` 证据并返回退出码 2；没有放宽 API、角色或远程写门禁。
3. `CHANGELOG.md` 与 v2.0.0 发布说明改为反映真实公开 Release，并明确 `i18n:audit` 的非零退出与安装/升级未验证范围。

## 5. GitHub 治理审计

已读取现有配置，未覆盖有效规则：

- `main` 分支保护：要求 PR；严格要求 `Windows checks`；启用管理员强制执行；强制解决对话；禁止 force push 和删除；当前要求审批数为 **0**，因此没有人工 reviewer 门槛。
- 稳定 Tag ruleset `Protect stable release tags`（ID `27867414`）处于 active，保护 `refs/tags/v*` 的创建、更新和删除；仓库 owner 是显式 bypass actor，属于残余高权限风险。
- Actions 默认 workflow 权限为 read；SHA pinning 已启用，现有 workflow action 均钉到 commit SHA；允许动作来源仍为 `all`，需持续依赖 SHA pinning 与 PR 审查。
- Dependabot security updates、secret scanning、push protection 已启用；非 provider secret scanning 与 validity checks 未启用。
- Repository secrets/variables 当前为 0；仅存在 `windows-release-verification` 环境。`windows-release-signing`、`windows-release-publication` 及签名 secrets/证书均不存在，因此不能声称已配置签名发布隔离。
- GitHub immutable releases 当前为 disabled；v2.0.0 已通过工作流发布，但后续应在管理员确认后启用不可变 Release 策略。

## 6. 2.1.0 优先级路线

路线只来自当前缺口与已提交的竞品研究（`docs/COMPETITOR_RESEARCH.md`、`docs/PHASE4_RESEARCH.md`）；只作设计参考，不复制第三方代码。研究过 OpenHands（MIT）、SWE-agent（MIT）、Cline（Apache-2.0）、Roo Code（Apache-2.0，已归档）、Continue（Apache-2.0、上游已声明 read-only）、Aider（Apache-2.0）、Open Interpreter（Apache-2.0）和 Gemini CLI（Apache-2.0）。任何未来复用必须重新核对具体 blob、LICENSE、NOTICE 和依赖义务。

### P0 — 安全、数据丢失、任务执行错误

- 引入真实用户身份/会话与 action-specific intent；在未完成前保持 `AUTONOMY_READ_ONLY`，不把进程级 role 当作多用户授权。
- 为 SQLite/state.json 建立备份、校验、迁移失败恢复和可演练的 restore 流程，补齐损坏数据库与跨版本回滚证据。
- 建立签名发布链：`windows-release-signing` / `windows-release-publication` 环境、证书指纹校验、不可变 Release，并在 disposable Windows 机验证签名更新。
- 固化敏感文件/密钥扫描为 CI 门禁，处理 i18n audit 的真实硬编码 UI 缺口，不通过调低扫描门槛“修复”。

### P1 — 核心功能不可用、自动化流程中断

- 提供专用测试仓库与短期凭据隔离，执行真实 AI provider → 任务 → worktree → diff → test → PR → CI → 失败恢复闭环；默认仍禁止生产仓库写入。
- 把任务事件、checkpoint、取消、重试、服务重启恢复持久化，避免当前 in-process worker 只能标记 interrupted。
- 补齐 Windows x64 全新安装、旧版升级、更新中断、回滚、卸载/重装和用户数据保留的自动化 VM 测试。
- 将发布前的本地 `public-ip` 外部下载依赖改为可重试、可镜像或预取的确定性构建输入。

### P2 — 性能、稳定性、使用体验

- 实施 24 小时及更长 soak：多任务并发、网络/Provider/API 限流、数据库异常、调度器重启，并记录 RSS/句柄/队列延迟趋势。
- 将队列锁和调度状态从单进程扩展为可协调的持久 worker/租约，补跨进程并发测试。
- 解决 `i18n:audit` 的 17 个硬编码字符串与 CSS token 报告，统一 Autonomy/desktop 标签与主题变量。

### P3 — 新功能与 UI 优化

- 在已通过 P0/P1 后再评估更多 Provider、任务模板、批量审查和更新 UX；新功能必须携带回归、权限和回滚证据。
- 优化九中心信息架构，但不把导航可达性当作底层业务完成度。

## 7. 仍需用户提供

- 已批准的专用测试仓库（非生产仓库）、最小权限 GitHub token 或 GitHub App 安装，以及允许创建临时分支/PR 的窗口；测试完成后应撤销。
- AI Provider 的临时测试凭据、模型与 endpoint；凭据只通过本机安全配置注入，不写入报告、日志或仓库。
- Windows x64 disposable VM、旧版 `v0.9.x` 安装包和可清理的数据目录，用于安装/升级/回滚验收。
- Authenticode 证书、私钥密码和证书 SHA-256 指纹，以及管理员批准的两个 GitHub Actions environment 保护规则。
- 若要启用真实远程 autonomy 写入，必须先完成 per-user auth、action intent、审计和回滚设计；本报告不建议临时关闭 `AUTONOMY_READ_ONLY`。

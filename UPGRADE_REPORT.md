# UPGRADE_REPORT

## 2026-11-21 · 首轮交付：Windows 发行完整性

**候选状态：已在 Windows 本地构建并验证，未合并、未推送 tag、未创建 Release。** 基线 `origin/main` 是 `464f75b`。已有 [PR #15](https://github.com/yuchen0x1/PROJECT-NEXUS/pull/15) 是此前的凭据脱敏修复，不是本轮交付。

| 项目 | 本轮结果 |
| --- | --- |
| 现状与故障 | [v0.9.4](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.4) 已公开但无 Windows 资产；[发行工作流](https://github.com/yuchen0x1/PROJECT-NEXUS/actions/runs/44571127933) 在检查公开重名版本时终止。没有改动该 Release。 |
| 实现 | 分离无发布权限的 Windows 构建与特权发布；支持 PR 构建和仅验证；正式路径要求主分支 dispatch、tag、可信签名；对账草稿、四项远端资产和 tag 后再报告完成。修复 Electron 测试尚未等到 renderer 就检查标题的问题。 |
| 性能、UI | 未做产品性能或 UI 改造，未报告性能收益。实测 Electron 主窗口、带鉴权的 preload、更新设置、中文切换和浅色；保留[实际截图](docs/evidence/2026-11-21-windows-settings.png)。 |
| 研究 | 阅读 Temporal、Windmill、Prefect 的指定提交与活动记录；本轮采用构建和发布分权，不引入运行时依赖。见 [研究记录](docs/RESEARCH_LOG.md)。 |
| 关键文件 | `.github/workflows/release-desktop.yml`、`scripts/publish-desktop-release.mjs`、`tests/unit/desktop-release.test.mjs`、`tests/desktop.smoke.mjs`、版本与 [Release 管理](docs/RELEASE_MANAGEMENT.md)。 |
| 测试 | 锁文件安装、TypeScript、ESLint、Vite 生产构建、`vitest --maxWorkers 2`：最终 75 个文件、442 个用例通过（含转入 Latest 的复核回归）。初次默认并发有 3 个测试超时；以 CI 并发复跑通过。YAML、Actions SHA 和七段 PowerShell 解析通过。 |
| Windows | Windows 11 / Node 26.13.1。官方直连下载超时后，用 npm 锁定 Electron 发行包的 SHA-256 验证镜像下载，成功构建 x64 NSIS。`desktop:verify-update` 和 `sha256sum -c` 通过；Windows `win-unpacked` 原生冒烟通过。未在用户主机安装或覆盖现有应用。 |
| 调度与稳定性 | 90.05 秒 Windows Electron 隔离 fixture 运行：3 个协作工作流、27 次本地模拟模型请求、2 次资源采样，错误为 0，测试原始项目和应用快照匹配。短测终态 `PARTIAL`，`continuous24hVerified: false`；回执在工作树 `test-results/soak/2026-11-21T11-43-43-433Z/status.json`。首轮 24 小时运行 `2026-11-21T11-50-15-563Z` 的进程以 `0x40010004` 退出（原因未确认）；最后回执停在 23 分 02 秒、24 次采样、1 个工作流、应用错误 0，`Running` 是中断前的旧状态，不是仍在运行。确认旧进程退出后已从新隔离目录重跑 `2026-11-21T13-30-49-951Z`，仍未取得 24 小时验收。fixture 不代表真实外部 AI 服务或签名安装升级。 |
| 本地候选摘要 | `PROJECT-NEXUS-0.9.5-win-x64-setup.exe`，122969134 字节，SHA-256 `53b394505318a280a5898659cedef03657b36a8e668e66578cecaa5402845b89`。只对应本轮**未签名**本地产物，不是公开发布资产。 |
| 安全检查 | npm 官方 advisory：全依赖和仅运行依赖均为 0。镜像 registry 不支持 audit，已用官方 endpoint 重试。没有 Docker daemon、签名升级/回滚或其他认证级扫描证据。 |
| 独立审查 | 首审发现 tag-push 信任边界、tag 并发变化和签名配置空缺；复审要求独立核对 GitHub Release 与 Latest 频道。已实施并通过最终独立聚焦复核，未发现剩余关键代码阻塞；仓库侧保护和签名仍未配置。 |
| 发布门禁 | 仓库未配置签名环境、签名秘密或证书指纹；默认分支及发行 tag 保护缺失，immutable releases 关闭；候选未在 GitHub 运行，也无旧版签名升级和回滚证据。新 Release 版本和 URL 均无。 |

### 独立候选与恢复顺序

- `fix/verified-desktop-release` 保留 v0.9.5 候选及发行证据。原工作区保留原分支且无用户改动被覆盖。
- `fix/guarded-autonomy-routing` (`2fbfae8`)：恢复总览所需的十项读取，保留角色、会话及只读门禁，界面隐藏不可用操作。Windows 75 个测试文件、437 项通过，TypeScript、ESLint、生产构建、独立复核及 Chromium 回归通过。Chromium 使用合成记录，通过真实侧栏导航验证显示和刷新，未发出写请求；该工作树保留 `test-results/autonomy-browser/` 截图。内置浏览器手动导航曾超时，不计作通过。
- `fix/github-write-guard` (`bff3431`)：五条旧 GitHub 写入在发送前重查开关；发布要求 Administrator 和显式确认，编辑和上传仅限草稿。Windows 464 项本地测试通过，独立复审的 40 项 API 测试通过；夹具没有写真实 GitHub。
- `fix/provider-credential-lifecycle` (`d13a508`)：凭据绑定使用摘要，阻止旧凭据在改址后复用，并能撤销最后一个密钥。Windows 75 个测试文件、457 项通过；独立复核 63 项通过，源码启动的 Electron 本地夹具通过。旧版未绑定密钥须重新录入；未运行已安装包或真实远端模型。
- `fix/startup-state-ownership` (`668303d`)：恢复前取得状态所有权并先验证监听；拒绝活跃进程重入。Windows 74 个测试文件、442 项通过；关闭 SQLite 的 19 项启动/持久化测试通过，独立复核通过。范围仅为启动所有权；不宣称优雅停机或 Compose 无人值守重启，实际 Compose 未验收。
- 未合并上面四个本地分支至 v0.9.5。组合试算显示 Autonomy 与 GitHub 写入门禁在 `server/index.mjs` 重叠，GitHub 与 Provider 在 `docs/SECURITY.md` 重叠；按顺序分别解决并复验，不将各分支本地结果当成组合后的证据。
- 以 [发布管理](docs/RELEASE_MANAGEMENT.md) 配置可信签名和保护规则，运行无发布的签名验证；在隔离 Windows 环境验证旧版安装升级、状态保留和失败恢复，取得真实 GitHub CI 后再履行合并及发布门禁。继续检查 24 小时运行的最终回执，不把短测、重跑中或外部中断视为通过。

---

下文为 2026-11-16 的历史交付。

- 交付日期：2026-11-16（Asia/Shanghai）
- 项目：PROJECT NEXUS
- 基线：main / v0.9.2
- 本轮目标：完成真实项目扫描、至少 15 个开源项目对标、形成 30+ 项升级清单、实施当前环境可验证的高价值修复、运行质量门禁并记录阻塞项。

## A. 竞品研究

### 研究数量

本轮研究了 16 个相关开源项目：

1. Cline
2. Continue
3. OpenHands
4. OpenCode
5. Aider
6. mini-SWE-agent
7. SWE-agent
8. Tabby
9. Dify
10. Open WebUI
11. GPT Pilot
12. n8n
13. Renovate
14. Roo Code
15. Gemini CLI
16. Open Interpreter

每个项目至少检查了官方仓库/README/目录或架构说明；重点项目还检查了许可证、近期提交/发布和 issue/PR 元数据。研究只提取设计与实现模式，没有复制外部代码。完整对标见 [COMPETITOR_ANALYSIS.md](COMPETITOR_ANALYSIS.md)。

### 最值得借鉴的方案

- Cline：同一 agent core 覆盖桌面、IDE、CLI、SDK，适合参考多入口与 checkpoint。
- OpenHands：Agent Server/Canvas/ACP 的控制面与后端分离，适合参考多后端工作区。
- OpenCode：后台子代理、Windows process daemon、MCP 事件和权限模式。
- Aider：repo-map、git undo、lint/test loop 的轻量上下文策略。
- mini-SWE-agent：极简工具协议、每次动作独立 subprocess 和可替换 sandbox。
- n8n：可视化 workflow、人审、RBAC/audit 和运行记录。
- Renovate：更新分组、置信度、跨平台 PR 和供应链安全资产。

### 许可证结论

MIT/Apache-2.0 项目适合借鉴概念并重新实现；Dify、Open WebUI、n8n、GPT Pilot 和 Renovate 的许可证包含额外条件或 copyleft 义务，未直接引入其代码。许可证必须在真正集成时按当前 commit 再审查。

## B. 升级数量与状态

总计划：36 项。

| 状态 | 数量 | 编号 |
| --- | ---: | --- |
| 本轮完成 | 9 | EV-001–EV-005、EV-007–EV-009、EV-018 |
| 基线已有并保留 | 13 | EV-010–EV-014、EV-019–EV-025、EV-035 |
| 部分完成 | 5 | EV-015、EV-029、EV-032、EV-034、EV-036 |
| 计划/外部阻塞 | 9 | EV-006、EV-016–EV-017、EV-026–EV-028、EV-030–EV-031、EV-033 |

“本轮完成”均有代码或配置差异；“基线已有”不重复虚报为本轮新增；“部分/阻塞”保留真实原因。

## C. 本轮代码和配置变更

### 修改文件

- [server/index.mjs](server/index.mjs)
  - 接入 request ID、安全响应头、API rate limit、API 404、全局错误边界。
  - 设置 Node request/header/keep-alive timeout。
  - settings API 增加 token/App/installation 分层状态。
- [server/services/competitor-research.mjs](server/services/competitor-research.mjs)
  - 默认研究候选从 5 调整为 15。
  - 增加并发池 3。
  - 限制 AI synthesis prompt 总长度和单候选摘要预算。
- [server/services/http-hardening.mjs](server/services/http-hardening.mjs)
  - 新增请求 ID、headers、fixed-window limiter、404/error contract。
- [src/main.tsx](src/main.tsx)
  - Web 与 Electron 入口改为 lazy + Suspense。
- [src/styles.css](src/styles.css)
  - 增加首屏加载状态样式。
- [src/api.ts](src/api.ts)
  - 同步 settings API 新字段类型。
- [.env.example](.env.example)
  - 增加 NEXUS_API_RATE_LIMIT 配置。
- [tests/unit/http-hardening.test.mjs](tests/unit/http-hardening.test.mjs)
  - 新增 HTTP hardening 单元测试。
- [tests/unit/competitor-research.test.mjs](tests/unit/competitor-research.test.mjs)
  - 增加 15 候选/并发约束断言。

### 新增文档

- [PROJECT_AUDIT.md](PROJECT_AUDIT.md)
- [COMPETITOR_ANALYSIS.md](COMPETITOR_ANALYSIS.md)
- [UPGRADE_ROADMAP.md](UPGRADE_ROADMAP.md)
- [UPGRADE_REPORT.md](UPGRADE_REPORT.md)

### 删除/迁移

- 未删除用户文件、项目数据、配置或历史报告。
- 未修改 data/state.json；未执行数据库迁移。
- 本报告生成时尚未提交、推送、创建 PR、发布或部署；后续已将本轮变更整理为 v0.9.3 并发布。

## D. 测试结果

### 本轮已运行

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| npm run typecheck | PASS | tsc --noEmit 退出码 0 |
| npm run lint | PASS | eslint --max-warnings=0 退出码 0 |
| npm test / vitest | PASS | 74 个测试文件、422 个测试通过 |
| npm run build | PASS | Vite 生产构建成功 |
| HTTP hardening + competitor focused tests | PASS | 2 个文件、12 个测试通过 |
| loopback API smoke | PASS | 实际启动 Express：health 200、request ID/安全头生效、未知 API 404、缺 token 401 |
| npm run i18n:coverage | PASS | 十语言覆盖率均为 100% |
| npm run i18n:audit | FAIL/PARTIAL | 结构性问题 0，但扫描到 17 个既有硬编码 UI 字符串和 5 类 CSS 颜色，脚本按现有规则退出 1；本轮未伪装成通过 |
| npm audit --package-lock-only --json | BLOCKED | 当前 npm registry 为 registry.npmmirror.com，该端点返回 404 NOT_IMPLEMENTED；没有据此声称依赖安全 |
| 真实 GitHub 写入/AI 生成/签名更新 | BLOCKED | 本轮没有凭据、授权或签名安装环境，未执行外部写入 |
| 真实 24 小时 Windows soak | NOT RUN | 本轮未占用长时间桌面会话 |
| Docker 严格隔离 | BLOCKED | 现有文档记录当前 Docker engine/严格宿主条件未满足 |

### 构建观察

本轮入口 lazy split 已接入并通过 build。当前构建产物显示 index-BP-yjHWI.js 约 369 kB，App 与 Workstation 分别约 157 kB/160 kB，未再出现此前约 685 kB 入口的 500 kB chunk warning。冷启动、内存和页面切换数字仍需后续性能预算任务记录；构建警告不能被当成失败，也不能只靠调大 warning threshold 解决。

## E. 项目变化

### 升级前

- 产品功能广度已经较高，包含自主运维、Agent runtime、GitHub 交付、更新、安全扫描和多语言桌面界面。
- 竞品研究默认只深读 5 个候选。
- API 缺少统一 request ID、rate limit、未知 API 404 和全局安全错误契约。
- Web/Electron 入口静态加载，构建有较大的入口 chunk 警告。
- 设置 API 不能区分 PAT、GitHub App 和 installation。
- 发布签名、原生更新回滚、多用户身份和严格 Windows 隔离仍未闭环。

### 升级后

- 默认竞品研究覆盖 15 个候选，深读并发固定为 3，AI prompt 有 120,000 字符上限。
- API 具备统一 request ID、安全 headers、no-store、rate limit、Retry-After、404 和安全错误体。
- Node HTTP server 有显式请求、headers 和 keep-alive timeout。
- Web/Electron 入口按运行表面 lazy load，首屏有可见 loading fallback。
- 设置诊断区分 tokenConfigured、appConfigured 和 installation 数量。
- 新增 9 个本轮完成项的单元验证；已有能力和未完成外部条件仍按真实状态保留。

### 仍然不够的地方

- 未完成 Authenticode 签名、安装备份、启动健康检查和回滚。
- 未完成真实多用户身份、严格 Windows 隔离宿主和 24 小时 soak。
- 外部安全工具和 npm advisory audit 仍依赖可用工具与 registry。
- 15 候选研究的 UI 分页、来源快照哈希和 benchmark receipt 仍是下一批升级。
- 未做真实 GitHub/AI 远程写入；不能把 fixture 或代码存在性当成生产闭环。

## F. 下一阶段执行顺序

1. 先完成 EV-006/EV-014/EV-015：签名、更新事务和外部安全工具。
2. 再完成 EV-016/EV-017：严格宿主和真实身份边界。
3. 完成 EV-026–EV-028：研究 provenance、15 候选审阅和 Agent benchmark receipt。
4. 建立 EV-030–EV-036 的 release/performance/soak 门禁。


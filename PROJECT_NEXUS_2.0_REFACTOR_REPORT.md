# PROJECT NEXUS 2.0 重构验收报告

日期：2026-11-22 · 基线：`c9ea0e1`（v0.9.5 快照）· 目标版本：2.0.0 · 状态：**发布前历史快照**

> 本文记录的是 2026-11-22 的发布前验收，保留当时的阻塞与证据，不代表当前远程状态。v2.0.0 已于 2026-11-23 发布；当前 GitHub、安装包和发布后生产级验收以 [`docs/POST_RELEASE_ACCEPTANCE_V2.0.0.md`](docs/POST_RELEASE_ACCEPTANCE_V2.0.0.md) 为准。

本报告只记录实际发生的事：每一项都标注了验证方式（命令、测试或浏览器实测），以及没有验证的部分。没有为了完成清单而虚构的条目。

## 1. 原有架构问题

重构前实测确认的问题（不是来自旧文档）：

| 问题 | 证据 | 2.0 处理 |
| --- | --- | --- |
| 21 个页面平铺在一条导航里，Web 侧边栏、Electron ActivityBar、命令面板各自维护一份列表 | 旧 `src/App.tsx` 与 `src/desktop/Workstation.tsx` 各有独立数组 | 单一注册表 `src/nav/centers.ts`（9 中心 / 21 叶子），三个界面共用 |
| Hosting 检查无准入控制：手动 + 计划可对同一仓库并发执行两次 GitHub 遍历 | 旧 `runHostingInspection` 直接调用 | 按仓库准入表 `withHostingInspectionAdmission`；冲突返回 409 `HOSTING_INSPECTION_IN_PROGRESS` |
| 扫描队列可被手动/计划/恢复三条路径叠加 | 旧 `pendingScans` 数组 + 多入口 | 进程级共享泵（去重 job id、合并并发批次） |
| 全量检查入队后不启动扫描泵 | 旧代码 `void runScanQueue(...)` 缺失 | 已修复：入队即启动 |
| Autonomy 启动时有分离的 `tickNow()` + 间隔 ticker 两个 tick 来源 | 旧 `server/index.mjs` 启动块 | `startAutonomyTicker(..., { immediate: true })` 唯一所有者 |
| AI 提供商响应体无上限读入内存 | 旧 `invokeAIProvider` 直接 `response.text()` | 请求 512 KiB / 响应 2 MiB 硬上限，超限不重试 |
| 模型返回的文件操作直接进工作区 | 旧 `generateIntegrationOperations` 只有基础路径检查 | 30 项上限、字段白名单、去重、敏感路径拒绝、256 KiB/文件、NUL 与密钥内容拒绝 |
| `allowScripts` 钉 `electron@45.3.1`，实际依赖 45.3.4，postinstall 被跳过 | `node_modules/electron/dist` 为空 | 修正为 `electron@45.3.4` |

## 2. 21 个旧页面的去向

全部保留，无一删除。叶子标识不变，历史导航事件、通知跳转与深链继续有效。

| 中心 | 叶子（= 旧页面） |
| --- | --- |
| Dashboard 总览控制台 | Overview、Monitoring |
| Repository Center 仓库中心 | Projects、Repository Scanner、Issues |
| AI Autopilot AI 自主运维 | Autonomy、AI Operations、Hosting |
| Development Center 开发与工作流 | Build Center、AI Pipeline |
| Security Center 安全与质量 | Security Center、Security Findings、Update Security |
| Research Center 智能研究 | Research |
| Release Center 发布与交付 | Release Center、Auto Update |
| Task Center 任务与日志 | Task Center、Integration History |
| Settings 系统设置 | Settings、GitHub Connections、Adapter Center |

不变量测试：`tests/unit/navigation-registry.test.ts`（9 中心、21 唯一叶子、默认叶子归属、`isRemotePage` 合约）。

## 3. 九个中心的实际功能

- **总览控制台**：12 项真实指标（仓库数来自 GitHub 同步）、项目面板、活动流、任务条。截图 `docs/evidence/dashboard-01-overview.png`。
- **仓库中心**：项目列表 + 真实分组过滤（实测 37 → 13 → 37）、仓库扫描器、Issue 跟踪。截图 `repositories-02-projects.png`。
- **AI 自主运维**：Autonomy 运行时真实状态（截图确认 sqlite 后端、观察模式、并发上限 2、只读横幅）、AI Operations、托管。截图 `autopilot-03-autonomy.png`。
- **开发与工作流**：构建中心（真实 workflow 列表与派发门禁）、AI 流水线。截图 `development-04-build.png`。
- **安全与质量**：安全中心、安全发现、更新安全。截图 `security-05-center.png`。
- **智能研究**：竞品研究（真实 GitHub Search + 报告持久化 + 升级提案审阅）。截图 `research-06-research.png`。
- **发布与交付**：发布中心（草稿/发布门禁）、自动更新。截图 `release-07-center.png`。
- **任务与日志**：任务中心、集成历史。截图 `task-08-center.png`。
- **系统设置**：GitHub 连接状态、真实 AI 提供商/任务运行面板（读 `/api/settings`）、外观与 10 语言。截图 `settings-09-server.png`。

## 4. 真正完成的业务整合

- **导航整合 + 数据整合**：九中心全部由同一注册表驱动，Web 与桌面共用；叶子即旧页面，无 shim。
- **调度收口**（真实代码修复，非导航改名）：
  - Hosting 检查按仓库单飞（409 + `inspectionToken`）；
  - 扫描队列单泵；
  - Autonomy tick 单所有者；
  - 全量检查真正启动入队扫描。
- **AI 输出边界**：传输大小硬上限 + 操作白名单验证，写入工作区前拒绝密钥/二进制内容。
- **设置页真实数据**：AI 提供商状态、模型、端点、并发上限、通知开关来自 `/api/settings`，含加载/错误/重试三态（截图确认“未配置/default/—/—/3/关”与服务端一致）。

## 5. 仅完成导航整合的模块（如实记录）

- **仓库中心**：Projects、Scanner、Issues 共用一个中心，但三者的数据仍是各自 API；没有合并成单一“仓库工作流”。这是现状，不是完成态。
- **安全中心**：Security Center / Findings / Update Security 是三个入口的聚合，底层各自扫描与存储；没有统一风险评分。
- **任务中心**：Task Center 读任务表，Integration History 读集成作业，HostedTimeline 读托管作业——三类来源在同一中心可见，但状态模型没有统一。
- **发布中心**：见第 8 节。

## 6. 重复调度问题的处理结果

| 路径 | 修复 | 验证 |
| --- | --- | --- |
| Hosting 手动 vs 计划 | `withHostingInspectionAdmission`（`server/index.mjs:1369`），计划路径 `:1402` 与手动路由 `:2429` 共用 | 代码审查 + 现有单元测试（hosting.test.mjs 74 项中含并发用例） |
| 扫描泵 | `scanQueuePending`/`scanQueueActive`/`scanQueuePump` 单泵 | `npm run check` 通过 |
| Autonomy tick | `startAutonomyTicker` 唯一所有者（`server/index.mjs:3626`），`api.mjs:427` 内部有 `running` 重入锁 | 代码审查 |
| Autonomy 任务重复触发 | `idempotencyKey`（`engine.mjs:157`）+ `canAdmit` REPO_WRITE_LOCK / CLIENT_BUSY（`engine.mjs:233`） | 现有 autonomy 测试套件 |

## 7. 安全改进

- AI 请求/响应体 512 KiB / 2 MiB 上限，超限码 `AI_REQUEST_TOO_LARGE` / `AI_RESPONSE_TOO_LARGE` 不重试（`server/services/ai-provider.mjs`）。
- 集成操作进入工作区前白名单校验；`redactSecrets(content) !== content` 即拒绝。
- 每仓库 hosting 准入防止重复 GitHub 消耗（限流保护）。
- 权限零提升：observe/repair/autonomous 模式、审批卡、远程写开关、角色检查全部未动。
- `allowScripts` 版本钉死修正（45.3.1 → 45.3.4），恢复供应链完整性。

## 8. 发布状态的明确区分（未合并业务）

- **用户托管仓库的 GitHub Release**：Release Center + Autonomy 交付门禁。默认全关：远程写、`autoRelease`、`autonomous` 模式、发布批准全部需要显式开启 + 9 项门禁。2.0 未改任何门禁逻辑。
- **PROJECT NEXUS 自身应用更新**：独立通道（`electron-updater` + `latest.yml`），桌面端开发/冒烟会话强制 `phase: 'disabled'`。2.0 未改。
- 两者仍是两条链路；2.0 只是把它们放进不同中心（Release Center vs 系统设置的应用更新区），没有做业务合并。**如实记录：发布中心是导航整合，不是业务整合。**

## 9. UI 改造

- 9 中心两级导航（Web + Electron + 命令面板）。
- Web 顶栏主题切换按钮；设置页外观面板（深/浅/跟随系统 + 10 语言）。
- 设置页 AI 与任务运行真实面板。
- 修复：
  - Projects 分组 chips 无事件处理 → 真实过滤 + `aria-pressed` + 计数联动（浏览器实测 37→13→37）。
  - RendererErrorBoundary 硬编码中文 → 中英双语（跟随 `document.documentElement.lang`）+ 主题变量，i18n 崩溃时仍可用。
  - toast 关闭按钮 `aria-label="关闭提示"` → `common:aria.dismissError`。
  - 英文界面底部设置入口与 Settings 中心重名 → 底部入口改名 “App settings”（10 语言新增 `navigation:rail.appSettings`）。
  - 七处页面轮询加 `visibilityState !== 'hidden'` 门控（窗口隐藏时不再发请求）。

## 10. 性能改进

- 窗口隐藏时 7 个页面级轮询全部停止（原来 3.5–7 秒一次持续打 API）。
- Hosting 检查单飞消除重复 GitHub 调用（间接降低限流退避）。
- AI 响应有界读取避免大响应占满内存。
- 无基准对比数据（未做性能测试，不声称具体百分比）。

## 11. 测试结果（真实执行记录）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（多轮，最后一次含全部 2.0 修改） |
| `npm run lint` | 通过（--max-warnings=0） |
| `npm test` | 78 文件 / 524 测试通过 |
| `npm run build` | 通过 |
| `npm run check`（全链） | 通过（2.0 修改后复跑见第 14 节） |
| `npm run i18n:coverage` | 10 语言 100% |
| `npm run i18n:audit` | 0 problems（17 个既有硬编码字符串为历史遗留，非本轮引入） |
| `tests/unit/navigation-registry.test.ts` | 3 项通过 |
| `npm run test:desktop:centers` | **通过**（真实 Electron 45.3.4，4 项 PASS，见下） |

浏览器实测（IAB，127.0.0.1:5173，真实 dev server + 真实 API）：
- 9 中心全部可展开、leaf 全部可达、页面切换正常。
- Projects 分组过滤真实生效。
- 主题深 → 浅 → 深（`data-theme` 断言）。
- 语言 zh-CN → en-US → zh-CN（`html lang` 断言），英文界面无残留中文导航。
- Settings AI 面板中英文文案与数据均正确。

## 12. 尚未完成的工作

- 仓库/安全/任务中心的数据层合并（第 5 节）。
- 旧页面轮询合并为中心级单一刷新通道（本轮只做了可见性门控）。
- i18n 审计报告中的 17 个既有硬编码字符串与 4 个 CSS 颜色发现（历史遗留，未在本轮处理）。

## 13. 环境阻塞

| 阻塞 | 影响 |
| --- | --- |
| **无 Git 远程**（`git remote -v` 为空） | 无法推送、无法创建远程 Tag、无法 GitHub Release。不是权限问题，是根本没有配置远程。 |
| **无签名证书** | 无法生成 Authenticode 签名安装包。 |
| **Electron 45.3.4 二进制下载一度受阻**（GitHub 直连多次中断，最终经 npmmirror 镜像完成安装） | 已解决；解决前 `test:desktop:centers` 无法执行。`allowScripts` 版本钉死错误（45.3.1 vs 45.3.4）是根因之一，已修复。 |
| **无真实 AI 提供商凭据** | Settings 显示”未配置”即真实状态；AI 链路仅经单元测试（mock fetch）验证。 |

## 14. 发布前真实状态（历史快照）

- **本地候选已就绪**：代码、测试、文档、版本号。
- **未推送** / **未合并** / **未打 Tag** / **未创建 GitHub Release** / **未生成安装包 SHA256**——全部因第 13 节阻塞，未伪造任何一项。
- 版本升级为 2.0.0 后，`npm run check` 与桌面验收的最终结果记录于下方“最终验证”小节。

## 最终验证（第二轮收口实测）

> 本小节全部为真实命令输出，执行于 2026-11-22 22:25 前后。

1. **`npm run check`（完整链）**：通过 —— typecheck ✓、lint（--max-warnings=0）✓、**78 个测试文件 / 524 项测试全部通过**、build ✓。
2. **`npm run test:desktop:centers`（真实 Electron，扩展版 7 项断言）**：通过。Electron 二进制经 `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js` 安装成功（`node_modules/electron/package.json` = **45.3.4**，与依赖声明一致）。全部 PASS：
   - `PASS: The Electron ActivityBar renders exactly the nine 2.0 centers in registry order.`
   - `PASS: Every center expands to its complete legacy leaf set and opens on its default leaf.`
   - `PASS: All 21 legacy page identifiers are reachable through their correct center/leaf controls.`（21 个叶子逐一点击验证）
   - `PASS: Center leaf switching and sidebar collapse/expand work.`（侧栏收起/展开）
   - `PASS: Ctrl+K searches for and navigates directly to a legacy leaf.`（命令面板直达叶子）
   - `PASS: Desktop settings language and dark/light theme controls update the document.`（zh-CN/en-US 往返 + light/dark 往返，断言 `documentElement.lang` 与 `data-theme`）
   - `PASS: Settings center loads real AI/task runtime status from the local API.`（真实 `/api/settings` 数据）
   桌面截图：`docs/evidence/desktop-10-electron-security-center.png`、`docs/evidence/desktop-11-electron-settings.png`。
3. **浏览器实测**（IAB，`127.0.0.1:5173`，真实 dev server + 真实 API）：
   - Projects 分组过滤：点击 "Desktop software" → 计数 37 → 13，`aria-pressed="true"`，卡片全部属于该分组；点 "全部" 恢复 37。
   - 主题往返：`切换主题` → `data-theme: light` → 再切 → `dark`。
   - 语言往返：zh-CN → en-US（`document.documentElement.lang = "en-US"`，导航全部英文化，AI 面板英文文案正确）→ zh-CN 恢复。
   - 9 个中心截图 + 3 张桌面截图，共 12 张，存 `docs/evidence/`。

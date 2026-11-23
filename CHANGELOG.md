# 更新日志

完整的功能变化、开发阶段状态和已知限制以 [发布记录](docs/releases/release-notes.md)为准。版本从新到旧排列，日期统一为 Asia/Shanghai。

| 版本 | 日期 | 更新主题 | 分发状态 |
| --- | --- | --- | --- |
| v2.0.0 | 2026-11-22 | [9 中心导航重构、重复调度收口与 AI 输出边界](#v200--2026-11-22) | [已正式发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v2.0.0)（Windows x64 安装包、blockmap、`latest.yml` 与 SHA256 清单已上传；未签名） |
| v0.9.5 | 2026-11-21 | [Windows 桌面发布完整性修复](docs/releases/v0.9.5.md) | 候选，尚未公开发布 |
| v0.9.4 | 2026-11-19 | 修复桌面 loopback 启动白屏 | [源码 Release](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.4)，没有 Windows 资产 |
| v0.9.3 | 2026-11-16 | 项目自主演进与 API 稳定性升级 | [已正式发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.3)（Windows x64 安装包、更新 feed、blockmap 与 SHA256 清单已上传） |
| v0.9.2 | 2026-11-16 | 验证后草稿 PR 交付与桌面体验修复 | [已正式发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.2)（Windows x64 安装包、更新 feed、blockmap 与 SHA256 清单已上传） |
| v0.9.1 | 2026-11-15 | 第二阶段闭环能力与真实诊断 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.1)（Windows 安装包与校验资产由 GitHub Actions 生成，详见 [v0.9.1 说明](docs/releases/v0.9.1.md)） |
| v0.9.0 | 2026-11-15 | 24/7 自主运维运行时与桌面 AI 客户端接入 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.9.0)（含 Windows 安装包与校验资产，详见 [v0.9.0 说明](docs/releases/v0.9.0.md)） |
| v0.8.9 | 2026-11-15 | ZIP 基线三方比较与 Agent 适配器 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.9) |
| v0.8.8 | 2026-11-15 | 本机 Codex 桥接与仓库来源档案 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.8) |
| v0.8.7 | 2026-11-14 | 一键下载开发环境 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.7) |
| v0.8.6 | 2026-11-14 | 首次启动自动教学 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.6) |
| v0.8.5 | 2026-11-13 | 仓库同步校准与定时刷新 | 本地开发预览，未公开发布 |
| v0.8.4 | 2026-11-13 | 归档仓库筛选与状态标记 | 本地开发预览，未公开发布 |
| v0.8.3 | 2026-11-13 | 更新栏布局与应用内日志 | 本地开发预览，未公开发布 |
| v0.8.2 | 2026-11-13 | 应用自动更新 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.2) |
| v0.8.1 | 2026-11-13 | 自动更新源码预览 | 仅源码标签，无安装包 |
| v0.8.0 | 2026-11-13 | 新图标与协作维护 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.0) |
| v0.7.0 | 2026-11-13 | 项目总览与批量托管 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.7.0) |
| v0.6.0 | 2026-11-13 | 多仓库批量托管 | 本地阶段，未单独发布 |
| v0.5.1 | 2026-11-13 | 获取并选择模型 | 本地阶段，未单独发布 |
| v0.5.0 | 2026-11-13 | 一键教学与平铺导航 | 本地阶段，未单独发布 |
| v0.4.0 | 2026-11-13 | 按序升级预览 | 本地阶段，未单独发布 |
| v0.3.0 | 2026-11-13 | 自主开发引擎 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.3.0) |
| v0.2.1 | 2026-11-13 | 桌面体验与十语言支持 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.2.1) |
| v0.2.0 | 2026-11-13 | 桌面界面与国际化基础 | 本地阶段，未单独发布 |
| v0.1.0 | 2026-11-13 | Windows 桌面与本地 Agent | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.1.0) |

已发布版本的独立说明均位于 `docs/releases/vX.Y.Z.md`，包含更新内容、下载与校验、验证记录和已知限制。历史安装包与标签保留，不以本地候选摘要替代公开资产摘要。


## v2.0.0 · 2026-11-23

正式版本已合并到 `main`，Tag `v2.0.0` 与 GitHub Release 已公开；Windows 安装包由发布工作流生成，并以真实 SHA256 发布。当前仓库未配置 Authenticode 证书，安装包按未签名构建标注。发布后的生产级验收见 [验收报告](docs/POST_RELEASE_ACCEPTANCE_V2.0.0.md)。

### 导航与界面

- 21 个平铺页面收拢为 9 个功能中心（总览控制台、仓库中心、AI 自主运维、开发与工作流、安全与质量、智能研究、发布与交付、任务与日志、系统设置），每个叶子保留原页面、API、权限与数据。
- 单一注册表 `src/nav/centers.ts` 同时驱动 Web 侧边栏、Electron ActivityBar 与命令面板；新增 9 中心 / 21 叶子不变量测试。
- 设置页新增真实 AI 提供商状态、默认模型、API 端点、并发任务上限与通知开关面板（读取 `/api/settings`，含加载、错误与重试状态）。
- Web 顶部栏新增主题切换；设置页外观面板提供深色 / 浅色 / 跟随系统与 10 种界面语言。
- 修复 Projects 分组筛选按钮无事件处理的问题：分组点击真实过滤列表（含计数联动与 `aria-pressed`）。
- 桌面错误边界不再硬编码中文：跟随界面语言显示中/英文，并使用主题变量。
- 提示框关闭按钮的 `aria-label` 改用 i18n（原为硬编码中文）。
- 英文界面底部「应用设置」入口与 Settings 中心重名的问题：底部入口改为 "App settings"（10 语言同步）。
- 所有新增文案同步写入 10 种语言，翻译覆盖率保持 100%。

### 并发与调度

- 托管检查改为按仓库准入：计划与手动检查共享同一在途状态，重复请求返回 HTTP 409 `HOSTING_INSPECTION_IN_PROGRESS`，不再重复遍历 GitHub。
- 扫描队列合并为进程级单一泵，去重任务 id 并合并并发批次；全量检查现在会真正启动其入队扫描。
- 自动运维启动只保留一个 tick 所有者（`startAutonomyTicker` 的 immediate 首帧），移除分离的 `tickNow()`。
- 页面级轮询（任务中心、集成历史、托管、Issue、流水线等 7 处）在窗口隐藏时暂停，回到前台自动恢复。

### 安全与可靠性

- AI 提供商请求/响应体分别限制为 512 KiB / 2 MiB，超限在解析前拒绝且不重试。
- 集成 AI 返回的文件操作在进入工作区前严格校验：最多 30 项、字段白名单、路径规范化与去重、拒绝敏感路径、单文件 ≤256 KiB、拒绝 NUL 与疑似密钥内容。
- `allowScripts` 的 Electron 版本钉死从 45.3.1 修正为实际依赖 45.3.4。

### 验证

- `npm run check`：78 个测试文件 / 524 项测试通过，typecheck、lint 与构建通过。
- `npm run i18n:coverage` 十语言 100%；`npm run i18n:audit` 的资源结构问题为 0，但命令仍因 17 个硬编码 UI 字符串而退出 1，详见 [验收报告](docs/POST_RELEASE_ACCEPTANCE_V2.0.0.md)。
- `npm run test:desktop:centers`：真实 Electron 45.3.4（经 npmmirror 镜像安装）中，7 项断言全部通过——9 中心顺序、叶子集与默认叶、全部 21 个叶子逐一可达、侧栏收起/展开、命令面板直达叶子、语言与深浅主题真实切换、Settings 读取真实本地 API 数据。

### 已知限制

- 真实 GitHub 写操作、真实 AI 提供商调用与 24 小时浸泡未验证。
- 未配置 Authenticode 证书时，安装包与解包后的可执行文件均为未签名构建；签名状态不作伪造或推断。
- 原生安装、跨版本升级与回滚仍需在独立 Windows 环境中单独验收。


## 本地演进记录 · 2026-11-16（已纳入 v0.9.3）

- 完成 API 请求追踪、安全响应头、单进程速率保护、结构化 API 404/错误边界和 HTTP 超时。
- 竞品研究默认覆盖 15 个候选，使用并发池和 prompt 预算；Web/Electron 入口改为按需加载。
- 新增 PROJECT_AUDIT.md、COMPETITOR_ANALYSIS.md、UPGRADE_ROADMAP.md、UPGRADE_REPORT.md。
- 本记录属于当前工作树的本地演进，已纳入 v0.9.3 发布内容。

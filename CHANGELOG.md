# 更新日志

完整的功能变化、开发阶段状态和已知限制以 [发布记录](docs/releases/release-notes.md)为准。版本从新到旧排列，日期统一为 Asia/Shanghai。

| 版本 | 日期 | 更新主题 | 分发状态 |
| --- | --- | --- | --- |
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


## 本地演进记录 · 2026-11-16（已纳入 v0.9.3）

- 完成 API 请求追踪、安全响应头、单进程速率保护、结构化 API 404/错误边界和 HTTP 超时。
- 竞品研究默认覆盖 15 个候选，使用并发池和 prompt 预算；Web/Electron 入口改为按需加载。
- 新增 PROJECT_AUDIT.md、COMPETITOR_ANALYSIS.md、UPGRADE_ROADMAP.md、UPGRADE_REPORT.md。
- 本记录属于当前工作树的本地演进，已纳入 v0.9.3 发布内容。

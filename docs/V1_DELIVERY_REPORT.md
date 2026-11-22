> Archived 0.3.0 evidence. Current upgrade: [0.4.0 report](ORDERED_UPGRADE_REPORT.md).

# PROJECT NEXUS v1.0 目标交付报告

日期：2026-11-13（Asia/Shanghai）。基线：main / ae54646 / 0.3.0。开始前已有大量未提交 v1.0 实现与历史安装产物，全部保留。

**总体：PARTIAL。核心真实交付闭环已通过，v1.0 全部目标尚未完成。软件仍为 0.3.0，未发布 v1.0 稳定版。**

## 1. 架构报告

见 [架构](V1_ARCHITECTURE.md)。沿用现有引擎、工作区适配器、Provider 和 JSON 存储，没有安装数据库或大型运行环境。

## 2. 功能清单

| 范围 | 状态 | 边界 |
| --- | --- | --- |
| 托管、按需缓存、Worktree | PASS / PARTIAL | 单仓库真实闭环通过；大规模并发未测 |
| Issue 分类、真实修改、回归、审查 | PASS | 真实 gpt-6-luna 与测试仓库 |
| PR、合并、Release、回复、关闭 | PASS / PARTIAL | Node 无依赖项目通过；非 npm 自动发布未实现 |
| 队列持久化、优先级、仓库串行 | PASS / PARTIAL | 单元/本地集成覆盖；无跨进程租约 |
| 安全扫描和失败门禁 | PASS / PARTIAL | 不是完整 SAST 或系统沙箱 |
| 竞品源码、Issue/PR、许可证证据 | PASS | 自动实施提案未实现 |
| 引导、凭据、十语言、主题 | PASS / PARTIAL | 真实窗口、切换、重启恢复；全向导业务路径还需扩展 |
| 24h、Windows 真重启、资源阈值 | NOT TESTED / PARTIAL | 不以短测替代长期证据 |

额外修复：翻译缺键、无效凭据读取接口、损坏密钥库覆盖风险、缺失独立审查仍算成功、错误交付证据字段、未合并发布和隐式关闭条件、上传失败仍发布、Issue 游标遗漏、同仓库新 Issue 被拒而非排队、Git 代理丢失、短期 Token 落盘/备份、GitHub 原始文本解析与研究来源选择。

## 3. 测试报告

见 [测试报告](V1_TEST_REPORT.md)，真实回执和工具输出在 `docs/evidence/`。

## 4. 安全审计报告

见 [安全报告](V1_SECURITY_AUDIT.md)。未签名、本机原生命令权限、开发依赖中危与未执行检查均单列，不将 SHA256 当作发布者认证。

## 5. GitHub 集成报告

真实账号 yuchen0x1。独立私有仓库 nexus-acceptance-20261113-1120 上创建 Bug，生成并合并 PR #2，发布 v0.1.1。资产 digest 与本地 SHA256 核对；回复后关闭 Issue。随后按用户要求删除仓库：DELETE 204，复查 404。未在正式仓库创建测试 Issue 或 Release。

## 6. AI Agent 执行报告

用户网关与 gpt-6-luna 实测 HTTP 200，应用连接测试及 DPAPI 重启恢复通过。真实修复 16 轮、12 次工具调用、0 次修复重试，真实测试 3 项通过，构建通过，独立审查 approve。详见 `evidence/v1-agent-runtime.json`。

## 7. 竞品研究报告

真实搜索，读取 OpenHands/OpenHands（MIT）和 cline/cline（Apache-2.0）的 README、源文件、提交、Issue/PR、Release、许可证。文件路径/blob SHA 见 `evidence/v1-research.json`。未复制竞品代码。研究模块新增源码证据、优先读取运行时代码、默认不认定许可证安全及对应回归测试。自动移植和提案实施仍未完成。

## 8. UI 改造报告

七步引导提供真实连接、错误、忙碌状态、步骤导航、焦点限制、Esc 关闭和远程写入授权。沿用 Segoe UI、深浅主题和现有 tokens；不替换原有桌面功能。修复设置入口和虚构头像，搜索防抖，新增托管任务时间线。截图位于 `screenshots/`。

## 9. 性能报告

单次真实 Electron 测量：冷启动可交互 1040ms、页面切换 59ms、首次德语 357ms、语言缓存切回 47ms、主题切换 41ms、Renderer JS heap 约 7MB、275 DOM 节点。入口约 522KB，有 chunk 大小提示。不是 24h 长期性能证据。

## 10. 已知限制

小型测试仓库闭环不代表任意业务项目都可完全自治。自动发布要求 npm 测试、匹配版本、一致合并树，缺依赖可能阻塞。Installation Token 仅保存在内存，重启重新获取。

## 未完成事项

- 竞品提案自动实施、自我维护独立策略。
- 跨进程锁、完整 ETag/退避/分页游标、精确交付自动核对恢复。
- 全语言/框架自动发布、签名安装包、完整发布事务。
- 多仓库/并发/故障注入和新向导全路径验收。
- Windows 真重启、24h 长期运行和完整资源阈值治理。
- 工作区自动清理目前要求明确清理回执，不因时间过期删除尚未应用的成果；清理审批界面仍待完成。
- ESLint 未安装；6 项打包依赖链中危尚未消除。

## 12. Windows 安装说明

见 [安装说明](V1_WINDOWS_INSTALL.md)，包括产物版本、大小、SHA256 和实际安装结果。

## 13. 使用说明

见 [README](../README.md#安装和首次使用)。使用明显引导入口，依次连接、配置、选择和启用；仅为可信仓库执行本机脚本。

## 14. README 与交付范围

README 已据实重写，历史 CHANGELOG 保留。本次工作在本地未提交、推送或发布；未覆盖既有未提交修改或用户数据。预览产物保留 0.3.0 版本，使用独立输出目录。

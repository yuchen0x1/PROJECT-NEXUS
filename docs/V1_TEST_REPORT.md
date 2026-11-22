> Archived 0.3.0 evidence. Current upgrade: [0.4.0 report](ORDERED_UPGRADE_REPORT.md).

# v1.0 增量验收报告 · 2026-11-13

所有 PASS 均有实际执行证据；单元/模拟服务测试与真实网络验收分列。

| 检查 | 结果 | 证据和边界 |
| --- | --- | --- |
| TypeScript | PASS | `npx tsc --noEmit`，exit 0 |
| Vitest | PASS | 35 文件 / 207 测试；含真实临时 Git 仓库与本地模拟 HTTP 边界，日志 `test-results/v1-tests.log` |
| 生产构建 | PASS | `npm run build`；入口约 522KB，有 chunk 大小提示 |
| 十语言键/覆盖 | PASS | i18n 审计无缺键，十语言 100% |
| 原生桌面冒烟 | PASS | BrowserWindow、受限 IPC、认证 API；直接 API 请求 401 |
| 桌面语言/主题/持久化 | PASS | 真实简中/日文/英文切换、主题切换、应用重启 |
| 桌面尺寸/DPI | PASS | 1280×720、1366×768、1600×900、150% 缩放 |
| 桌面性能 | PASS（单次测量） | 冷启动 1040ms、页面 59ms、JS heap 约 7MB；不是长稳验收 |
| gpt-6-luna 网关 | PASS | 实际 HTTP 200、pong；应用内连接测试约 9.4s |
| DPAPI 密钥恢复 | PASS | 保存后无明文 key；重启 Provider 仍 configured |
| GitHub 账号/权限 | PASS | 当前真实账号 yuchen0x1，私有测试仓库 push 权限 |
| 按需获取与原始保护 | PASS | 轻量巡检无仓库目录；修复 Worktree；原始 HEAD/源码保持一致 |
| 真实自动修复 | PASS | 原始测试失败；模型实际修改，3 个回归测试和构建成功，独立审查 approve |
| 真实交付闭环 | PASS | 推送、PR #2、合并、v0.1.1 Release、资产 SHA256、回复和关闭 Issue |
| 测试仓库清理 | PASS | 用户授权删除，DELETE 204、复查 404 |
| 真实竞品研究 | PASS / PARTIAL | 两个真实项目的源码与许可证；未自动移植功能 |
| 队列优先级/去重/恢复 | PASS（单元/本地） | 持久化、仓库排队与 Interrupted 不重放；不是多进程/多云实测 |
| 依赖审计 | PARTIAL | 官方 npm 审计执行成功，发现 6 项 moderate、0 high/critical；未消除 |
| ESLint | BLOCKED | 项目没有安装或配置 ESLint；未擅自新增工具 |
| 24h、Windows 真重启、多仓库全链路、全异常注入 | NOT TESTED | 不用短时间测试冒充通过 |

## 可复核回执

- `evidence/v1-live-acceptance.json`：真实流程断言、发布资产 digest、测试工作区路径。
- `evidence/v1-agent-runtime.json`：实际多轮、工具调用、命令结果、测试输出、审查。
- `evidence/v1-github-receipts.json`：仓库、PR、Diff、Release、Issue 和评论响应。
- `evidence/v1-test-repository-cleanup.json`：测试仓库删除回执。
- `evidence/v1-research.json`：真实搜索、源码路径与 SHA、许可证、Issue/PR 等。

测试仓库已删除，因此远程 URL 不再能访问；已保存的回执不是当前仍存在的在线资源。保留本地临时工作区便于复核，没有删除用户原始项目。

## 安装验收

见 [安装报告](V1_WINDOWS_INSTALL.md)。安装验收使用已打包应用和独立临时 LOCALAPPDATA；不会把源码开发窗口当作安装通过。

## 失败与纠正记录

基线有缺失翻译键。真实验收发现 Git 代理被隔离环境丢弃、Issue 列表存在索引延迟/游标风险；已修复后跑通。加强审查门禁后，两个旧测试未提供实际 reviewer 响应，已补充明确 approve 响应，并新增 malformed/request_changes 必须失败的测试。未弱化验证断言。

npmmirror 未实现安全审计端点，首次官方直连也失败；使用现有代理后成功获取官方结果。打包曾遇 Electron 下载超时，最终复用本机相同版本的已安装运行时。

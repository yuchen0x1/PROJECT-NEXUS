# 多仓库批量托管 · 0.6.0

仓库选择改为勾选列表，提供「全选」「全不选」、搜索和已选数量。全选与全不选始终作用于全部已同步仓库，搜索只过滤显示；自动刷新不会重新勾选用户已取消的仓库。没有选择时不能继续。

## 批量流程

- 后续策略设置、检查、开启托管及立即检查 Issue 均应用于全部所选仓库。统一选择策略与间隔，脚本授权明确覆盖全部所选可信仓库，未选仓库不写入。
- 每步显示逐仓库的等待、处理中、成功、失败及失败原因，同时最多处理两个仓库。某个仓库失败后继续处理其他仓库，不伪装整批成功。
- 失败后保留成功项，「重试未完成项」只处理失败或待处理项；仅全部成功才完成该步骤。部分开启成功时保留已开启仓库的真实状态，其余仓库可重试。
- 可以停止后续请求，当前请求结束后保留结果；窗口卸载也停止发起后续请求。当前设置会话内可继续未完成项，已成功的策略和托管状态由原服务逐仓库持久化。
- 检查凭证仍分别绑定各自仓库、策略和连接。批量耗时导致过期时，开启前刷新；启用失败后删除该仓库缓存凭证，重试时重新检查。没有放宽原权限与交付检查。
- 重复点击「立即检查 Issue」会重新读取所选全部仓库，汇总本次结果；完成后可查看已开启仓库清单，并进入托管、任务、Issue 与研究页面。

这次变更扩展设置向导的批量范围，后台继续沿用已有逐仓库调度和隔离任务。自动维护覆盖符合条件的 Issue 修复与授权交付；研究升级提案仍需审阅，不代表任意项目升级已实现全自动执行。

## 验证范围

完整流程使用独立数据目录与本地 HTTP fixture，覆盖全选、全不选、搜索、刷新不重选、统一策略、部分检查失败、真实后端凭证失效、部分开启失败、重试不重复成功项、未选仓库不变及批量 Issue 重复检查。未对用户真实仓库开启或执行维护任务。

| 检查 | 证据 |
| --- | --- |
| 类型检查与构建 | PASS · `npx tsc --noEmit`、`npm run build`，见 [TypeScript](evidence/batch-repositories-types.log)、[构建](evidence/batch-repositories-build.log) |
| 完整单元回归 | PARTIAL · 两次全量运行均为 43/44 文件、243/244 项通过；第一次 Git 缓存测试超过 5 秒时限，第二次任务存储压力测试超过 15 秒时限。对应功能断言均已在分开运行中通过，见 [第二次全量日志](evidence/batch-repositories-tests.log) 及 [任务存储复验](evidence/batch-repositories-task-store-recheck.log)（5/5 PASS） |
| 中英文批量桌面流程 | PASS · [中文](evidence/batch-repositories-ui-zh-CN.log)、[英文](evidence/batch-repositories-ui-en-US.log) |
| 单仓库兼容及检查失效回归 | PASS · [单仓库](evidence/batch-repositories-single-en-US.log)、[原有流程](evidence/batch-repositories-ordered-regression.log) |
| 安装后中英文批量流程 | PASS · [中文](evidence/batch-repositories-installed-zh-CN.log)、[英文](evidence/batch-repositories-installed-en-US.log)，含失败项重试和成功项不重复处理 |
| 真实仓库列表选择 | PASS · 26 个已同步仓库全部勾选、全部取消、刷新不重选，原状态文件哈希不变，使用不含凭据的临时元数据副本，见 [记录](evidence/batch-repositories-real-selection.json) 与 [截图](screenshots/batch-repositories/real-repository-list.png) |
| 安装包冒烟 | PASS · UI、API 认证、存储位置及解包的 Windows 命令执行器，见 [日志](evidence/batch-repositories-installed-smoke.log) |
| 安装及配置保留 | PASS · 安装退出码 0，安装后 ASAR 与构建产物哈希一致，7 个配置 JSON 哈希不变，见 [证据](evidence/batch-repositories-install.json) |

默认测试超时记录保留在 [首次全量检查](evidence/batch-repositories-tests-before-concurrency-limit.log) 和 [Git 单独复查](evidence/batch-repositories-git-recheck.log)。Git 测试文件在第二次全量运行中通过，任务存储文件随后单独通过。复验只调整 CLI 并发和运行时限，不修改测试断言；不将存在超时的单次全量运行写成全部通过。

命令：首次 `npm test`；第二次 `npm test -- --maxWorkers=2 --testTimeout=15000`；存储复验 `npx vitest run tests/unit/local-agent-tasks.test.mjs --maxWorkers=1 --testTimeout=60000`。批量流程验收使用 `node tests/guided-setup-desktop.mjs` 并设置 `NEXUS_GUIDE_BATCH=true`，安装后再设置 `NEXUS_GUIDE_INSTALLED_EXE`；真实列表选择使用 `node tests/batch-selection-installed.mjs`。

## 安装产物

- `release-batch-repositories/PROJECT-NEXUS-0.6.0-win-x64-setup.exe`，122118244 字节。
- SHA256：`3CE57784D658AEE13EE55D5874A6903981E2893908CF57EF317F4FD88A3181B7`
- 原 0.5.1 应用与用户数据备份：`C:\Users\lenmo\AppData\Local\PROJECT NEXUS Backups\20261113-143753-batch-repositories`。未恢复或覆盖用户配置。

本次不增加依赖、不修改存储结构。当前为本地预览，未提交、推送或公开发布，安装包未签名。

# 更新栏布局、日志与旧文件复核

日期：2026-11-13（Asia/Shanghai）。源码基线：`main` / `609aa4b`，开始时工作区干净。本次本地版本为 0.8.3。

## 问题与修改

桌面主栏原本只有顶栏、正文和底部日志三条网格轨道。更新栏作为额外子项插入后，占用了正文的弹性轨道，正文被排入后续自动轨道，导致截图中的文字重叠。旧界面测试只渲染更新组件，没有包含桌面外壳，因此没有捕获该问题。

现在主栏固定保留顶栏、更新区域、可滚动正文、底部日志四个位置。更新提示隐藏时对应区域高度为零；展开日志或换行时，正文继续获得剩余空间。更新卡片将图标、版本/状态和按钮分开排列，窄窗口将操作按钮排到下一行。

新增可展开的日志列表，内置本次版本与六个历史发布版本的十语言摘要；按数值版本降序排列，标记当前和可更新版本。新版说明通过现有固定更新源传递，作为有长度限制的纯文本呈现，缺失时明确提示。

更新说明字段采用已安装 electron-updater 的类型与 [v26 UpdateInfo 文档](https://www.electron.build/v26/docs/features/auto-update/)约定，兼容字符串和带版本号的说明列表。没有开放渲染层自定义源、安装器路径或任意外链导航。

## 验证

| 状态 | 命令 / 范围 | 结果 |
| --- | --- | --- |
| PASS | `npm run typecheck`、`npm run lint` | 类型和代码检查通过 |
| PASS | `npx vitest run tests/unit/app-updater.test.mjs tests/unit/i18n-resources.test.mjs tests/unit/i18n-keys.test.mjs` | 3 文件 / 19 项通过；覆盖日志类型、长度、日期与清理旧元数据 |
| PASS | `node tests/app-update-ui.mjs` | 完整桌面外壳、更新状态、键盘展开、数值排序、远端文本、980–1920 宽度及 100%/125%/150% 缩放通过 |
| PASS | `npm run build` | 生产构建通过，保留既有主包大小提示 |
| PASS | `node tests/desktop.smoke.mjs` | 实际 Electron 窗口、受信 IPC、设置页布局、离线日志和中文切换通过 |
| PASS | `npm run i18n:audit`、`npm run i18n:coverage` | 十语言资源覆盖 100%，没有缺键/占位符问题；既有 CPU 文本和颜色提示保留 |
| PASS | `npx electron-builder --win nsis --x64 --publish never --config.directories.output=release-v0.8.3` | Windows x64 NSIS 本地打包成功，未签名 |
| PASS | `node scripts/verify-desktop-update.mjs release-v0.8.3` | 安装包版本、大小、SHA512、blockmap 与更新源匹配 |
| PASS | 设置 `NEXUS_TEST_DESKTOP_EXECUTABLE` 指向本版打包 EXE 后运行 desktop smoke | 打包程序真实启动并通过同一组窗口检查；使用独立临时 profile |
| PASS | 本地产物检查 | [报告](../releases/v0.8.3-audit.md)；基线对比无新增或加重发现 |

完整回归：`npx vitest run --maxWorkers 1 --reporter verbose` 退出 0，**56 文件 / 299 项全部通过**，耗时 532.51 秒。

首次 `npm run check` 的默认并发测试出现既有任务持久化用例 5000 ms 超时，该轮未记作通过。保持原断言和原时限后，该用例单独运行 5 项通过，随后完成上述单 worker 全量回归。类型、lint 与生产构建也已分别确认通过。


## 旧文件清理状态：BLOCKED

重新核对了 21 个旧打包目录，约 **10.26 GiB**；它们不含目录联接且已不在 Git 跟踪中。再次请求删除明确的 `release-phase4-diagnostic/` 目录时，自动审批仍返回 `blocked by policy`，没有提供更具体原因。

因此旧打包目录仍在磁盘上，没有声称已释放空间。此前的构建输出、空 GPU 日志目录和含 10 个依赖目录联接的临时测试目录也保留；详细旧清单见 [首次清理记录](2026-11-13-cleanup.md)。保留 0.8.2 本地包作对照，0.8.3 包作为本次交付；未删除全局依赖缓存、项目运行数据或当前安装目录。

项目 `data/state.json`、`data/local-agent-tasks.json` 和开发依赖哨兵文件的 SHA256 在验证前后保持一致。实际用户安装版仍运行于原目录，没有覆盖其数据或中断任务。

## 交付范围

安装包、大小与 SHA256 见 [v0.8.3 说明](../releases/v0.8.3.md)。这是本地产物，不冒充 CI Release 产物。没有推送新版本标签或创建公开 Release；现有 0.8.2 自动更新客户端暂时不会收到本次更新。真实跨版本下载、安装、自动启动和回滚验收仍未完成。

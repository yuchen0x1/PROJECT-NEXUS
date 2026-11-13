# 仓库同步与计数校准记录

2026-11-13（Asia/Shanghai）。源码基线 `main` / `e037946`，开始时工作区干净。本地交付版本 0.8.5。

## 原因与修复

原 `syncRepositories()` 仅按名称合并仓库，未移出远端已删除或当前连接已无访问权限的记录。前端在收到 202 排队响应后立即读取本地数据，因此刚点击同步时仍显示旧计数；顶部刷新也只读缓存。

新增完整列表校准：按 GitHub id 匹配仓库，保持原本地 id、对象与策略；改名沿用原记录，同名重建使用新身份。为令牌/指定 owner/各 App 安装维护独立可访问范围，任一连接仍列出的仓库继续可用。成功取全当前范围后，缺失项标记 `repositoryAvailable=false`，保留历史、托管配置与本地工作区，不执行目录清理。恢复访问后清除不可用标记。分页截断仅更新已取得的记录；抓取失败不校准该范围的缺失项。

当前总览、仓库 API、托管列表和项目总览统一排除不可用记录；后续巡检不再为其排队，开启托管的 API 也会拒绝。运行中的任务和历史任务不因此删除。列表刷新保留扫描得到的技术栈、工作流和最新发布信息，避免定时同步将这些信息重置为列表默认值。

手动操作等待实际任务成功/失败后刷新，后台任务状态轮询只访问本地 API。应用根部统一调度前台约 60 秒自动同步，隐藏时停止发起新同步，恢复后检查到期时间。控制中心约 5 秒读取本地数据，项目总览维持约 3 秒读取本地快照。

## 请求与限流

客户端与服务端均合并正在执行的同步，同一连接的列表抓取也共用 Promise。自动同步至少间隔 60 秒，手动操作可提前刷新，但不能越过错误退避时间。重启后保留最近成功时间与重试期限。

仓库分页缓存按授权摘要与端点隔离，最多 200 页；使用 ETag / If-None-Match，304 复用该页数据及分页链接。遵守 Retry-After、剩余额度为零时的重置时间、服务端 x-poll-interval；失败按 60 秒起指数退避，常规退避上限 15 分钟，服务端要求的更长等待优先。仓库请求设置 30 秒超时。设计依据为 [GitHub REST 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)和[额度说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。不承诺恒定 60 秒或绝不触及限流。

## 验证

| 状态 | 命令 / 范围 | 结果 |
| --- | --- | --- |
| PASS | `npm run typecheck`、`npm run lint`、`node --check server/index.mjs` | 类型、lint 和语法通过 |
| PASS | 定向 Vitest | 7 文件 / 36 项通过，含校准、恢复、部分数据、范围隔离、重叠连接、身份匹配、任务合并、持久化退避、API 和语言资源 |
| PASS | `node tests/repository-sync-timing.mjs` | 模拟浏览器时钟验证 60 秒、隐藏暂停、恢复、重试期限、重复请求及未连接状态 |
| PASS | `node tests/repository-sync-desktop.mjs` | 真实 Electron 开发窗口验证手动 26→25、重复点击一次抓取、列表一致和实际一分钟自动 25→24 |
| PASS | `NEXUS_SYNC_TEST_EXECUTABLE` 指向 v0.8.5 打包 EXE，执行同一桌面脚本 | 本版 EXE 与实际桌面桥接通过；本地进度轮询没有增加 GitHub 请求，26 条历史仍保留，仅 24 条当前可用 |
| PASS | `node tests/app-update-ui.mjs` | 本版摘要与更新栏布局、排序、状态、主题、窗口宽度和缩放回归通过 |
| PASS | `npm run build -- --logLevel warn` | 构建通过，保留既有主包大小提示 |
| PASS | `npx electron-builder --win nsis --x64 --publish never --config.directories.output=release-v0.8.5 --config.electronDist=node_modules/electron/dist` | 复用已安装的 Electron 45.3.1，生成本地 Windows x64 NSIS 包 |
| PASS | `node scripts/verify-desktop-update.mjs release-v0.8.5` | 版本、大小、SHA512、blockmap 和更新源匹配 |
| PASS | `npm run i18n:coverage` | 十语言均 100%；1455 个基准键 |
| PARTIAL | `npm run i18n:audit`，退出码 1 | 翻译资源 problems=0；既有 `EvolutionCenter.tsx` 的 CPU 字面值仍触发扫描，另保留 3 组颜色提示，本次未新增 |
| PASS | 项目运行文件摘要对比 | `data/state.json`、`data/local-agent-tasks.json` 和 React 依赖清单与先前记录完全一致 |

定向回归命令：

```text
npx vitest run tests/unit/repository-sync.test.mjs tests/unit/server-api.test.mjs tests/unit/github-pagination.test.mjs tests/unit/project-overview.test.mjs tests/unit/state-store.test.mjs tests/unit/i18n-resources.test.mjs tests/unit/i18n-keys.test.mjs --maxWorkers 1
```

API fixture 覆盖一次并行任务、26→25、当前列表/总览一致、历史保留、304 数据复用、自动到期跳过、429/120 秒冷却与手动操作遵守冷却。此次为定向回归，不记作全库测试。

## 本地产物核对

1. 总览：使用 `reverse-engineering-exposure-audit` 只读扫描，76 个文件 / 7 个二进制，相对评分 31/D；与 0.8.4 基线无新增或加重发现，不作为安全认证。
2. 发现：安装包为 `NotSigned`；保留既有 Electron fuse、第三方二进制和 ASAR 可读边界。
3. 证据：[扫描](../evidence/v0.8.5-exposure.json)与[人工核对](../evidence/v0.8.5-package-inspection.json)。ASAR 版本为 0.8.5，服务端入口、同步模块和前端入口与交付文件一致，未发现实际 `.map`、环境凭据或运行状态库。扫描器命中的第三方 sourceMappingURL 文字不等于实际附带 map。
4. 客户端边界：未随包加入用户凭据；DPAPI 与 ASAR 不防御同一 Windows 用户权限下的恶意程序。本次没有改变授权与安全宿主。
5. 后续：公开发布前仍需核对签名和真实旧客户端更新链；后台结构变化后再评估 fuse 收紧。

## 交付边界

桌面与 API 流程使用隔离 fixture 服务、临时数据目录；未删除真实 GitHub 仓库、未改变现有凭据或托管策略。截图中 25/24 是验收用仓库数，不能当作已经同步用户真实安装版的证据。

未覆盖当前用户安装目录，未创建版本标签或公开 Release。安装包摘要见 [v0.8.5](../releases/v0.8.5.md)。需要安装新版才会改变现有软件的同步行为，真实跨版本自动安装与重启尚未验收。

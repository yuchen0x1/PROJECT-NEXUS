# 首次启动教学记录

工作开始于 2026-11-13（Asia/Shanghai），基线 `main` / `e3e686c`，工作区干净。本地交付版本 0.8.6 于 2026-11-14 完成。

## 变化与持久化

此前已有七步配置教学和四页功能定位，但必须主动点击入口。配置成功时只写入网页 localStorage，启动时没有读取它来判断是否应展示教学。桌面服务使用本地端口，网页存储也不适合作为跨启动的完成依据。

本版在桌面设置中增加 `onboardingStage`，通过既有窄 IPC 读取和保存，仅允许 `setup`、`tour`、`complete`。缺失或非法值默认进入设置教学，不推断用户已经完成。SettingsProvider 加载设置后才挂载工作台，首次渲染即展示相应教学，避免依赖用户发现帮助入口。

- `setup`：自动展示七步教学，可稍后继续；关闭不改变完成状态。重新打开时复用有效连接，其余步骤重新确认。
- `tour`：所选仓库全部开启成功后才保存；下一次启动自动介绍功能位置。保存失败会保留错误，不能把失败当作完成。
- `complete`：用户点击功能导览最后一步的完成按钮、且设置保存成功后才关闭导览，后续启动不再自动打开。手动重看保留完成状态。

新增首次使用说明与「稍后继续」，沿用原有焦点管理、键盘操作、位置高亮、步骤校验和显式授权。仅打开教学不启用托管，也不代替授权。未改动真实用户设置、凭据或已安装程序。

## 验证

| 状态 | 命令 / 范围 | 结果 |
| --- | --- | --- |
| PASS | `npm run typecheck`、`npm run lint`、`node --check desktop/main.mjs` | 类型、lint 和主进程语法通过 |
| PASS | 定向 Vitest | 4 文件 / 13 项：教学批量处理、开启前检查、语言资源与键引用 |
| PASS | `node tests/first-use-desktop.mjs` | 使用全新临时目录，自动教学、稍后继续、重启、待完成导览、持久完成、清除网页存储、手动重看与非法状态恢复通过 |
| PASS | `NEXUS_GUIDE_TEST_LOCALE=zh-CN` 执行 `node tests/guided-setup-desktop.mjs` | 真实开发窗口完成七步配置及四页导览，验证真正的配置成功写入 tour、最后完成写入 complete；保留失败重试、明确授权及 720p 布局检查 |
| PASS | `NEXUS_FIRST_USE_TEST_EXECUTABLE` 指向本版打包 EXE 执行首次使用脚本 | 主进程、实际桌面桥接及跨多次启动的状态恢复通过 |
| PASS | `NEXUS_GUIDE_INSTALLED_EXE` 指向本版未安装 EXE、`NEXUS_GUIDE_TEST_LOCALE=en-US` 执行完整配置脚本 | 英文完整流程通过；变量名沿用旧脚本，本次验证的是打包 EXE，没有执行安装 |
| PASS | `node tests/desktop.smoke.mjs` | 桌面启动、窄桥接、未认证 API 拒绝、更新栏及设置布局回归通过 |
| PASS | `node tests/desktop-i18n.mjs` | 系统语言、中文/日文/英文切换、主题、命令面板和重启后的语言保留通过 |
| PASS | `node tests/app-update-ui.mjs` | 本版日志、排序、更新状态、主题和窗口/缩放回归通过 |
| PASS | `npm run build -- --logLevel warn` | 构建通过；既有主包大小提示保留 |
| PASS | 本地 Windows x64 NSIS 打包及 `node scripts/verify-desktop-update.mjs release-v0.8.6` | 版本、大小、SHA512、blockmap 和更新源匹配 |
| PASS | `npm run i18n:coverage` | 十语言均 100%，1461 个基准键 |
| PARTIAL | `npm run i18n:audit`，退出码 1 | 翻译资源 problems=0；既有 CPU 字面值仍触发扫描，另保留 3 组颜色提示，无新增 |

定向回归命令：

```text
npx vitest run tests/unit/i18n-resources.test.mjs tests/unit/i18n-keys.test.mjs tests/unit/setup-batch.test.ts tests/unit/setup-readiness.test.mjs --maxWorkers 1
```

打包命令：

```text
npx electron-builder --win nsis --x64 --publish never --config.directories.output=release-v0.8.6 --config.electronDist=node_modules/electron/dist
```

首次使用脚本的 tour 恢复用例恢复配置完成后的持久状态；真实 setup→tour 转换由完整教学脚本另行验证。未使用真实凭据或向业务仓库写入。本次不是全库测试。

其他桌面功能测试的已有设置样本明确声明教学已完成，首次使用专项测试保持全新设置；语言首次启动测试显式点击稍后继续。完整教学脚本的截图与回执改写入忽略的 test-results，保留原历史证据，避免每次回归覆盖历史截图并提交重复图片。

## 产物与交付

1. 总览：`reverse-engineering-exposure-audit` 只读扫描 76 个文件 / 7 个二进制，相对评分 31/D，与 0.8.5 基线无新增或加重发现，不作为安全认证。
2. 发现：安装包未签名；既有 Electron fuse、第三方二进制与 ASAR 可读边界保留。
3. 证据：[扫描](../evidence/v0.8.6-exposure.json)与[包内容核对](../evidence/v0.8.6-package-inspection.json)。包版本、桌面主进程、preload、后端与前端入口一致；未发现实际 map、运行状态库或用户凭据文件。
4. 客户端边界：教学完成标记仅影响显示流程，不授权仓库操作；DPAPI 和 ASAR 不防御同一用户权限下的恶意程序。
5. 后续：公开发布前仍需核对签名与真实旧客户端更新链；本次没有安装、创建新版本标签或发布 Release。

本次本地验收候选为 `release-v0.8.6/PROJECT-NEXUS-0.8.6-win-x64-setup.exe`，122,859,854 字节，SHA256 `ecef51e09048fc48acb143060ad3646a8e9a1496c62a778bafe66559bb1dc9ad`。此摘要不能替代后续 Windows CI 生成的公开资产摘要。

旧版未保存教学状态的用户升级后会看到教学一次，未提前伪造为已完成。本记录描述本地交付时的状态，后续公开发布与实际通道验证另行记录；当前下载入口见 [v0.8.6](../releases/v0.8.6.md)。

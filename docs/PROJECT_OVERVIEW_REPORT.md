# 项目总览关系图 · 0.7.0

日期：2026-11-13（Asia/Shanghai）。本次续接已完成源码开发、尚未完成安装验收与交付记录的 0.7.0，保留 main / ae54646 和全部既有未提交修改。

本报告保留发布前的本地验收快照；后续推送与发布资料另见[0.7.0 版本说明](releases/v0.7.0.md)。

**功能与本地安装验收：PASS。真实配置展示：PASS；现有加密凭据恢复：BLOCKED。当前为本地预览，未提交、推送或公开发布。**

汇总见[交付回执](evidence/project-overview-delivery.json)；[最终检查](evidence/project-overview-final-check.json)确认 9 个原配置及备份文件哈希未变，README、发布记录和本报告的本地链接均有效。

## 已完成的体验

- 左侧工作区提供「项目总览」。账号居中，仓库分布四周，内圈显示 AI、巡检、分析规划、代码执行、测试审查、交付和源码研究。
- 任务记录驱动对应连线；等待审批、完成、连接中断和页面隐藏时停止相应动画。进入总览只读取记录，不启动任务。
- 支持缩放、拖动、显示全图、搜索、状态筛选和仓库定位，点击节点查看任务、模型连接和近期输出，并进入对应功能页。
- 执行结果与交付结果分别显示；交付不完整仍显示阻塞。输出有数量与长度限制，过滤已知凭据，不返回提示词、密钥字段或工作区路径。
- 页面约每 3 秒刷新任务级活动；它不表示逐字生成的模型文本流。沿用原有语言、主题、导航和多仓库教学。

## 续作清单

- [x] 核对当前源码与现有 0.7.0 构建产物。
- [x] 在当前 E 盘工作区复查类型、总览投影、布局及语言资源。
- [x] 备份 0.6.0 程序和用户数据，安装 0.7.0 并验证数据保留。
- [x] 验收安装版中英文完整交互、API 认证和真实 Windows 命令执行器。
- [x] 展示真实配置副本中的全部 26 个仓库，确认原配置未变。
- [x] 补齐 README 和发布记录已引用的本交付报告。
- [ ] 在可解密现有凭据的 Windows 会话中完成真实账号与 AI 连接恢复验收，或由用户重新连接后复验。

## 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 续作前的完整回归 | PASS，46 文件 / 254 项；保留原记录，未重复声称本次全量运行 | [原始日志](evidence/project-overview-tests.log) |
| 当前工作区 TypeScript | PASS，`npx tsc --noEmit`，退出码 0 | [日志](evidence/project-overview-resume-types.log) |
| 当前总览投影与布局回归 | PASS，2 文件 / 10 项，退出码 0 | [日志](evidence/project-overview-resume-focused.log) |
| 当前语言键与资源 | PASS，2 文件 / 7 项，退出码 0 | [日志](evidence/project-overview-resume-i18n.log) |
| 安装包与源码一致性 | PASS，186 个 desktop/server/dist 文件一致，0 个 source map；包含物理解包的 Windows Job Object 执行器 | [内容核对](evidence/project-overview-content.json) |
| Windows 更新安装 | PASS，安装退出码 0；安装后 ASAR 与构建产物一致，9 个配置及备份文件哈希不变 | [安装回执](evidence/project-overview-install.json) |
| 安装版中文完整交互 | PASS，18 项；独立数据目录和本地 fixture，0 个外部请求 | [日志](evidence/project-overview-installed-ui-zh-CN.log)、[回执](evidence/project-overview-installed-zh-CN.json) |
| 安装版英文完整交互 | PASS，18 项；独立数据目录和本地 fixture，0 个外部请求 | [日志](evidence/project-overview-installed-ui-en-US.log)、[回执](evidence/project-overview-installed-en-US.json) |
| 安装版基础与命令执行器 | PASS；实际窗口、数据位置、受认证桥接 200、直接请求 401、七步教学、真实命令执行 | [日志](evidence/project-overview-installed-smoke.log) |
| 真实仓库配置展示 | PASS；26/26 节点，0 个运行任务时无流动动画；退出验收后 7 个原 JSON 哈希不变 | [回执](evidence/project-overview-live.json)、[截图](screenshots/project-overview/installed-real-overview.png) |
| 真实 GitHub / AI 凭据恢复 | BLOCKED；综合真实配置验收为 PARTIAL，脚本退出码 2 | [日志](evidence/project-overview-installed-live.log) |

命令：

```powershell
npx tsc --noEmit
npx vitest run tests/unit/project-overview.test.mjs tests/unit/overview-layout.test.ts --maxWorkers=2 --testTimeout=60000
npx vitest run tests/unit/i18n-keys.test.mjs tests/unit/i18n-resources.test.mjs --maxWorkers=2 --testTimeout=60000
$env:NEXUS_OVERVIEW_INSTALLED_EXE = "$env:LOCALAPPDATA\Programs\PROJECT NEXUS\PROJECT NEXUS.exe"
$env:NEXUS_OVERVIEW_LOCALE = 'zh-CN' # 英文验收使用 en-US
node tests/project-overview-desktop.mjs
$env:NEXUS_INSTALLED_EXE = $env:NEXUS_OVERVIEW_INSTALLED_EXE
node tests/installed-package-smoke.mjs
$env:NEXUS_OVERVIEW_LIVE_EXE = $env:NEXUS_OVERVIEW_INSTALLED_EXE
node tests/project-overview-installed-live.mjs
```

真实配置验收改为使用临时副本：启动前暂停托管、关闭远程写入及独立集成扫描计划，阻止待恢复扫描，并关闭副本的开机启动设置。加密凭据仅复制到临时目录，退出后删除。不会直接启动真实用户配置来进行验收，也没有对真实仓库开启或执行新任务。

## 凭据恢复阻塞

当前 Windows 会话中，系统报告加密可用，但 `safeStorage` 无法解密副本中的 GitHub 凭据及 2 个 Provider 密钥。未输出明文、重置或覆盖原凭据，具体失败原因尚未确定。真实截图如实显示未连接状态，不能当作真实服务已连接的证据。

0.6.0 备份与 0.7.0 安装包中的桌面主进程、预加载桥和 Provider 存储代码哈希相同，见[对比记录](evidence/project-overview-credential-code-comparison.json)。这项比较只证明相关代码未变化，不代替旧版真实会话验收。

后续需要在可解密这些凭据的原 Windows 会话复验，或在应用中重新连接 GitHub、填写 AI 密钥后复验；没有凭据就绪前不应将真实服务验收标为通过。

## 本地安装产物

- 安装包：`release-project-overview/PROJECT-NEXUS-0.7.0-win-x64-setup.exe`
- 大小：122131830 字节。
- SHA256：`620CF4F5CD4130778B9F8AD7BEE7812D7B2D96A4954754667870256D9D175297`
- 签名：NotSigned。SHA256 仅用于文件一致性核对。
- 已安装：`C:\Users\lenmo\AppData\Local\Programs\PROJECT NEXUS\PROJECT NEXUS.exe`，文件版本 0.7.0。
- 旧程序与数据备份：`C:\Users\lenmo\AppData\Local\PROJECT NEXUS Backups\20261113-171223-project-overview`。未恢复或覆盖备份。

总览本身不新增数据库、依赖或远程执行权限。CI 权限、签名、通用多语言发布、精确中断续跑和 24 小时长稳等既有待办仍见[按序升级报告](ORDERED_UPGRADE_REPORT.md)，本次不将这些目标算作已完成。

使用方法见[中文上手指南](QUICK_START.zh-CN.md)。

# 0.5.0 导航与教学交付

日期：2026-11-13。本地预览，保留 main / ae54646 及已有未提交工作；未提交或公开发布本项目。

## 用户能看到的变化

- 移除远程控制台二级入口，20 个管理页面平铺到主侧栏。工作区入口固定在上方，管理列表使用一个滚动区域，设置仍在底部。
- 工作台和顶部新增「一键教学」。每一步说明操作、当前位置与后续结果，填写后点下一步会先保存和检查，再自动导航。
- 已有账号、服务商配置和密钥可复用；不会要求重复输入密钥。失败保留当前步骤；保存了密钥但测试失败时仍可直接重试。
- 教学明确要求可信脚本授权、远程写入授权；全局调度暂停时必须明确恢复。浏览教学和切换步骤不会替用户授权。
- 完成后显示实际开启结果，可立即同步 Issue，并进入托管、任务、Issue、研究四个页面的定位教学。选中的仓库和刚保存的状态会立即刷新。
- 新教学文案覆盖十种语言；补齐中文托管、Issue 和研究页面的操作说明。

## 验证与边界

| 检查 | 结果 | 证据 |
|---|---|---|
| TypeScript 与构建 | PASS | `npx tsc --noEmit`、`evidence/guided-setup-build.log` |
| 完整单元/本地集成 | PASS，42 文件 / 225 项 | `evidence/guided-setup-tests.log` |
| 语言键与资源 | PASS，7 项 | i18n 两个测试文件；各语言键与变量一致 |
| 中文、英文教学 | PASS | `tests/guided-setup-desktop.mjs`；真实 Electron、1280×720、本地模拟 GitHub 与 AI 服务 |
| 正常连接、错误重试、复用密钥、明确授权、暂停恢复、正确仓库和四页定位 | PASS | `evidence/guided-setup-zh-CN.json`、`guided-setup-en-US.json` |
| 既有设置与任务回执 | PASS | `tests/ordered-upgrade-desktop.mjs` |
| 原生窗口、语言、主题、重启 | PASS | `desktop.smoke.mjs`、`desktop-i18n.mjs` |
| 安装与原配置保留 | PASS | 安装 exit 0，7 个 JSON 文件哈希不变，旧程序和数据已备份 |
| 安装版完整中文教学 | PASS | `evidence/guided-setup-installed-zh-CN.json`，含失败重试、明确恢复调度、复用密钥和服务商名称/优先级/能力项保留 |
| 安装版命令执行与认证 | PASS | `evidence/guided-setup-installed-smoke.log`，包含真实 Windows Job Object 执行器调用 |

最终安装程序：`release-guided-setup/PROJECT-NEXUS-0.5.0-win-x64-setup.exe`，122,107,872 字节，未签名。

SHA256：`186E848579FCA97E7B37A7CAE853637D4ABECB808E09FFC2F268F8C217A31CC3`。

安装位置：`C:\Users\lenmo\AppData\Local\Programs\PROJECT NEXUS\PROJECT NEXUS.exe`。旧程序和数据备份：`C:\Users\lenmo\AppData\Local\PROJECT NEXUS Backups\20261113-134806-0.5.0`。

本次没有用模拟服务证明真实 GitHub 合并或发布；也没有创建业务仓库任务。原有 CI 权限、签名、非 Node 发布等限制未被绕过。界面明确说明：自动维护会处理符合条件的 Issue，研究升级提案仍需要审阅，不能宣称任意项目都能自动升级。

使用步骤见 [中文上手指南](QUICK_START.zh-CN.md)。截图在 `screenshots/guided-setup/`，仅包含专用本地测试数据。

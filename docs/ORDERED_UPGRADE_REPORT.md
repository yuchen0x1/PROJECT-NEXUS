# 0.4.0 按序升级报告

日期：2026-11-13。基线为 main / ae54646 与工作区已有未提交修改。本次保留全部既有实现，按五阶段增量升级；未引入数据库、后台系统服务或新依赖。

## 实现与顺序

1. **状态与权限**：执行和交付分别记录，发布失败不算整项成功。推送、PR、合并、发布、上传及关闭逐步复查实时权限。高风险工具不能通过允许名单绕过审批。就绪检查绑定仓库、账号、Provider、凭据、策略及当前宿主，十分钟后过期；切换仓库清除后续完成状态。实际验收还修复了 Issue 重新分类替换记录对象、导致运行状态无法更新的问题。
2. **持久化与核对**：沿用 JSON 原子存储，加入 fsync、数据目录宿主租约、仓库租约、操作前意图与操作后回执。任务中心通过只读请求核对不确定的 PR、合并、Release、评论、关闭、分支和资产。中断操作不会自动重放；精确步骤自动续跑仍未实现。
3. **后台与执行**：十分钟内最多重启五次。仓库脚本默认禁止，明确授权后采用可信本机执行。Windows Job Object 限制每条命令的进程树为 64 个进程、2 GiB 总内存，并在宿主退出时清理；另保留超时、输出限制与环境过滤。这不是文件或网络安全沙箱。窗口关闭留在托盘；完全退出应用仍会停止后台。
4. **交付与研究**：核对当前 PR HEAD、GitHub Checks 与 Commit Status，等待排队检查并阻止失败或缺失的必要检查。无 CI 需要单独授权，403 不视为没有 CI。发布前保存版本、SHA、适配器、命令和签名要求；Electron 资产默认要求有效 Authenticode。研究提案验证真实源码 blob SHA、保存许可证人工审阅，批准不等于已实施。Node 发布路径保留；Python、Rust、.NET、Tauri 打包明确阻止，尚无真实适配验收。
5. **桌面与交付**：统一侧栏访问 20 个远程页面，托管权限可逐项撤销；任务显示执行/交付状态、计划、回执和核对入口。通知中心发现后台任务和待审批操作。新增文案覆盖十种语言。

## 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 完整单元及本地集成回归 | PASS，42 文件 / 225 测试 | `evidence/ordered-tests.log`；随后执行器 12 项、权限/API 6 项定向复查通过 |
| TypeScript 与生产构建 | PASS | `npx tsc --noEmit`、`evidence/ordered-build.log` |
| 响应丢失、持久化失败、租约互斥、精确回执核对 | PASS | `durable-effects.test.mjs` |
| 宿主异常退出后子进程清理 | PASS | 真实 Windows 进程，`service-health.test.mjs` |
| 设置切换失效、统一导航、双状态、回执核对 | PASS | 真实 Electron 窗口，`ordered-upgrade-desktop.mjs` |
| 语言、主题、重启恢复 | PASS | `desktop-i18n.mjs` |
| 当前 GitHub 真实验收 | PARTIAL / BLOCKED | AI 修复、真实测试/构建/审查、推送和 PR 成功；Checks API 返回 403，正确阻止合并，未声称本版本完整发布闭环通过 |
| Windows 安装包 | PASS | 最终安装 exit 0；现有 7 个 JSON 文件哈希保持不变，实际安装版命令执行成功 |
| 安装版凭据恢复 | PASS | 不传入 GitHub/AI 凭据环境变量，仍恢复原账号与 Provider |
| 安装包内容 | PASS | 636 项、0 个 source map，包含最新就绪超时和 Issue 状态修复 |
| 凭据模式扫描 | PASS（范围有限） | 应用代码/文档未命中；3 个测试文件中的合成凭据已人工核对 |

最终安装程序：`release-ordered-upgrade/PROJECT-NEXUS-0.4.0-win-x64-setup.exe`，122,091,575 字节。已包含随后添加的 GitHub 令牌获取链接。

SHA256：`72829292CB8DC9080C22805517E03C433E8C33EBE2DE11EEEE8E8C658B157C38`。

已安装并正常启动：`C:\Users\lenmo\AppData\Local\Programs\PROJECT NEXUS\PROJECT NEXUS.exe`。

旧应用和数据备份：`C:\Users\lenmo\AppData\Local\PROJECT NEXUS Backups\20261113-125828-0.4.0`。未恢复或覆盖备份。

实际回执见 `evidence/ordered-windows-install.json`、`ordered-installed-smoke.log`、`ordered-installed-connections.json`、`ordered-installed-asar.json`。私有测试仓库 `yuchen0x1/nexus-acceptance-20261113-1243` 已删除，DELETE 204 后 GET 404，见 `ordered-repository-cleanup.json`。

后续令牌链接更新：输入框右上方可点击“获取 GitHub 访问令牌”，由受限桌面接口打开 `https://github.com/settings/tokens/new`。十种语言文案已补齐。TypeScript、构建、7 项语言检查、真实 Electron 窗口内的键盘激活/主进程调用验证及安装版冒烟通过；跳转调用测试替代了浏览器实际启动，未创建令牌或修改 GitHub 权限。更新安装未改变 7 个 JSON 配置。最新安装与校验记录为 `evidence/token-link-install.json`、`token-link-ui.json`、`token-link-installed-smoke.log`、`token-link-installed-content.json`；更新前应用和数据备份在 `C:\Users\lenmo\AppData\Local\PROJECT NEXUS Backups\20261113-131045-token-link`。

## 尚未通过的条件

- 当前 GitHub 凭据缺少读取检查结果的权限，真实 CI→合并→Release→关闭全链路验收受阻。
- 没有可用代码签名证书，安装包仍未签名。
- 没有执行 24 小时长稳或 Windows 真重启验收；PROJECT NEXUS 自身的客户端自动更新尚未实现，未进行旧客户端跨版本自动更新验收。
- 非 Node 自动打包及中断后的精确步骤续跑未实现；不会以识别到框架或核对到回执代替完成。

本次为本地升级，未提交、推送或公开发布本项目。临时仓库的创建、测试与删除另存实际回执；历史 0.3.0 的成功闭环不能代替本版本新增门禁的验收。

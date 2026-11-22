# 安全加固与发布暴露面报告

日期：2026-11-13。目标为本项目 0.8.0 本地候选源码、前端构建及 Windows 打包目录，不对第三方闭源软件执行分析。

## 1. 总览

总体 PARTIAL，当前候选不满足正式安全发布条件。官方 npm 审计在本次依赖修复后为 0 漏洞；安全执行边界、代码签名及 Electron fuse 仍有明确限制。静态暴露扫描器评分 31 / 100、D，属于工具的相对暴露评分，不是绝对安全评级。

候选安装器的 Authenticode 实测为 `NotSigned`。严格执行模式未配置可信原生隔离宿主时失败关闭；不能将 Renderer sandbox、Worktree、命令允许列表或 Job Object 宣传为 Agent 的完整 OS 沙箱。

## 2. 发现清单

| 编号 | 优先级 | 结果 | 证据与判断 |
| --- | --- | --- | --- |
| DURABILITY | P1 | 已修复并测试 | 持久化失败抛错，停止后续模型和工具执行 |
| DYNAMIC-PERMISSION | P1 | 已修复并测试 | git 远程写入、包安装/发布通过实际工具定义升级审批风险，测试命令包装不可绕过 |
| WORKSPACE-ROOT | P1 | 已修复并测试 | 选择嵌套项目时拒绝父仓库 Worktree，改用授权目录副本 |
| WORKSPACE-LINK | P1 | 已修复并测试 | 读写删除和候选应用拒绝链接、路径穿越及特殊文件 |
| APPLY-BACKUP | P1 | 已修复并测试 | 所有原文件备份成功后才写入，保存应用意图和回执，二进制字节不再经 UTF-8 转换 |
| SIGNING | P1 | 未完成 | 候选安装器未签名，更新下载后不能获得安装授权 |
| ELECTRON-FUSES | P1 | 未完成 | RunAsNode、NODE_OPTIONS、Node 调试参数仍开启；仅从 ASAR 加载及内嵌 ASAR 校验未开启 |
| OS-ISOLATION | P1 | BLOCKED | 普通可信脚本仍可访问当前用户文件和网络；严格模式拒绝执行 |
| CLIENT-SECRETS | P0 检查项 | 扫描未发现实际凭据 | ASAR 444 个脚本/JSON 等文件中，无检测规则命中的实际 GitHub token/私钥，无凭据库或运行数据文件 |
| SOURCE-MAPS | P2 | 未发现打包 map | ASAR 清单中 map 文件为 0；扫描器命中引用字符串，不能等同实际 map 泄漏 |

## 3. 逐项证据与修复

依赖使用定向 override：`minimatch@>=7 <11.0.1 → 11.0.8`，不改动不受该公告影响的旧 3.x/5.x。ESLint、TypeScript、完整测试、生产构建和 NSIS 打包均已实际运行。该范围来自 [GitHub 官方安全公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)，没有为消除警告整体升级 Electron 或 TypeScript 大版本。

保留 `contextIsolation: true`、Renderer `sandbox: true`、`nodeIntegration: false`、同源 IPC 校验、受认证回环 API 和 CSP。新增 metrics IPC 只返回本应用进程指标，不接受任意 PID、命令或文件路径。

工作区、候选与独立测试证据使用实际字节 SHA-256，包括二进制文件。应用前复核审查指纹、原项目清洁状态和基线 HEAD；备份失败不再忽略，发生部分失败时仅恢复仍匹配本次写入的文件，保护并发用户修改。断电留下的不确定应用回执须人工检查，不能自行重放。

`test-results/ultimate-artifact-audit.json` 记录 652 条 ASAR 项、444 个扫描文件，map、受禁止数据文件和实际 token/私钥规则命中均为 0。ASAR 本身未加密，服务端 ESM 源码可以读取；本项目公开源码，不把代码混淆视为核心凭据保护措施。

扫描器还命中 Electron 上游 DLL 的 PDB 文件名及 `BSJB` 字节模式。实测打包目录 PDB 文件为 0，d3dcompiler_47.dll 的 PE CLR 数据目录为 (0, 0)，因此不能将偶然字节匹配认定为自有 .NET 程序集。内网地址命中为 localhost/127.0.0.1 等本地服务契约，不是组织私网地址清单。扫描原始 JSON、Authenticode 检查和 fuse 字节值保留在本地证据目录，未隐藏未签名和 fuse 缺口。

当前 Node 服务由同一 Electron exe 的 RunAsNode 模式启动，直接关闭该 fuse 会破坏启动。应先改造原生服务宿主，再关闭不需要的 Node 环境/调试入口，开启 ASAR 完整性与仅 ASAR 加载，重做真实打包窗口验收，最后签名。不能仅修改配置便宣称加固成功。

[Microsoft AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) 提供不同于 Job Object 的安全边界。AppContainer、Restricted Token、独立低权限账户及 ACL/网络策略的安装配置尚未执行，需要单独的原生实现与用户授权。不存在自动回退为普通模式的路径。

## 4. 客户端无法解决的问题

同一 Windows 用户权限下的恶意程序、可信脚本或被控制的本地进程，仍可能访问该用户的数据。DPAPI 不等于独立账户隔离；删除环境变量不阻止脚本读取宿主文件。计费准确性最终取决于提供方用量和定价，不能把无用量响应算成免费。本次已显式记录未知用量和费用。

更新通过 TLS 获取自有仓库 Release 和 SHA-256，再要求 Authenticode 有效且发布者等于受信任配置。SHA-256 单独不提供发布者认证。当前没有可用签名发布者，原生安装事务也未实现，因此不会静默安装。参见 [Electron 官方签名说明](https://github.com/electron/electron/blob/main/docs/tutorial/code-signing.md)。

## 5. 修复顺序

P0：继续阻止凭据进入候选/日志/模型上下文，真实密钥恢复由用户在应用内完成。

P1：独立原生隔离与服务宿主、最小权限、fuse 与 ASAR 完整性、受信任签名，以及可验收的备份/安装/健康检查/回滚事务。安装、证书或系统配置须单独授权。

P2：更完整的 IPC/API 模糊测试、依赖许可证清单和语言工具链覆盖；不以加壳或字符串混淆代替上述边界。

已读取候选 ASAR 内 68 份 package.json：67 份第三方依赖声明的许可证为 MIT、ISC 或 BSD-3-Clause；未知项仅本项目本身。清单在本地 ultimate-bundled-licenses.json。此清单不是完整依赖法律意见，发行时仍须保留各依赖许可/NOTICE。

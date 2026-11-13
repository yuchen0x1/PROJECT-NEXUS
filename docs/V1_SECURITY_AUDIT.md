> 0.4.0: host/repository leases, durable intents, remote receipt reconciliation, trusted execution authorization and Windows Job Objects added. Precise automatic resume and OS security sandbox remain incomplete. Below: archived 0.3.0 findings. See [current report](ORDERED_UPGRADE_REPORT.md).

# 安全与逆向暴露面审计 · 2026-11-13

## 1. 总览

范围：当前源码、认证桌面 API、凭据持久化、托管执行/交付、Vite 产物与 Windows 安装产物。整体为 **PARTIAL**；静态扫描分数不是系统安全评级。项目本身开源，不把能读取其 JS 当作秘密泄露。

本次修复了独立审查缺失仍成功、交付证据字段不匹配、未合并发布、隐式关闭、构建/上传失败仍发布、无资产发布、损坏密钥库覆盖、短期 Installation Token 落盘/备份、脏缓存覆盖和工作区链接边界。精确用户 API Key 扫描：源码与报告 0 命中。

## 2. 发现清单

| 编号 | 级别 | 结论 |
| --- | --- | --- |
| SIGN-01 | 高 | 应用和安装包未配置 Authenticode 证书，NotSigned |
| EXEC-01 | 高 | 原生脚本以当前 Windows 用户运行；允许程序和环境过滤不是 OS 沙箱 |
| DEP-01 | 中 | minimatch 等打包开发依赖链共 6 项 moderate，未处理跨大版本升级 |
| RESUME-01 | 中 | Interrupted 不重放可避免重复交付，但自动远端核对恢复尚未实现 |
| LOCK-01 | 中 | 仓库锁仅单进程有效，未实现跨进程租约 |
| OBS-01 | 未验证 | Electron fuses 与跨版本更新签名完整闭环未验收 |

## 3. 逐项证据与修复

- `Get-AuthenticodeSignature` 对实际安装程序返回 NotSigned。没有证书，不能凭空完成签名；SHA256 仅用于核对文件。
- `server/services/agent/executor.mjs` 有命令允许列表、超时、输出限制与凭据环境过滤，但没有 Windows 限制令牌/AppContainer 或强制文件系统/网络沙箱。仅对可信仓库启用执行。
- 官方 npm 审计：6 moderate、0 high、0 critical，主要经 electron-builder → app-builder-lib / @electron/universal → minimatch。审计建议涉及不合适的历史版本降级，未自动执行。报告保留在 `test-results/dependency-audit-official.json`。
- `hosted-queue.mjs` 将运行中任务恢复为 Interrupted，保留回执而非重放；当前没有完成自动远端对账与继续交付的实现。
- 状态原子写与备份测试验证旧记录保留、临时 Installation Token 从全部新磁盘副本剔除。Provider 和 GitHub 长期凭据通过 Windows DPAPI 加密保存在项目外。
- 构建移除了无用的 Electron default_app.asar，并把前端构建/已打包库移到开发依赖，避免将前端依赖源码和 source maps 带入运行安装包。最终 ASAR 项目清单与静态扫描单独核对。

静态扫描误报已人工核对：d3dcompiler_47.dll 仅因字节串 BSJB 被判作 .NET，PE CLI 目录 RVA/Size 均为 0，因此不能据此认定它是托管程序集；PDB 命中大多只是第三方库文件名，不能声称泄露本项目用户名/源码路径。Vite dist 扫描未发现 source map 或凭据；不代表服务端授权已经通过完整渗透测试。

最终 ASAR 有 624 条目、0 个 .map，sample launcher 已移除。扫描器仍报告 sourceMappingURL 模板文字，但没有对应 .map；localhost/127.0.0.1 是本机 API 和第三方库示例，不是发现了内部业务地址。elevate.exe 的 CFG 标志缺失属于第三方辅助二进制待评估项。静态启发式评分为 36/D，因含误报且跳过过大的主 EXE，不将该分数解释成实际安全结论。最终原始扫描见 `evidence/v1-exposure-electron.json`。

参考：[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)、[GitHub 合并 API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)、[GitHub Release API](https://docs.github.com/en/rest/releases/releases)、[minimatch 维护者安全公告](https://github.com/isaacs/minimatch/security/advisories)。未引用记忆作为当前行为证明。

## 4. 客户端无法解决的问题

DPAPI 能保护落盘凭据，但同一 Windows 用户权限的恶意程序仍可能访问应用内存或解密数据。ASAR 是归档，不是加密。桌面控制中心没有商业授权/订阅判定需求；未来如引入计费授权，应由服务端裁决。安装包混淆不能替代发布签名或真实沙箱。

当前自有更新能力主要为被托管项目提供适配分析和交付，不能声称已验证 NEXUS 自身从旧版本发现、认证、安装并重新启动新版本的完整更新闭环。

## 5. 修复顺序

P0：继续确保凭据只进入受控凭据库，禁止发布失败证据被误判成功。

P1：补充代码签名、真实命令沙箱、交付远端对账与跨进程锁；完成中断/限流/断网故障注入。

P2：评估兼容的打包依赖修复、检查必要 fuses、完善长期资源治理和 24h 验收。不要关闭当前后台架构必需的 RunAsNode 开关而导致服务失效。

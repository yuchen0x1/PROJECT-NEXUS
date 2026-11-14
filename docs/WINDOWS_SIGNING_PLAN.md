# Windows 代码签名方案

本文是 [WINDOWS_ISOLATION_AND_INSTALL_PLAN.md](WINDOWS_ISOLATION_AND_INSTALL_PLAN.md)「原生安装事务」签名门禁的具体实施计划。截至 2026-11-14：未购买证书、未创建签名账户、未签署任何产物；公开安装包 Authenticode 状态为 NotSigned。

## 决策记录（2026-11-14）

用户决定不采购付费签名。因此：Azure Artifact Signing 与 Certum 方案搁置；T2 签名闭环（见 [WINDOWS_UPDATE_INSTALL_ACCEPTANCE_PLAN.md](WINDOWS_UPDATE_INSTALL_ACCEPTANCE_PLAN.md)）无限期推迟；公开版维持 NotSigned，SmartScreen 警告如实记录，安装授权门禁按设计保持关闭。

零成本路径核查：唯一免费公开分发选项为 [SignPath Foundation](https://signpath.org)（合格开源项目免费，Sectigo 签发），要求项目具备 OSI 许可证并通过资格审核。**2026-11-14 更新：用户同意开源，已添加 MIT LICENSE 文件（版权：冷漠不是神）；`package.json` 的 `license` 字段因 24h soak 源码哈希约束待其结束后补上。SignPath 资格审核通过前，T2 仍视为搁置；通过后按 T2 轨道恢复。**自签名证书免费但仅限本地验收，公开分发无效。

## 现状（仓库事实）

- CI 已预留签名通道：[release-desktop.yml](../.github/workflows/release-desktop.yml) 读取可选 secrets `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD`，未配置时按未签名构建。
- 打包链：electron-builder 26.18.0 + NSIS x64；更新客户端 electron-updater（`desktop/auto-update.mjs`），完整性靠 `latest.yml` 的 SHA512。
- 安装授权门禁要求「重验 SHA-256、大小、Authenticode 链及明确受信发布者」，未签名时该门禁按设计保持关闭（[WINDOWS_ISOLATION_AND_INSTALL_PLAN.md](WINDOWS_ISOLATION_AND_INSTALL_PLAN.md)）。

## 选项对比（价格与政策为 2026-11 调研值，采购时以官网现价为准）

| 方案 | 成本 | 个体准入 | CI 集成 | SmartScreen | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Azure Artifact Signing**（原 Trusted Signing） | Basic $9.99/月（5,000 签名/月） | 已开放个体开发者，需身份验证 | electron-builder 26 原生 `azureSignOptions`，密钥在微软云，无需 USB 令牌 | OV 级，初始需积累信誉 | **推荐** |
| Certum 开源证书（SimplySign 云签约） | 首次约 €49，续期约 €29；证书最长 459 天 | 面向开源/个体开发者 | SimplySign 客户端在本机，CI 集成较绕，适合本机签 | OV 级 | 备选（最低年成本） |
| EV 证书 | 约 $300–700/年 | 通常要求注册企业 | 同上 | 立即信誉 | 现阶段不必 |
| 自签名 | 免费 | — | 简单 | 无效 | **仅限本地验收**，禁止用于公开分发 |

推荐 Azure Artifact Signing 的理由：成本最低的合规路径、个体身份验证已文档化、云端密钥直接匹配现有 GitHub Actions 发布流程、electron-builder 26.18.0 已内置支持，不新增本地签名步骤。

## 实施步骤（每步完成才进入下一步）

1. **账户与身份**：创建/使用 Azure 订阅 → 创建 Artifact Signing 账户（Basic）→ 提交个体开发者身份验证（等待期可能数个工作日）。
2. **证书 profile**：创建证书 identity 与公共证书 profile，记录 Subject 与指纹。
3. **本地试签**：本机以 `azureSignOptions` 对一个未发布的候选安装包试签，`Get-AuthenticodeSignature` 确认 Valid，`signtool verify /pa` 确认链完整。
4. **CI 接入**：electron-builder 配置 `win.azureSignOptions`（Azure 凭据走 GitHub secrets：tenant/client/secret，不落仓库）；远端完整回归通过后产出一个**已签名**的公开 Release。
5. **发布者验证闭环**：`win` 配置增加 `publisherName`，新客户端对更新包做 Authenticode 验证；旧客户端（无 publisherName 配置）仍按 SHA512 更新，属预期行为，发布说明如实记录。
6. **文档回写**：更新 [UPDATE_SECURITY.md](UPDATE_SECURITY.md) 与安全证据，`signatureCryptographicallyVerified` 只在真实验证后改值。

## 不做的事

- 不自动购买、不自动创建账户、不生成并信任自建根证书（既有策略）。
- 证书凭据只进 GitHub secrets 与本机用户级配置，不进仓库、不进应用数据。
- 签名不等于清白：SmartScreen 初始警告可能仍在，发布说明不得宣称「无警告」。

## 参考资料

- [Azure Artifact Signing 产品页](https://azure.microsoft.com/en-us/products/artifact-signing)、[Quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [Certum 开源代码签名](https://certum.store/open-source-code-signing-code.html)
- [electron-builder 代码签名文档](https://www.electron.build/code-signing)

# Windows 跨版本安装与重启验收计划

本文把 v0.8.6 已知限制「真实跨版本自动安装、重启与回滚未验收」落成可执行的验收步骤。截至 2026-11-14：未安装任何候选、未执行本计划任何步骤。安装事务状态机与门禁定义见 [WINDOWS_ISOLATION_AND_INSTALL_PLAN.md](WINDOWS_ISOLATION_AND_INSTALL_PLAN.md)，签名前置见 [WINDOWS_SIGNING_PLAN.md](WINDOWS_SIGNING_PLAN.md)。

## 前置条件

- P1：24h soak 测试 PASS（2026-11-14 启动，运行中；以 `test-results/soak/2026-11-14T05-05-57-289Z/status.json` 为准）。
- P2：本机有可用的 0.8.x 安装版作为旧版基线（无则先安装已发布的 0.8.6，安装动作本身需要授权）。
- P3：更新源快照与 ACL/数据导出先行完成（改前留证）。

## 轨道 T1：未签名候选的本地事务验收（签名前可做）

目的：证明「发现 → 下载 → SHA512 校验 → 安装 → 自动重启 → 健康检查」的机械闭环。**发布者签名门禁在 T1 明确豁免并如实记录，不得据此宣称公开自动更新已验收。**

1. 基线：确认安装版版本号、数据目录（`%LOCALAPPDATA%\PROJECT NEXUS`）状态导出（state/local-projects/desktop-settings 摘要）。
2. 候选：本地构建高于基线的版本（如 0.8.7-local.1），产出安装包 + blockmap + `latest.yml`，三者摘要入库。
3. 本地 feed：验收窗口内用临时 generic 更新源（本地 HTTP，仅回环）提供上述三件资产；旧版客户端更新源指向它，验收后即撤销。
4. 触发：安装版客户端设置内「检查更新」→「立即更新」，全流程录证：发现时间、下载进度、校验结果、安装启动、进程退出与重启、新版本号回读。
5. 健康检查：API ready、设置与项目注册保留、托管暂停状态保留、教学完成状态保留；逐项记录。
6. 失败注入：安装阶段终止安装进程、`latest.yml` 摘要不匹配、下载中断三类故障各一次，确认旧版可继续运行、错误有明确呈现、无半安装状态。
7. 恢复路径：复现一次 `recoverFailedUpdate` 路径（更新失败后重启），确认服务恢复与错误对话框行为符合 [desktop/main.mjs](../desktop/main.mjs) 设计。

## 轨道 T2：签名候选的自动更新闭环（已搁置）

完整重跑 T1 第 3–7 步，差异：候选带有效 Authenticode 链，客户端 `publisherName` 验证生效；`UPDATE_SECURITY.md` 的 `signatureCryptographicallyVerified` 与 `oldClientUpdateVerified` 仅在此轨道通过后改值。签名后的第一次公开 Release 用真实 GitHub 源做最终回归。

**2026-11-14 决策：用户决定不采购付费签名，T2 无限期搁置**（见 [WINDOWS_SIGNING_PLAN.md](WINDOWS_SIGNING_PLAN.md) 决策记录）。若将来通过 SignPath Foundation 等免费路径取得有效签名，从本轨道恢复。

## 轨道 T3：真实 Windows 重启（单独授权）

- 更新安装完成后真实重启系统（不模拟），核对开机后版本、自启设置（若开启）与数据完整性。
- 重启需要用户单独明确同意并提供恢复点；不能从 T1/T2 的进程级授权推导。

## 证据要求

- 每轨道产出 `docs/evidence/vX.Y.Z-install-<step>.json`：时间线、版本、SHA256、检查结果、失败注入记录。
- 维护报告入 `docs/maintenance/`，如实区分 PASS / 豁免项 / 失败项。

## 需要用户批准的动作清单（届时逐项申请）

1. 在真实安装目录安装 0.8.6 基线（若本机尚无安装版）。
2. 验收窗口内修改安装版客户端更新源指向本地回环 feed（验收后撤销并复核）。
3. 退出正在运行的应用并运行候选安装器、允许自动重启。
4. 故障注入（终止安装进程、篡改本地 feed 摘要）。
5. T2 依赖的证书购买/账户创建（见签名方案）。
6. 真实系统重启（单独授权 + 恢复点）。

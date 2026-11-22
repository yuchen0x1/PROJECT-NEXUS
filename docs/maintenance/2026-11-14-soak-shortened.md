# 2026-11-14 · 24h soak 改为 1 小时短检验（用户决策）

## 决策

用户在 24h soak 运行约 20 分钟后决定改为 1 小时：「时间太久了1个小时就行了」。此决策覆盖 [FINAL_DELIVERY_REPORT.md](../FINAL_DELIVERY_REPORT.md) 的 24h 封板门禁：**1 小时结果不构成 24 小时持续验收**，相关已知限制不得宣称完成。

## 执行记录

- 24h 运行 `2026-11-14T05-05-57-289Z`：停止时健康（1202 秒、21 采样、1 工作流、0 错误、最大采样间隔 60.8 秒）。进程树经 `taskkill /T /F` 终止并逐一确认死亡，status.json 回写 `Interrupted`，reason `USER_DECISION_SHORTENED_TO_1H_STOPPED_EARLY`，实测字段未改动。
- 新运行 `2026-11-14T05-27-05-174Z`：`NEXUS_SOAK_HOURS=1`，2026-11-14 13:27 Asia/Shanghai 启动，预计 14:27 自行结束。
- **后续变更（13:41）**：用户报告桌面出现两个实例与白屏，要求单实例运行。该白屏窗口为 soak 测试实例被托盘双击唤出（测试实例托盘图标与正式版一致，启动前未告知用户可见影响，属沟通疏漏），用户正式应用全程健康。1h 运行于 782 秒（13 分钟）时按用户要求提前停止，回写 `Interrupted`，reason `USER_REQUESTED_SINGLE_INSTANCE_STOP_EARLY`；停止时健康（14 采样、1 工作流、0 错误）。
- 结束状态：两次运行均 `Interrupted`，`continuous24hVerified: false`。若未来恢复短检验，预期终态仍为 `PARTIAL`，reason `SHORT_HARNESS_CHECK_ONLY`。

## 语义

- 1 小时短检验能证明：该时段内无错误、资源采样连续、fixture 工作流可完成、期间源码未变。
- 它不能证明：24 小时不劣化（内存/句柄增长）、跨日稳定性。`continuous24hVerified` 保持 `false`，发布说明继续如实记录「24 小时持续验收未完成」。
- 源码哈希约束（不改 desktop/、server/、dist/、package.json、package-lock.json）适用至 1 小时运行结束。

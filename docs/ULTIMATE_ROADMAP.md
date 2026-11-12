# PROJECT NEXUS Ultimate Roadmap

## 已完成的本次阶段 A：审计与基线

- 读取并遵循 `application-development` skill。
- 检查当前代码、文档、测试、Git 状态和 live `data/state.json`。
- 研究 OpenHands、SWE-agent/SWE-ReX、Aider、Continue、Temporal、Dagger、GitHub Actions、Dependabot/Renovate、Electron/Tauri updater 的公开架构。
- 生成 Ultimate gap、architecture、security、deployment、user 和 test 文档。
- 基线：`npm test` 18/18、TypeScript、Vite build、隔离 API smoke、Playwright 导航断言均通过；真实 AI/GitHub 写入/Docker 目标构建仍按证据标记 BLOCKED。

## 阶段 B：P0 执行底座（当前优先）

### B1 Provider registry

- 多 provider 配置与能力声明。
- 任务角色路由、备用模型、超时/重试、usage/cost 归一化。
- 诊断 API 只返回脱敏状态；无凭据时明确 BLOCKED。

验收：provider 单元测试、超时/取消测试、无凭据测试；使用真实凭据时再做 live connection evidence。

### B2 AgentRun 与工具策略

- 持久化 phase/event/checkpoint。
- read-only、local mutation、build/test、remote write 四级工具策略。
- 失败诊断→修复→回归测试循环；每轮有上限和人工升级。

验收：可取消、重启恢复、重复请求幂等、敏感日志脱敏、diff 可复现。

### B3 安全门禁（本轮已完成首批）

- GitHub App OAuth state/CSRF：已加入一次性、10 分钟 state 校验。
- App-only installation 的统一访问判断：已覆盖扫描、Actions、releases 等项目路径。
- 收紧 CORS、补 CSRF/速率限制和真正身份前的部署边界说明。

## 阶段 C：本地 Agent 与沙箱

- Windows Agent 设备注册、短期 token、心跳、任务租约、断线恢复。
- 本地路径 allowlist、Git 分支权限、Docker/本机执行器分离。
- 资源配额、清理、日志 artifact 和取消传播。

## 阶段 D：AI Fix / Health / Workflow

- 构建、测试、类型、依赖和运行异常统一 Finding 模型。
- 真实健康评分与扣分证据。
- 可视化工作流、审批、批量隔离、重试和优先级。

## 阶段 E：发布与更新闭环

- 多平台构建矩阵、资产 digest、签名和 manifest。
- Draft → approval → publish → old-client install/launch evidence。
- 失败回滚和 staged rollout。

## 阶段 F：成本、灾备与扩展

- provider/project/task cost、预算、Docker 资源和告警。
- 自动备份、损坏检测、恢复演练和审计归档。
- 插件 API、通知渠道、多用户 RBAC；按真实需求评估 PostgreSQL/Redis。

每个阶段都必须留下命令、日志、输入、输出和状态分类；没有外部凭据或目标客户端时，不得把 BLOCKED 改成 PASS。

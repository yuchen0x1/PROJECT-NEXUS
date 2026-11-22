# PROJECT NEXUS Ultimate User Guide

## 推荐工作流

1. 在 Settings 配置 GitHub Token 或 GitHub App installation。
2. 在 Project Center 同步仓库；确认项目数量与 GitHub 一致。
3. 运行 Repository Scanner，查看 commit、证据路径、缺口和评分。
4. 在 AI Operations 选择任务类型和 provider；确认将发送的源文件范围。
5. 让 NEXUS 在隔离 workspace 生成 diff，查看日志、测试状态和外部前提。
6. 只有人工审查、测试 PASS、精确 repo/branch 确认后，才启用 Draft PR。
7. Release/Update Center 逐层确认构建、资产、digest、签名和旧客户端证据。

## 状态含义

- `PASS`：指定检查真实运行并通过。
- `FAIL`：检查运行但失败。
- `PARTIAL`：只验证了部分行为。
- `BLOCKED`：缺凭据、环境、权限或外部目标，不能声称完成。
- `NOT APPLICABLE`：该技术栈或流程不适用。

## 危险操作

远程 push、PR、Release、生产部署、删除文件、数据库迁移和发布签名都需要明确审批。不要把 provider 的文字输出当作测试或签名证据；以 NEXUS 的日志、退出码、diff、digest 和审计记录为准。

# PROJECT NEXUS Ultimate Security Audit

## 结论

当前系统适合受信任单用户、loopback 或已认证反向代理后的内部环境；不应直接暴露到不可信网络。远程写入默认关闭是正确的安全基线，但不能替代身份认证、CSRF、速率限制和审计主体。

## 已有控制（PASS/PARTIAL）

- GitHub/AI 凭据只在服务端读取，错误信息有脱敏。
- Webhook 使用原始 body 的 HMAC SHA-256 与 constant-time compare，并做 delivery 去重。
- workspace 进行路径 containment、realpath、符号链接、`.git`、secret-like 文件和大小/数量限制。
- Docker runner 默认无网络、非 root、cap-drop、no-new-privileges、CPU/内存/PID 限制。
- Draft PR 路由要求管理员、远程写入开关、精确 repository/branch 确认和 PASS 检查。
- CORS 默认只允许 loopback Vite origins，可通过 `NEXUS_CORS_ORIGINS` 明确扩展；空 Origin（CLI/server-to-server）仍可用。
- GitHub App 安装 state 现在是服务端签发、10 分钟过期且一次性消费；App-only 项目路由统一检查 installationId。

## P0 风险

1. 身份模型仍是进程环境变量；可选 role header 只能在远程写入关闭时存在。
2. 仍无 CSRF、速率限制和真正用户认证；部署必须放在可信 loopback 或认证 TLS 反代后。
3. JSON 写入队列是进程内的，多进程/崩溃可能导致更新丢失；远程写入前应有幂等键和 durable event。
4. Agent 变更应用需事务备份/回滚；当前工作区持久化和资源清理仍需配额。

## P1 风险

- 不可信仓库的 package scripts、Makefile、CI 配置不得自动执行；必须走明确的命令白名单和审批。
- provider 请求需要 host allowlist、超时、取消、重试上限、token budget 和敏感内容过滤。
- 日志、artifact、缓存和 trace 不得包含 API key、安装 token、私钥或完整 `.env` 内容。
- Release/Update 必须把 digest、签名验证和旧客户端启动证据分开记录。

## 建议的修复顺序

认证/CSRF/rate limit → Agent 工具策略与事务回滚 → durable queue/event log → 多用户 RBAC/设备认证 → 发布和更新签名闭环。

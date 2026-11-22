# PROJECT NEXUS Ultimate Deployment Guide

## 当前安全部署形态

1. 使用 Node.js 运行 API，Vite 构建产物由现有启动方式提供。
2. 复制 `.env.example` 为 `.env`，仅在服务端注入凭据。
3. 先备份 `data/state.json`，确认备份可读；不要在生产环境直接用测试脚本。
4. 默认绑定 `127.0.0.1`，或放在具备 TLS、身份认证、CSRF 防护和严格网络 ACL 的反向代理后。
5. 保持 `NEXUS_ENABLE_REMOTE_WRITES=false`，直到已经配置真实用户身份、审批、审计和回滚。

## 最小配置

```env
PORT=4317
NEXUS_HOST=127.0.0.1
NEXUS_STATE_FILE=./data/state.json
GITHUB_TOKEN=
GITHUB_OWNER=
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
NEXUS_ENABLE_REMOTE_WRITES=false
```

## Docker 与沙箱

沙箱默认 `network=none`、非 root、资源限制和临时容器；目标项目构建仍依赖可用镜像和预置依赖缓存。不要把容器当作绝对安全边界，不要挂载宿主机 Docker socket，不要把 secret 放入 workspace、镜像层或日志。

## 备份与恢复

- 停止写入或使用文件系统快照后复制 `data/state.json`。
- 校验 JSON 可解析、schemaVersion、项目/任务数量和最近审计记录。
- 恢复前保留当前文件副本；不得用未经校验的备份覆盖 live state。
- 迁移仅在明确审批后执行，并在 disposable fixture 上先验证。

## 生产前检查

`npm test`、TypeScript、production build、API smoke、反代健康检查、CORS/CSRF/rate-limit 检查、凭据轮换、备份恢复演练。没有真实 GitHub/AI/客户端证据的功能必须标记 BLOCKED。

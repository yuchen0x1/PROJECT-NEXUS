# GitHub 接入与监控配置说明

## 1. 凭据

监控引擎支持两种凭据来源，**优先级在请求时按仓库解析**：

| 来源 | 配置方式 | 说明 |
| --- | --- | --- |
| 环境变量 | `GITHUB_TOKEN`（PAT） | `server/index.mjs` 把 `githubTokenForProject` 注入 `tokenResolver`；无 installation 的项目返回该环境变量 |
| 应用内 GitHub App 安装 | 既有 `/api/github/app/*` 流程 | 带 `installationId` 的项目返回安装令牌，令牌过期前自动刷新 |

因此用户在应用界面里配置的 GitHub 凭据同样会被新的监控引擎使用，不要求额外配置一份环境变量。凭据永不写入日志、任务包或证据文件。

只读监控所需权限：`repo`（私有仓库）或 `public_repo`、`actions:read`、`security_events:read`（Dependabot / Code scanning / Secret scanning）。权限不足的扩展资源会降级为 `unavailable` 并单独记录，**不会导致整个扫描失败**。

## 2. 添加仓库

REST：

```http
POST /api/autonomy/repositories
Content-Type: application/json

{
  "fullName": "owner/repo",
  "localPath": "D:\\projects\\repo",
  "defaultBranch": "main",
  "pollIntervalMs": 900000,
  "monitorItems": ["issues", "issue_comments", "pull_requests", "pr_reviews",
                   "commits", "branches", "releases", "actions_runs",
                   "repository", "dependabot_alerts", "code_scanning_alerts",
                   "secret_scanning_alerts", "security_advisories"],
  "agentAdapterId": "chatgpt-desktop",
  "agentProjectRef": "My Project",
  "automationMode": "observe",
  "autoFix": false,
  "autoRelease": false,
  "webhookEnabled": true
}
```

界面：指挥中心 →「仓库监控」→ 填写 owner/repo、本地目录、客户端项目标识、执行客户端、监控周期。

监控周期预设：5 分钟 / 15 分钟（默认）/ 30 分钟 / 1 小时，也支持自定义 `pollIntervalMs`。

`fullName` 经过严格校验：必须恰好两段、仅允许安全字符、拒绝 `..` 等穿越片段。

## 3. 监控资源（13 类）

| id | GitHub 端点 | 范围 |
| --- | --- | --- |
| `issues` | `/issues?state=all` | core |
| `issue_comments` | `/issues/comments` | core |
| `pull_requests` | `/pulls?state=all` | core |
| `pr_reviews` | `/pulls/comments` | core |
| `commits` | `/commits` | core |
| `branches` | `/branches` | core |
| `releases` | `/releases` | core |
| `actions_runs` | `/actions/runs` | core |
| `repository` | `/repos/{owner}/{repo}` | core |
| `security_advisories` | `/security-advisories` | extended |
| `dependabot_alerts` | `/dependabot/alerts` | extended |
| `code_scanning_alerts` | `/code-scanning/alerts` | extended |
| `secret_scanning_alerts` | `/secret-scanning/alerts` | extended |

## 4. 增量同步机制

- 每个 `(repoId, resource)` 保存一个 `sync_cursors` 记录：`etag / lastSeenExternalId / lastSuccessAt / failures / nextAttemptAt / available`。
- 请求带 `If-None-Match`；GitHub 返回 **304** 时不解析响应体、不重新下载仓库。
- 首次同步只建立基线（`lastSeenExternalId`），不把历史 Issue 当成「新问题」批量生成任务。
- 之后只处理游标之前的新条目；每条事件用 `sha256(repoId|kind|externalId|version)` 做指纹，重复指纹直接跳过。
- 分页遵循 `Link: rel="next"`，单资源最多 20 页，每页 100 条。
- 429/403 读取 `Retry-After` 与 `x-ratelimit-reset`，按 `min(15min, 30s·2^n)` 退避；扩展资源 403/404 降级为 `unavailable` 而不阻断核心监控。

## 5. Webhook 与自动回退

- 新端点 `POST /api/autonomy/webhook` 接收 `x-github-event` / `x-github-delivery`，把事件规范化进同一事件模型并按 deliveryId 去重。既有 `/api/github/webhook`（含 HMAC 校验）保持不变。
- `engine.webhookHealthy(repo)`：只有 `webhookEnabled` 且最近一次投递时间在两个监控周期内才认为 Webhook 有效。
- Webhook 有效时，扩展资源跳过轮询（由事件驱动），核心资源仍按周期低频兜底轮询。
- **Webhook 停止投递后自动回到完整轮询模式**，无需用户干预。

配置 GitHub Webhook：Payload URL 指向本机的可访问地址（本地开发需内网穿透或反向代理），Content type `application/json`，事件勾选 Issues、Issue comments、Pull requests、Pull request reviews、Pushes、Releases、Workflow runs、Dependabot alerts、Code scanning alerts、Secret scanning alerts。若使用既有 `/api/github/webhook`，沿用其 secret 配置。

## 6. 「Issue 已关闭」≠「问题已解决」

`POST /api/autonomy/repositories/:id/issues/:number/assess` 会真实调用 GitHub 收集证据：

- timeline 中的 cross-referenced / referenced / closed 事件 → 关联 PR 与提交
- `GET /pulls/:n` → 是否合并、merge commit
- `GET /pulls/:n/reviews` → 是否 APPROVED
- `GET /compare/{base}...{mergeSha}` → 修复是否真的进入目标分支
- `GET /issues/:n/comments` → 是否有新评论重新报告问题 / 回归
- `GET /actions/runs` → CI 结论

结论写入 9 态生命周期：`PENDING_ANALYSIS / ANALYZED / AWAITING_FIX / FIXING / AWAITING_VERIFICATION / VERIFIED_RESOLVED / UNRESOLVED / REAPPEARED / UNCONFIRMABLE`，并附置信度与完整证据。

**保守原则**：没有关联 PR/提交、或无法证明不可复现时，一律 `UNCONFIRMABLE`，绝不伪造「已解决」。只有传入独立回归测试结果 `regressionTestResult: 'not-reproducible'`，且证据充分、无回归、无新报告时，才能到达 `VERIFIED_RESOLVED`。

## 7. 立即动作

| 接口 | 作用 |
| --- | --- |
| `POST /api/autonomy/control/scan-now` | 忽略周期，立即对所有仓库做一次增量扫描 |
| `POST /api/autonomy/repositories/:id/sync` | 单仓库立即同步，可传 `force` 与 `resources` |
| `GET /api/autonomy/monitor/runs` | 每次扫描的逐资源结果、事件数、错误 |
| `GET /api/autonomy/monitor/cursors` | 所有游标与退避状态 |
| `GET /api/autonomy/events`、`/findings`、`/issues` | 事件流、问题记录、Issue 生命周期 |

## 8. 真实验收记录

`docs/evidence/autonomy-v2-live-acceptance.json`（`node tests/autonomy-live-github.mjs`）：

- `rate_limit / repository / issues / pull_requests / commits / actions_runs / releases` 全部 HTTP 200；
- 首次扫描 6 个资源建立基线、0 错误；第二次 6 个资源全部 304；6 个 ETag 持久化；两轮 0 重复事件。

## 9. 远程写入

本引擎**默认不做任何远程写入**。创建 PR / 合并 / 创建 Release 复用既有的、受 `NEXUS_ENABLE_REMOTE_WRITES` 与角色门禁保护的 `delivery-stage.mjs` 通道；新引擎只准备变更摘要、测试报告、安全报告、版本号与 CHANGELOG，并给出发布门禁结论。详见 `docs/AUTONOMY_V2_PERMISSIONS.md`。

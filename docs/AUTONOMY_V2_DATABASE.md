# 数据库与迁移说明

## 1. 选型

新增自治运行时使用 **SQLite**（`node:sqlite` 的 `DatabaseSync`），文件位于 `data/autonomy.db`（由 `NEXUS_DATA_DIR` 决定目录；测试用 `:memory:`）。

选型依据：

- 实测本机 Node v22.22.2 无需启动参数即可加载 `node:sqlite`（仅有 `ExperimentalWarning`）。
- 需要跨进程重启恢复、append-only 审计、任务唯一 ID 查询与稳定索引，JSON 全量重写不适合 24/7 增量事件流。
- 不引入第三方原生依赖，避免 Electron 打包/N-API 兼容问题。

**降级路径**：若某个 Electron 构建的内嵌 Node 不含 `node:sqlite`，`openAutonomyStore` 自动改用接口完全一致的原子替换 JSON 存储（`data/autonomy.db.json` 风格文件），运行时不崩溃。`forceBackend: 'json' | 'sqlite'` 可强制指定，单元测试两种后端都覆盖。

## 2. 与既有状态的关系

| 存储 | 内容 | 本升级是否改动 |
| --- | --- | --- |
| `data/state.json`（schema v4） | 既有项目、任务、托管、集成、审计等 | **不迁移、不覆盖、不删除**，继续由原 `state-store.mjs` 管理 |
| `data/autonomy.db`（schema v2） | 新增的自治运行时全部实体 | 新建，独立文件 |

两者通过 `repository.fullName` 与 `localPath` 逻辑关联，不做双向同步。GitHub 凭据仍由既有 DPAPI 加密文件 / 环境变量提供，`tokenResolver` 在请求时读取，**不复制进新库**。

`data/` 已在 `.gitignore` 中忽略，`autonomy.db`、`autonomy.db-wal`、`autonomy.db-shm`、`.bak` 均不会进版本库。

## 3. Schema

```sql
CREATE TABLE records (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,          -- JSON document
  seq        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX records_collection_seq ON records(collection, seq);
CREATE INDEX records_collection_updated ON records(collection, updated_at);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE audit_seq (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL);
```

启动时 PRAGMA：`journal_mode = WAL`、`synchronous = NORMAL`、`busy_timeout = 5000`。

集合（16 个）：`repositories, sync_cursors, events, issues, tasks, task_events, adapters, agent_sessions, peer_projects, porting_proposals, verification_reports, releases, audit_log, settings, findings, monitor_runs`。

`audit_log` 与 `task_events` 是 **append-only**：`delete()` / `clear()` 对它们抛 `AUTONOMY_APPEND_ONLY`。

## 4. 迁移

`db.mjs` 的 `MIGRATIONS` 数组，`meta.schemaVersion` 记录当前版本，启动时按序执行、幂等（`CREATE TABLE IF NOT EXISTS`）：

| 版本 | 内容 |
| --- | --- |
| 1 | 初始 `records` / `meta` 表与 `(collection, seq)` 索引 |
| 2 | `audit_seq` 单调审计序列与 `(collection, updated_at)` 索引 |

未来新增版本只需向 `MIGRATIONS` 追加 `{ version, description, up(db) }`；启动时自动执行，无需用户手工操作。`GET /api/autonomy/db` 返回当前 backend、schemaVersion、各集合记录数与迁移清单。

## 5. 关键键设计

| 集合 | id 规则 | 去重语义 |
| --- | --- | --- |
| `repositories` | `repo_<uuid>` | `fullName` 由 API 校验，不重复添加 |
| `sync_cursors` | `<repoId>:<resource>` | 每资源一条游标 |
| `events` | `sha256(repoId\|kind\|externalId\|version)[:40]` | 主键即去重，重复事件直接跳过 |
| `findings` | `finding:<eventId>` | 一个事件最多一个问题记录 |
| `tasks` | `task_<uuid>` | `idempotencyKey = sha256(repoId\|kind\|findingIds\|source)` 业务去重 |
| `agent_sessions` | `session_<uuid>` | `sentPackageHash` 防止重复发送 |
| `issues` | `<repoId>:<number>` | 每 Issue 一条生命周期记录 |
| `peer_projects` | `peer:<fullName lowercase>` | 重复发现只更新 |
| `releases` | `release_<uuid>` | `contentFingerprint` 防止重复发布 |

## 6. 重启恢复

`createAutonomyRuntime` 打开数据库后立即调用 `engine.recover()`：

- `DISPATCHED / IN_PROGRESS / VERIFYING` → `AWAITING_HUMAN`，写入 `RESTARTED` 说明，**不重发任务**；
- 活跃 `agent_sessions` → `handoff: true`，要求人工确认客户端与 Git 工作区状态；
- `QUEUED` 任务保留，下个 tick 按优先级重新派发；
- 审计日志保留全部历史，`GET /api/autonomy/audit` 可查。

真实验证：以隔离 `NEXUS_DATA_DIR` 启动 `server/index.mjs` → 添加仓库并扫描 → 重启服务 → 仓库记录、9 个游标与 9 个 ETag 全部保留（见 `docs/AUTONOMY_V2_TEST_REPORT.md`）。

## 7. 损坏与备份

- SQLite：WAL 模式由 SQLite 自身保证原子性；不自动用备份覆盖当前库。
- JSON 降级后端：写入采用 `临时文件 → fsync → .bak → rename`；启动时若文件解析失败，抛 `AUTONOMY_STORE_CORRUPT` 并**拒绝覆盖原文件**（有单元测试）。
- 恢复前请退出应用，手工复制 `data/autonomy.db`（及 `-wal`/`-shm`）并核对，不要直接把 `.bak` 覆盖在线数据。

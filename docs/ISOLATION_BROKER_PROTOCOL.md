# 隔离宿主 Broker 协议 v1（B1 冻结稿）

本文冻结 [WINDOWS_STRICT_ISOLATION_EXECUTION_PLAN.md](WINDOWS_STRICT_ISOLATION_EXECUTION_PLAN.md) 交付物 I-1 的窄协议。2026-11-14 定稿，未实现。实现不得增加字段或放宽语义；确需变更时升主版本号并回写本文。冻结前基线：`tests/evolution-soak.mjs` 运行中，实现代码须待其结束后再动 `desktop/`、`server/`。

## 传输与进程边界

- 宿主进程（server 演进执行链）以子进程启动 broker，通信为 **stdin/stdout 的换行分隔 JSON**（一行一对象，UTF-8）。stderr 只用于人类可读诊断，不承载协议。
- 模型服务凭据只存在于宿主进程；broker 启动环境为**显式白名单构造**，不继承父环境（见「环境最小化」）。
- broker 拒绝多路复用：一次启动服务一个任务；结束即退出进程。

## 请求（宿主 → broker，单条）

```json
{
  "v": 1,
  "requestId": "<uuid>",
  "taskId": "<任务ID>",
  "workspaceRoot": "<任务私有临时副本的绝对路径>",
  "commands": [
    { "argv": ["node", "verify.mjs"], "cwd": "relative/under/workspace", "timeoutMs": 120000, "maxOutputBytes": 1048576 }
  ],
  "limits": { "maxProcesses": 8, "memoryBytes": 1073741824, "wallClockMs": 600000 },
  "network": false
}
```

约束：

- `commands[].argv` 是**参数数组**，不是 shell 字符串；`argv[0]` 必须命中编译进 broker 的绝对路径白名单（Node、项目测试运行器等），白名单在 broker 构建时固定，不接受请求下发。
- `cwd` 与所有路径参数解析后必须位于 `workspaceRoot` 内（解析符号链接后再判定）。
- `network` 协议常量为 `false`；v1 无开启网络的能力，需要网络的工具不属于 broker 范围。
- 未知字段 → 整请求拒绝（fail-closed），不忽略。

## 响应事件（broker → 宿主，流式多行）

| type | 语义 | 必含字段 |
| --- | --- | --- |
| `ready` | broker 初始化完成（profile/Job 就绪） | `v`, `requestId` |
| `started` | 某 command 已在受限上下文启动 | `index`, `pid`（broker 可见） |
| `output` | stdout/stderr 增量（受 maxOutputBytes 约束） | `index`, `stream`, `bytesBase64` |
| `denied` | 拒绝事件（见拒绝码表） | `code`, `detail`, `at` |
| `exited` | 某 command 正常退出 | `index`, `exitCode`, `durationMs` |
| `timeout` | 超时终止 | `index`, `limit` |
| `killed` | Job Object 上限/逃逸终止 | `index`, `reason` |
| `result` | 任务终态，最后一条 | `status`(`Completed`\|`Failed`\|`Denied`), `denials`, `usage` |

## 拒绝码表（与验收矩阵一一对应）

| code | 触发 |
| --- | --- |
| `E_SCHEMA` | 请求不符合本文（未知字段/类型/越界） |
| `E_PATH_OUTSIDE_WORKSPACE` | 解析后路径越出 workspaceRoot |
| `E_CMD_NOT_ALLOWLISTED` | argv[0] 不在构建期白名单 |
| `E_PROFILE_INIT` | AppContainer/受限令牌初始化失败（严格模式失败即关闭，不降级） |
| `E_OUTPUT_LIMIT` | 输出超限，进程终止 |
| `E_PROCESS_LIMIT` | 进程数超 Job 上限 |
| `E_MEMORY_LIMIT` | 内存超 Job 上限 |
| `E_NETWORK_BLOCKED` | 任务内进程尝试网络访问被记录 |
| `E_WALLCLOCK` | 总时限超限 |

每个 `denied` 同时写入任务事件流（I-5），验收以此记录为准。

## 环境最小化

broker 子进程环境只含：`PATH`（白名单工具链目录）、`SystemRoot`、`TEMP`（指向任务私有临时区）、`NEXUS_SANDBOX_TASK_ID`。显式排除 `GITHUB_TOKEN`、`AI_*`、`NEXUS_AI_PROVIDERS_JSON`、`NEXUS_UPDATE_PUBLISHER` 及一切凭据变量；宿主构造环境后逐项断言不包含凭据键名，断言失败即不启动。

## B3 fixture 用例（验收矩阵的执行形态）

实现完成后 `tests/isolation-host.mjs` 必须全部真实触发并断言对应拒绝码：

1. 读取 `~/.ssh`、宿主实例数据目录、另一注册仓库 → `E_PATH_OUTSIDE_WORKSPACE`
2. 写 workspaceRoot 外路径（含安装目录） → `E_PATH_OUTSIDE_WORKSPACE`
3. argv[0] 为白名单外可执行（含 `powershell -Command` 字符串形式）→ `E_CMD_NOT_ALLOWLISTED`
4. 任务内启动子进程试图连接 127.0.0.1 与外网 → `E_NETWORK_BLOCKED`
5. 衍生进程逃逸出 Job（ spawned 进程在 Job kill 后仍存活即测试失败）→ `killed`
6. 输出超限、内存超限、进程数超限、总时限超限 → 对应 `E_*` 与终止记录
7. 非法请求（未知字段、缺字段、路径含 `..` 解析逃逸）→ `E_SCHEMA` / `E_PATH_OUTSIDE_WORKSPACE`
8. profile 初始化失败注入 → `E_PROFILE_INIT`，且宿主确认严格任务关闭而非降级

## 状态

- B1（本文）：已冻结。
- B2–B5：未开始；依赖 soak 结束（代码目录解冻）与用户对 AppContainer profile / ACL 动作的逐项授权。

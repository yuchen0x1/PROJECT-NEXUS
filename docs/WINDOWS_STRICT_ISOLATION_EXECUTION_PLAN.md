# Windows 严格隔离执行方案

本文是 [WINDOWS_ISOLATION_AND_INSTALL_PLAN.md](WINDOWS_ISOLATION_AND_INSTALL_PLAN.md)「原生执行宿主」一节的具体实施计划。截至 2026-11-14：方案未实施，严格任务保持 BLOCKED，本文不代表任何系统修改已执行或已授权。

## 目标

把「严格模式无原生宿主时阻断」变为「任务在受限令牌 + AppContainer + Job Object 内真实执行，拒绝行为有记录」。验收矩阵见文末；缺任一边界不得宣布严格隔离可用。

## 本机约束

- 本机缺 MSVC（`cl.exe`/`vswhere.exe` 不可发现，见 [WINDOWS_DESKTOP_DECISION.md](WINDOWS_DESKTOP_DECISION.md)），第一步不能用需要 C/C++ 编译的原生模块。
- PowerShell `Add-Type` 可在内存中编译调用 Win32（`CreateAppContainerProfile`、`SaferCreateLevel`、`CreateJobObject`）的 C#，不需要外部编译器。方案先用该路径交付可用宿主，签名证书就绪后再编译为可签名的独立 `nexus-isolate.exe`。

## 交付物

| 编号 | 交付物 | 位置 | 说明 |
| --- | --- | --- | --- |
| I-1 | 隔离宿主 broker | `desktop/isolation/host.mjs`（编排）+ `desktop/isolation/sandbox.ps1`（受限执行） | 窄 stdin/stdout JSON 协议：任务 ID、允许命令白名单、超时、输出上限。不接受任意路径或开放式 shell 字符串。 |
| I-2 | AppContainer profile 管理 | `desktop/isolation/profile.ps1` | 创建/删除 NEXUS 专用 profile（`PROJECT.NEXUS.Task.Sandbox`），导出并记录 SID。 |
| I-3 | Job Object 限制 | `desktop/isolation/job.ps1` | 进程/内存上限、超时 kill、UI 限制；子进程创建时挂起，安全属性就位后再恢复。 |
| I-4 | 接入开关 | `server/services/` 演进执行链 | `NEXUS_STRICT_ISOLATION=1` 且宿主自检通过时，任务走 broker；自检失败保持现有阻断并写明原因。 |
| I-5 | 拒绝事件记录 | broker 输出 → 任务事件流 | 每次拒绝写事件（类别、路径、时间），供验收与 UI 展示。 |

## 实施顺序

1. **B1 协议冻结**：已完成，协议见 [ISOLATION_BROKER_PROTOCOL.md](ISOLATION_BROKER_PROTOCOL.md)（2026-11-14 冻结，v1，含 8 组 fixture 用例；未写实现）。
2. **B2 宿主实现**：`Add-Type` 编译 C# 完成三件事——受限令牌启动、AppContainer profile 创建（需要授权）、Job Object 限制。
3. **B3 负向测试**：`tests/isolation-host.mjs`，见验收矩阵；全部拒绝行为必须观察到并有记录。
4. **B4 运行时接入**：演进执行链增加宿主自检与开关；严格任务失败即关闭，不降级为普通执行。
5. **B5 证据固化**：验收输出存 `docs/evidence/isolation-acceptance.json`，报告入 `docs/maintenance/`。

## 验收矩阵（全部必须真实触发并记录拒绝）

- 读取未授权目录（用户 profile、其他仓库、凭据库、安装目录、实例数据目录）→ 拒绝 + 事件。
- 写入原项目目录与桌面安装目录 → 拒绝 + 事件。
- 网络连接（默认无网络能力）→ 拒绝 + 事件。
- 衍生进程逃逸出 Job Object → 终止 + 事件。
- 超时与内存/进程上限触发 → 按上限终止 + 事件。
- 非法协议输入（任意路径、白名单外命令、超限输出）→ 任务拒绝 + 事件。

## 需要用户单独批准的动作（届时逐项申请，不默认执行）

1. 创建/删除 AppContainer profile `PROJECT.NEXUS.Task.Sandbox`（含系统 profile 存储）。
2. 修改任务临时工作区与必要只读工具链的 SID ACL（改前导出现有 ACL，失败只回收本次创建对象）。
3. 网络策略测试（如需）。
4. 安装 VS Build Tools（仅当转入编译原生 `nexus-isolate.exe` 阶段时）。

不笼统授予整盘权限、不创建管理员账户、不改动现有用户权限。

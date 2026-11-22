# 桌面 AI 编程客户端接入说明

> 重要：**桌面客户端模式 ≠ AI API 模式**。本模式直接驱动 Windows 上已安装、已登录的客户端，不需要购买或配置 `AI_API_KEY`。两种模式完全独立，AI API 未配置不会让桌面模式变为不可用。

## 1. 已支持的适配器

| 适配器 ID | 客户端 | 检测来源 | 备注 |
| --- | --- | --- | --- |
| `chatgpt-desktop` | ChatGPT Desktop | MSIX 包 `OpenAI.Codex` + 进程 `ChatGPT` | 实测路径 `C:\Program Files\WindowsApps\OpenAI.Codex_...\app\ChatGPT.exe` |
| `workbuddy-desktop` | WorkBuddy | 卸载注册表 `DisplayName` + 进程 `WorkBuddy` | 实测路径 `E:\AppStoreSoftstore\Install\WorkBuddy\WorkBuddy.exe`，v5.11.3 |
| `codex-cli` | Codex CLI | 同一 MSIX 包内 `app\resources\codex.exe` | **与 ChatGPT Desktop 是同一安装包的不同入口**，无窗口，能力表独立 |
| `generic-desktop-N` | 自定义客户端 | 由 `genericConfigs` 提供 `processName/windowMatch/launcher/控件` | 配置驱动 |

检测是只读的：读取进程列表、MSIX 包清单、卸载注册表，**不读取应用数据、会话或凭据**。

## 2. 能力检测表

每个适配器对每个能力报告 `verified / partial / unsupported` 及证据，通过 `GET /api/autonomy/adapters` 查看，`POST /api/autonomy/adapters/probe` 重新探测。

| 能力 | 说明 | 当前等级 |
| --- | --- | --- |
| `detect` | 真实进程/包/注册表清单 | verified |
| `isRunning` | 进程列表 | verified |
| `launch` | 从包/注册表解析 launcher，detached 启动（不会误杀已开窗口） | partial（探测阶段不实际启动） |
| `loginState` | 无官方接口可读取登录态 | unsupported（永远显示 UNKNOWN，需人工确认） |
| `listProjects` / `selectProject` | UI Automation 可用时按 AutomationId/Name/ControlType 定位 | partial（控件未对真实客户端端到端验证） |
| `sendTask` | 按控件输入 + 调用发送按钮 | partial |
| `readExecutionState` | 真实 UI 文本启发式 + Git/测试的独立证据 | partial |
| `captureFailure` | 窗口矩形截图（非固定坐标） | partial |
| `closeSession` | 不主动关闭用户已登录会话 | unsupported |

**能力表不共享**：ChatGPT Desktop 与 WorkBuddy 分别计算；Codex CLI 明确标记 `windowless`，窗口相关能力为 unsupported。

## 3. Windows UI Automation 驱动

文件：`server/autonomy/desktop/uia-driver.ps1`（已加入 `asarUnpack`，打包后仍可调用）。

调用方式由 `server/autonomy/desktop/uia.mjs` 封装：
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File uia-driver.ps1 -Action <action> ...`

| Action | 作用 |
| --- | --- |
| `probe` | 加载 `UIAutomationClient`/`UIAutomationTypes`/`System.Drawing`，返回线程 apartment、会话、根元素子元素数 |
| `windows` | 枚举桌面顶层元素，按**窗口标题 + 拥有进程名**筛选（不用坐标） |
| `find` | 按 AutomationId / Name / ControlType 定位控件 |
| `set-value` | ValuePattern 写入；长任务包走 UTF-8 文件（`-ValueFile`），避免命令行长度限制 |
| `invoke` | InvokePattern 调用发送/选择按钮 |
| `read-text` | 读取窗口内 Text 控件，用于执行状态启发式 |
| `screenshot` | 按窗口自身 bounding rectangle 截图 |

安全约束：
- 找不到窗口返回 `WINDOW_NOT_FOUND`；多个候选返回 `WINDOW_AMBIGUOUS`；找不到控件返回 `CONTROL_NOT_FOUND` —— **一律停止，不随意点击、不猜测坐标**。
- 不使用固定 Sleep 判定完成：状态来自真实 UI 文本、进程存活与单调时钟超时，最终验收来自 Git diff 与测试。
- 窗口最小化/离屏时 `BoundingRectangle` 会是 Infinity，驱动已规范化为有限值，避免输出非法 JSON。

### 本机真实验证记录

`docs/evidence/autonomy-v2-live-acceptance.json` 与 `docs/evidence/autonomy-v2-uia-real-windows.json`：

- UIA 程序集加载成功（`UIA_LOADED`，STA，Session 1，根元素 12 个子元素）。
- 枚举出 12 个顶层窗口；按进程名/标题定位到：
  - `ChatGPT` / PID 45856 / `Chrome_WidgetWin_1`
  - `WorkBuddy` / PID 7316 / `Chrome_WidgetWin_1` / bounds 600,217,1747,1288

## 4. 自动选择项目（防止把 A 仓库任务发给 B 项目）

每个仓库必须配置 `agentProjectRef`（客户端内项目/工作区标识）与 `agentAdapterId`。发送前依次校验：

1. `agentProjectRef` 非空，否则停止（`PROJECT_SELECTION_UNCERTAIN`）。
2. UIA 找到的项目控件，其可访问名称必须包含该引用；否则停止。
3. 调用该控件完成选择；再对 `repo.agentProjectRef` 与 `repo.localPath` 做精确绑定校验。
4. 客户端工作区路径与仓库本地目录不一致 → 停止。

任何一步不确定都进入人工接管，不会把任务发到错误项目。

## 5. 任务包与幂等发送

`POST /api/autonomy/tasks` 生成任务后，引擎调用 `buildTaskPackage` 生成包含仓库信息、本地路径、分支、base SHA、问题列表与证据、代码位置、复现方法、预期结果、关联 Issue、同类项目参考、推荐方案、禁止修改项、测试要求、验收标准、文档/CHANGELOG 要求的完整任务包。

- 所有字段经 `redactSecrets` 脱敏；`auditPackageSecrets` 同时检查**结构化原始内容**和渲染文本；发现凭据直接拒绝发送。
- 会话记录 `sentPackageHash`；同一任务在会话处于非终态时重复发送会抛 `DUPLICATE_TASK_SEND`。
- 任务包文件落在 `data/autonomy-packages/`，可通过 `GET /api/autonomy/packages/:taskId` 读取（路径校验防止穿越）。

## 6. 人工接管闭环（UIA 不可用或控件无法识别时）

1. 会话状态转为 `NEEDS_HUMAN_HANDOFF`，任务转为 `AWAITING_HUMAN`。
2. NEXUS 生成完整任务包文件，并给出明确操作指引（打开客户端 → 选对项目 → 粘贴完整任务包 → 发送）。
3. 用户在界面上 `POST /api/autonomy/sessions/:id/resolve`，可选 `outcome: sent | completed | failed`。
4. 标记 `completed` **不会**直接判定成功：NEXUS 随即运行 `finalize`，对 Git diff 做范围审查、执行真实测试与安全扫描，由独立 Reviewer Engine 给出 PASS/FAIL。
5. 失败按上限 3 轮退避重派，之后留在人工队列。

这满足「对无法自动化的步骤实现可靠人工接管」，且不以 AI 的自我报告替代验收。

## 7. 已知边界

- 控件级自动化（真实聊天输入框的 AutomationId、发送按钮）**未在已登录的真实客户端上端到端验证**：这需要在用户会话内实际发送任务，属于需要用户明确授权的操作。当前默认 `agentProjectRef` 未确认时一律走人工接管，不会误发。
- Chromium/Electron 客户端可能不向 UIA 暴露 Text 控件（本机 WorkBuddy 读取返回 0 行），此时执行状态识别降级为「Git diff + 测试」与人工确认。
- 客户端界面升级导致控件无法识别时，适配器停止并报告，不会盲点。可通过适配器构造参数 `inputAutomationId / sendAutomationId / projectControlName` 等更新控件定位。

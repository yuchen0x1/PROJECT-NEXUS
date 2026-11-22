# COMPETITOR_ANALYSIS

- 研究日期：2026-11-16（Asia/Shanghai）
- 研究方式：优先使用 GitHub 官方仓库 README、目录、许可证、releases、commits/issues/PR 元数据和官方文档；不执行外部仓库代码。
- 研究数量：16 个项目。
- 许可证原则：只借鉴公开实现思路；未把外部代码复制进 PROJECT NEXUS。任何未来移植必须重新检查当前许可证、依赖许可证和版权义务。

## 2026-11-21：持久恢复与发布对标

本轮额外深入阅读 Temporal、Windmill 和 Prefect 的指定版本源码。采用 Prefect 的构建/发布权限分离；保留本地调度器，借鉴 Temporal 的重试 fencing 与 Windmill 的真实隔离能力探测。不新增外部运行时依赖。版本、许可证、源码、Issue/PR 与实施结果见 [研究记录](docs/RESEARCH_LOG.md) 和 [技术决策](docs/TECHNOLOGY_DECISIONS.md)。

## 1. 对标总表

| 项目 | 实际观察到的优势 | PROJECT NEXUS 现状 | 差距/风险 | 决策 |
| --- | --- | --- | --- | --- |
| [Cline](https://github.com/cline/cline) | 统一 agent core 覆盖 IDE、CLI、桌面、SDK；Plan/Act、checkpoint、MCP、子代理、计划任务和 Windows 发布链较完整。Apache-2.0。 | 已有本地 Agent runtime、Codex bridge、工作区隔离、审批和任务持久化；桌面是 Electron 工作站。 | NEXUS 的跨客户端会话模型和插件生态较窄；发布签名证据不足。 | 借鉴 checkpoint/会话恢复和多入口能力；不复制代码。 |
| [Continue](https://github.com/continuedev/continue) | 共享 CLI/IDE agent core，支持 TUI/headless、MCP、只读/自动/允许策略、AGENTS.md 和 CI PR review。Apache-2.0；当前仓库状态需按其最新声明判断维护性。 | 有桌面工作站、Web console、Agent runtime 和受控命令执行。 | 缺少成熟的 headless CI 任务入口和跨表面配置同步。 | 借鉴 headless 任务协议和权限档位。 |
| [OpenHands](https://github.com/OpenHands/OpenHands) | Agent Canvas、self-host、CLI/headless、Agent Server/ACP、多后端控制面、GitHub issue execution 和自动化。MIT。 | 有本地隔离 workspace、任务包、独立验收和桌面客户端接管。 | NEXUS 还没有多 Agent Server 控制面和统一 Canvas。 | 借鉴控制面/后端分离与人工接管视图。 |
| [OpenCode](https://github.com/anomalyco/opencode) | TUI + beta desktop；build/plan/subagent 权限模式、后台子代理、MCP events、Windows process daemon 和 mTLS。MIT。 | 有 observe/repair/autonomous、approval、command allowlist 和任务队列。 | 缺少可复用的后台 session/daemon 事件协议。 | 借鉴后台子代理事件和 shell handoff；评估 mTLS。 |
| [Aider](https://github.com/Aider-AI/aider) | repo-map 上下文、自动 git commit/undo、lint/test 反馈、云/本地模型和极简终端交互。Apache-2.0。 | 有项目索引、上下文窗口、工作区 diff、独立测试和回滚。 | NEXUS 上下文选择仍主要是固定索引/任务包，不够轻量。 | 借鉴 repo-map 评分、变更摘要和终端可恢复 UX。 |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | 约百行核心、单一 bash 工具、每次动作独立 subprocess，容易替换 Docker/Podman/bubblewrap；MIT；有可复现 SWE-bench 评估。 | 有命令白名单、worktree/copy、Docker runner 和 BLOCKED 状态。 | 严格隔离宿主在当前 Windows 会话不可用，评估指标未接入。 | 借鉴极简执行协议、sandbox adapter 和 benchmark receipt。 |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | issue-to-code 研究型 agent、YAML 可配置、SWE-ReX sandbox、评测导向。MIT；官方建议新实现优先 mini-SWE-agent。 | 已有 GitHub Issue 分类、修复流水线、独立验收和交付门禁。 | 缺少跨项目可比的任务成功率、回归率和成本指标。 | 借鉴评测数据模型；不引入旧实现。 |
| [Tabby](https://github.com/TabbyML/tabby) | self-host/on-prem、Rust 服务、OpenAPI、消费级 GPU、IDE client 和 Agent/PR 方向。许可证需按具体版本核对。 | 支持多 Provider、Ollama/openai-compatible 路径和本地桌面模式。 | 本地模型发现、硬件资源观测和统一 OpenAPI 能力较弱。 | 借鉴 provider capability schema 和本地资源诊断。 |
| [Dify](https://github.com/langgenius/dify) | 可视化 workflow、RAG、模型管理、observability、agent sandbox 和 Docker Compose。Dify Open Source License 有额外条件。 | 有任务编排、策略、托管、研究和安全扫描，但不是通用工作流画布。 | 复杂跨步骤工作流可见性和人工审批图不够。 | 借鉴流程图/approval 节点；不直接引入其许可证受限代码。 |
| [Open WebUI](https://github.com/open-webui/open-webui) | 离线 self-host、Ollama/OpenAI-compatible、多平台客户端、Open Terminal、Knowledge Base Sync、scheduled agent runs。新版本采用带品牌条件的 Open WebUI License。 | 有 Windows 桌面、Provider registry、项目索引和任务调度。 | 知识库、终端工作区与对话历史的统一体验较弱；许可证不适合盲目移植。 | 借鉴 offline-first/terminal workspace UX，仅重写兼容逻辑。 |
| [GPT Pilot](https://github.com/Pythagora-io/gpt-pilot) | 以任务步骤、代码生成、调试和人工 review 为中心，SQLite/PostgreSQL 存储。当前维护状态和 FSL 条件需谨慎核对。 | NEXUS 已有 plan → edit → verify → review 和任务事件。 | 老项目的流程可参考，但不应作为活跃技术基线。 | 仅作历史架构参考。 |
| [n8n](https://github.com/n8n-io/n8n) | 可视化工作流、AI 节点、人审、RBAC/audit、observability、1500+ integrations 和 MCP；Sustainable Use/Enterprise license，非普通 OSI 许可。 | 有 hosting strategy、审批、审计和 GitHub/AI 集成。 | NEXUS 缺少通用 connector/node SDK 和可视化流程编辑器。 | 借鉴节点契约、人工审批和运行记录；不复制代码。 |
| [Renovate](https://github.com/renovatebot/renovate) | 多包管理器依赖更新、更新 PR、merge-confidence、age/adoption/pass-rate、跨 Git 平台、SBOM/安全披露实践。AGPL-3.0。 | 有更新扫描、release plan、版本门禁和应用 updater。 | 依赖更新策略、分组、可解释性和 PR 复用还不够。 | 借鉴 update grouping、confidence 和证据记录；AGPL 仅隔离运行或重写。 |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | VS Code agent 交互、模式化任务、工具调用和编辑/终端反馈，适合观察 IDE agent 的可见性设计。 | NEXUS 主要是独立桌面工作站和任务包。 | 缺少 IDE 内逐步工具时间线和更细粒度的 diff 反馈。 | 借鉴工具时间线与模式切换。 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 终端 agent、工具 registry、模型/上下文抽象和可脚本化工作流，适合 CI/headless 集成比较。 | 有 Codex bridge、local-agent-runtime 和 Provider registry。 | 第三方 CLI 适配器数量和统一 session protocol 不足。 | 借鉴 adapter contract 和非交互执行 receipt。 |
| [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter) | 以本地代码/命令执行为核心，强调用户授权、交互式控制和多模型接入。 | NEXUS 有命令 allowlist、approval、workspace boundary 和回滚。 | 交互式工具确认和长任务输出压缩仍可提升。 | 借鉴授权 UX 与输出摘要；保持 NEXUS 的更严格隔离。 |

## 2. 关键结论

### 对方明显领先的方向

1. **多表面 agent 体验**：Cline/OpenCode/Continue 把同一 agent core 复用到桌面、IDE、CLI、CI；NEXUS 的优势是工作区、验收和交付控制，但入口还较少。
2. **可视化控制面**：OpenHands/Dify/n8n 把任务、工具、审批、后端和运行结果放进可解释图面；NEXUS 目前有指挥中心，但流程仍以页签和时间线为主。
3. **评测与证据**：mini-SWE-agent/SWE-agent/Aider 强调任务成功率、repo map、测试结果或 benchmark；NEXUS 有独立验收，但还没有长期趋势指标。
4. **更新和供应链成熟度**：Renovate/n8n 的发布资产、SBOM、依赖分组、可信提交和安全披露流程更完整。
5. **本地/离线模型体验**：Tabby/Open WebUI 把本地模型、终端、知识库和模型管理做成产品中心；NEXUS 有 Provider/Ollama 能力，但本地资源诊断较少。

### PROJECT NEXUS 反而领先或具有独特性

- Windows loopback + Electron 工作站 + 托盘常驻 + 本地 Agent 的一体化产品路径。
- 不采信 Agent 自报结果，使用独立 Git diff、测试、构建和安全门禁验收。
- GitHub Issue 关闭不等于解决，要求 PR、目标分支、测试、Review 和回归证据。
- GitHub App、Webhook HMAC、installation token、草稿 PR、合并/发布独立授权。
- 任务重启恢复、幂等、锁、凭据脱敏、state migration 和失败状态分类。
- 明确把 AI API、桌面客户端、扫描、任务生成、外部工具和发布签名分别诊断为 READY/PARTIAL/BLOCKED。

## 3. 借鉴边界

- **采用**：数据契约、状态机、可解释审批、repo-map 评分、限流/并发池、事件时间线、更新置信度和 benchmark receipt。
- **重新实现**：所有进入核心运行时的功能，按 MIT/Apache-2.0 允许的概念重新编码，并保存来源链接与许可证记录。
- **不直接集成**：Dify、Open WebUI、n8n 等附加条件或 source-available 许可证代码；Renovate AGPL 代码不进入同一分发产物。
- **不采用**：已声明不再维护或许可证/竞争限制不适合本产品的实现作为运行时依赖。



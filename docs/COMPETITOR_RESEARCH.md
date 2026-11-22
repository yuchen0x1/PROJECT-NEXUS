# 开源竞品源码研究

检查日期：2026-11-13。通过 GitHub REST API 读取固定提交的核心源文件、许可证、最近 3 次提交、4 条 Issue/PR 和最近 2 个 Release。原始源码仅保留在本地 test-results/ultimate-research，不执行、不导入、不复制到产品。

当前仓库未声明项目许可证，不能作无条件代码复制兼容结论。MIT/Apache-2.0 的项目只能作为设计参考；如以后复制代码，须另行核对目标许可证、具体文件头、NOTICE、第三方依赖及义务。

| 项目 | 许可证 | 源码观察 | NEXUS 决策 | 最近提交 | 最近 Release |
| --- | --- | --- | --- | --- | --- |
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | MIT | 独立子会话与 Worktree 隔离，UI 会话协议适配 | 子任务须携带完整简报，避免共享文件写入 | 2026-11-12T15:45:05Z | v1.40.0 |
| [cline/cline](https://github.com/cline/cline) | Apache-2.0 | 委派运行时、团队工具和显式工具策略 | 角色上下文独立，权限由宿主执行而非角色文本声明 | 2026-11-12T22:03:14Z | v4.1.26 |
| [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | Apache-2.0 | 每任务 checkpoint 服务、任务持久化、自动审批 | 检查点与实际工作区绑定，审批不能用无保护的自动允许覆盖 | 2026-05-15T18:04:45Z | v3.54.0 |
| [continuedev/continue](https://github.com/continuedev/continue) | Apache-2.0 | 会话历史服务与 LLM 适配、取消与退避 | 复用 NEXUS Provider，不另造模型协议 | 2026-07-21T04:00:09Z | v2.1.0-vscode |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | Apache-2.0 | 代码图缓存、上下文预算和有界修复重试 | 真正跳过未变化文件解析，保持来源与项目根绑定 | 2026-05-22T14:02:20Z | v0.86.0 |
| [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | MIT | 重试代理与跨尝试总费用统计 | 给每轮分配剩余预算，失败不能重置总预算 | 2026-07-16T15:21:18Z | v1.1.0 |
| [OpenInterpreter/open-interpreter](https://github.com/OpenInterpreter/open-interpreter) | Apache-2.0 | 当前默认分支为 Rust Agent 控制实现，包含 spawn、共享预算及用户授权 | 按当前源码记录，不能套用旧版 Python Interpreter 架构；保持总预算和权限交集 | 2026-11-11T02:57:27Z | rust-v0.0.61 |
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | Apache-2.0 | 会话轮次上限、工具注册、请求退避与中断 | 有限循环、取消贯穿请求和工具，不无限重试 | 2026-11-12T22:25:40Z | v0.69.0-preview.0 |

## OpenHands/OpenHands

检查提交：754abee4f0869dfc85dbd0acb6457f2e0ad17d4c；许可证 blob：f6f60f52368bcc96f82fbe59ec65049c2c3af9db（[原文](https://github.com/OpenHands/OpenHands/blob/754abee4f0869dfc85dbd0acb6457f2e0ad17d4c/LICENSE)）。元数据未标记归档。

读取的核心文件：

- [src/api/launch-child-conversation-client-tool.ts](https://github.com/OpenHands/OpenHands/blob/754abee4f0869dfc85dbd0acb6457f2e0ad17d4c/src/api/launch-child-conversation-client-tool.ts)，blob SHA 17ca1801115dc39575a32196bce3e93cd4950cf0。
- [src/api/conversation-service/agent-server-conversation-service.api.ts](https://github.com/OpenHands/OpenHands/blob/754abee4f0869dfc85dbd0acb6457f2e0ad17d4c/src/api/conversation-service/agent-server-conversation-service.api.ts)，blob SHA 68c4c78dca073276703d57821bc2a19be7d1d51d。
- [src/api/runtime-service/agent-server-runtime-service.ts](https://github.com/OpenHands/OpenHands/blob/754abee4f0869dfc85dbd0acb6457f2e0ad17d4c/src/api/runtime-service/agent-server-runtime-service.ts)，blob SHA e3341a6cfef95ddeb31a7007bf65585a8c610564。

检查到的 Issue/PR：[#19713](https://github.com/OpenHands/OpenHands/issues/19713)（open，2026-11-13T09:30:04Z）、[#19712](https://github.com/OpenHands/OpenHands/pull/19712)（open，2026-11-13T02:26:58Z）、[#19711](https://github.com/OpenHands/OpenHands/pull/19711)（open，2026-11-13T03:02:17Z）、[#19710](https://github.com/OpenHands/OpenHands/issues/19710)（open，2026-11-13T02:46:44Z）。

Release 记录：[v1.40.0](https://github.com/OpenHands/OpenHands/releases/tag/v1.40.0)（2026-11-12T14:22:00Z）、[v1.39.0](https://github.com/OpenHands/OpenHands/releases/tag/v1.39.0)（2026-11-11T17:14:58Z）。

## cline/cline

检查提交：72b3d7140553a733242126e51a7c2e87efe75c64；许可证 blob：05ae14a377caf4df24e26edde0c4f7b22ef3ef30（[原文](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/LICENSE)）。元数据未标记归档。

读取的核心文件：

- [sdk/packages/core/src/extensions/tools/team/multi-agent.ts](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/core/src/extensions/tools/team/multi-agent.ts)，blob SHA 4c5c6685de77a35cd12a60c81064526fe18412aa。
- [sdk/packages/core/src/extensions/tools/team/delegated-agent.ts](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/core/src/extensions/tools/team/delegated-agent.ts)，blob SHA 37c38b5bef970a3a19db44e63c9acd4c403447bc。
- [apps/cli/src/runtime/tool-policies.ts](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/apps/cli/src/runtime/tool-policies.ts)，blob SHA bac5b96578dec609339eff9c5a0e8e24a7f98599。

检查到的 Issue/PR：[#15707](https://github.com/cline/cline/issues/15707)（open，2026-11-13T07:33:23Z）、[#15706](https://github.com/cline/cline/pull/15706)（open，2026-11-13T02:27:25Z）、[#15705](https://github.com/cline/cline/pull/15705)（closed，2026-11-13T02:29:12Z）、[#15704](https://github.com/cline/cline/issues/15704)（open，2026-11-12T22:09:19Z）。

Release 记录：[v4.1.26](https://github.com/cline/cline/releases/tag/v4.1.26)（2026-10-26T09:06:50Z）、[sdk/sdk/v0.2.0](https://github.com/cline/cline/releases/tag/sdk/sdk/v0.2.0)（2026-10-26T03:34:08Z）。

## RooCodeInc/Roo-Code

检查提交：b867ec9145750d0ae1ff7f02d35406e9bf2a0b16；许可证 blob：302fa51c8a6e47ad20ae0092cc302a3af9f59107（[原文](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/LICENSE)）。仓库已归档。

读取的核心文件：

- [src/core/task/Task.ts](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts)，blob SHA 97f07fcc7aa4eda3e21598bc62c80e325e8c29e9。
- [src/core/webview/ClineProvider.ts](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/webview/ClineProvider.ts)，blob SHA 61a54f8ead728b829cf6f88d61ad3afac8e5cdc0。

检查到的 Issue/PR：[#12375](https://github.com/RooCodeInc/Roo-Code/pull/12375)（closed，2026-05-15T18:04:47Z）、[#12374](https://github.com/RooCodeInc/Roo-Code/pull/12374)（closed，2026-05-15T17:55:26Z）、[#12373](https://github.com/RooCodeInc/Roo-Code/pull/12373)（open，2026-05-15T18:32:24Z）、[#12372](https://github.com/RooCodeInc/Roo-Code/pull/12372)（closed，2026-05-15T17:29:05Z）。

Release 记录：[v3.54.0](https://github.com/RooCodeInc/Roo-Code/releases/tag/v3.54.0)（2026-05-15T17:52:24Z）、[v3.53.0](https://github.com/RooCodeInc/Roo-Code/releases/tag/v3.53.0)（2026-04-23T21:28:55Z）。

## continuedev/continue

检查提交：5522c6f44ca0ac3528b37244818fbfa39b5af470；许可证 blob：c25dc1768217ba50d454fcc06290d66886512872（[原文](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/LICENSE)）。元数据未标记归档。

读取的核心文件：

- [core/core.ts](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/core.ts)，blob SHA daba8ffaac549fd509c321c3ebae9a6b018b6dfa。
- [core/llm/index.ts](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/llm/index.ts)，blob SHA 1af44b2561463541fd6b9e0429979bfb110deb7f。

检查到的 Issue/PR：[#13480](https://github.com/continuedev/continue/issues/13480)（open，2026-11-13T09:33:55Z）、[#13479](https://github.com/continuedev/continue/issues/13479)（open，2026-11-12T08:55:56Z）、[#13478](https://github.com/continuedev/continue/issues/13478)（open，2026-11-11T09:42:51Z）、[#13477](https://github.com/continuedev/continue/pull/13477)（open，2026-11-10T08:56:21Z）。

Release 记录：[v2.1.0-vscode](https://github.com/continuedev/continue/releases/tag/v2.1.0-vscode)（2026-06-19T00:24:00Z）、[v2.0.0-vscode](https://github.com/continuedev/continue/releases/tag/v2.0.0-vscode)（2026-06-19T00:24:01Z）。

## Aider-AI/aider

检查提交：5dc9490bb35f9729ef2c95d00a19ccd30c26339c；许可证 blob：d645695673349e3947e8e5ae42332d0ac3164cd7（[原文](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt)）。元数据未标记归档。

读取的核心文件：

- [aider/coders/base_coder.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py)，blob SHA 56613782b02e756085d930554b8f9deeadeebb28。
- [aider/repomap.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py)，blob SHA 541bba6ef4a5385b8cf032201ec6e3f3e32a6ea6。

检查到的 Issue/PR：[#5977](https://github.com/Aider-AI/aider/pull/5977)（open，2026-11-12T18:07:06Z）、[#5976](https://github.com/Aider-AI/aider/pull/5976)（open，2026-11-12T18:07:07Z）、[#5975](https://github.com/Aider-AI/aider/issues/5975)（closed，2026-11-11T00:10:58Z）、[#5974](https://github.com/Aider-AI/aider/pull/5974)（open，2026-11-09T21:18:57Z）。

Release 记录：[v0.86.0](https://github.com/Aider-AI/aider/releases/tag/v0.86.0)（2025-08-09T17:42:19Z）、[v0.85.0](https://github.com/Aider-AI/aider/releases/tag/v0.85.0)（2025-06-27T23:47:09Z）。

## SWE-agent/SWE-agent

检查提交：3ea751c087f32b16e039a2233dd6eefecef325d5；许可证 blob：e702436e21844c5c519de31ab68277a6d3b427d9（[原文](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/LICENSE)）。元数据未标记归档。

读取的核心文件：

- [sweagent/agent/agents.py](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py)，blob SHA 4844aeb7c42e06121fe37ba223e9263c04b53c3b。
- [sweagent/environment/swe_env.py](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/environment/swe_env.py)，blob SHA cbe01952643decdf8c519b10a659e254e9a02384。

检查到的 Issue/PR：[#1638](https://github.com/SWE-agent/SWE-agent/pull/1638)（open，2026-11-12T22:51:19Z）、[#1637](https://github.com/SWE-agent/SWE-agent/pull/1637)（open，2026-11-12T18:06:21Z）、[#1636](https://github.com/SWE-agent/SWE-agent/pull/1636)（open，2026-11-11T18:44:35Z）、[#1635](https://github.com/SWE-agent/SWE-agent/pull/1635)（open，2026-11-11T04:40:19Z）。

Release 记录：[v1.1.0](https://github.com/SWE-agent/SWE-agent/releases/tag/v1.1.0)（2025-05-22T16:11:39Z）、[v1.0.1](https://github.com/SWE-agent/SWE-agent/releases/tag/v1.0.1)（2025-02-28T16:46:14Z）。

## OpenInterpreter/open-interpreter

检查提交：80d8f55385452457a625dbabc032f3003b9545b4；许可证 blob：4606e72e042564097e8780d66c1d4dcb611869bd（[原文](https://github.com/openinterpreter/openinterpreter/blob/80d8f55385452457a625dbabc032f3003b9545b4/LICENSE)）。元数据未标记归档。

读取的核心文件：

- [codex-rs/core/src/agent/control/budget.rs](https://github.com/OpenInterpreter/open-interpreter/blob/80d8f55385452457a625dbabc032f3003b9545b4/codex-rs/core/src/agent/control/budget.rs)，blob SHA 855072b9c4f0d28b4d6387e14c5d24ce485f9ad8。
- [codex-rs/core/src/agent/control/spawn.rs](https://github.com/OpenInterpreter/open-interpreter/blob/80d8f55385452457a625dbabc032f3003b9545b4/codex-rs/core/src/agent/control/spawn.rs)，blob SHA cfd5020634bb15449f56ff2d1dbabe9a4a88ab16。
- [codex-rs/core/src/agent/control/user_authorization.rs](https://github.com/OpenInterpreter/open-interpreter/blob/80d8f55385452457a625dbabc032f3003b9545b4/codex-rs/core/src/agent/control/user_authorization.rs)，blob SHA f8d2a374eddb7897610f62b8c64fc7ab0c6618d7。

检查到的 Issue/PR：[#1982](https://github.com/openinterpreter/openinterpreter/issues/1982)（open，2026-11-12T19:38:02Z）、[#1981](https://github.com/openinterpreter/openinterpreter/pull/1981)（open，2026-11-13T09:28:29Z）、[#1980](https://github.com/openinterpreter/openinterpreter/issues/1980)（open，2026-11-10T18:38:56Z）、[#1979](https://github.com/openinterpreter/openinterpreter/pull/1979)（closed，2026-11-11T02:57:28Z）。

Release 记录：[rust-v0.0.61](https://github.com/openinterpreter/openinterpreter/releases/tag/rust-v0.0.61)（2026-11-11T04:39:22Z）、[rust-v0.0.60](https://github.com/openinterpreter/openinterpreter/releases/tag/rust-v0.0.60)（2026-11-09T03:21:08Z）。

## google-gemini/gemini-cli

检查提交：b9776560ea5710bc673891499aaec68c737d160a；许可证 blob：7a4a3ea2424c09fbe48d455aed1eaa94d9124835（[原文](https://github.com/google-gemini/gemini-cli/blob/b9776560ea5710bc673891499aaec68c737d160a/LICENSE)）。元数据未标记归档。

读取的核心文件：

- [packages/core/src/core/client.ts](https://github.com/google-gemini/gemini-cli/blob/b9776560ea5710bc673891499aaec68c737d160a/packages/core/src/core/client.ts)，blob SHA 349a759b08fd361029f27e2f5da4420586d01cd7。
- [packages/core/src/tools/tool-registry.ts](https://github.com/google-gemini/gemini-cli/blob/b9776560ea5710bc673891499aaec68c737d160a/packages/core/src/tools/tool-registry.ts)，blob SHA 75e8e6cdfcaec75a919a2791e56993cf84aece38。

检查到的 Issue/PR：[#30269](https://github.com/google-gemini/gemini-cli/issues/30269)（open，2026-11-13T08:29:53Z）、[#30268](https://github.com/google-gemini/gemini-cli/pull/30268)（open，2026-11-13T06:48:51Z）、[#30267](https://github.com/google-gemini/gemini-cli/pull/30267)（open，2026-11-13T06:40:33Z）、[#30266](https://github.com/google-gemini/gemini-cli/pull/30266)（open，2026-11-13T06:22:47Z）。

Release 记录：[v0.69.0-preview.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.69.0-preview.0)（2026-11-10T21:05:08Z）、[v0.68.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.68.0)（2026-11-10T21:17:07Z）。

## 实施映射

- 角色独立上下文、依赖图、并发及预算：collaboration-engine.mjs 与 collaboration-roles.mjs，复用 NEXUS 工具/Provider。
- 检查点与持久化：evolution-store.mjs，复用原子写和跨进程租约，未知写入不重放。
- 增量理解：修复 agent/indexer.mjs 的实际缓存复用，project-memory.mjs 绑定项目根和来源时间。
- 权限与资源：角色不自授权限，脚本执行沿用明确可信授权；资源压力驱动准入，严格隔离和签名安装不能降级绕过。

以上源码观察不意味着完整审计了每个项目的全部能力，未在本机运行这些第三方项目。研究结论不等于 NEXUS 功能已经完成；测试和接线状态见 ULTIMATE_EVOLUTION_PROGRESS.md。

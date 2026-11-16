# UPGRADE_REPORT

- 交付日期：2026-11-16（Asia/Shanghai）
- 项目：PROJECT NEXUS
- 基线：main / v0.9.2
- 本轮目标：完成真实项目扫描、至少 15 个开源项目对标、形成 30+ 项升级清单、实施当前环境可验证的高价值修复、运行质量门禁并记录阻塞项。

## A. 竞品研究

### 研究数量

本轮研究了 16 个相关开源项目：

1. Cline
2. Continue
3. OpenHands
4. OpenCode
5. Aider
6. mini-SWE-agent
7. SWE-agent
8. Tabby
9. Dify
10. Open WebUI
11. GPT Pilot
12. n8n
13. Renovate
14. Roo Code
15. Gemini CLI
16. Open Interpreter

每个项目至少检查了官方仓库/README/目录或架构说明；重点项目还检查了许可证、近期提交/发布和 issue/PR 元数据。研究只提取设计与实现模式，没有复制外部代码。完整对标见 [COMPETITOR_ANALYSIS.md](COMPETITOR_ANALYSIS.md)。

### 最值得借鉴的方案

- Cline：同一 agent core 覆盖桌面、IDE、CLI、SDK，适合参考多入口与 checkpoint。
- OpenHands：Agent Server/Canvas/ACP 的控制面与后端分离，适合参考多后端工作区。
- OpenCode：后台子代理、Windows process daemon、MCP 事件和权限模式。
- Aider：repo-map、git undo、lint/test loop 的轻量上下文策略。
- mini-SWE-agent：极简工具协议、每次动作独立 subprocess 和可替换 sandbox。
- n8n：可视化 workflow、人审、RBAC/audit 和运行记录。
- Renovate：更新分组、置信度、跨平台 PR 和供应链安全资产。

### 许可证结论

MIT/Apache-2.0 项目适合借鉴概念并重新实现；Dify、Open WebUI、n8n、GPT Pilot 和 Renovate 的许可证包含额外条件或 copyleft 义务，未直接引入其代码。许可证必须在真正集成时按当前 commit 再审查。

## B. 升级数量与状态

总计划：36 项。

| 状态 | 数量 | 编号 |
| --- | ---: | --- |
| 本轮完成 | 9 | EV-001–EV-005、EV-007–EV-009、EV-018 |
| 基线已有并保留 | 13 | EV-010–EV-014、EV-019–EV-025、EV-035 |
| 部分完成 | 5 | EV-015、EV-029、EV-032、EV-034、EV-036 |
| 计划/外部阻塞 | 9 | EV-006、EV-016–EV-017、EV-026–EV-028、EV-030–EV-031、EV-033 |

“本轮完成”均有代码或配置差异；“基线已有”不重复虚报为本轮新增；“部分/阻塞”保留真实原因。

## C. 本轮代码和配置变更

### 修改文件

- [server/index.mjs](server/index.mjs)
  - 接入 request ID、安全响应头、API rate limit、API 404、全局错误边界。
  - 设置 Node request/header/keep-alive timeout。
  - settings API 增加 token/App/installation 分层状态。
- [server/services/competitor-research.mjs](server/services/competitor-research.mjs)
  - 默认研究候选从 5 调整为 15。
  - 增加并发池 3。
  - 限制 AI synthesis prompt 总长度和单候选摘要预算。
- [server/services/http-hardening.mjs](server/services/http-hardening.mjs)
  - 新增请求 ID、headers、fixed-window limiter、404/error contract。
- [src/main.tsx](src/main.tsx)
  - Web 与 Electron 入口改为 lazy + Suspense。
- [src/styles.css](src/styles.css)
  - 增加首屏加载状态样式。
- [src/api.ts](src/api.ts)
  - 同步 settings API 新字段类型。
- [.env.example](.env.example)
  - 增加 NEXUS_API_RATE_LIMIT 配置。
- [tests/unit/http-hardening.test.mjs](tests/unit/http-hardening.test.mjs)
  - 新增 HTTP hardening 单元测试。
- [tests/unit/competitor-research.test.mjs](tests/unit/competitor-research.test.mjs)
  - 增加 15 候选/并发约束断言。

### 新增文档

- [PROJECT_AUDIT.md](PROJECT_AUDIT.md)
- [COMPETITOR_ANALYSIS.md](COMPETITOR_ANALYSIS.md)
- [UPGRADE_ROADMAP.md](UPGRADE_ROADMAP.md)
- [UPGRADE_REPORT.md](UPGRADE_REPORT.md)

### 删除/迁移

- 未删除用户文件、项目数据、配置或历史报告。
- 未修改 data/state.json；未执行数据库迁移。
- 本报告生成时尚未提交、推送、创建 PR、发布或部署；后续已将本轮变更整理为 v0.9.3 并发布。

## D. 测试结果

### 本轮已运行

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| npm run typecheck | PASS | tsc --noEmit 退出码 0 |
| npm run lint | PASS | eslint --max-warnings=0 退出码 0 |
| npm test / vitest | PASS | 74 个测试文件、422 个测试通过 |
| npm run build | PASS | Vite 生产构建成功 |
| HTTP hardening + competitor focused tests | PASS | 2 个文件、12 个测试通过 |
| loopback API smoke | PASS | 实际启动 Express：health 200、request ID/安全头生效、未知 API 404、缺 token 401 |
| npm run i18n:coverage | PASS | 十语言覆盖率均为 100% |
| npm run i18n:audit | FAIL/PARTIAL | 结构性问题 0，但扫描到 17 个既有硬编码 UI 字符串和 5 类 CSS 颜色，脚本按现有规则退出 1；本轮未伪装成通过 |
| npm audit --package-lock-only --json | BLOCKED | 当前 npm registry 为 registry.npmmirror.com，该端点返回 404 NOT_IMPLEMENTED；没有据此声称依赖安全 |
| 真实 GitHub 写入/AI 生成/签名更新 | BLOCKED | 本轮没有凭据、授权或签名安装环境，未执行外部写入 |
| 真实 24 小时 Windows soak | NOT RUN | 本轮未占用长时间桌面会话 |
| Docker 严格隔离 | BLOCKED | 现有文档记录当前 Docker engine/严格宿主条件未满足 |

### 构建观察

本轮入口 lazy split 已接入并通过 build。当前构建产物显示 index-BP-yjHWI.js 约 369 kB，App 与 Workstation 分别约 157 kB/160 kB，未再出现此前约 685 kB 入口的 500 kB chunk warning。冷启动、内存和页面切换数字仍需后续性能预算任务记录；构建警告不能被当成失败，也不能只靠调大 warning threshold 解决。

## E. 项目变化

### 升级前

- 产品功能广度已经较高，包含自主运维、Agent runtime、GitHub 交付、更新、安全扫描和多语言桌面界面。
- 竞品研究默认只深读 5 个候选。
- API 缺少统一 request ID、rate limit、未知 API 404 和全局安全错误契约。
- Web/Electron 入口静态加载，构建有较大的入口 chunk 警告。
- 设置 API 不能区分 PAT、GitHub App 和 installation。
- 发布签名、原生更新回滚、多用户身份和严格 Windows 隔离仍未闭环。

### 升级后

- 默认竞品研究覆盖 15 个候选，深读并发固定为 3，AI prompt 有 120,000 字符上限。
- API 具备统一 request ID、安全 headers、no-store、rate limit、Retry-After、404 和安全错误体。
- Node HTTP server 有显式请求、headers 和 keep-alive timeout。
- Web/Electron 入口按运行表面 lazy load，首屏有可见 loading fallback。
- 设置诊断区分 tokenConfigured、appConfigured 和 installation 数量。
- 新增 9 个本轮完成项的单元验证；已有能力和未完成外部条件仍按真实状态保留。

### 仍然不够的地方

- 未完成 Authenticode 签名、安装备份、启动健康检查和回滚。
- 未完成真实多用户身份、严格 Windows 隔离宿主和 24 小时 soak。
- 外部安全工具和 npm advisory audit 仍依赖可用工具与 registry。
- 15 候选研究的 UI 分页、来源快照哈希和 benchmark receipt 仍是下一批升级。
- 未做真实 GitHub/AI 远程写入；不能把 fixture 或代码存在性当成生产闭环。

## F. 下一阶段执行顺序

1. 先完成 EV-006/EV-014/EV-015：签名、更新事务和外部安全工具。
2. 再完成 EV-016/EV-017：严格宿主和真实身份边界。
3. 完成 EV-026–EV-028：研究 provenance、15 候选审阅和 Agent benchmark receipt。
4. 建立 EV-030–EV-036 的 release/performance/soak 门禁。


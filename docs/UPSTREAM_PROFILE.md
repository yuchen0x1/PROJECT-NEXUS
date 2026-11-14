# Repository Upstream Profile — 仓库来源档案

> 总开发指令第三部分（多仓库管理与项目来源智能识别）的核心落地。2026-11-14 完成。

## 解决什么问题

用户管理的仓库来源各异：正式 Fork、Clone 后独立开发、ZIP 下载重传、基于他人二开项目继续修改。系统不再假设统一的 Fork 关系，而是为每个仓库建立**来源档案**，并保留证据与置信度。

## 来源类型与判定方式

| 类型 | 含义 | 判定依据 |
| --- | --- | --- |
| `fork-verified` | 正式 Fork（A） | GitHub 单仓库接口返回 `parent`/`source`（置信度 1.0） |
| `clone-common-history` | 有共同提交历史的 Clone（B） | GitHub compare 跨仓库 API 证明共同祖先（merge base），记录 ahead/behind（置信度 0.9） |
| `zip-reupload-declared` | ZIP 下载重传（C） | 用户显式申报；随后仍尝试验证 |
| `third-party-declared` | 第三方二开延续（D） | 用户显式申报；随后仍尝试验证 |
| `unknown` | 无法可靠确认（E） | 无证据即保持未知 |

**硬性规则（指令 §3.1）：绝不根据仓库名称猜测并自动绑定候选上游。** 类型 C/D 必须用户显式申报；类型 B 必须有 GitHub compare 证据；申报后若证明出更强的证据（Fork/共同历史），类型自动升级但申报记录保留。

## 实现

- 服务：`server/services/upstream-profile.mjs`（纯逻辑，GitHub 访问注入，可单测）
- API：
  - `POST /api/projects/:id/upstream/detect`（body 可带 `upstreamFullName` 候选）
  - `POST /api/projects/:id/upstream/declare`（`{upstreamFullName, kind: 'zip-reupload'|'third-party', version?, note?}`）
- 存储：`project.upstreamProfile`（state.json，含 type/upstream/confidence/evidence[]/declared/mergeBase/checkedAt），随 `GET /api/projects` 返回
- UI：构建中心新增「上游档案」面板（检测/申报/证据链）；项目卡片显示来源徽章
- i18n：`git:upstream.*`，10 语言全过

## 三方比较的位置

当前已把上游基线的"身份与证据"落库。ZIP 重传（类型 C）的**内容级三方比较**（原始基线 ↔ 用户版本 ↔ 上游最新，区分双方各自改动与冲突）是下一阶段工作，将基于本档案的 `declared.upstreamFullName` 作为比较目标。

## 验收证据

- 单测 7 项 PASS：A/B/E 判定、无共同祖先不绑定、申报保留与升级、声明不被证据清空（该用例抓出并修复了 merge 覆盖 `declared` 的真实 bug）。
- 真实 compare API 形状核验（gh CLI，expressjs/express ← lady707/express）：`status/ahead_by/behind_by/total_commits/merge_base_commit.sha` 全部符合实现假设。
- vitest 全量 348/348 PASS；typecheck、eslint、build 通过；i18n 10 语言 0 问题。

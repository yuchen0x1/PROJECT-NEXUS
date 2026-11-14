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

## 三方比较（已实现，2026-11-15）

ZIP 基线的内容级三方比较已落地（`server/services/upstream-baseline.mjs`）：

- **建立基线**：记录申报上游在指定 ref 的完整文件清单（路径 → git blob SHA，上限 2 万条），存于 `dataDir/upstream-baselines.json`。
- **三方比较**：按 blob SHA 对「基线 ↔ 用户仓库当前 ↔ 上游最新（自动解析上游默认分支）」逐路径分类，**不下载任何文件内容**——哈希相同即内容相同。
- **分类输出**（指令 §3.2 全矩阵）：冲突（双方都修改 / 双方各自新增 / 你删上游留 / 你改上游删）、上游变更（可移植候选）、上游删除、你的改动、已同步、双方未动；列表每类封顶 400 条并保留总数，树过大时如实标记 truncated。
- API：`GET/POST /api/projects/:id/upstream/baseline(/capture|/compare)`；UI 在构建中心「上游档案」面板新增基线区块（建立/比较按钮、计数摘要、冲突与上游变更清单）。
- 单测 6 项覆盖全分类矩阵、持久化往返、截断与空树防御。

## 验收证据

- 单测 7 项 PASS：A/B/E 判定、无共同祖先不绑定、申报保留与升级、声明不被证据清空（该用例抓出并修复了 merge 覆盖 `declared` 的真实 bug）。
- 真实 compare API 形状核验（gh CLI，expressjs/express ← lady707/express）：`status/ahead_by/behind_by/total_commits/merge_base_commit.sha` 全部符合实现假设。
- vitest 全量 348/348 PASS；typecheck、eslint、build 通过；i18n 10 语言 0 问题。

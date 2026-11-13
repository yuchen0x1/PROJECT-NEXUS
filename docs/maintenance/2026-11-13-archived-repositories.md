# 托管仓库归档状态优化记录

2026-11-13（Asia/Shanghai）。源码基线：`main` / `09b8c05`；开始时工作区干净。本地交付版本 0.8.4。

## 行为与数据

原仓库同步的归一化过程遗漏 GitHub 返回的 `archived` 字段，选择组件也没有读取旧检查记录中的 `repoMeta.archived`，因此归档项目和普通项目混在一起。

现在令牌同步与 GitHub App 同步共用的归一化过程保留该布尔值；旧元数据中的归档位同步更新；不会为隐藏归档项目而删除仓库记录，既有托管策略和工作区信息保留。轻量检查也更新该状态。字段约定以 [GitHub 仓库 API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)为依据。

选择列表默认隐藏已归档仓库，显示开关仅用于查看。归档行有「已归档」标记且不可选择；其他行显示「正常更新」，含义为未归档，不是运行中的任务状态。全选作用于所有可托管仓库，不受搜索影响；数量也只计算这些仓库。默认选择跳过首个归档项目，轮询剔除已归档或已不在列表中的选项，同时保留用户手动取消。

确认和各批量阶段开始前重新读取当前列表。开启托管前再次核对 GitHub 实际状态；新发现归档时返回 `REPOSITORY_ARCHIVED`、保存状态并清除旧检查凭证。归档状态纳入检查凭证指纹，解除归档并同步后恢复可选。已有启用策略或运行中任务不会被此列表改动自动删除或中止。

## 验证

| 状态 | 范围 | 结果 |
| --- | --- | --- |
| PASS | `npm run typecheck`、`npm run lint`、`node --check server/index.mjs` | 类型、静态检查与服务端语法通过 |
| PASS | 定向 Vitest 回归 | 10 文件 / 46 项通过：API 同步/归档拦截、检查凭证、批量重试、托管门禁、状态持久化、总览及语言资源 |
| PASS | `node tests/archived-repositories-desktop.mjs` | 真实 Electron 窗口验证默认隐藏、标签、禁选、数量、搜索/全选、轮询、新归档剔除、全部归档、解除归档及窄窗口 |
| PASS | `node tests/app-update-ui.mjs` | 新日志版本摘要与此前更新栏布局、排序、状态、主题和缩放回归通过 |
| PASS | `npm run build -- --logLevel warn` | 构建通过，保留既有主包大小提示 |
| PASS | Windows NSIS 本地打包 | `npx electron-builder --win nsis --x64 --publish never --config.directories.output=release-v0.8.4` 成功 |
| PASS | `node scripts/verify-desktop-update.mjs release-v0.8.4` | 安装包版本、大小、SHA512、blockmap 与内置更新源匹配 |
| PASS | `NEXUS_ARCHIVE_TEST_EXECUTABLE` 指向本版打包 EXE 后运行同一选择测试 | 打包程序与实际桌面桥接通过，隔离临时数据，未写真实仓库 |
| PASS | `npm run i18n:audit`、`npm run i18n:coverage` | 十语言覆盖完整，既有 CPU 与颜色扫描提示保留 |

定向命令为：

```text
npx vitest run tests/unit/server-api.test.mjs tests/unit/setup-readiness.test.mjs tests/unit/setup-batch.test.ts tests/unit/overview-layout.test.ts tests/unit/i18n-resources.test.mjs tests/unit/i18n-keys.test.mjs tests/unit/hosting.test.mjs tests/unit/hosting-gates.test.mjs tests/unit/state-store.test.mjs tests/unit/project-overview.test.mjs --maxWorkers 1
```

发现原默认测试配置只包含 `.mjs`，既有批量与布局的 `.test.ts` 被漏过。本次补齐两种扩展名，两组既有 TypeScript 测试均实际运行并通过。此次不将定向回归写成全库回归。

## 本地产物检查

1. 总览：使用 `reverse-engineering-exposure-audit` 只读检查本地 Electron 包；相对评分 31/D，与 0.8.3 基线相比没有新增或加重发现，不作为整体安全认证。
2. 发现：安装包 `NotSigned`；既有 Electron fuse、第三方二进制及 ASAR 可读边界保留。没有为本次列表功能改动安全宿主结构。
3. 证据：扫描 75 个文件、7 个二进制。ASAR 清单、版本及服务端/构建入口与本地源码对照通过；未发现实际 `.map` 或运行数据/凭据库文件。见[扫描](../evidence/v0.8.4-exposure.json)与[人工核对](../evidence/v0.8.4-package-inspection.json)。
4. 客户端边界：用户 GitHub/AI 凭据不随包下发，DPAPI 与 ASAR 不能防御同一用户权限下的恶意程序；没有新增商业授权判定。
5. 后续顺序：继续排除运行数据，公开发布前核对签名与真实旧客户端更新链；后台启动结构调整后再评估 fuse 收紧。本次没有改动 GitHub 归档状态或新建 Release。

## 交付边界

只读核对过公开 GitHub 列表中的归档字段；没有将它记作完整账号或私有仓库验收。功能流程使用隔离 fixture API 与临时 profile，未修改现有用户安装目录、凭据或真实仓库托管策略。旧记录安装后需要主动同步一次 GitHub。

本地安装包摘要见 [v0.8.4](../releases/v0.8.4.md)。没有推送版本标签或发布公开 Release，自动更新通道仍指向已公开版本；安装和真实跨版本自动重启不属于本次已验证范围。

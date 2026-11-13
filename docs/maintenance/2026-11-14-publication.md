# v0.8.6 自动更新通道发布记录

2026-11-14（Asia/Shanghai）。用户明确要求将新版安装包发布到自动更新通道。

## 发布结果

- [v0.8.6 Release](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.6) 已于本地时间 00:16:06 公开，非草稿、非预发布，并设为 GitHub Latest。
- 标签指向 `0deed0e16eec01dcb4cc5d096a656c4a71981ad6`，包含已验证的 0.8.6 应用代码和发布说明。标签保持不变，未覆盖历史版本。
- 使用现有 Windows 发布工作流生成公开安装包，经检查后先上传全部四项资产，再公开发布。没有将本地候选改名冒充 CI 产物。
- 发布说明汇总首次启动教学，以及 0.8.2 之后的更新栏、日志、归档筛选和仓库同步修复；发布页不重复显示版本大标题，文档链接指向仓库中的实际文件。
- README、版本索引及自动更新文档已更新为实际公开状态。

## 资产

公开安装包 `PROJECT-NEXUS-0.8.6-win-x64-setup.exe`，122,858,987 字节，SHA256 `bc343b27df6a3825eca27d2611e4084beac140431f2b29f4ff9a0a87f655e7d3`。另有对应 blockmap、`latest.yml` 与 `SHA256SUMS.txt`，具体摘要及下载地址见[发布回执](../evidence/v0.8.6-publication.json)。

此前的本地候选大小及摘要不同，保留在[本地验收记录](2026-11-13-first-use-guide.md)，不用于公开资产校验。

## 验证

| 状态 | 范围 | 结果 |
| --- | --- | --- |
| PASS | 本地完整回归 | `npx vitest run --bail 1 --maxWorkers 2`，59 文件 / 316 项通过 |
| PASS | 本地类型与 lint | `npm run typecheck`、`npm run lint` 退出 0 |
| PASS | [Windows CI](https://github.com/yuchen0x1/PROJECT-NEXUS/actions/runs/43459735920) 第 2 次运行 | 预检、类型、lint、完整 59 文件 / 316 项、构建、安装包清单核验、上传与发布均成功 |
| PASS | 四项公开资产完整回读 | 所有文件大小和 SHA256 与 GitHub Release 元数据一致 |
| PASS | 安装包与清单 | SHA512 与 `latest.yml` 一致，大小匹配，SHA256 与 `SHA256SUMS.txt` 一致 |
| PASS | 匿名访问更新入口 | `/releases/latest/download/latest.yml` 的内容与已发布清单相同，版本为 0.8.6 |
| PASS | 旧版真实更新检查 | 隔离运行的未修改本地 0.8.2 显示 available / 0.8.6，使用真实 GitHub 更新源；[回执](../evidence/v0.8.6-update-discovery.json) |
| PASS | 安装程序版本和签名识别 | ProductVersion=0.8.6，Authenticode=NotSigned |
| PARTIAL | 真实跨版本下载安装、重启及回滚 | 未执行安装；发现新版不能替代这一验收 |

第一次 CI 在 Windows 命令执行预检中发生 15 秒超时，没有发布资产。同一代码开启诊断后重跑成功，未删除检查、延长超时、修改执行器或减少测试。运行编号为 `43459735920`，成功 attempt 为 2。

旧版检查使用本地 0.8.2 打包程序，桌面入口和更新模块与公开标签源码一致。通过该旧版实际支持的子进程 LOCALAPPDATA 指向临时目录；启动前已核对路径处理，启动后再次确认实际 dataPath，隐藏窗口运行。没有使用会禁用更新的 smoke 模式，没有覆盖或安装到用户当前程序目录，也未使用真实 GitHub / AI 凭据。检查只调用更新发现接口，未请求下载安装程序。

安装包仍未签名。Windows CI、完整资产回读和真实更新发现均已验证，真实安装、自动重启和数据迁移没有因此被标记为已通过。

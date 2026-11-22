# 默认模型选择 · 0.5.1

配置 AI 时，默认模型输入框旁提供「获取模型」按钮。先填写 API 地址与密钥即可读取列表，不要求先输入模型或保存连接。选择列表项会填入默认模型，手动输入仍然可用；最终可用性由「保存并测试」确认。

## 行为与兼容性

- 支持设置向导中的 OpenAI compatible、OpenAI、Anthropic 和 Gemini 模型列表协议。保留网关路径前缀，避免重复追加 `/v1`；Gemini 列表排除明确标记为不支持文本生成的模型。
- 获取失败显示对应提示，支持重试。有效空列表、不支持列表、无权限、限流、网络失败、响应无效和超时均保留手动输入。
- 切换类型、地址或密钥会清除旧列表，过期响应不能恢复旧结果。成功后在控件挂载完成时定位到下拉框，避免被小窗口底部操作栏遮挡。
- 只读取远端列表，不保存草稿、不创建占位服务商、不切换默认模型。已有服务商名称、优先级与能力设置继续保留。
- 新密钥只经受信任的桌面 IPC 临时传递；保存的密钥在主进程解密。仅在服务商 ID、类型和地址匹配时复用，修改地址或类型需重新输入。禁用请求重定向，不返回远端错误正文。
- 请求总超时 15 秒，单页最多 1 MiB，最多 5 页、500 个去重模型。截断时显示提示，不将部分结果伪装为全部结果。没有增加依赖。

## 验证证据

| 检查 | 结果与证据 |
| --- | --- |
| TypeScript | PASS · `npx tsc --noEmit`，见 [日志](evidence/model-picker-types.log) |
| 前端构建 | PASS · `npm run build`，见 [日志](evidence/model-picker-build.log) |
| 完整单元回归 | PASS · `npm test`：43 文件、239 项，见 [日志](evidence/model-picker-tests.log) |
| 源码桌面界面 | PASS · 中英文完整教学，覆盖未保存草稿读取、失败重试、选择、手动输入、列表清除、加密密钥复用及后续七步，见 [中文](evidence/model-picker-ui-zh-CN.log)、[英文](evidence/model-picker-ui-en-US.log) |
| 安装后桌面界面 | PASS · 中英文完整流程，包含模型列表位于底部操作栏之上的检查，见 [中文](evidence/model-picker-installed-zh-CN.log)、[英文](evidence/model-picker-installed-en-US.log) |
| 安装包冒烟 | PASS · 真实安装程序启动、API 认证、数据位置及解包的 Windows 命令执行器，见 [日志](evidence/model-picker-installed-smoke.log) |
| 当前真实网关 | PASS · 返回 11 个模型，包含已保存的 `gpt-6-luna`；密钥未回传到输入框，见 [记录](evidence/model-picker-live.json) 与 [截图](screenshots/model-picker/live-provider.png) |
| 安装和数据保留 | PASS · 安装退出码 0，安装后 ASAR 与构建产物哈希一致，7 个配置 JSON 哈希全部不变，见 [安装证据](evidence/model-picker-install.json) |

真实服务检查使用临时凭据副本，不保存模型或启用用户仓库任务。其他协议经过本地 HTTP fixture 验证，未使用相应厂商的真实账号验收。

## 安装产物

- 文件：`release-model-picker/PROJECT-NEXUS-0.5.1-win-x64-setup.exe`
- 大小：122113775 字节。
- SHA256：`187A25C79B447FB0145352187AFA75BBB292E1CBB0D0DA125CEBD7C176F12D13`
- 原应用与用户数据备份：`C:\Users\lenmo\AppData\Local\PROJECT NEXUS Backups\20261113-141326-model-picker`。未恢复或覆盖用户配置。

## 实现依据

模型协议参考 [OpenAI List models](https://developers.openai.com/api/reference/resources/models/methods/list)、[Anthropic List Models](https://platform.claude.com/docs/en/api/models/list) 和 [Gemini Models](https://aistudio.google.com/api-reference/models)。模型名称来自实际接口响应，不内置可用模型名单。

此版本为本地预览，尚未提交、推送或公开发布；安装包没有代码签名。模型列表成功仅表示接口返回模型，具体调用权限与可用性仍需保存并测试。

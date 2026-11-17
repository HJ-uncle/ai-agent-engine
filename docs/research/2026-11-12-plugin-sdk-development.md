# 插件 SDK 与本地开发模式验收

<!-- documentation-status: historical -->
> 历史资料：保留原有调研、设计或验收条件，不代表当前版本全部行为或本轮测试结果。现行操作与源码入口见[文档首页](../README.md)；文档状态见[全量清单](../documentation-inventory.md)。状态标注：2026-11-17。


日期：2026-11-12。涉及 `D:/dev/ai-agent-engine` 与 `D:/dev/aether-code`。

## 问题与实现

原会话质量校验需求需要读取绑定会话、选择消息、调用平台已有模型。旧插件作者反复读取工程协议仍无法获得这些接口，最终退化成手工粘贴与另配模型。此次增加可执行的宿主能力，并让脚手架直接生成本地工程。

- `plugin_get_template` 一次返回模板目录、开发流程与 SDK 摘要；`plugin_scaffold` 可通过 `directory` 在工作区生成完整工程，含清单、源码、页面、类型、快速指引与案例。
- 开发模式直接读取工程目录，修改后手动刷新。每次执行校验源码 hash，使用临时快照；开发预览和已安装发布版分开管理。
- 同工程、同插件 ID 刷新保留仍声明的授权，新增能力默认关闭，移除声明撤权，改变插件 ID 清空授权。
- `$AE` 在受信页面和宿主启动的 Node 工具中提供会话、平台模型、AI、Agent、Skills、MCP、知识库、工作区与插件设置。页面额外提供工具调用、导航、服务与下载。
- 插件管理支持单插件、批量及开发权限配置。已安装授权绑定修订；插件设置与平台密钥分开存储。
- 内置浏览器提供受信插件标签，复用页面桥与会话绑定。普通网站不注入 SDK。开发浏览器标签独立持有开发会话，关闭时停止相关调用和 Agent。
- 插件 Agent 使用真实 ReAct 与持久子代理执行器，支持沿用上下文继续。每次模型或工具操作检查授权与工作区绑定；任务中切换工作区会拒绝后续写入，子代理不能借 Node 插件递归启动 Agent。
- 修复 Windows 瞬态文件占用导致版本保存失败：仅对指定错误有界重试，保留原子重命名、版本冲突保护和写入锁。未提交的初次安装不会出现在列表。
- 最后的真实客户端模型测试发现空报告假成功：插件漏传平台思考配置和输出窗口，适配器回退到 4096 tokens。已改为统一模型解析与参数，空正文、纯思考、截断和未完成响应均明确失败；页面清空旧结果并禁用导出。

## 验证证据

最终引擎构建：`sha256:ecd2094941a8d9b294349f5cfc5ab8de1f70e7dfe5ff72f8ca27c256df2cb2d2`。

| 验证层 | 结果与范围 |
|---|---|
| 引擎 TypeScript 与构建 | `npm run typecheck`、`npm run build` 通过 |
| 引擎插件测试 | 25 个文件、287/287；覆盖真实 Node、租户/会话、权限撤销、工作区切换、Skills 文件、SQLite 知识库、真实 JSON-RPC、Agent 生命周期、实际模型 SDK 请求参数和故障注入 |
| 前端 TypeScript 与构建 | `npm run build` 通过，包含 node/web typecheck |
| 前端相关测试 | 33 项不同用例通过，含纯逻辑、真实 Electron 交互、真实引擎开发运行；最新浏览器变更后 12 项宿主回归与 2 项浏览器验收通过，空报告修复后 session-review 4/4 通过 |
| 联网模型与 AI 脚手架 | 开发模型 `deepseek-v4.1-flash-1017`，隔离引擎读取 3 条消息、选择 2 条并真实分析；254 输入 / 470 输出 tokens。Aether Agent 用 2 次工具完成模板脚手架：`plugin_get_template → plugin_scaffold`，未创建安装草稿 |
| 客户端到真实模型闭环 | 精确解包交付 v2 ZIP，真实 Electron 中打开开发工程、授权、绑定会话、选择 2 条消息与模型、点击分析。真实报告 234 输入 / 3294 输出 tokens，约 21.5 秒；安装记录 0，renderer 错误 0 |
| 精确交付包 | `ai-session-review.zip` 经真实导入、安装、发布与 Node 业务案例验证 |

引擎日志：`.e2e-tmp/plugin-sdk-final-validation/engine-tests-v2.log`。

最终联网模型与客户端证据：`.e2e-tmp/plugin-sdk-acceptance/2026-11-12T13-48-06-231Z-93c2d343/report.json`、`live-analysis.json`、`ui-live-analysis.json`、`ui-live-model-result.png`。真实结果指出 PNG、透明通道、批量与压缩前后大小的缺口，以及覆盖原件违反需求。隔离客户端与引擎已关闭，模型数据库、WAL、凭据副本与客户端 profile 已清除，开发源凭据文件校验未变；未读取正式会话。

真实客户端浏览器截图：`D:/dev/aether-code/.e2e-tmp/plugin-browser-final-results/`。此处的模型交互夹具只证明 UI/桥契约；以上最终 run 另外完成了客户端到真实模型的完整调用，未使用接口拦截或伪造结果。

交付目录：`.e2e-tmp/plugin-sdk-final-validation/delivery-v2/`，版本 `1.0.1`。ZIP SHA-256：`4d5ae81c39fd4f8b0ed007173c0dbce12cbacad7b9d85a7af33c857f7d03671a`。基于真实 AI 生成的工程补入本次空报告修复；旧包与失败证据保留，不作为最终交付。

重跑入口（先完成两仓库 build，串行启动 Electron）：

```powershell
node scripts/diagnostics/plugin-sdk-live-model.mjs --run --source-profile <已授权开发profile> --ui-plugin-archive .e2e-tmp/plugin-sdk-final-validation/delivery-v2/ai-session-review.zip
```

## 使用与边界

「插件 → 开发模式 → 工程目录」打开后，选择会话并授予需要的权限，即可预览、运行与刷新。正式分发再导出 ZIP、导入、测试和发布。完整协议见 [插件工程规范](../plugin-project-v1.md) 与 [前端贡献协议](../plugin-ui-contributions.md)。

- 两次工具调用验证的是取得模板脚手架；任意复杂需求仍须实现并验收。
- `session.messages` 提供消息与附件元数据，不能假装已分析附件内容。工作区 SDK 当前提供目录与文本文件读写，单文件最多 1 MiB。
- 已安装插件设置持久保存，开发设置随开发会话释放。插件不获得平台模型密钥或全局设置写权限。
- SDK 授权不等于操作系统沙箱，Node 插件仍是本机代码。
- 浏览器插件标签可使用 `$AE`，尚不接入普通网页的原生 AI 点击/截图工具。
- 本次更新与验证是源码和构建产物；没有将新桌面安装器发布到正式环境。正式环境须更新客户端和引擎后再使用此 SDK 插件。

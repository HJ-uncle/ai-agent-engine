# 插件工程内部维护地图

本文只记录封装、模板、导入和宿主装配的维护入口。开发者清单、协议、SDK 和完整示例统一维护在前端 [HTML 插件参考](../../aether-code/docs/plugin-api/content/manifest.html)，这里不复制公开字段和接口表。

## 工程结构与唯一清单

`src/plugins/project.ts` 负责工程读取、检查和导出，`service.ts` 负责管理权威、路径与修订。分发工程以根目录 aether-plugin.json 为唯一清单。管理服务保存 manifest 时同步包内清单，导出时重新生成，避免管理元数据与包内文件分叉。

静态依赖需自包含，不打包凭据、数据库、租户记录或安装后的依赖目录。源文件、路径和 Schema 规则见 [文件约束](../../aether-code/docs/plugin-api/content/manifest.html#file-constraints)。当前没有旧的 100 文件、1 MiB 单文件或 8 MiB 工程配额，仍保留类型、路径、引用完整性和参数结构校验。

## 运行协议

工具执行与结果解析在 `runtime.ts`，工程独立测试驱动在 `project-runner.ts`，产物处理在 `artifacts.ts`。公开请求/结果见 [工具协议](../../aether-code/docs/plugin-api/content/manifest.html#tool-protocol)。

维护时验证 EOF、UTF-8 分块、顶层错误、非零退出、无效 JSON、取消进程树和输出背压。独立 npm test 验证确定性业务值及可选产物精确值，不替代宿主 Schema、路径、页面、真实模型和权限验证。独立测试未设置 AETHER_PLUGIN_TEST_TIMEOUT_MS 或值为 0 时不附加执行期限；显式正整数才限定毫秒时长。

## 官方模板和脚手架

模板权威在 `templates.ts`，会话分析模板在 `session-review-template.ts`，SDK 声明由 `sdk-contract.ts` 提供。前端、AI 管理工具和 `scripts/plugin-project.ts` 共用模板目录。当前模板包括 json-tool、markdown-report、time-calculator、currency-converter、desktop-timer、session-review。

模板生成清单、入口、README、QUICKSTART、SDK 类型、独立测试驱动和样例。`create-input.ts` 保证模板创建与自定义源码互斥：宿主先构建完整工程，再封存待批准操作，避免模型重新抄写实现。改模板时同步审阅测试、表单和说明；货币示例使用用户提供汇率，不宣称实时行情。

CLI 的 templates / init / check / test / pack 是维护入口。init 不覆盖已有目录；check 与 pack 不执行代码；test 执行并断言样例；ZIP 不应放回源工程。临时工程和诊断产物使用 `.e2e-tmp/`，不污染根目录。

## 桌面批量导入

`batch-import.ts` 编排批量，`importer.ts` 负责单项作业和安装，`zip.ts` 负责归档验证；前端处理选择、预览、错误与选中项安装。安装得到草稿，发布独立；已有 ID 不覆盖，同批冲突需反馈。单项失败不撤销已成功项，重试先核对原作业。

取消、重新预览或退出时清理本次拥有的未安装暂存作业，不清理生产插件。核对取消和网络失败分支，避免丢失作业 ID 后重复安装。

### 批量导入预览

preview-batch 接收一个导入来源，不是拼接多个 Base64 ZIP。原生总包只展开一层 plugins/*.zip；根清单存在时按普通插件处理。说明、证据与截图是辅助文件，不作为插件安装。未知布局、危险路径、链接、重复项、加密和损坏归档仍需拒绝。

当前 maxPlugins 是可选正整数，省略时不施加旧的 20 项默认配额。ZIP 源码没有旧的 20 MiB、64 MiB 或 4096 条目插件专项容量上限；实际传输仍受部署和系统资源约束。修改资源策略需分别审阅上传、归档解析和解压内存，不把“无插件专项配额”写成无成本。

## AI 创建与手动创建

AI 管理入口是 `management-tools.ts`，只读发现入口在 `read-tools.ts`，操作回执由 `mutation-receipts.ts` 等模块支持。结构化选择插件管理工具包才授予相应工具，历史消息中的 @ 文本不构成授权。管理角色、会话安全策略和能力开关是独立检查。

前端开发模式走 `dev-session.ts` 和 `temporary-snapshot.ts`：绑定工程、可选会话和权限，刷新重读源码，执行前验证快照，退出取消其拥有的调用与 Agent。开发预览不自动登记正式导航、hooks 或持久后台任务。

## 发布后直接操作

`application.ts` 返回固定发布修订的公开元数据、示例和页面文档。直接调用固定修订，不复用允许草稿执行的开发接口，不注册会话工具，也不把返回产物写入工作区。

正式挂载只读取已发布且启用目录。`catalogue.ts`、`catalogue-stream.ts` 及前端宿主同步目录，不能以打开插件管理页作为激活前提。UI 目标由宿主绑定，业务参数不是身份来源。

## 平台 SDK 与权限

| 实现 | 维护责任 |
|---|---|
| sdk-contract.ts、capability-contract.ts | Node/页面类型与能力参数契约 |
| capabilities.ts | 22 项权限目录 |
| capability-runtime.ts、node-sdk.ts | 当前修订、授权、会话与工作区边界、SDK 派发 |
| agent-capability.ts、agent-configuration.ts | 任务、模型、工具配置、继续和取消 |
| agent-execution-root.ts、agent-registry-authority.ts | 执行归属、持久确认和父子实时权威 |
| agent-tool-registry.ts | 六组、33 个基础工具精确允许列表 |
| workbench-binding.ts、host-context.ts | 宿主目标和委派绑定，拒绝业务 JSON 伪造权威 |

公开签名和例子见 [平台 API](../../aether-code/docs/plugin-api/content/platform.html)、[页面 API](../../aether-code/docs/plugin-api/content/page.html)、[权限](../../aether-code/docs/plugin-api/content/permissions.html)。执行框架内部具备某能力，不代表插件 Agent 已装配对应工具。

## 扩展与边界

页面、浏览器、服务和后台维护入口见 [UI 内部地图](plugin-ui-contributions.md)。JSON 原生组件不能注入 React 模块，没有动态结果绑定；浏览器插件标签不等于浏览器控制 API；Office 和成果管理没有公开插件 SDK。

services 是前端服务状态与可选内存截止时间；background 是引擎落盘、恢复和重试的周期调度。桌面计时器模板不能证明跨重启调度正确，远端连接断开也不证明服务器任务停止。公开说明见 [服务](../../aether-code/docs/plugin-api/content/contributions.html#services) 和 [后台](../../aether-code/docs/plugin-api/content/events.html#background)。

# 插件系统内部维护地图

本文面向 Aether 维护者，记录实现分层、存储和验证入口，不是开发者 API 参考。公开文档唯一来源是前端仓库的 [HTML 正文](../../aether-code/docs/plugin-api/content/overview.html)，构建后入口为 [插件参考站](../../aether-code/docs/plugin-api/dist/index.html)。修改公开行为时同步 HTML 与示例，不在本目录另建协议副本。

Aether 只有一个默认界面。「插件」管理页、开发模式、直接打开插件页面和会话选用工具是不同入口。前端承载见 [UI 内部地图](plugin-ui-contributions.md)，工程创建与导入见 [工程维护地图](plugin-project-v1.md)。

## 原生包

清单、源文件和引用验证以 `src/plugins/service.ts` 为准；参数验证由 `schema.ts` 实现；贡献和原生页面分别由 `contributions.ts`、`native-ui.ts` 校验。字段签名、完整示例和实际限制统一维护在 [插件文件与清单](../../aether-code/docs/plugin-api/content/manifest.html)。

`runtime.ts` 为每次工具调用创建独立 Node 进程，发送一次 UTF-8 请求后关闭 stdin，解析最后一个非空 stdout 行。模块导出不会被自动调用。非零退出码、无效结果和顶层错误分别进入失败路径；嵌套业务结果不由宿主猜测成功与否，测试需断言业务值。

产物需按执行入口分开审阅：

- 主会话插件工具通过 `artifacts.ts` 写入文件变更账本，使用路径锁和回执，拒绝覆盖已有文件及冲突路径，支持会话回退。
- `application.ts` 的用户操作接口和工具测试只返回产物预览。
- 平台工作区写入走权限和路径边界；直接调用 Node 文件或网络接口的副作用，不会自动纳入产物回退。

## 生命周期与存储

PluginService 是管理页与 AI 管理工具共用的存储权威。创建得到未启用草稿；保存产生不可变修订；发布验证当前修订与内容哈希并启用。作者版本与平台修订号不同，编辑草稿不会自动替换当前发布版。

会话工具包固定为 `plugin-<id>--r<revision>`，同一会话不能选择同插件的多个版本。发布不替换正在执行调用的快照；后续能力调用仍复核启用状态、修订、权限与绑定。管理工具、能力校验和开发工程分别位于 `management-tools.ts`、`capability-runtime.ts`、`dev-session.ts`。

默认根目录为 `dirname(DATA_DIR)/plugins/`，按租户散列隔离。`record.json` 保存管理元数据，`revisions/<revision>/snapshot.json` 和 `files/` 保存不可变快照及文件。设置、租户标记、导入作业和 `.background.json` 调度状态也落磁盘。SQLite 不保存插件源码。执行进程、页面连接、近期事件和前端服务计时器是运行态，不能视为长期业务存储。

停用阻止后续调用；卸载删除插件自身源码与修订，不删除工作区产物。前端在停用、修订替换和引擎切换时撤销挂载和旧回执；后台调度器取消所拥有的执行。

## 导入范围

`importer.ts` 处理原生目录、ZIP、GitHub 仓库或子目录及受支持的 Remark 适配。GitHub 来源固定 commit，预览不执行源码。`zip.ts` 校验归档结构、路径、重复项、链接、解压结果和 CRC，不应恢复已经移除的旧源码容量和文件数配额。

Remark 适配使用独立 unified/remark 管线执行封存源码。安装阶段禁止 npm 生命周期脚本，依赖树和 lockfile 随修订校验；不是任意 GitHub、VS Code、Cordis 或 MCP 包的通用兼容层。

导入作业持久化，可查询、取消和重试；已安装作业重复提交返回原记录。原生包可导出固定修订；含适配器依赖的插件按受支持来源重装，不能导出缺少依赖的伪自包含包。批量编排见 [工程维护地图](plugin-project-v1.md#桌面批量导入)。

## 执行边界

Node 子进程隔离故障和生命周期，**不是操作系统沙箱**，以引擎进程用户身份运行。安全模式拒绝无法约束副作用的执行。`application.ts` 用户操作接口使用引擎默认安全策略，不能借用猜测的会话 ID 绕过限制。

当前默认不附加插件专属超时、V8 堆、输入输出容量或并发配额。可选调用配额需显式传入；日志通过磁盘缓冲和流式背压处理，返回的 stderr 仅保留最多 64 KiB 尾部预览，省略早期内容时标记 `stderrTruncated`。运行缓冲结束后清理，不是完整日志归档。取消需终止本次拥有的进程树。

环境仅保留平台必要变量，Electron 显式设置 `ELECTRON_RUN_AS_NODE=1`，不继承 API key、NODE_OPTIONS 或代理秘密。原生包不自动安装 npm 依赖，也没有插件专用秘密配置、任意常驻 activate/dispose 入口或市场自动升级。

插件 Agent 由 `agent-capability.ts`、`agent-execution-root.ts`、`agent-tool-registry.ts` 等模块组成，复用平台执行根、持久交互和子代理上下文，但只开放明确登记的六组、35 个基础工具。Office、浏览器控制、成果、工作台和管理工具不因主 Agent 可用而自动开放。自定义工具、MCP、Skills 按实时权限装配，子代理不能扩张父任务权力。公开范围见 [Agent API](../../aether-code/docs/plugin-api/content/platform.html#agents-tools)。

`lifecycle-runtime.ts` 负责近期事件与 hooks；`background-runtime.ts` 负责落盘周期调度。调度归引擎进程所有：桌面内置引擎随应用退出停止，远端引擎生命周期独立。服务 UI 截止时间与持久后台调度是不同机制。

## API 与验证

内部路由位于 `src/api/http/routes/`，调用上述领域服务。公开插件使用平台 SDK，不依赖这些 HTTP 路径。管理鉴权由 `access.ts` 统一执行：启用认证时要求 admin 或 plugin-manager；关闭认证时允许对应本地身份。能力授权与会话确认独立。

`catalogue-stream.ts` 与 `change-events.ts` 推送同一存储根、租户内的目录变化。`GET /api/v1/plugins/runtime/changes` 初连发送 refresh，后续发送 update；重连重新读取目录，不借用会话游标，不传源码或聊天内容。心跳不扫描磁盘，慢连接合并通知，断连释放资源。前端宿主按当前发布目录协调挂载。

按变更选择既有测试，不把入口存在记为已通过：

| 领域 | 测试 |
|---|---|
| 清单、Schema、修订、权限 | `src/plugins/__tests__/metadata-validation.test.ts`、`schema.test.ts`、`service-runtime.test.ts`、`capability-contract.test.ts` |
| 子进程、SDK、流式背压 | `electron-runtime.test.ts`、`node-stream-sdk.test.ts`、`capability-stream.test.ts`、`project-runner.test.ts` |
| Agent 与工作台绑定 | `agent-capability.test.ts`、`agent-catalogue.test.ts`、`workbench-binding.test.ts` |
| 导入与目录同步 | `importer.test.ts`、`batch-import.test.ts`、`catalogue-stream.test.ts` |
| hooks 与后台 | `lifecycle-background.test.ts` |
| 会话选用 | `src/api/http/routes/__tests__/session-toolkits-chat.test.ts`、`src/storage/session/toolkits.test.ts` |

HTML 维护命令和审阅规则见 [维护说明](../../aether-code/docs/plugin-api/maintenance.html)。监控实现变更后先交叉审阅再显式运行 docs:review，不能自动接受快照。诊断产物统一放仓库忽略的 `.e2e-tmp/<任务>/`，使用隔离数据。

### 普通需求创建验收

`scripts/plugin-natural-ai-acceptance.mjs --run` 验证普通需求通过真实模型、模板发现、创建、测试、发布和选用完成。`--currency` 验证货币换算器。证据区分模板发现、完整读取、宿主模板创建、模型自测和独立保留样例。

其他入口有 `plugin-ai-acceptance.mjs`、`plugin-github-acceptance.ts`、`plugin-adversarial-acceptance.ts`，分别覆盖真实创建、联网适配导入与复杂协议负例。运行前阅读当前数据根、凭据读取、联网和模型行为，确认现有任务授权，使用 `.e2e-tmp/` 下的隔离目录；不操作生产实例。真实实验与桌面 E2E 串行。

记录必须区分未运行、模拟通过、真实调用通过和业务断言通过。未执行脚本不能沿用历史描述声称本轮成功，缺失的样例也不能写成已经覆盖。

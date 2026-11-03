# AE 工具精简与请求说明压缩

2026-11-03。本文记录最终实施状态，替代同日第一轮“仅默认关闭 18 项”的方案。范围是 AE 引擎及 Aether 客户端的工具选择、显示和调用协议；此前生态调研清单保留为历史快照。

## 命名与说明原则

工具名使用能表达完整含义的最短常用词；去掉重复词，保留区分对象所需的词。此次 `glob_search` → `glob`、`grep_search` → `grep`，实现、模型 schema、权限分类、白名单、调用点和客户端同步修改，没有旧名别名。其他名称未进行全量重命名。

说明保留用途、参数含义、适用条件、返回状态及必要约束，删除重复目录和复述。schema 的 required、enum、类型、边界和版本保护不因文案精简而删减。浏览器、办公、工作台的变更经 AST 对比：移除 description 后，修改前后源码一致；逐项人工语义复核也未发现实质用法丢失。

## 真正删除的工具

| 删除项 | 当前处理 |
| --- | --- |
| `install_package` | 删除 npm 包装；需要命令时使用受现有权限约束的 `execute_cmd`。 |
| `list_packages` | 删除 package.json 格式化包装；读取依赖声明使用 `read_file`。 |
| `get_time` | 删除独立时钟工具；每次请求注入引擎宿主当前时刻、本地日期、时区和 UTC 偏移。 |
| `calculate` | 删除简易表达式计算器；没有自动扩大只读代理的命令权限。办公公式仍由 `office_document.recalculate` 执行，缓存/模型推算不能冒充执行重算。 |
| `get_tool_details` | 删除重复查询入口；完整工具说明和参数已通过每次请求的 tools 字段发送。 |
| `get_current_context` | 删除环境查询入口；环境改为每次请求自动生成。 |

这些工具的实现、注册、导出、权限白名单与客户端显示映射均已清理，不保留兼容实现。注册边界拒绝这六个名字和旧搜索名，显式选择或同名扩展也不能重新暴露它们。负向测试与历史审计中保留名字不代表保留可调用入口。

## 对话压缩后仍有完整工具用法

ReAct 每轮读取当前注册表，并生成共享执行协议和最新环境；主会话、子代理、旧消息重试路径及 Flow 共用这条链路。上层的一次性环境注入已移除，避免重复和陈旧快照。

- 环境保留实际工作区路径、平台/架构、Node 路径和版本、时间、权限及客户端能力声明。工作区首项明确为相对路径和命令默认目录。
- 不在系统提示中再列一遍工具目录；完整 description 和 parameters 随每次模型请求的 `options.tools` 发送，包括历史压缩后的下一次请求。
- 工具、环境和公共执行协议独立于历史摘要生成。不会要求模型通过已删除的工具查自己的参数。
- 客户端能力声明不等于授权或成功执行；shell/PATH/办公依赖不作未经探测的推断。
- 收尾请求的实际工具集为空时，环境中的工具数量也为零。

精炼后继续保留：程序与 args 分离、后台 job 身份和终态、真实 expectedHash 与冲突重读、用户改动保护、浏览器 tab/ref/navigation 身份及失败恢复、办公依赖检查、产物执行回执、子代理当前 run 证据、历史回查，以及功能/交互/视觉验证的区别。

## 默认执行集与配置目录

15 项工具继续按需选择：8 项 Agent 配置管理、4 项 todo、3 项 task 队列工具。这些是仍存在的管理或队列功能，本次未删除。当前会话计划使用 `plan_update`；命令和子代理各自使用对应状态及取消工具。

`GET /tools` 和 `GET /system-tools` 的配置目录标注 `defaultEnabled`，Aether 新建 Agent 按该字段预选。目录模式不提升执行权限，也不让 Code profile 获得不支持的工具。用户明确选择仍受 profile、安全策略及删除名单限制。

受控规模：没有外部 Skill/MCP，关闭记忆 scopes，OSM 为 balanced。字符数仅为 `JSON.stringify([{name, description, parameters}, ...])`，不是 token 数。

| 模式 | 可配置目录 | 默认执行集 | 目录 / 默认 schema 字符 |
| --- | ---: | ---: | ---: |
| Work / general | 68 | 53 | 43,096 / 38,387 |
| Code | 49 | 45 | 26,774 / 25,673 |

内置工具共 73 项（含 5 项按 memory scope 注册的工具）。实际会话数量还受模式、选择、记忆和外部工具影响，不是所有会话固定 73 项。

## 说明体积对比

以下使用引擎 `estimateTokens` 本地估算，**不是模型服务商计费，不代表整条请求或账单同比下降**。每组使用相同输入条件；组间不合并成一个全局百分比。

| 测量部分 | 精简前估算 token | 精简后估算 token |
| --- | ---: | ---: |
| 环境与共享执行协议（73 工具、两个工作区、无客户端声明） | 2,909 | 1,528 |
| Code 专项说明与命令完整定义 | 5,306 | 2,931 |
| 15 个浏览器工具完整定义 | 4,597 | 3,637 |
| 2 个办公工具完整定义 | 2,571 | 2,179 |
| 办公环境工具完整定义 | 224 | 149 |
| 2 个工作台工具完整定义 | 502 | 350 |

环境与共享协议这一组约减少 47.5%，Code 专项与命令这一组约减少 44.8%。JSON schema 的实际约束保持完整。原始测量见 [tool-guidance-metrics-2026-11-03.json](tool-guidance-metrics-2026-11-03.json)。

## 验证

- 默认暴露、profile、OSM、浏览器 schema 一致性：4 文件 110 项通过。
- 请求环境、压缩、完整 schema 与收尾：4 文件 88 项通过；HTTP 工具目录 28 项、子代理能力 6 项、浏览器上下文继承 7 项通过。
- 搜索、安全、只读历史、进度、真实子代理搜索及退役工具：10 文件 167 项通过；JSONL/SQLite 子代理单槽位资源池 4 项通过；Code 提示/命令/计划 40 项通过。
- 引擎 `npx tsc --outDir .e2e-tmp/tool-retirement-build --noEmitOnError` 通过，包含完整类型检查；隔离目录另按正式构建流程复制运行资产并生成当前源码清单，构建前后源码哈希一致，终端依赖补丁校验通过。
- Aether 隔离 build 通过，含 node/web typecheck；中文工具名 7 项通过；真实 Electron Agent 配置 3 项通过（8.0 秒）。
- 办公六角色、32 项原生办公授权、11 项独立任务工具的定向契约断言通过。

测试组存在重叠，不相加为唯一总数，也未声称执行全量测试。完整 stress 契约尚未通过：处理 Windows TEMP 短路径后，旧 `frozenBriefReadContract` 夹具仍缺 tools 且读取旧 dist；上述定向断言不能代替全量契约。测试使用隔离产物与本地受控 provider，没有调用付费模型或重启用户服务。

最终真实 Electron + 引擎 + 本地模拟模型的 `tool-ergonomics-ui.spec.ts` 两项通过（16.1 秒，errors 为空）。验证首轮自动环境、六个工具不暴露、`glob` / `grep` 与完整关键参数 schema、五次真实工具回执、同文件 hash 衔接、带引号命令的真实执行及故意失败诊断、复制/刷新、历史微压缩后重启回放。测试结束后 Electron 已退出。模型回复为夹具，因此证明的是产品调用和恢复链路，不等于真实模型行为质量测评。

隔离构建身份：`sha256:b4578257c3f0371affbc5339fa7945f87cb277bc4e9ce74f3282614325f6d658`。两仓 `git diff --check` 通过。

真实 Agent 界面截图：[默认选择](../../aether-code/docs/ecosystem-audit-2026-11-03/validation/agent-tools-retirement-defaults.png)、[显式选择](../../aether-code/docs/ecosystem-audit-2026-11-03/validation/agent-tools-explicit-selection.png)。截图使用受控工具目录，非生产用户配置。

实现入口：`src/tools/tool-exposure.ts`、`src/tools/registry-factory.ts`、`src/core/runtime-capabilities.ts`、`src/core/execution-protocol.ts`、`src/core/agent-loop/react.ts`。客户端对应 `src/renderer/src/core/engine/tool-labels.ts`、`src/renderer/src/contrib/work/WorkAgentManager.tsx`。

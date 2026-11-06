# Work 首次问答输入开销调研

日期：2026-11-06（Asia/Shanghai）。本轮仅调查并记录结果，未修改引擎、前端、配置或会话数据库，未调用模型、未操作当前 Aether 窗口。

## 1. 已匹配到截图中的真实请求

问题：`你是谁`；模型：`deepseek-v4.1-flash-1017`。

持久历史：`C:/Users/wb.xielin02/AppData/Roaming/Aether Code/engine/state/sessions/default/work-home-ded73bea-694b-48f1-9dfb-5919a199329f.jsonl` 第 9–10 行。

根执行：`e0e4df0d-1f27-48b3-b980-0bfd5fab4768`。用户消息时间 17:51:17.348，回答时间 17:51:19.409；SQLite 根执行 17:51:17.343–17:51:19.415，已成功，耗时约 2.072 秒。

| 字段 | 持久值 | 含义 |
|---|---:|---|
| promptTokens | 21,156 | 输入总量，记录标记 usageEstimated=false |
| systemPromptTokens | 6,382 | 本地估算后分摊，约占输入 30.2% |
| builtinToolsTokens | 14,482 | 本地估算后分摊，约占输入 68.5% |
| skillTokens | 278 | 本地估算后分摊，约占输入 1.3% |
| messagesTokens | 1 | 此项也接收分项向下取整后的余数，不能据此认定存在有意义的旧历史 |
| userInputTokens | 13 | 当前输入的估算分摊 |
| completionTokens | 141 | 输出总量 |
| totalTokens | 21,297 | 输入加输出 |
| cacheHitTokens | 3,840 | 输入内的缓存命中量，不再加到总量上 |
| cacheMissTokens | 0 | 归档原值；不能据此断言剩余输入免费或全部命中 |
| mcpToolsTokens / ragTokens | 0 / 0 | 该记录没有 MCP / RAG 分摊 |
| requestInputTokenEstimate | 32,890 | 请求准入的保守估计，采用另一套 JSON 序列化及 1.2 系数，不是额外消费 |

该根执行归档只有一条用户输入和一条助手回答，没有工具调用。因此，首次约 21k 输入确实在回答之前就已存在。归档本身不能证明上游网关绝无重试，也不是原始供应商账单。

## 2. 顶部 7.5M 与问答 21.3k 是不同口径

- 问答弹层按当前问题及同一次根执行的补充汇总。
- 顶部按整个会话的主代理和子代理累计。
- “已知”表示有子代理用量未知，只显示可确认部分；不是“全部经过供应商实测”的标签。
- 16m13s 是最早已加载回答至当前/结束的时间跨度，不是这句问候的耗时，也不是 CPU 时间之和。

在同一父会话及其 3 个子会话内，按 17:51:16–18:07:30 聚合持久助手用量，可得到：

| 范围 | totalTokens |
|---|---:|
| 主会话 | 3,881,150 |
| 子会话 1 | 2,102,824 |
| 子会话 2 | 461,764 |
| 子会话 3 | 1,089,707 |
| 合计 | **7,535,445** |

18:07:30 是依据首条保留消息时间与截图 16m13s 推算，非独立截图时间证据；这个聚合与 7.5M 高度对应，但不是严格同一时刻的 UI 快照重建。它说明不能把后续主子任务的累计量归给第一句问候。

前端已存在防重机制：实时累计 usage 快照覆盖、同 root 补充分段相减、会话基准加后续正增量、子代理按 runId/lastSeq 去重。目前没有证据证明截图中的 7.5M 是重复累计。

源码：前端 `contrib/chat/session-usage.ts:80`、`:119`、`:122`，`contrib/chat/usage.ts:277`，`contrib/chat/ConversationUsage.tsx:189`。已回复文字不会单独终结任务，最终状态取自持久 root；截图不能单独证明运行状态卡死。本次问候对应 root 已成功。

## 3. 首轮系统内容从哪里来

当前请求组装链会根据配置加入以下内容。很多块没有“是否正在问候”的条件，即使本轮没有工具执行，也会发送。

| 内容 | 注入条件 / 内容 | 当前源码本地估计 |
|---|---|---:|
| 客户端 / Agent 身份 | 请求 systemPrompt、Agent 配置、inlineAgent 的优先级合并 | 随配置 |
| 租户默认身份 | default_identity 配置存在时前置 | 随配置 |
| 子代理委派说明 | 默认追加：角色、复用、分工、深度、回收及验证 | 1,104 |
| 技能目录 | 名称、简介及 get_skill 使用规则；通常不是全部 SKILL.md 正文 | 单列计入技能 |
| 项目 / 用户 AE.md | 文件存在时注入；单份最多 32Ki 字符 | 随工作区 |
| OSM 方法论入口 | methodology/max 才注入入口全文或静态后备 | 随模式 |
| 知识库目录、长期记忆、RAG | 根据客户端输入、配置与检索结果加入 | 随配置及任务 |
| 通用 Rules | 提问工具、中文表达、计划、禁止无效重复尝试等 | 957（不含下列独立块） |
| 下载链接规范 | 文件根、路径编码、完整下载链接示例 | 321 |
| Work 执行流程 | quick/standard/large 分级、规划、实施、验证与收尾 | 785 |
| Office 交付说明 | 文档/表格/幻灯片/PDF 参数、哈希、公式、渲染、交付 | 653 |
| 公共执行协议 | 用户表达、命令、文件、浏览器、办公、协作、成果等 | 2,918（所有相关工具已注册时） |
| 内建计划说明 | plan_update 使用、ID、状态及持久化 | 387 |
| 实时请求环境 | 时间、宿主平台、Node、工作区、权限、记忆范围、客户端声明 | 随运行环境 |
| 已保存计划 / 团队摘要 / 恢复指引 | 存在对应任务状态或异常时加入；首轮不一定存在 | 随任务 |

表中的估算使用项目 `estimateTokens`，不是供应商 tokenizer，也不能直接与截图中按比例分摊的 6,382 相加对账。上述有固定估算值的说明，在完整能力场景下共约 7,125 本地估算 tokens，尚未计运行环境、自定义身份等。

实际语义重复包括：计划规则出现在 Rules、独立计划说明和工具 description；协作纪律出现在委派块、公共协议及协作工具；办公与交付约束出现在公共协议、办公说明、工具参数和按需技能。可以合并职责，而不能简单删除权限与失败处理约束。

注意：源码中 `fullSystemPrompt` 与 `pureSystemPrompt` 两个相似模板分别用于发送和统计/日志，不能把源码重复误认为同一完整模板发送了两遍。

## 4. 首轮工具定义清单与大头

以下是**当前源码的条件化静态重建**：general/Work、balanced/methodology/max 的全能力分支、默认曝光、会话记忆开启、无 MCP，得到 63 个工具。没有找到截图请求的完整 QA 文本，所以不能直接宣称截图当时正好用了这 63 个。

采用纯 TypeScript AST 内存求值获得工具定义，未导入或启动引擎。按生产 `name + description + JSON.stringify(parameters)` 拼接并估算，总计 **17,710**；描述约 6,794，参数 schema 约 10,682，名称与分隔符/舍入约 234。参数结构约占 60.3%。

| 类别 | 数量 | 本地估算 tokens |
|---|---:|---:|
| 浏览器 | 15 | 3,747 |
| 子代理 | 10 | 2,490 |
| Office | 3 | 2,420 |
| 文件 | 6 | 1,954 |
| 定时任务 | 5 | 1,632 |
| 成果提交/交付 | 2 | 806 |
| 命令执行/观察/取消 | 3 | 660 |
| 代码图 | 1 | 586 |
| 长期记忆 | 5 | 540 |
| 计划 | 1 | 520 |
| 技能操作工具 | 3 | 465 |
| 历史搜索 | 1 | 432 |
| 工作台 | 2 | 330 |
| 提问 | 1 | 302 |
| 代码诊断 | 1 | 297 |
| glob / grep | 2 | 284 |
| HTTP | 1 | 199 |
| 网页获取 | 1 | 48 |

类别独立取整可能与整段估算有少量差异。技能操作工具的 schema 不等于技能目录正文。

最重的 10 个工具：

| 工具 | 合计 | description | schema |
|---|---:|---:|---:|
| office_document | 1,893 | 364 | 1,525 |
| write_file | 696 | 184 | 509 |
| subagent | 665 | 194 | 469 |
| cron_create | 657 | 58 | 596 |
| cron_update | 623 | 25 | 595 |
| edit_file | 612 | 253 | 356 |
| subagent_start | 593 | 120 | 469 |
| codegraph | 586 | 255 | 329 |
| plan_update | 520 | 312 | 204 |
| browser_click | 497 | 183 | 311 |

完整 63 个工具名：

```text
read_file, write_file, edit_file, list_files, delete_file, create_dir,
office_document, office_inspect, office_environment,
execute_cmd, command_output, cancel_command, ask_user, glob, grep, plan_update,
cron_list, cron_preview, cron_create, cron_update, cron_delete,
subagent, subagent_start, subagent_send, subagent_wait, subagent_cancel,
subagent_participants, subagent_inbox, subagent_directory,
subagent_followup, subagent_request_input,
web_fetch, http_request, search_history, code_diagnose, codegraph,
workbench_context, workbench_open, deliver_files, report_artifacts,
run_skill_script, list_skills, get_skill,
remember, recall, list_memories, forget, link_memories,
browser_tabs, browser_open, browser_navigate, browser_snapshot,
browser_screenshot, browser_click, browser_fill, browser_scroll,
browser_press_key, browser_wait, browser_console, browser_network,
browser_network_request, browser_set_viewport, browser_close
```

关闭记忆时，同场景为 58 个 / 17,170；OSM off 为 17 个 / 6,288，但会减少命令、浏览器、协作等能力，不能把切换 off 当作无损优化。默认曝光已隐藏旧 Agent 管理、旧待办/队列管理工具；不是把仓库所有工具无差别发送。

### 本轮协作功能增加了多少

仅相对当前 Git HEAD 比较，并不等同于截图所用二进制版本比较：

- 协作工具 7→10 个，本地估算 1,554→2,490，净增 936。
- 新 directory/followup/request_input 合计 579；两个已有启动工具的角色参数等增加 357。
- 委派提示 854→1,104，净增 250；公共执行协议条件全部满足时 2,270→2,918，净增 648。
- 工具定义增量约占当前工具定义的 5.3%。新协作功能增加了一部分固定成本，但整块 14.5k 不是全部由这次增加。

## 5. 统计准确性与可观测性

`react.ts` 使用实际发送的工具重估说明长度，然后把系统、工具、技能、历史等本地估算值乘以 `promptTokens / localEstimate`。向下取整后的余数放到历史项，使拆分相加等于输入总数。

因此：输入/输出总量可来自供应商回执，分项只是估算分摊。前端弹层目前未清楚标注分项的估算来源，容易被理解为供应商逐项实测。修正标签有助于诊断，但不直接减少实际 token。

DeepSeek/OpenAI-compatible 的缓存命中量不额外加到 promptTokens；流式 usage 是覆盖快照，不逐帧累加。缓存命中不等于从上下文中删去，也不能把命中数字当成额外开销。

QA 日志理论上保存 pureSystemPrompt、工具文本和技能目录；但该系统文本没有包含 ReAct 后加的公共协议、实时环境等，所以即便有 QA 文本，也不等于最终 wire 完整快照。目标请求的 QA 文本在本轮有界搜索中未找到。

## 6. 后续优化建议（尚未实施）

1. **按任务提供工具定义。** 首轮保留简洁的能力目录与受权限约束的发现入口；浏览器、Office、定时任务等在相关任务需要时展开。当前每次 ReAct 迭代会重新取工具列表，但还没有完整的模型侧工具发现/延迟展开协议，需要端到端设计。
2. **为简单问答建立轻量路径。** “你是谁”等纯介绍可使用短身份与能力说明，不附带所有任务工具；必须识别已有运行任务、补充、续做、附件和显式 Agent 委派，避免仅凭关键词误删能力。不要为了省首轮 token 再无条件增加一次大模型分类调用。
3. **系统规则按职责合并、按场景注入。** 保留短全局约束，将计划、命令、浏览器、办公、交付等详细说明与对应能力一起提供。权限和后端校验仍由服务端执行。
4. **主子代理按身份准确曝光。** 主代理无需携带只允许 child 使用的 subagent_request_input 和 report_artifacts；历史兼容与真实权限检查保留。同步 subagent 与异步 subagent_start 的默认展示是否合并，须连同提示和兼容调用设计。
5. **精简重 schema 和重复描述。** office_document、cron_create/update 等参数较重；按场景拆选或延迟加载比只删几句话收益大。不能为了缩短文本删除后端验证或必需参数约束。
6. **改善用量显示与缓存稳定性。** 标注“供应商总量 / 估算分摊 / 缓存包含于输入 / 会话累计”，将真实动态环境与稳定规则组织清楚；缓存收益需实际供应商验证，不能先承诺节省金额。

不建议用自动压缩、把工具注册表放内存、隐藏用量数字或永久禁用大批能力来代替上述优化。固定系统提示和工具 schema 仍进入请求时，历史压缩和存储位置变化不会减少这些首轮输入。

建议下一轮验收先覆盖：纯问候、单文件读取、办公生成、浏览器任务、活跃子代理补充、完成子代理续用、压缩后恢复和权限受限 Agent；同时测首轮输入、完整任务累计输入、调用轮数及成功率，避免首轮变小却增加后续往返。

## 7. 已确认与尚未确认的边界

- 已确认截图首轮精确 usage、模型、时间与根执行成功状态。
- 已确认约 7.5M 可由同会话及其三个 child 的后续工作复算，时间上界为推算值。
- 已确认当前源码的工具/规则体积与逐次发送机制。
- 未获得目标请求完整最终 wire、当时工具名单及技能名称；静态清单不可冒充当时精确快照。
- 当前运行引擎 build 为 `fa926547…`，进程于 18:14:29 启动，晚于目标请求；当前源码与截图时的运行版本须区分。
- 本轮未优化实现、未更改运行配置、未发出新的模型请求。这里只新增本调研文档。

## 8. 主要源码定位

引擎：

- `src/api/http/routes/chat.ts:60` 委派提示；`:88` Work 流程；`:836` 身份合并；`:1099` 技能目录；`:1142` 项目说明；`:1386` 模式/办公块；`:1406` 分项估算；`:1766` QA 记录。
- `src/core/agent-loop/react.ts:649` 每轮取全部已注册工具；`:656` 计划注入；`:683` 公共协议/运行环境；`:1292` 分项；`:1335` 比例换算。
- `src/core/execution-protocol.ts:5` 公共执行协议。
- `src/core/runtime-capabilities.ts:48` 环境与记忆说明。
- `src/core/agent-loop/finalization.ts:35` 请求保守估算。
- `src/tools/registry-factory.ts:149` 注册过滤；`:349` 协作；`:362` MCP；`:390` 浏览器/成果。
- `src/tools/office/index.ts:118` office_document；`src/tools/cron/cron-tool.ts:32` cron schema；`src/tools/subagent/subagent-tool.ts:145` 两种启动工具。
- `src/core/llm-adapter/request-attempt.ts:89` 回执快照与缓存；`src/core/utils/tokens.ts:9` 本地估算。

前端（`D:/dev/aether-code`）：

- `src/renderer/src/contrib/work/WorkView.tsx:680` 顶部统计；`:1115` 问答统计。
- `src/renderer/src/contrib/chat/session-usage.ts:80` 会话基准及增量；`:119` 时间跨度；`:122` 主子累计。
- `src/renderer/src/contrib/chat/usage.ts:174` 缓存不重复计入；`:277` 子 run 去重。
- `src/renderer/src/contrib/chat/ConversationUsage.tsx:29` 分项未标估算来源；`:189` “已知”标签。
- `src/renderer/src/core/engine/chat-payload.ts:45` 流式累计覆盖；`chat-timeline.ts:54` 同根分段扣减；`chat-history.ts:33` 历史增量合并。
- `src/renderer/src/contrib/work/work-runtime.ts:245` 活跃流恢复/状态探测边界；`src/renderer/src/core/engine/useChat.ts:899` 持久运行恢复。

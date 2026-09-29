# Aether Code ↔ Agent Engine 端到端契约审计

日期：2026-09-29。引擎：`D:\dev\ai-agent-engine`；实际消费者：`D:\dev\aether-code`。本报告以本轮读取的当前磁盘源码为准，包含前端尚未提交的工作，不代表任何旧版本或发布包。

本子项只读审计业务代码，只写本报告；没有启动 Electron、服务或外部模型。主线另行执行了类型检查、纯函数测试、隔离路由探测，其日志在本文末尾引用。静态发现与动态验证分开标注。

## 1. 结论

聊天主链已连接：文本、思考、工具启动/参数/结果、单题 ask_user、命令审批、文件改动、todo、usage、子代理快照均能经过 HTTP → Electron main → preload → renderer。当前子代理的真实状态、晚到结果归属、取消中状态、历史补投影尤其比普通根聊天状态更完整。

真正的问题主要是**跨运行周期的语义没有闭合**：SSE 事件编号在主进程被丢弃；实时消息身份没有回填；待回答/审批状态不从历史恢复；普通工具及根消息回放时倾向默认成功；通用 HTTP 信封的 metadata 被主进程剥离。仅检查路由存在、TypeScript 通过或单次聊天能显示，无法证明这些契约正确。

不能把两处看似缺失的接口列为缺陷：

- `/subagent/runs` 四接口由 [conversation.ts:48](/D:/dev/ai-agent-engine/src/api/http/routes/conversation.ts:48) 间接注册；[server.ts:84](/D:/dev/ai-agent-engine/src/api/http/server.ts:84) 注册 conversationRoutes，统一 `/api/v1` 前缀在 [server.ts:108](/D:/dev/ai-agent-engine/src/api/http/server.ts:108)。不是 404。
- 旧 `/subagent/cancel` 仍在 [chat.ts:311](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:311)。当前命令正式名称仍是 `execute_cmd`：[cmd-tool.ts:22](/D:/dev/ai-agent-engine/src/tools/cmd/cmd-tool.ts:22)；`run_command` 仅用于配置名归一化：[tool-profile.ts:5](/D:/dev/ai-agent-engine/src/tools/tool-profile.ts:5)。审批 handler 与正式名称一致。

主线动态探测确认 48 个前端字面量 HTTP 调用点全部匹配真实注册路由。这个结论只覆盖路径和方法，不证明响应字段、状态及回放语义正确。

## 2. 实际链路与请求字段

### 2.1 调用链

| 阶段 | 实际入口 | 处理与限制 |
|---|---|---|
| renderer 发起普通 HTTP | [renderer/client.ts:63](/D:/dev/aether-code/src/renderer/src/core/engine/client.ts:63) | 走 `window.aether`；通用 body 为 unknown，无跨仓共享 schema |
| renderer 发起聊天 | [useChat.ts:584](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:584) | 构造 `/chat` body；本地先生成 user/assistant UUID |
| preload | [preload/index.ts:72](/D:/dev/aether-code/src/preload/index.ts:72)、[index.ts:92](/D:/dev/aether-code/src/preload/index.ts:92) | start/abort 使用 invoke；流事件原样转发监听器 |
| main IPC | [main/ipc.ts:80](/D:/dev/aether-code/src/main/ipc.ts:80)、[ipc.ts:85](/D:/dev/aether-code/src/main/ipc.ts:85) | 每个 streamId 一个 AbortController；start invoke 等流完成才返回 `{ok:true}`，业务成功失败以独立 stream event 为准 |
| main 普通 HTTP | [main/engine/client.ts:40](/D:/dev/aether-code/src/main/engine/client.ts:40) | 业务路径加 `/api/v1`；code=200/0 才算业务成功；保留 data/pagination，丢 metadata/timestamp |
| main SSE | [host.ts:387](/D:/dev/aether-code/src/main/engine/host.ts:387) | 非 SSE JSON 被转成 error；SSE 按空行切块，再解析 data/done；不保留 id |
| 引擎 producer | [chat.ts:334](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:334)、[react.ts:857](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:857) | schema + ReAct；控制帧经 StreamBus、sse-sink 转 JSON SSE |
| renderer reducer | [useChat.ts:358](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:358)、[useChat.ts:980](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:980) | 非子代理帧按 activeStreamId 过滤；文本 patch 每 80ms 合并；终帧先 flush |

普通 HTTP 与 SSE 都注入 `X-Aether-Tool-Profile: code`，见 [tool-profile.ts:2](/D:/dev/aether-code/src/main/engine/tool-profile.ts:2)、[client.ts:52](/D:/dev/aether-code/src/main/engine/client.ts:52)、[host.ts:411](/D:/dev/aether-code/src/main/engine/host.ts:411)。因此引擎 general 模式全部能力不能直接等同于 Aether 聊天可用能力。code profile 的可用工具集合与配置名兼容在 [engine/tool-profile.ts:20](/D:/dev/ai-agent-engine/src/tools/tool-profile.ts:20)。

### 2.2 `/chat` 字段矩阵

引擎完整 body 定义从 [chat.ts:60](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:60) 开始，schema 从 [chat.ts:339](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:339) 开始；下表区分聊天 hook 实际发送与引擎能力，不能把未发送一律称为引擎缺失。

| 字段/组 | 正常发送 | 交互应答续跑 | 当前含义/差距 |
|---|---|---|---|
| message | 字符串 | 不发送 | 引擎 schema 还允许 null/array；UI 以附件列表补充多模态 |
| sessionId | 是 | 是 | 引擎未传可生成，但 UI 恢复/停止需要调用方持有稳定 ID |
| agentId | 是 | 不发送 | 已存在 session 会锁定绑定 agent；不能仅因续跑不传就认定 agent 丢失，[chat.ts:422](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:422) |
| model | 是 | 是 | 应答取当前 UI 选择的模型，并不保存待交互产生时的不可变模型快照 |
| workspacePaths | 是 | 是 | 每次请求传当前工作区；这条关键链已接通 |
| thinkingMode | 是 | 是 | boolean 或 low/medium/high；具体值经 UI resolveThinkingMode |
| subagentModel、utilityModel | 是 | 是 | 专用模型路由已接通 |
| attachments | `{name:path,type}` | 不发送 | 不透传 content/encoding；引擎从工作区读文件 |
| toolResponse | 不发送 | `{toolCallId,name,output}` | output 为字符串；多选为逗号拼接 |
| systemPrompt、maxAskUserCount、inheritContext、ragTopK | hook 不发送 | 不发送 | 使用引擎/agent 默认，当前聊天 UI 无请求级控制 |
| modelApiKey、modelBaseUrl、modelProvider、capabilities、extraHeaders | hook 不发送 | 不发送 | 当前聊天依赖引擎已有模型配置；不能因为引擎有这些字段就宣称 UI 支持逐次覆盖 |
| skills、mcpServers、knowledgeBases、allowedTools | hook 不发送 | 不发送 | 当前由引擎配置及 code profile 选择资源 |
| inlineSkills、inlineMcpServers、inlineAgents、inlineAgent、inlineKnowledgeBases、inlineMemoriesXml、metadata | hook 不发送 | 不发送 | 引擎接受这些扩展，但本聊天链未提供对应请求级透传入口；字段声明本身也不保证引擎端完整执行 |

正常发送证据：[useChat.ts:584](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:584)。交互应答：[useChat.ts:720](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:720)。应答 UI 使用当前设置：[ChatView.tsx:774](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:774)。

## 3. SSE 全事件矩阵

引擎 [sse-sink.ts:72](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:72) 会输出 `id:`；前端 [host.ts:521](/D:/dev/aether-code/src/main/engine/host.ts:521) 只返回 data payload / done。共享 [ChatSsePayload:472](/D:/dev/aether-code/src/shared/ipc.ts:472) 多数 payload 为 unknown，兼容透传容易，但编译不能验证真实 shape。

| Wire 字段/事件 | producer | 实时 renderer 消费 | 历史/恢复 | 判断 |
|---|---|---|---|---|
| content | [sink:241](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:241) | 追加正文+timeline，[useChat:991](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:991) | extractText/replay | 已接通，重连去重未闭合 |
| thinking | [sink:112](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:112) | 追加思考+timeline，[useChat:997](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:997) | reasoningContent；仅模型完成并落库后可回放 | 已接通，断线中间增量会缺失 |
| toolStart | [react:527](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:527)、[react:857](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:857) | 初始占位，后续完整 args 覆盖，同 toolCallId 更新 | toolCall 建卡 | 已接通 |
| toolArgs | [react:531](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:531) | args 片段追加；先 args 后 start 可占位，[useChat:1069](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1069) | 只恢复完整参数 | 已接通；需稳定 toolCallId |
| toolCall | [react:859](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:859) | 作为 start 别名按 toolCallId 去重 | toolCall 记录 | messageId 被忽略 |
| toolEnd | [react:1014](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1014) | finishTool 读取 success/error/metadata.subagent | role=tool metadata | outputPreview 不被 normalizeTool 读取 |
| toolResult | [react:1022](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1022) | output 补全，按调用 ID 回填原消息 | 工具输出可能持久化截断 | 正常双帧弥补 outputPreview；durationMs 丢弃 |
| ask_user | [react:864](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:864)、[react:993](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:993) | normalizePending → 交互卡 | replay 不重建 pending | 实时接通，重启/切换丢等待态 |
| permissionRequest | [react:867](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:867)、[react:999](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:999) | 真实权限胜过 ask 别名，回传真实工具名 | replay 不重建 pending | 实时接通，sessionId/messageId/args 不进入 PendingInteraction |
| userMsgId | [react:279](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:279)、[sink:159](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:159) | 无 reducer 分支 | 历史才获得 engine ID | 静默丢失，影响精确删轮/重试 |
| usage | [react:841](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:841)、[react:1120](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1120) | 整帧覆盖，符合累计用量语义，[useChat:1003](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1003) | 每行增量求和、snapshot 字段取最后值，[chat-history:29](/D:/dev/aether-code/src/renderer/src/core/engine/chat-history.ts:29) | 大体接通；ID 命名及信封 sessionUsage 有缺口 |
| todo | [react:188](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:188)、[sink:216](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:216) | 会话级整表替换，[useChat:403](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:403) | 切会话清空，loadHistory 不拉 /todos | 实时接通，静止历史无恢复 |
| fileChange | [react:1040](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1040) | 依 toolCallId 挂卡，[useChat:1027](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1027) | 工具卡不恢复 change；独立 ChangesPanel 拉 /changes | 部分恢复，不是文件改动能力全丢 |
| subagentEvent | [chat:613](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:613)、[sink:96](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:96) | 先入全局 store 再做 active stream 过滤，[useChat:360](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:360) | runs REST + metadata 双通道恢复 | 当前最完整的版本化事件契约 |
| messageBlock | [sink:197](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:197) | 类型声明有，reducer 无分支 | 无 | 当前搜索未见真实聊天 producer；属于预留未消费，不能算已上线功能 |
| flow | [flow-event-bus:14](/D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-event-bus.ts:14)、[sink:207](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:207) | 普通 useChat 不消费 | 无 | 是独立 flow 路径，不能把聊天共享声明当成 UI 支持 |
| `{error:string}` | [sink:253](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:253) | reducer 显式兼容但类型未声明，[useChat:981](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:981) | 根消息错误状态没有稳定回放契约 | 实时 string error 能显示 |
| event:done / [DONE] | [sink:245](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:245) | done 保留此前 error，否则置 done，[useChat:381](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:381) | 普通 assistant 回放一律 done | 流结束 ≠ 任务完成，根级缺 typed outcome |
| id / heartbeat | [sink:72](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:72)、[sink:36](/D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:36) | 心跳正确忽略，id 一并丢弃 | 不能从客户端消费游标恢复 | 恢复协议核心缺口 |

`pickToolFrame` 支持新旧名字、同一 ID start 覆盖、args 追加，见 [useChat.ts:1108](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1108)。不能把双发别名简单计为双倍工具执行；它们仅多发事件。

## 4. 已确认的当前风险

### P1-A：恢复游标是服务端最新位置，不是客户端已消费位置

证据链：StreamBus 给每条控制/内容帧赋 ID，并在 [stream-bus.ts:41](/D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-bus.ts:41) 重放游标之后的事件；`/chat/status` 返回服务端 events 最后一条 ID：[chat.ts:1212](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:1212)。前端 parser 不输出 ID，`resumeStream` 先拿 status，再取历史，最后传该 status.lastEventId：[useChat.ts:660](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:660)、[useChat.ts:682](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:682)。

可由源码推出两个窗口，未在本子项启动真机复现：

1. 模型仍在流式生成 thinking/args；这些增量已进入 bus，但完整 assistant 行尚未落盘。status 返回增量末尾 ID，history 没有这些增量，恢复又跳过这些 ID，导致丢帧。
2. status 与 history 是两次独立请求。status 后完成的迭代既可能被 history 读到，又被 `after(lastEventId)` 重放；文本/思考 reducer 只追加，没有事件去重，存在重复窗口。

此外 `running:false,finished:true` 直接不续接 [useChat.ts:665](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:665)，不会消费引擎保留一分钟的已完成事件缓冲。恢复早期若历史只有 user，`patchLastAssistant` 也没有明确创建该轮新 assistant 的协议依据。

同步修复点：引擎返回带同一水位的历史快照/当前 run identity；主进程解析 eventId 并进入 StreamEvent；renderer 保存已应用游标并按 ID 去重；重连从该水位恢复 pending/outcome。不能单独把 status.lastEventId 改成空值：这样会全量重放并重复历史内容。

### P1-B：实时 message ID 被丢弃，删除/截断靠正文匹配

用户消息先由前端生成 UUID：[useChat.ts:558](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:558)。引擎随后发送 userMsgId 和 toolCall.messageId，但 reducer 不使用，usage.conversationId 也只是存入 usage。`resolveEngineRow` 先按 ID，失败后按 `rows.find(role && content)` 找第一条：[useChat.ts:805](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:805)。

同会话两次发送相同“继续”，用户对第二条实时消息重试/删除，正文 fallback 可以定位到第一条，引起错误范围截断；multipart 历史又可能无法与 UI 字符串相等，导致无法定位。`retryFrom` 在找不到 row 时仍截断本地 UI 并重新发送：[useChat.ts:838](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:838)，可能让显示历史与引擎实际上下文分离。

同步修复点：稳定区分 sessionId、turnId/conversationId、messageId、toolCallId；实时回填 producer ID；禁止以非唯一正文作为破坏性历史操作的身份。引擎 usage 中名为 conversationId 的值实际是 assistantMsgId/messageId：[react.ts:849](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:849)、[react.ts:1126](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1126)，不能直接拿它当真实轮次 ID。

### P1-C：等待用户状态没有持久化投影，回放会失去应答入口

引擎 ask_user 在保存 assistant.toolCall 后发交互帧，并且明确不保存 tool result，随后结束本轮：[react.ts:837](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:837)、[react.ts:876](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:876)。权限确认分支同样返回，未保存结构化 pending：[react.ts:986](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:986)。

回放函数只建文本/思考/工具，没有 normalizePending；未配对的普通工具初始 state=done：[chat-history.ts:237](/D:/dev/aether-code/src/renderer/src/core/engine/chat-history.ts:237)。因此切换会话、重启或纯历史加载后，ask_user/权限请求可显示成普通完成工具而失去交互卡；流已结束，resumeStream 也不会恢复已结束缓冲。

同步修复点：引擎提供稳定 pendingInteraction 记录或 history 投影，明确 requestId/toolCallId、类型、状态、原始问题/审批上下文、回答幂等性；前端回放重建 pending/answered。仅给 replay 的 ask_user 生成卡不能解决权限 reason 等未持久化字段，也要避免已回答请求被重新激活。

### P2-A：审批原工具可能长期显示运行中

实时问答工具 `ask_user` 被特殊隐藏：[useChat.ts:1043](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:1043)；被拦截的 `execute_cmd` 没有该隐藏逻辑。引擎 needsConfirmation 分支不发该工具 end，前端 done 只更改 assistant.status。应答只写 answered 并续流：[useChat.ts:708](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:708)，引擎审批后写历史 toolMsg 并提示模型重新调用命令：[chat.ts:970](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:970)，没有给旧 toolCallId 发结果事件。

因此当前静态路径下旧工具卡可以一直 running，新工具调用另有 ID；重载历史后又默认 done。需要工具状态明确支持 waiting/approved/rejected/superseded，或由应答 ACK/终帧闭合原调用。此问题应以真实命令审批 E2E 补充确认。

### P2-B：HTTP metadata 在 main 被剥离

引擎 `/conversation/history` 返回 `metadata:{sessionUsage,subagentRuns}`：[conversation.ts:82](/D:/dev/ai-agent-engine/src/api/http/routes/conversation.ts:82)。共享 StandardResponse 已声明 metadata：[ipc.ts:432](/D:/dev/aether-code/src/shared/ipc.ts:432)，但 EngineRequestResult 未声明，main client 返回只含 ok/code/message/data/pagination：[client.ts:96](/D:/dev/aether-code/src/main/engine/client.ts:96)。因此信息在 IPC 前静默丢失。

subagentRuns 已通过另一请求补拉，未因此断链。sessionUsage 则不能经该调用获得，前端只能基于回放行自己求和，无法直接采用服务端完整会话统计。未来任何结果级 metadata 扩展都需要同时改 `EngineRequestResult`、main HTTP client、consumer，不能只改 engine/StandardResponse。

### P2-C：工具结果只支持部分字段，单独 toolEnd 会丢原因

`normalizeTool` 只读 output/result/content/text：[chat-history.ts:296](/D:/dev/aether-code/src/renderer/src/core/engine/chat-history.ts:296)，不读 outputPreview。普通执行同时发 toolEnd、toolResult，第二帧能补回完整 output；所以不能描述成“所有工具结果都丢”。但 ask_user 跳过同轮后续工具时只有 toolEnd.outputPreview：[react.ts:884](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:884)，跳过原因会消失，只剩失败状态。

`durationMs`、一般工具 metadata 除 error/success/status/subagent 外也不进入 ToolActivity。ToolActivity 只有 startedAt、没有引擎结束/耗时字段：[useChat.ts:19](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:19)。未来删除别名帧或统一为单事件时必须先升级 normalizer，否则结果会退化为空。

### P2-D：根任务结束语义和历史状态不完整

实时 `{error:string}` 已处理，不能误报为错误全部吞掉。但自然 EOF 也会被 host 变成 done：[host.ts:466](/D:/dev/aether-code/src/main/engine/host.ts:466)；根 loop 的步骤/预算/重复失败可能只产出普通说明文字，然后 done：[react.ts:1079](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1079)、[react.ts:1135](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1135)。根聊天未复用子代理 typed RunOutcome。

历史 assistant 一律 status=done：[chat-history.ts:205](/D:/dev/aether-code/src/renderer/src/core/engine/chat-history.ts:205)，忽略 finalMsg.metadata.partial/stopReason：[react.ts:1106](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:1106)。普通工具无结果也先 done；某些取消合成 tool result 没有 success/error/status metadata：[react.ts:962](/D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:962)，fallback 会标为 done。应由协议明确 succeeded/failed/cancelled/blocked/partial，历史与 live 使用同一 reducer，不能把传输结束等同于任务成功。

### P2-E：静态历史的 todo、文件内联卡、附件不能完整重建

- todo：loadHistory 切会话清空 todo，只加载 history/runs；没有请求已存在的 [GET /todos](/D:/dev/ai-agent-engine/src/api/http/routes/todos.ts:29)。下一轮 SSE 能再送快照，但静止历史不恢复 todo 托盘。
- 文件改动：replayMessages 不挂回 tool.change。独立 [ChangesPanel.tsx:73](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:73) 用 REST 恢复 pending 改动，故独立面板能恢复；聊天中原工具内联 diff 与独立面板能力不可混为一谈。
- 附件：live ChatMessage 保存 attachments，而 user 历史构造只取 extractText：[chat-history.ts:146](/D:/dev/aether-code/src/renderer/src/core/engine/chat-history.ts:146)。图片/非文本退化为类型说明，原始附件卡、路径与重试所需附件引用不从该投影重建；retryFrom 仅复用仍在消息上的 attachments。

这些需要服务端持久化投影与前端回放一起设计，不能仅增加前端声明。

## 5. 审批与 ask_user：当前闭环和未来陷阱

### 5.1 当前真正可用的协议

1. 普通提问：engine 发 ask_user，再发 toolName=ask_user 的 permissionRequest 别名；前端解析为 kind=ask，同 ID 合并。引擎当前工具 schema 是单 `question + options + multiSelect`，options 至少两项：[ask-user/index.ts:13](/D:/dev/ai-agent-engine/src/tools/ask-user/index.ts:13)。
2. 命令审批：execute_cmd 返回 needsConfirmation；engine 发带 approved/rejected 字符串选项的 ask_user，再发真实 toolName 的 permissionRequest。前端让真实 permission 帧胜出：[pending.ts:208](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:208)。
3. UI 显示中文 label，回传精确 approved/rejected value：[pending.ts:60](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:60)、[pending.ts:219](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:219)。
4. 应答用 `/chat` toolResponse；execute_cmd approved 更新会话允许命令并要求模型重试：[chat.ts:970](/D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:970)。实际工具正式名和 handler 一致。

### 5.2 UI 已写的多题组件不等于引擎已支持多题

前端 [pending.ts:168](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:168) 能解析 questions 数组，ChatView 能按组展示；但当前 engine ask_user schema 不定义 questions。若将来引擎改为只传 questions，仍双发别名，则前端 [pending.ts:118](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:118) 的 `args.question || args.options` 判断不包含 questions，后来的别名会被错判为真实 permission，再由 mergePending 覆盖正确问答。

即使修正别名判断，[ChatView.tsx:2545](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:2545) 仍把所有组选择展平成 string[]，[pending.ts:225](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:225) 逗号连接，丢失 question/group 身份与含逗号答案边界。要升级到多题，应同时定义 questionId/answer 对映与后向兼容 toolResponse，而非仅扩展 engine schema。

### 5.3 本轮失败的无选项测试不等于 UI 无路可走

主线 pure test 中唯一失败为 [pending-interactions.spec.ts:76](/D:/dev/aether-code/e2e/pending-interactions.spec.ts:76)，期望无 options 时强塞一个按钮。当前 normalizeQuestionGroups 返回 `allowInput:true`：[pending.ts:195](/D:/dev/aether-code/src/renderer/src/core/engine/pending.ts:195)；UI 有自由输入：[ChatView.tsx:2516](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:2516)，也有跳过与空提交跳过逻辑：[ChatView.tsx:2535](/D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:2535)。因此应归为测试断言与新交互语义未同步，不能仅凭该失败宣称死卡片。仍需产品决定无选项是否合法，并让 schema、fallback、UI、测试保持一致。

## 6. 子代理端到端：已接通程度与兼容边界

| 能力 | 当前证据与判断 |
|---|---|
| 版本化 snapshot | engine [types.ts:31](/D:/dev/ai-agent-engine/src/core/subagent/types.ts:31) 与 frontend [shared/subagent.ts:40](/D:/dev/aether-code/src/shared/subagent.ts:40) 的 v1 字段/8种状态一致；frontend transcriptRef 可选、event.kind 宽松 |
| 边界校验 | [subagent-state.ts:94](/D:/dev/aether-code/src/renderer/src/core/engine/subagent-state.ts:94) 要求 schemaVersion=1、归属ID、已知status、有限lastSeq；event要求seq与snapshot一致 |
| 全局事件接收 | useChat 在流过滤前 ingest subagentEvent，晚到子任务更新不被新 activeStreamId 丢掉 |
| 所属轮次 | [subagent-state.ts:296](/D:/dev/aether-code/src/renderer/src/core/engine/subagent-state.ts:296) 优先 parentToolCallId，再 parentMessageId/parentConversationId；正常 live 不制造未知归属气泡 |
| seq与终态 | [subagent-state.ts:184](/D:/dev/aether-code/src/renderer/src/core/engine/subagent-state.ts:184) 拒绝重复/旧seq，终态不被后续running复活，usage取单调最大值 |
| REST补偿 | [subagent-store.ts:54](/D:/dev/aether-code/src/renderer/src/core/engine/subagent-store.ts:54) 拉父session全表；useChat每2.5秒仅对已知active runs轮询；loadHistory也主动拉一次 |
| 历史恢复 | history API会附当前run metadata；前端同时拉runs，并用 restoreMissing=true 补缺父投影：[useChat.ts:640](/D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:640) |
| 单个取消 | [SubagentCard.tsx:225](/D:/dev/aether-code/src/renderer/src/contrib/chat/SubagentCard.tsx:225) 有runId走新接口，否则旧sessionId/toolCallId接口；ACK合并真实snapshot，未直接伪造cancelled |
| 详情 | 打开卡片再GET单run：[SubagentCard.tsx:202](/D:/dev/aether-code/src/renderer/src/contrib/chat/SubagentCard.tsx:202)；展示子工具列表、错误和外部效果未知状态 |
| 事件历史接口 | engine有 `/subagent/runs/:runId/events?afterSeq`，frontend客户端只用list/get/cancel，未消费事件历史；当前快照已覆盖状态需求，但没有逐事件审计时间线 |
| transcriptRef | normalizer保留字段；本轮查未发现由该ref读取完整子会话transcript的调用链，不能把它计为完整子聊天浏览能力 |

子代理不应整体判为“没有后台状态/没有取消/只能显示文本”。当前 v1 有实质连接和专门测试。兼容边界是：新增 schemaVersion/status 会被 normalizer 严格丢弃；快照里新增字段默认被显式投影丢弃；轮询异常在 useChat 被吞掉。引擎升级必须配对更新 frontend v1 normalizer或明确协商降级。

另一个可用性边界：轮询只在本地已知存在 active run 时开启；如果创建事件未送达且本地不知道任务存在，就不能靠该定时器自动发现，需要重新 loadHistory 等触发全表拉取。不能将其描述成无条件后台发现所有子代理。

## 7. 引擎升级必须同步的文件与验收

| 改动主题 | Engine 侧 | Aether 侧必须同步 | 必须补充的验收场景 |
|---|---|---|---|
| 新事件、事件改名/撤别名 | react.ts、sse-sink.ts、StreamBus | shared/ipc.ts、host parser、useChat reducer、chat-history normalizer | 同轮双别名无重复、单独新版帧不丢输出、未知版本有可见降级 |
| 断线恢复 | chat status/stream、history快照和持久水位 | StreamEvent.eventId、preload透传、useChat游标与去重 | thinking/args中途断开、tool result落盘前断开、status/history竞态、已结束缓冲恢复 |
| 身份与历史操作 | user/assistant/turn ID producer、history API | useChat回填ID、resolveEngineRow、deleteTurn/retryFrom/revertFrom | 连续两次“继续”、相同assistant正文、多模态、合并多条assistant后精确删轮 |
| pending/approval | pending记录、权限结果、toolResponse幂等性 | pending.ts、useChat.respond、chat-history、PendingCard | 提问后重启、审批后重启、重复点击、拒绝后旧工具闭合、等待时切换模型/工作区 |
| 多题/结构化答复 | ask_user schema、双帧别名、toolResponse | pending questions判断、group答案映射、UI与类型 | 只有questions的别名帧、两组相同选项、答案含逗号、多选和自由输入 |
| 根终态/部分结果 | RunOutcome与history metadata | ChatMessage.status/stopReason、done处理、replay | budget/max_steps/provider error/cancel在live与replay一致 |
| 通用响应信封 | response.metadata/schema | shared EngineRequestResult、main client、消费者 | metadata经HTTP/IPC完整保留；sessionUsage与压缩后的行统计区分 |
| todo/changes/附件持久投影 | history或专用REST | loadHistory、chat-history、ChangesPanel/附件组件 | 重启后todo、内联diff、附件预览与重试保持一致 |
| subagent v2 | types/store/runner/projection/routes | shared/subagent、subagent-state/store、SubagentCard/export | 新版本降级、乱序seq、晚到终态、单个取消不影响兄弟、重启中断态 |
| 工具profile/权限名 | tool-profile、registry、cmd policy | main tool-profile headers、UI工具识别/审批回传 | 嵌入与远程均发送同profile；execute_cmd合法审批；不可用工具不向模型宣称 |

建议先建立共享的、可版本化的 Wire Schema 与 producer-generated fixtures，而不是继续在三个位置分别写 unknown/类型断言：engine正式产出事件 → 真实SSE parser → preload/IPC契约 → reducer → history replay，至少用同一套fixture穿过两仓。新增字段本身通常兼容，但改变旧字段语义、删除别名、改变终态或游标行为必须成组交付。

## 8. 验证证据与剩余限制

已阅读 [Aether AGENTS.md](/D:/dev/aether-code/AGENTS.md)。其要求引擎通信/IPC改动执行 typecheck、build、E2E；本轮只交付审计，无业务代码改动。未来实施不能以本文静态结论替代真机验证。

主线提供且本子项检查过的结果：

- [最新类型检查日志](/D:/dev/ai-agent-engine/docs/research/aether-code-typecheck-latest.txt)：node/web均通过。较早的[首次日志](/D:/dev/ai-agent-engine/docs/research/aether-code-typecheck.txt)曾记录 ChatView.tsx 的 `setMemory` 未用、`setOpen` 未定义；工作树在审计期间发生了后续变更，不能把首次失败当作最终状态。本子项未修改业务代码。
- [纯契约测试日志](/D:/dev/ai-agent-engine/docs/research/aether-code-contract-tests.txt)：pending/security/subagent 三组共38条，37通过、1失败；失败解释见5.3。
- [路由契约JSON](/D:/dev/ai-agent-engine/docs/research/aether-code-route-contract.json)：48调用点全部匹配、unmatched为空；[真实注册路由](/D:/dev/ai-agent-engine/docs/research/engine-registered-routes.txt)。这反驳了“子代理新旧路由不存在”的误判，不代表所有body/response正确。

已有测试的有效覆盖：[subagent-state.spec.ts:73](/D:/dev/aether-code/e2e/subagent-state.spec.ts:73)起覆盖版本、seq、live/replay失败、晚到归属、取消语义、用量；[subagent-lifecycle.spec.ts:278](/D:/dev/aether-code/e2e/subagent-lifecycle.spec.ts:278)含真实HTTP/IPC、单取消、重启等场景，本子项未自行执行，主线正在负责构建与该真机spec，最终动态数据以主报告最新结果为准；[history-replay.spec.ts:140](/D:/dev/aether-code/e2e/history-replay.spec.ts:140)验证落盘消息/思考/工具回放，不足以证明断线增量、pending恢复、精确ID或附件恢复。

本文 P1/P2 中未标动态复现的项目是基于确定代码路径的静态风险结论。尤其断线竞态、审批旧工具卡和历史交互恢复，应增加有控制时序的本地假模型 E2E；不需要调用真实外部模型，也不能仅依赖正常happy-path聊天通过。

# 会话存储深度调研：执行写入、上下文与流式投影

调研日期：2026-11-05（Asia/Shanghai）。基于当前工作树，包含已有未提交修改；没有修改引擎实现。本分报告仅依据源码和隔离测试，没有读取用户实际会话、数据库或 `.env`。

## 1. 必须区分的五种内容

| 内容 | 用途 | 关键证据 |
|---|---|---|
| `content` | 用户看到的消息；可能是文本，也可能是图片/附件块 | `src/core/agent-context/types.ts:32` |
| `modelInputContent` | 附件解析、图片处理后的实际模型输入快照 | `src/core/agent-context/types.ts:36`；`src/core/agent-loop/react.ts:464` |
| 当前上下文投影 | 摘要、近期完整工具交换和仍有效的消息，用于下一次模型请求 | `src/core/agent-context/types.ts:153`、`:158` |
| 可检索原始归档 | JSONL 压缩前仍可搜索的消息，应用编辑和删除后的逻辑原文 | `src/core/agent-context/types.ts:164` |
| StreamBus 投影/回放 | 当前轮 UI 内容、事件游标、工具卡片、运行状态 | `src/core/stream-pipeline/stream-bus.ts:54` |

`getFullHistory` 的“Full”只表示不做 token window，不代表穿透摘要读取所有历史。`getArchive` 是单独接口。UI history 还会剔除 `modelInputContent`；因此数据库里存在的信息不一定在普通 UI 返回中出现。依据：`src/api/http/history-projection.ts:4`。

## 2. 一轮执行何时写入

1. 用户输入先写入历史，保留显示内容和实际模型输入的差别，然后才发 `user_msg_id` 帧。`react.ts:463`、`:478`。
2. 工具调用和结果分别保存；工具返回结果包含 status、success、error、duration、rootRunId、turnId、文件变更证据。`react.ts:297`、`:326`。
3. 等待用户回答或权限批准时，`status=waiting` 不在普通结果分支保存最终 tool result，等待状态依赖运行记录中的 pending 和后续恢复。`react.ts:323`。
4. 模型流式 delta 可以先被用户看到，完整 assistant 正文通常在当前模型调用完成后保存；遇到捕获到的失败/取消时由 `persistPartial` 保存部分正文、reasoning、用量和终止原因。`react.ts:971`、`:1683`。
5. 最终 assistant append 完成后，才发 assistant ID 并报告 run outcome。`react.ts:1701`。
6. 工具持久化失败会记录错误并向上返回 `failedToPersist`；不能把工具副作用与历史回执视为同一事务。`react.ts:331`、`:344`、`:374`。

**含义**：进程强杀可能发生在“工具已经改变磁盘/外部系统，但结果回执还没写入”，或“用户已经看到一段模型输出，但 assistant 消息还没提交”之间。已有幂等回执和运行状态不等于所有外部工具都具备 exactly-once 副作用语义。

## 3. 存储前已经发生的有损处理

普通 tool output 的基础上限为 4,000 字符，经过 OSM 倍率；code profile 默认 64 Ki 字符，可以环境变量覆盖。依据：`src/core/agent-loop/tool-output-limit.ts:4`、`:11`。

`settleTool` 在 append 前执行 `browserOutputPresentation` / `truncateToolOutput`，并标记 `outputTruncated`。因此即使 JSONL 保留完整历史，它完整保留的也是当时写入的消息，不承诺保留每个工具原始 stdout 的全部字节。浏览器及图片使用专门的展示/模型输入分离与传输缩减逻辑，不能用一般文本截断规则概括。依据：`react.ts:314`、`:328`、`:360`。

`reasoningContent` 是单独存储字段；它和“模型内部状态/KV cache”不是同一对象。仓库中的 cacheHitTokens/cacheMissTokens 是供应商用量数据，不意味着引擎持久化了模型 KV cache。

## 4. 模型实际上下文不等于历史接口返回

每次请求会追加运行能力、任务计划、工具推进提示、只读历史合并提示、输出恢复指令等系统内容。已有计划来自 TodoStore；取回失败时明确告知不可当作空计划覆盖。依据：`react.ts:637`、`:662`。

只读工具历史还会做非持久化投影：同样的只读查询且结果完全相同才可合并；看到结果变化、失败或写操作等边界会保留因果顺序。这不会删除归档原文。依据：`src/core/agent-loop/readonly-history.ts`，以及 37 项对应测试。

历史快照自身也不足以重现一次完全相同的模型请求：还需要当时的 Agent、model/provider、工具 schema、Skills、RAG、系统提示、workspace binding、运行时能力和安全设置。QA log 可记录其中一部分，但仍不是严格可重放的模型执行镜像。

## 5. 压缩机制与成本

压缩有三条入口：执行前预算检查、回合结束后维护、手工 compact API。这里重点说明前两条。

执行中压缩以有效模型窗口/请求预算和实际完整输入估算为依据，包含系统和工具开销及输出预留。默认 `COMPRESS_THRESHOLD_RATIO=0.92` 经 OSM 规则处理，并校正非法比例；不能直接使用 README 中“超过固定 500000 token 才压缩”理解当前实现。依据：`react.ts:679`、`:686`、`:717`。

先执行 micro-compact，默认保留最近 10 条，不调用 LLM；仍超阈值再执行最多四次摘要压缩，逐步收缩保留近期消息的预算。可使用 `LLM_SUMMARIZE_MODEL`，否则回退主模型。压缩调用本身也占模型请求预算并可能失败。依据：`react.ts:718`、`:733`、`:743`、`:766`。

有原文归档时采用分块/分层摘要，返回 `AETHER_ARCHIVED_SUMMARY_V1`，保留原始 system instructions 和 digest，并提示 `search_history` 检索具体事实；旧无归档摘要分支每消息序列化上限 2,000 字符、整体 120,000 字符，同时把 user/system 指令单独保留。依据：`src/core/agent-loop/compact-prompt.ts:42`、`:91`、`:127`、`:205`。

**原文存续与模型注意到原文是两件事**：摘要在语义上仍可能漏掉重要事实；搜索工具提供按需回查能力，不能保证模型每次主动查回。对于 SQLite 已删除的旧正文，检索也不能凭空恢复。

回合结束后还有 `AUTO_COMPACT_THRESHOLD_RATIO` 默认 0.92，按最后 `currentPromptTokens` 与有效窗口触发维护；实际等待维护完成后才关闭 producer。旧文档“完全脱离前台的后台压缩”描述不够精确。依据：`src/api/http/routes/chat.ts:1788`。

## 6. 原始历史检索和多模态恢复

`search_history` 只允许当前执行的 tenant/session，不接受覆盖身份参数；字面关键词、messageId、role、offset、limit，最多每页 10 条，正文每次返回 2,000 字符，可用 contentOffset 接着读取。优先读取 `modelInputContent`，同时提供 displayContent。依据：`src/tools/get-context/search-history-tool.ts:33`、`:46`、`:73`。

图片按 imageIndex 回取：若归档内有 data URL，可恢复保留的像素；若只存远程 URL，工具返回 `IMAGE_PIXELS_UNAVAILABLE`，只说明保存了引用。sha256 标识的 hash domain 是 data-url 字符串/URL，并非原始文件字节。历史 fileVersion 声明未经可信工具证据验证时不会被升级为可信文件版本。依据：同文件 `:27`、`:91`、`:103`。

相应测试覆盖了旧历史搜索、压缩后重启、附件实际输入、图片视觉通道和删除后不复活。此次运行 5 文件 54 项通过，见 `archive-and-snapshot-tests.txt`。

## 7. SSE 回放是有界内存缓存

`StreamBus` 默认保留 2,048 个事件、8 MiB 回放字节；每个订阅者同样有数量/字节上限。事件 ID 为 `随机streamId:单调sequence`。游标属于其他 stream、超出保留区间、超过当前位置时抛出 `snapshot_required`，应刷新快照。依据：`src/core/stream-pipeline/stream-bus.ts:105`、`:248`、`:273`。

`activeStreams` 是进程内 Map。已完成运行通常再保留一分钟后清除；其存在不代表持久日志。依据：`stream-bus.ts:305`；`chat.ts:1878`。

投影本身也有上限：4,096 slots、单段文本 512 Ki 字符、浏览器图片总字符 16 Mi、子代理投影 4 MiB，会返回 `projectionTruncated`。依据：`src/core/stream-pipeline/stream-projection.ts:13`、`:227`、`:386`。

请求 `X-Aether-Run-Lifetime` 默认 `durable`：root 已受理、执行开始后，SSE 客户端断开仍继续执行；受理前工具发现等准备阶段断线会取消准备（`chat.ts:959`）。`attached` 模式进入断开宽限计时后中止。依据：`src/api/http/tool-profile.ts:15`；`chat.ts:1028`。这里的 durable 指运行不受单个查看者断开支配，不能据此推导进程重启后自动续跑。

## 8. 已实现的持久发布能力与默认生产路径不同

`ParentPublicationAuthority` 已实现串行发布屏障：子代理证据先提交，再进入可见投影；普通文本不逐 token 写 SQLite。启用 durable 时，关键事件即时 checkpoint，普通事件在下一个事件到来时检查 1 秒或 64 个事件阈值，关闭时写最后 checkpoint 及独立 closure receipt。依据：`src/core/subagent/parent-publication.ts:76`、`:86`、`:101`。

队列默认 256 个事件、1 MiB，过大或过载返回 `publication_recovery_required`。观察通道失败不会直接终止执行器；各订阅者异常被隔离。依据：`src/core/stream-pipeline/publication-queue.ts:16`、`:29`；`stream-bus.ts:169`。

**关键可达性限制**：`chat.ts:515` 的 `newStreamPublication`、`liveChildRecovery`、`durableChildRecovery` 必须由可信路由注册显式打开；`src/api/http/server.ts:115` 只是 `api.register(chatRoutes)`，没有传这些开关。因此默认生产服务器不能宣称已经启用上述完整持久发布恢复协议。存在模块及大量测试不等于默认产品路径已经启用。

即便开启了 checkpoint，普通文本也是周期性检查点，不是每 token 同步持久化。它提供观测恢复，不恢复模型生成过程、进程调用栈或正在运行的 OS 进程。

## 9. 快照、账单和上下文占用

`persistedTurnProjection` 从本轮 history 重建 UI 帧、工具卡片和用量；它明确不重放工具执行。`currentPromptTokens` 是最近一次模型请求的上下文大小，不能与历次 promptTokens 累加后当作当前上下文。它还保留 estimated/provisional/confirmed 的区分。依据：`src/api/http/chat-snapshot.ts:7`、`:26`。

最终 assistant 保存当前物理调用的增量用量，以避免累加重复；流式 usage 可呈现累计计数。partial/recovery segment 也有自己的调用用量。依据：`react.ts:976`、`:1697`。

注意兼容协议：`react.ts:1711` 的 usage 帧 `conversationId` 实际赋值 `messageId`，不能单凭字段名把所有 SSE conversationId 都当作 run.turnId。下游应按具体帧和接口约定解释身份。

## 10. 辅助日志也是数据副本

`QA_LOG_ENABLED=true` 时，将用户输入、助手输出、reasoning、system prompt、RAG、Skills、工具参数/结果和历史写为 Markdown，目录默认 cwd 下 `logs/qa`，可用 QA_LOG_DIR 改；当前 `QA_LOG_TRUNCATE=false`。它默认不开启，不应把“存在实现”误报成“当前环境实际记录”。依据：`src/observability/qa-logger.ts:7`、`:88`、`:123`；`chat.ts:1735`。

这形成会话正文的另一份存储；删除会话的路由没有调用 QA 日志删除。多轮日志重复包含历史，也有容量放大效应。普通 logger 只配置 level/transport，未配置统一 pino redact；仍需逐调用点评估日志内容。依据：`src/observability/logger.ts:9`。

## 11. 本分支验证结果及限制

- 首批 8 文件、200 项：198 通过，2 失败。通过文件为 stream-bus、ordered-publication、sse-sink、archived-compaction、readonly-history、react-streaming-context、history-projection；compaction-progress 为 3 通过、2 失败。
- 单独复核 compaction-progress 后同样 2 失败：一项在 afterEach 临时目录清理处 EPERM；另一项 light cleanup 场景期望 succeeded、实际 failed。不能把前者当作历史持久化断言失败，也不能把后者略过。详见 `compaction-progress-recheck.txt`。本次没有修复或进一步改写该测试。
- 归档/多模态/快照第二批 5 文件、54 项全部通过，详见 `archive-and-snapshot-tests.txt`。
- 上述测试使用仓库 vitest.setup 隔离的 DATA_DIR/WORKSPACE_ROOT/MEMORY_DB_PATH 和测试自己的临时目录，没有调用真实模型或操作生产会话。这里的“重启”包括测试新实例/新进程，不等价于真实机器掉电测试。

# 当前引擎核心运行时审计

审计日期：2026-09-29。对象为 `D:\dev\ai-agent-engine` 当前磁盘工作树，包含未提交修改。本笔记不把注释中的“对齐 Claude Code”“照抄”视为实际等价证明。Claude 2.1.266 本地包的能力证据由主报告另行核验；本笔记提供引擎一侧事实与可靠性差距。只读静态审计，未调用模型、未启动服务、未执行外部集成测试。

## 结论

当前已具备多供应商 ReAct 工具循环、会话历史、自动压缩、流式事件、父子代理执行、共享 token 预算、持久子任务状态、取消与崩溃标记等真实实现，不能归为“仅有聊天 UI”。但多个已命名功能存在接入断链：Anthropic/Ollama 丢弃压缩摘要、流式主路径不执行 fallback、默认 JSONL 无滑窗、Ollama 宣称工具调用却不序列化工具、最终正文全量缓存后模拟流式。核心差距首先是运行时契约的完整性与可恢复性，其次才是更多工具数量。

## 能力清单与成熟度

“已接入”表示能从聊天入口追到代码实现，不代表在线供应商实测成功。“部分”表示关键语义缺失或只对部分路径成立。“未发现”限定本次审查的源码范围。

| 能力 | 当前事实 | 状态 / 主要边界 | 定位 |
|---|---|---|---|
| Agent 策略接口 | `LoopStrategy.run()`，当前执行策略为 `ReActStrategy` | 已接入；没有发现第二套实际规划/反思执行器 | `src/core/agent-loop/strategy.ts:3`；`src/api/http/routes/chat.ts:1024` |
| 多轮工具推理循环 | 模型返回 tool calls → 调工具 → 存结果 → 再请求，默认基数 50 轮，受 OSM 倍率控制 | 已接入 | `src/core/agent-loop/react.ts:253`、`:333`、`:790` |
| OSM 模式 | off/balanced/methodology/max 调工具集合、预算/轮数/输出倍率及技能 bootstrap | 已接入；是配置与提示词方法论，不是独立求解算法；当前默认 balanced | `src/core/osm.ts:109`、`:197` |
| 中止 | 迭代边界检查、模型请求 AbortSignal、工具 invocation context 带 signal | 已接入；实际工具是否合作中止取决于其实现 | `src/core/agent-loop/react.ts:334`、`:493`、`:912` |
| 重复/失败刹车 | 工具名+排序参数的指纹；字符串仅保留前 200 字符，默认连续失败阈值 8 | 已接入；为字面归一化检测，不能称语义检测 | `src/core/agent-loop/react.ts:34`、`:51`、`:1076` |
| 并行工具调用 | 同轮非 ask_user 调用全部 `Promise.all`；全局池限流（默认 8） | 部分；不区分副作用/同文件冲突/依赖；结果等全部结束再向父流送达 | `src/core/agent-loop/react.ts:934`、`:950`；`src/core/tool-registry/registry.ts:45` |
| 工具参数恢复 | 流式拼接 JSON 参数、repairJson、解析错误转工具失败 | 已接入；注册中心没有统一 JSON Schema 校验 | `src/core/agent-loop/react.ts:565`；`src/core/tool-registry/registry.ts:33` |
| 工具动态发现 | 每轮将当前注册工具全部传给模型 | 无按需工具检索/延迟 schema 装载；大 MCP 工具集持续占用上下文 | `src/core/agent-loop/react.ts:287`、`:419` |
| 工具调用配对 | `pairToolHistory()` 重排调用与结果相邻，provider 过滤孤儿记录 | 已接入；是在清理不完整历史，不能等价于可恢复执行日志 | `src/core/agent-loop/react.ts:195`；`src/core/llm-adapter/openai.ts:284`；`src/core/llm-adapter/anthropic.ts:51` |
| 用户提问 | ask_user 发送交互/permission 帧后暂停本轮，下一请求补 tool_result | 已接入；没有持久运行中的交互等待状态机 | `src/core/agent-loop/react.ts:861`；`src/api/http/routes/chat.ts:962` |
| 工具审批 | 工具返回 needsConfirmation 时产生请求帧并停止 | 已接入；与已并行执行的其他工具之间缺少统一提交边界 | `src/core/agent-loop/react.ts:985` |
| 正文明文流式 | adapter 提供增量；ReAct 将正文全量缓存，末尾以 20 字/5ms 再播放 | 部分；用户首字延迟接近完整模型生成时间 | `src/core/agent-loop/react.ts:500`、`:555` |
| 思考/工具参数流 | reasoningContent 即时输出；OpenAI 工具 JSON 参数增量发送 | 已接入；Anthropic 工具参数等 block_stop 才上报 | `src/core/agent-loop/react.ts:509`、`:530`；`src/core/llm-adapter/anthropic.ts:397` |
| SSE 重连 | StreamBus 内存缓存全部事件、lastEventId 回放、断连 15 秒宽限、结束留存 1 分钟 | 部分；无磁盘事件流、跨进程 replay 或有界缓冲/背压 | `src/core/stream-pipeline/stream-bus.ts:8`、`:41`；`src/api/http/routes/chat.ts:588`、`:1181` |
| 流中间件 | 有 middleware pipeline 抽象 | 主聊天实际 `createPipeline([])`，不能把抽象算成已启用审核/变换链 | `src/core/stream-pipeline/pipeline.ts:3`；`src/api/http/routes/chat.ts:1036` |
| OpenAI-compatible 协议 | Chat Completions、图像转换、工具调用、reasoning字段、参数不兼容重试、embedding | 已接入；不是 Responses API；reasoningEffort 仅 o1/o3 前缀专门映射 | `src/core/llm-adapter/openai.ts:674`、`:785`、`:809`、`:965` |
| Anthropic 协议 | Messages API、text/tool_use/image、thinking文本增量、cache usage统计、自定义header | 部分；摘要丢弃、thinking block/signature 不保真；未见标准 cache_control 构造 | `src/core/llm-adapter/anthropic.ts:51`、`:249`、`:329`、`:381` |
| DeepSeek | 专用适配器、自动模型/URL判定、thinking/JSON/prefix/FIM、错误类型 | 已接入（FIM 等是否作为产品入口由主报告另核） | `src/core/llm-adapter/deepseek.ts:70`、`:111`、`:210` |
| Qwen | 专用适配器、DashScope检测、thinking与联网配置 | 已接入；兼容不代表每模型实际支持所有能力 | `src/core/llm-adapter/qwen.ts:68`、`:107`、`:120` |
| Ollama | `/api/chat` 完整/NDJSON流、计量、AbortSignal | 文本聊天已接入；工具/图片原生协议未接入 | `src/core/llm-adapter/ollama.ts:20`、`:39`、`:75` |
| 其他模型家族 | 能力表列 Gemini/Kimi/GLM，工厂 default 走 OpenAIAdapter | 兼容通道路由，不是原生 Gemini/Bedrock/Vertex 独立 adapter | `src/core/model-capabilities/index.ts:120`；`src/core/llm-adapter/factory.ts:77` |
| 模型配置 | 环境变量、系统 DB、租户 enabled model记录、request override；子模型独立解析连接/能力 | 已接入 | `src/core/llm-adapter/factory.ts:123`；`src/core/llm-adapter/resolve-model.ts:25` |
| 模型能力注册表 | vision/thinking/toolCalling/jsonMode/search/caching/audio/video/parallelTools/contextWindow，规则+DB+请求覆盖 | 部分；多个字段只是描述元数据，未见用于请求序列化或 loop决策 | `src/core/model-capabilities/index.ts:26`、`:263` |
| 重试 | 408/429/5xx/网络错误退避，取消不重试，流产生输出后不重放 | 已接入；OpenAI 内层流重试和外层包装可叠加，缺全局尝试/时限契约 | `src/core/llm-adapter/retry.ts:6`、`:61`；`src/core/llm-adapter/openai.ts:853` |
| fallback | 环境变量可生成 fallback adapter，complete 路径尝试备用 | 部分；主聊天 stream 只调用 primary；同provider单备用，无列表/独立连接解析 | `src/core/llm-adapter/factory.ts:98`；`src/core/llm-adapter/retry.ts:101`、`:120` |
| 结构化输出 | adapter支持 JSON object模式 | 未见聊天/子代理的严格 JSON Schema 输出契约或验证重试 | `src/core/llm-adapter/types.ts:85`；`src/core/llm-adapter/openai.ts:702` |
| token估算 | 汉字1.5、其他字符0.25；image_url固定300 | 启发式估算，不是供应商 tokenizer；其他多模态块未完整计量 | `src/core/utils/tokens.ts:9` |
| 上下文自动压缩 | raw tokens阈值→先清旧工具结果→LLM摘要→保留近期消息 | 已接入但有严重契约问题，见下文 | `src/core/agent-loop/react.ts:341` |
| 摘要专用模型 | LLM_SUMMARIZE_MODEL；不可用创建阶段回退主模型 | 已接入；实际摘要调用失败后不再换模型，只记录错误 | `src/core/agent-loop/react.ts:368`、`:384` |
| 历史后端 | 默认 JSONL append-only，SQLite可切换；旧 SQLite 懒迁移 | 已接入；不是 Claude transcript格式/语义全面兼容证明 | `src/storage/conversation/factory.ts:14`；`src/storage/conversation/jsonl-history.ts:123` |
| 历史修改 | 更新、删除、截断、压缩、原始文件中保留旧行 | 已接入；getFullHistory 实际是折叠后的历史，压缩前内容需读 transcript 文件 | `src/storage/conversation/jsonl-history.ts:170`、`:208`、`:383` |
| 项目说明 | 用户 ~/.aether/AE.md + 项目 .aether/AE.md + 根 AE.md，每份最多32KiB | 已接入；未见目录递归/按文件路径规则/CLAUDE.md和AGENTS.md互操作 | `src/core/project-context.ts:19`、`:35` |
| RAG/记忆注入 | 聊天入口并行知识库搜索和memory recall；结束异步提取记忆 | 已接入；附加调用预算/取消未统一 | `src/api/http/routes/chat.ts:859`、`:1107` |
| 子代理独立上下文 | 新session、任务首条消息、自己的history/model；项目根/CWD与父相同 | 已接入；未继承父聊天全上下文，无 fork-conversation选项 | `src/tools/subagent/subagent-tool.ts:141`、`:181` |
| 子代理权限 | 默认只读research工具列表，implementer继承父工具；reviewer始终只读；剔除ask_user/subagent | 已接入；reviewer可改自己TODO；无嵌套/提问/审批通道 | `src/tools/subagent/subagent-tool.ts:60`、`:116` |
| 子代理角色 | implementer/spec-reviewer/code-quality-reviewer；方法论模式载角色prompt | 已接入；不是任意agent团队配置、团队邮箱或长期worker | `src/tools/subagent/subagent-tool.ts:29`、`:122` |
| 子代理并发/时限 | 独立池默认3，可配置；同父会话排队；默认10分钟deadline；父取消传播 | 已接入 | `src/core/subagent/runner.ts:31`、`:70`、`:146` |
| 子代理持久状态 | queued/running/cancelling/succeeded/failed/cancelled/blocked/interrupted；SQLite snapshot/event/outbox | 已接入且有较完整边界设计，不是只把文本当成功 | `src/core/subagent/types.ts:1`；`src/core/subagent/store.ts:45` |
| 子代理恢复 | 启动将未完成run标记 interrupted，投影终态到父history；不自动重跑副作用 | 已接入；是状态恢复，不是执行续跑；没有resume/followup/mailbox工具 | `src/core/subagent/store.ts:195`；`src/main.ts:67`；`src/core/subagent/projection.ts:7` |
| 子代理结果 | 父subagent工具等待直到终态，短摘要8k字符、完整子transcript另存；独立进度事件 | 已接入；父模型不能在等待同批子代理时继续其它轮推理 | `src/tools/subagent/subagent-tool.ts:133`、`:184`；`src/core/subagent/runner.ts:26` |
| token累计预算 | 每physical request预留/结算，重试计量，unknown保守记账，父子预算fork与结算 | 已接入；默认Infinity，需环境变量启用；不是美元预算 | `src/core/subagent/budget.ts:19`、`:78`、`:89`；`src/api/http/routes/chat.ts:612` |
| 预算/步数收尾 | 接近上限撤tools、预留最后摘要请求；无法摘要时回已有证据且标失败 | 已接入；子代理maxSteps默认24上限64，最后一轮收尾 | `src/core/agent-loop/react.ts:425`；`src/core/agent-loop/finalization.ts:4`；`src/tools/subagent/subagent-tool.ts:99` |

## 关键缺陷和优先级

### P0：先补核心正确性

1. **Anthropic/Ollama 压缩后遗失早期上下文。** JSONL将summary转为`role: 'system'`（`jsonl-history.ts:231-240`）。Anthropic转换器直接丢弃system（`anthropic.ts:153`），请求system只取options.systemPrompt（`:329-334`），没有合并历史摘要。Ollama转换器同样跳过历史system（`ollama.ts:28`）。这不是“摘要质量差”，是摘要未进入模型请求。建议统一canonical context表示，并对各adapter做“压缩前关键约束→压缩后请求仍包含”契约测试。

2. **上下文容量检查只检查history，未包含system、tool schema和输出预留；默认JSONL压缩失败后也没有滑窗。** auto compact rawTokens来自history（`react.ts:349`），硬检查也仅`historyTokens*1.1 >= ctx.tokenBudget`（`:409-412`），未检查`modelCaps.contextWindow`上的全请求。默认`createConversationHistory()`没有maxTokens（`chat.ts:602`）；JSONL`:765`在无maxTokens时返回全量。大技能/MCP/system提示词或压缩失败时，实际请求可在本地检查通过后被上游拒绝。建议先完成统一input+output预算与一次有界恢复压缩路径。

3. **同批工具执行与审批/失败退出没有完整结果提交边界。** `react.ts:934-937`先并行执行全部工具，`:979-1010`遇blocked/needsConfirmation立即return，`:1076-1080`达到失败阈值也立即return。因此同批后面的工具可能已经产生副作用，但其结果不落父history、不发结束帧。普通工具又缺少独立durable invocation记录（子代理例外）。建议本批每个调用的终态先幂等落盘，再决定挂起/退出；对互斥写操作按资源锁串行化。

4. **全局池嵌套可形成LSP饥饿。** `tool-registry/registry.ts:45-47`外层占全局池；`lsp/index.ts:143-148`又向同池申请诊断；池只在当前fn完成后释放（`concurrency-pool.ts:29`）。在limit=1单个需要实际诊断的LSP，或limit=N且N个外层LSP占满时，内层排队可能一直等不到槽。内层还未传signal。本项是确定调用链上的静态死锁条件推断，未运行复现。

### P1：让已宣称能力在主路径生效

5. **fallback不覆盖流式主循环。** ReAct固定调用`llm.stream`（`react.ts:493`）；`FallbackAdapter.stream`只转发primary（`retry.ts:120-121`）。`LLM_FALLBACK_MODEL`在聊天最需要它时不起作用。工厂仅支持同provider、一个fallback（`factory.ts:98-101`）。此外complete直接透传options.model，会覆盖备用adapter自身模型，调用方显式携带primary model时还需修复model重写（`retry.ts:107`；provider用`options.model ?? this.model`）。

6. **正文是假流式。** `react.ts:500-507`收集完整正文，`:555-560`结束后模拟分片。应分开“模型assistant文本delta”和“工具/最终消息归属”，即时发稳定协议事件，完成后再确定存储角色，避免大回答一直没有正文。

7. **Ollama工具与视觉能力表和实现不一致。** 能力表`:201`默认toolCalling=true，`:206`声明若干vision模型。适配器发送仅model/messages/options（`ollama.ts:39-47`、`:75-83`），既无tools也无images，消息数组JSON.stringify且tool结果转user文本；响应也不解tool_calls。应实现协议或对外准确降级能力。

8. **摘要预处理先丢掉证据。** microCompact把最近10条之前所有tool结果替换占位符（`jsonl-history.ts:522-553`），再调用总结（`react.ts:354`、`:378`）；总结序列化每条只留2000字符，总计120000字符且去头（`compact-prompt.ts:41-74`）。该序列化只取content，不包含toolCall.args、toolName等结构字段。提示词要求“所有用户消息/安全指令逐字保留”，但实现先截断，无法兑现。应保留完整原始transcript引用、提取任务/约束/证据结构，并在microcompact前保留可检索凭据。

9. **附加LLM调用不受同一预算/取消约束。** vision-proxy调用只有model/temperature（`vision-proxy.ts:115-125`）；记忆提取completeOpts无signal/onRequestAttempt（`middleware/memory/extractor.ts:132-139`）；后台autoCompact单独创建history和adapter，未传budget/signal（`routes/conversation.ts:16-33`）。“父子请求预算”已实现，但不是“整次用户任务总成本上限”。应给所有utility请求统一调用上下文与可观测计量。

10. **JSONL写入/墓碑锁仅实例内。** `jsonl-history.ts:79-82`的states/writeQueues/tombstones属于instance，而chat每请求新建history（`chat.ts:602`），conversation路由另外持有instance（`conversation.ts:47`），后台压缩再新建（`:17`）。因此同session跨instance的append/clear/compact不共享排序或删除保护。已取消请求的迟到回写、后台摘要与新轮交错需要session级全局锁或持久租约。此项为静态竞态风险，未运行复现。

### P2：完整协议与高级编排

11. **Anthropic推理/缓存支持只是部分。** SDK依赖为`@anthropic-ai/sdk ^0.20`（`package.json:33`）；源码只消费thinking文本，不保留signature/redacted_thinking及其多轮block结构；未检出标准`cache_control`构造。拥有cache token统计或thinkingConfig透传，不等于完整prompt caching/adaptive thinking兼容。应升级SDK和有类型的block模型，并做provider请求快照契约测试。

12. **流/运行恢复能力不对称。** 子任务有持久事件和outbox；根chat仍只由AbortController与StreamBus内存Map维护（`chat.ts:240`；`stream-bus.ts:39`）。服务器重启后不能继续根运行或回放此前SSE，子任务仅标interrupted。建议抽取统一RunStore/InvocationStore，区分重连、继续推理、重试调用和重新执行副作用。

13. **子代理是同步委派，未到团队编排。** 当前工具接口仅task/description/systemPrompt/model/maxSteps/role/access（`subagent-tool.ts:92-103`），没有detach、resume、send_message、followup、shared task board、worktree隔离。父工具等待子完成；子无审批，无再委派，默认只拿独立任务与AE.md。可先补durable后台run+wait/poll+结果通知，再加消息/权限移交。

14. **能力表不等于可用协议。** 检索toolCalling/parallelTools/audio/video/jsonMode的调用处，主要是注册表和展示；ReAct无toolCalling/parallelTools判断且每轮发送全部schema。应把“模型宣称支持”“adapter实现支持”“当前环境允许”分开，求交集后生成工具/多模态请求。

15. **默认资源数字与注释存在漂移。** `osm.ts:160`注释称默认off，`:197-198`实现默认balanced；max压缩阈值0.7在注释被称为“放宽/留更多”，实际相对0.92是更早压缩。`react.ts`还保留“next-iteration pruning”变量/注释，但实际全量tools。深度对比应依据可达代码，不能统计名词或注释当功能。

## 已有设计中值得保留的部分

- 子代理run以tenant/root/parent/message/toolCall建立稳定关系；终态不靠文本猜测。SQLite snapshot、event、outbox同事务；父transcript投影用稳定message ID。适合继续扩展，避免重新退回“子代理就是一次字符串函数”。证据：`subagent/store.ts:45-60`、`:63-84`、`:112-123`；`subagent/projection.ts:15-24`。
- 物理请求计量在重试之前reserve、finally结算，unknown费用保守处理；预算fork同步准入防并发超分配；实际超额不被静默clamp。证据：`llm-adapter/request-attempt.ts:6-11`、`:35-55`；`subagent/budget.ts:78-113`、`:124-145`。
- 子任务取消终态争用在写事务内裁决，重启不自动重复潜在副作用；没有outcome时明确failed。证据：`subagent/runner.ts:162`、`:188-200`；`subagent/store.ts:195-209`。
- 达到步数/预算时，撤除tools、保留证据并将结果标为未完成；供应商无视空tools也不继续执行。证据：`react.ts:425-455`、`:608-614`。

## 建议验收顺序

1. 建立统一模型请求快照测试：压缩摘要、工具调用/结果配对、图像、thinking block、schema、fallback切换与终态截断，覆盖OpenAI-compatible/Anthropic/Ollama。
2. 引入完整request容量估算、固定输出预留、自动压缩失败恢复、摘要证据可回取，并统一根/子/utility请求预算与取消。
3. 补工具批次的持久终态提交、读写分类、资源锁与审批屏障，修复嵌套全局池。
4. 统一类型化事件协议与真流式，根运行持久化、有界事件日志/重连；让能力字段反映实际实现。
5. 最后再添加Claude本地包已核验的高级工作流/团队/客户端集成。以行为验收覆盖率衡量差距，不以工具名数量或提示词相似度衡量。

现有tests目录已经覆盖ReAct基本循环、子代理状态机/取消/outbox、预算fork、物理请求计量等；本审计仅静态阅读测试声明，未宣称测试通过。优先增加缺失的跨模块契约用例，而不是继续只测局部类的理想输入。

# 长时任务执行限制审计（2026-10-10）

## 结论和适用范围

本报告依据当前源码和本轮回归测试核对真实执行规则，覆盖主 ReAct 循环、子代理、模型适配器、上下文压缩、历史/记忆保留、命令任务与流式恢复。未停止正在运行的长测，也未改写其证据或被监控的 dist。

Code 模式默认没有主循环步数上限、引擎累计 token 上限、前台/后台命令默认时限或默认子代理执行时限。一次正常的正文生成触及输出上限时，现已保存分段并自动续写，每轮继续经过预算、压缩和取消检查；有持续进展的续写没有额外次数天花板。

这不等于“绝不会中断”。模型服务的上下文/输出容量、服务故障、配额、审批等待、重复无进展保护、进程重启、固定 MCP 时限和命令容量仍可能终止或阻塞执行。当前证据不能证明已完成 7×24 小时无间断运行，也不能证明所有模型经过几千轮压缩后的准确率完全不变。

表中的“默认”表示未配置该字段的源码默认。已有 DB、启动环境、项目配置或请求参数可以改变行为。用户要求的 100K 是测试使用的模型能力配置，不是把所有未知模型的真实容量无条件改成 100K。

## 设置展示契约已修复

旧 GET `/settings` 曾展示 `MAX_ITERATIONS=50`、`TOKEN_BUDGET=80000`、`COMPRESS_THRESHOLD_RATIO=0.5`、`CMD_TIMEOUT_MS=5000`，与执行默认不一致。把整页值保存可能将旧展示值变成显式限制。

当前契约如下，已保存的显式值保留原值：

| 设置 | 未配置时 GET 值 | 实际含义 |
| --- | --- | --- |
| `MAX_ITERATIONS` | `null` | 无设置级本地步数上限。Code 忽略此 env 设置；显式子任务 `maxSteps` 仍有效。 |
| `TOKEN_BUDGET` | `null` | 无设置级本地上下文预算。Code 忽略此值，仍受模型窗口约束。 |
| `CMD_TIMEOUT_MS` | `null` | 使用模式默认。Code 无默认时限；其他模式默认见下表。 |
| `COMPRESS_THRESHOLD_RATIO` | `0.92` | 基础压缩比例；OSM max 实际覆盖为 0.7，其他模式有防御性校验。 |

GET 新增只读 `runtimeLimits`，显示 Code/其他模式适用值、OSM 后的数值、命令模式默认和有效压缩比例。PUT 不写入 `runtimeLimits`/`managedKeys`；前三项 PUT `null` 清理该项 DB/当前进程 env，恢复模式默认。它们不是模型容量、用户审批或服务配额的绕过开关。

源码：`src/api/http/routes/settings.ts`。真实 HTTP/DB 专项 `settings-runtime.test.ts` 验证默认、显式值保留、读写回环、按字段重置、OSM 比例及异常比例防御；5/5 通过。引擎 console 的消费者改为只提交已修改字段；该前端的独立验证由客户端同步代理记录。

## 主循环、输出和预算

| 限制/规则 | 当前默认与配置入口 | 仍会停止或阻塞的条件 | 测试/源码依据 |
| --- | --- | --- | --- |
| 主 ReAct 步数 | 未给 `ReActOptions.maxIterations` 时，Code 为 Infinity；其他模式读取正 `MAX_ITERATIONS` 并应用 OSM 倍率，未配同样 Infinity。显式参数优先，保持原值。 | 显式有限步数用尽返回 `MAX_STEPS`。源码注释中“NaN 表示不限”不符合 JS 循环判断；传 NaN 实际不会进入循环，不能作为受支持配置。应使用省略或 Infinity。 | `react.ts:316`；`react.test.ts` 显式上限及 finalization 测试。 |
| 子代理步数 | `subagent.maxSteps` 不传为 Infinity；提供时必须是 ≥1 的整数。 | 有限任务接近最后一步时 `finalizeOnLimit` 预留一次无工具总结，尚未完成仍为失败，不伪报成功。 | `subagent-tool.ts:134`；`react.test.ts` bounded finalization。 |
| 主输入上下文 | Code 使用 `modelCaps.contextWindow`；其他模式取 `min(tokenBudget, contextWindow)`。配置模型 `capabilityOverrides.contextWindow`；请求覆盖优先于 DB，DB 优先于内置规则。 | 固定系统提示/工具加输出预留装不下，或压缩后仍装不下，返回 `CONTEXT_LIMIT`；最终 adapter 还会按完整请求检查 `CONTEXT_WINDOW_EXCEEDED`。 | `react-streaming-context.test.ts`；`request-attempt.ts:7`；模型能力/模型 CRUD 测试。 |
| 本地 `TOKEN_BUDGET` | 默认不注入；Code 的 context factory 忽略显式及 env 本地预算。其他模式正 env 值应用 OSM 倍率，显式 context 参数不放大。 | 非 Code 保守历史估计达到本地预算（`ceil(historyTokens × 1.1)`）时可提前停止。它不是供应商累计计费额度。 | `factory.test.ts` 10 项含 Code 忽略/缺省未配；`factory.ts:52`。 |
| 累计请求花费 | `RequestBudget` 默认 Infinity。HTTP Code 强制 Infinity；其他模式 `AGENT_TOTAL_TOKEN_LIMIT` 为有限正数时启用。子代理 Code 不采用 `SUBAGENT_TOKEN_LIMIT`；其他模式可分配子额度。 | 显式有限额度不足时，物理请求发出前拒绝 `TOKEN_BUDGET_EXCEEDED`。未报告 usage 的失败请求保留预留额；并发请求先预留，不能超卖。 | `budget-fork.test.ts` 12/12；`subagent-runtime.test.ts` 物理请求和子额度；`react-output-continuation.test.ts` 续写预算。 |
| 子额度分配 | 启用有限父额度时，单子额度 ≤父额度 25%；保留父额度至少 20% 或 finalization reserve，以较大者为准。未启用有限额度则仅记账。 | 分叉申请不足会失败；子额度用尽也会失败。关闭额度不会删除已计费/未知请求事实。 | `runner.ts:167`；`budget-fork.test.ts`。 |
| Code 单次输出 | 没有固定 8192 的引擎 cap；实际 wire cap 取剩余配置上下文容量，再受协议/模型输出上限约束。100K 时输入和输出总和不超过 100000。 | 单次 `length` 无工具且正文有新进展可自动续写。工具调用被截断、没有有效正文、重复正文、已无显式剩余步数或处于预留 finalization 时仍以 `OUTPUT_LIMIT` 停止。 | `react-output-continuation.test.ts` 15/15；`provider-attempts.test.ts`。 |
| 非 Code 单次输出 | `maxOutputTokens` 显式值优先，否则 `min(8192, max(256, floor(effectiveBudget / 4)))`。 | 同样可正文续写，但受显式步数/花费额度和 provider 容量影响。 | `react.ts:474`；续写专项。 |
| 正文续写无进展 | 每条连续续写链记录全文规范化 SHA256；工具轮次后重置。没有单独的续写总轮数 cap。 | 相同正文（允许空白差异）再次触顶不继续；已发出的正文如实保留，不被包装为成功。仅思考/空正文的 length 不重试。 | 12 次有进展 length 后第 13 次成功；重复/空白变体/思考-only 测试；`react.test.ts` 第 2 次重复 length 终止。 |
| 空最终回答 | 默认没有静默“补一句成功”。 | 正常 stop 但正文和工具都没有时，返回 `EMPTY_OUTPUT` 并保留安全的形状/用量诊断；有 thinking 不等于收到答案。 | `react-streaming-context.test.ts` 两个 empty-output 场景。 |
| 工具无进展 | `MAX_CONSECUTIVE_FAILURES` 缺省 8；显式 0 禁用此可选止损；正数为每批次数上限。指纹包含完整参数、结果、状态和错误。 | 无新成功进展的永久失败/相同成功观察达到阈值，返回 `REPEATED_FAILURE`。变化后的读取、运行中 command/task 轮询和暂时网络故障不计入。 | `tool-progress.test.ts` 7/7；`tool-batch-settlement.test.ts` 连续变化读取、0 禁用及重复失败集成。 |
| 提问数 | Code Infinity；其他模式 `maxAskUserCount` 缺省 5，可请求覆盖。 | 达到次数后不再提供 ask_user；真实提问或授权请求令本轮进入 waiting/blocked，须用户回答。 | `react.ts:334`/工具批次 pending 测试。 |
| 用户取消/历史修改 | 没有“后台忽略取消”模式。 | 用户取消、清空/删除/回滚会取消对应主任务、子任务和命令；租户/权限隔离不会因长任务而放宽。 | `chat-recovery.test.ts`、工具批次 settlement、history mutation 测试。 |

续写段均按唯一 assistant ID、同一 `conversationId` 保存，`metadata.outputContinuation=true` 表示当前段之后还有后续正文；最后段正常保存。`onOutput/onOutcome` 汇总本轮可见正文，实际 usage 保留每个物理请求/段的增量，不能重复计费。JSON 在字符串转义处截断、JavaScript 在 `return` 中间截断的专项均验证无新增分隔符、拼接后可解析/执行。

## 压缩和长期可追溯性

| 规则 | 当前默认/配置 | 失败边界或准确率影响 |
| --- | --- | --- |
| 执行前压缩触发 | `COMPRESS_THRESHOLD_RATIO` 缺省 0.92；OSM max=0.7；其他模式非法/非正回落 0.92，>0.95 clamp 0.95。比较完整估算输入加输出预留，不是累计花费。 | 在 100K Code、5000 输出预留下，通常输入估算 >87000 触发 92% 路径；max 模式约 >65000。不能用 92K 的“纯正文输入”误判触发失败。 |
| Code admission 预留 | `min(8192, max(256, floor(window × 0.05)))`；100K 为 5000。这是触发压缩/准入的安全空间，实际 wire 生成可用全部剩余容量。 | 估算与服务 tokenizer 并不完全一致，远端仍可能返回 context 拒绝。模型能力设得比真实容量大不能突破上游。 |
| Micro-compaction | 先处理最近 10 条之前的工具结果；Code 工具模型投影通常最多 64KiB，其他模式见输出表。 | 原始 replay/archive 与模型投影分离，不能因 metadata/diff/archive 数据大而全部回灌 prompt。 |
| 执行前压缩重试 | 每次准备请求最多 4 个压缩 pass；保留量逐 pass /2；没有缩小就停止本次压缩尝试。有限累计预算须能承担 `rawTokens ×3 +16384` 估计，否则跳过压缩。 | 摘要服务失败不修改原始历史；原始请求仍装得下可继续，装不下则明确失败。4 pass 是一次准入的保护，不是会话压缩总次数上限。 |
| 原文近期保留 | `floor(min(window ×0.2, max(0, threshold −固定输入−输出预留−8192)) / 2^pass)`；典型 100K 约 20K→10K→5K→2.5K。 | retention 边界保持完整工具调用/结果交换；大消息可能整体进入摘要。可检索原文并不代表每条原文仍在当前 prompt。 |
| JSONL 分页摘要 | 默认 `HISTORY_BACKEND=jsonl`；归档所有原始段。摘要页 input≤min(24000, window×0.55, 剩余容量)，每页所有内容都访问；输出默认 ≤4096，适配小窗口。 | 一次空摘要有一次加大输出预算重试；有用但过长摘要继续层级缩减。缩减最多 12 层，空/不缩小/失败摘要不提交；达到边界可使大请求无法准入。 |
| 摘要思考参数 | 事实摘要请求关闭可选 thinking；特定 MiniMax/GLM 网关因协议要求仍强制自己的 thinking 开关。 | 固定 thinking 服务可能耗尽单次输出而无正文。一次摘要重试不是保证所有供应商永远能产生有效摘要。 |
| SQLite 回退摘要 | `HISTORY_BACKEND=sqlite`；旧摘要序列化每条 2000 字符、总计 120000 字符，系统和用户指令另行逐字保留。SQLite 压缩采用重建，不保留已覆盖的全部原始旧行。 | 工具/assistant 事实可摘要损失；大量不可删的原始用户指令仍可能大于 100K。要求长期逐条追踪时应使用默认 JSONL 归档，而不是把 SQLite 回退描述成等价无损。 |
| 历史窗口 | SQLite `HISTORY_MAX_TOKENS` 基数 20000，经 OSM 放大；JSONL 未传显式构造 maxTokens 默认不窗口化。当前 ReAct 优先读完整活动投影，避免数据库滑窗藏掉系统约束。 | 完整活动投影仍有摘要 floor；归档的覆盖行必须显式通过 archive/search_history 读取。无限历史存储与无限模型上下文不是同一概念。 |
| 请求结束后的后台压缩 | `AUTO_COMPACT_THRESHOLD_RATIO` 默认0.92；窗口未知时 `AUTO_COMPACT_TOKEN_LIMIT` 默认500000；保留近期 6 条。新任务运行/等待时后台 job 跳过，由其循环负责压缩。 | 此路径不承担执行前准入；失败异步记录。当前后台 ratio 没有与 ReAct 相同的非法值/clamp 防御，不能依赖它保障100K。 |
| 会话记忆 | Code 默认 session，其他模式 global；`ENABLE_LONG_TERM_MEMORY=false` 强制 off，用户可切换scope。记录有来源 session/turnId，当前修正优先。 | 默认回忆注入预算 `min(8000, window×0.08)`，单条投影≤2000 token；100K 为最多8000。未注入的全文留 DB，须按来源检索，不能宣称数千轮全部原文每次都在prompt。 |
| 记忆提取与维护 | 提取分块 input≤16000 token，output≤4096并适配窗口；嵌入服务独立，缺失时关键词回忆降级。维护默认24h，弱记忆阈值0.05。 | 自动提取可能失败且异步记录；语义召回/摘要仍有遗漏风险。当前 consolidation 只标记弱项，不直接删除全部弱记忆；原始对话归档是核实依据。 |

测试依据：`archived-compaction.test.ts` 9/9（全页覆盖、空摘要重试、过长缩减、多次压缩/重启、原始系统角色、编辑/删除真实性）；`compression-model-budget.test.ts` 6/6（零 stored tokens 的真实参数预算、完整 parallel tool exchanges、强制进展）；`react-streaming-context.test.ts` 36/36（系统/工具/附件准入、压缩失败、缩减 retention、阈值异常、模型输入重放）；模型输入持久化、原生图像预算、归档分页/检索专项由本轮关联报告记录。

## 超时、并发、输出保留和断线

| 层次 | 当前真实规则/可配置性 | 对长任务的实际影响 |
| --- | --- | --- |
| 模型 SDK 请求 | 本机 OpenAI/Anthropic SDK 默认 `600000ms`，引擎构造器 `maxRetries=0` 且没有 timeout 配置入口。SDK fetch timeout 在拿到 Response headers 时清除。Ollama只跟调用signal。 | 600s 是等待 HTTP fetch/响应头的边界，不是“整个 Agent/SSE 只能运行10分钟”。返回头后provider、代理和底层网络仍可能中断流；也缺少引擎层可配置的流空闲超时。 |
| 模型重试/fallback | RetryingAdapter 默认3次retry，共最多4次物理请求，退避1/2/4s（maxDelay30s）。408/429/5xx或明确network等可重试；400/401/403/非retryable不重试。 | 一旦下游已收到任意chunk（包括thinking/tool参数/usage），不重放本次stream，也不切fallback重放，防止重复内容/工具副作用；这样的中途网络故障仍会结束本轮，保存partial。 |
| 命令执行时限 | Code省略timeoutMs持续到退出或取消；显式timeoutMs有效。其他模式 env覆盖优先；未配前台standard/safe30s、full-access120s、后台600s。 | 显式deadline触发`timed_out`并保留输出。长编译/测试须省略Code timeout或设置适当值。命令非零退出本身是工具失败，主AI可读取诊断继续修复。 |
| 命令全局容量 | manager 默认最多16个活跃/正在启动的任务；仅构造选项`maxConcurrentJobs`，当前singleton无env/API入口。 | 第17个拒绝`COMMAND_CAPACITY`/429；不会自动杀掉前16个，也没有内置排队。长期开发遗留多个server/background job可能撞容量。 |
| 工具/子代理并发 | 全局工具池 `TOOL_CONCURRENCY_LIMIT` 默认8，可设置热更新；子代理每个父session池默认3，`SUBAGENT_CONCURRENCY_LIMIT`正值最多16，runner初始化读取。 | 排队本身不是执行失败；子代理显式deadline从排队前开始计时，非Code默认10min可在排队中超时。Code未配deadline无此默认时限。 |
| 子代理deadline | Code默认无deadline；显式`SUBAGENT_DEADLINE_MS`正值或runner请求deadline生效。非Code默认10分钟。 | 超时取消并持久化`DEADLINE_EXCEEDED`及partial。用户/父取消会传播子任务。 |
| Skill脚本 | `run_skill_script`默认60000ms，工具参数可调；exec `maxBuffer=10MiB`。 | 长技能脚本可超时或因输出超buffer失败；不是Code执行命令的无限时规则。 |
| MCP | stdio/Streamable HTTP JSON-RPC默认固定15s；legacy SSE endpoint/RPC也15s；REST discovery10s/call30s，初始化通知5s。当前无每server通用timeout配置入口。 | 长MCP操作可报timeout；远端副作用状态可能未知，不能自动盲目重复。长会话正常不意味着每次长MCP操作都能完成。 |
| 浏览器 | bridge poll20s、lease65s、command60s；`browser_wait`≤10s。内部构造可改，工具wait参数有硬上限。 | 浏览器未持续轮询会失lease；单操作未回应会失败，须重新snapshot核实状态。不会因任一poll timeout直接宣布整个Agent成功/结束。 |
| 文件检索 | `grep_search.timeoutMs`默认120000，可传0不设超时；maxResults/offset分页。 | 搜索超时是工具失败，可缩小路径/分页/调timeout；无限制全文读取仍可能导致后续100K准入失败。 |
| 模型工具结果投影 | Code默认64KiB，`CODE_TOOL_OUTPUT_MAX_CHARS`正值覆盖；其他模式`TOOL_OUTPUT_MAX_CHARS`基数4000经OSM倍率。真实native image保留像素并按语义图像预算；任意base64文本不会绕过。 | 超大结果摘要/头尾投影不等于全量进入prompt。完整命令输出用command_output分页；文件用分页读取；图像token估算不是供应商权威值。 |
| 命令输出/历史保留 | 内存tail256KiB、page64KiB，完整输出独立落盘。终态任务默认全局500个/每session100个/7天，以先到者为准；活跃任务不prune。仅构造参数可调。 | 旧终态command logs可在100/500个之前的证据位置消失；不会自动终止活跃任务。需要长期精确证据应在项目工件归档关键日志。 |
| SSE回放/订阅队列 | 默认最多2048事件或8MiB，构造选项可调；snapshot保存当前投影。Code retainOnDisconnect=true。 | 过旧cursor/慢订阅者要求重新snapshot，仅断开该订阅者，不因溢出终止producer。非Code无人重连15s则abort；Code远端断线继续并可重接。 |
| 服务重启 | root/child/command持久化记录恢复为interrupted，`ENGINE_RESTARTED`，不会自动重跑或接管此前进程。 | 能恢复历史和真实状态，不等于自动继续此前Agent/命令。系统升级、崩溃或断电仍中断执行；7×24要求额外核实故障恢复策略。 |

源码定位：`openai.ts:654`、`anthropic.ts:267`；安装的 SDK `openai/core.mjs:131,375`及`@anthropic-ai/sdk/core.mjs:117,335`；`retry.ts:46`；`execute-command.ts:76`；`manager.ts:74,124,277`；`runner.ts:32,79`；`run-skill-script.ts:29`；`mcp/client.ts:80,132,388`；`browser-bridge.ts:53`；`stream-bus.ts:51`；`chat.ts:718`；`root-runs/index.ts:104`。

## Provider 客观限制

当前 Anthropic-compatible wire 输出上限按模型分支：MiniMax 32768，GLM131072，Kimi K2.6 262144，其他分支393216。DeepSeek V4 OpenAI-compatible 协议正字段最大基数393216。它们是适配器当前支持的协议上限；有配置context时仍须缩至剩余capacity。例如100K配置、99.6K请求输入时实际最大输出400，而不是将393216当成可用窗口。

上游仍可能有更小的实际输出容量、请求字节数限制、RPM/TPM、账单/余额、凭证有效期、并发、排队时长、代理 idle/read timeout，以及固定thinking策略。引擎设置不能开放这些供应商资源。模型服务报400/401/403、配额耗尽或stream中断应如实显示，不能通过假成功或无限自动重放隐藏。

100K配置应对每个测试主模型、换模后模型和子模型核对最终物理请求。内置能力表包含启发式值，部分未知模型未给窗口；需要明确 DB/请求 override。不能由“前端显示100K”推断所有压缩/主请求都已使用同一容量。

## 本轮测试证据和未验证项

本报告编写时实际执行的相关回归：

- ReAct/续写/流式上下文/工具settlement：4个文件，95/95通过。包括更新旧单次length终止断言，改为真实重复续写停止契约，没有通过假报成功消除失败。
- 设置HTTP/DB、embedding设置、context factory、续写：4个文件，32/32通过；`npm run typecheck`通过。
- 无进展、子代理运行/预算、物理请求、分页摘要、存储保留边界、HTTP恢复、真实命令和SSE总线：9个文件，131/131通过。
- `engine-longrun-candidate-full-20261010.json`此前全量结果1495通过/1失败/1pending；唯一失败为旧length断言，现已通过上述95项回归。新候选全量构建/运行结果由主代理另外记录，本报告不把旧JSON改写成新全量结果。

这些是边界与回归证据，其中有mock模型响应和缩短计时的fixture；不能代替5–6小时真实多模型负载或168小时实测。

尚须在真实压力阶段单独验收：

1. 每个模型的主/子Agent物理请求都固定100K；重复真实压缩后的关键约束、旧附件细节、来源messageId/turnId与最新修正都能被核实。
2. 长任务触顶续写、Minimax/GLM固定thinking、模型交叉切换与压缩失败恢复的真实服务行为，不能只根据模拟chunk验证宣称供应商已通过。
3. MCP超过15秒、长Skill脚本、超过16个command job及超过100个完成命令的场景；目前相应边界仍存在，报告没有把它们隐藏。
4. 长期磁盘/数据库增长、模型计费增长、memory提取/检索准确率、慢订阅者与真实远端断线重接。
5. 服务重启/升级/网络中断的可恢复边界；当前恢复历史与interrupted状态，不自动恢复执行。
6. 168小时连续运行及几百/几千轮对话准确率。目前均未证实完成。

本报告仅声明经过核对的默认、触发条件和已有证据，不承诺“所有限制已移除”或“7×24绝不会中断”。

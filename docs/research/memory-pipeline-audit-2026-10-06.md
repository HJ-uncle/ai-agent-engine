# 三层记忆体端到端审计（2026-10-06）

## 结论

引擎已经实现了一个“向量 + 关系 + 图”三脑记忆管线，但它只在 `general` tool profile 的聊天请求中启用。Aether IDE 的普通 HTTP/SSE 请求固定发送 `X-Aether-Tool-Profile: code`，因此 IDE 代码会话不会自动召回、自动抽取长期记忆，也不会注册 `remember/recall/...` 记忆工具。这是当前最重要的能力差距。

## 三层结构和数据流

### 1. 记忆节点/关系层（关系数据库与图）

- `src/storage/memory/schema.ts:10-108` 创建 `memory_nodes`、`memory_edges`、`memory_tags`、`memory_node_tags` 和索引。
- 节点隔离以 `tenant_id` 为硬边界；节点另带 `session_id`、来源会话、类型、重要性、强度、衰减率、情绪字段、摘要/详情和 embedding。
- `src/storage/memory/memory-manager.ts:68-194` 提供节点 CRUD；`198-294` 提供关键词、标签、重要性、近期和会话查询。
- `src/storage/memory/memory-manager.ts:325-500` 提供边 CRUD、邻居查询、递归多跳遍历和关联节点查询；边类型包括 `reinforces/contradicts/leads_to/part_of/similar_to/tagged_with`。
- `src/api/http/routes/memory.ts:1-210` 暴露记忆 remember/recall/list/graph、节点编辑删除、手动 link 和 consolidation API，可供独立记忆管理 UI 使用。

### 2. 向量层（语义召回）

- `src/storage/memory/schema.ts:31-42` 为节点保留 `F32_BLOB(1536)` embedding 和向量索引。
- `src/middleware/memory/extractor.ts:151-166` 抽取后调用当前模型 adapter 的 `embed`；失败时仍保存无 embedding 节点。
- `src/storage/memory/memory-manager.ts:297-320` 用 `vector_distance_cos` 做相似度召回，默认最大距离 `0.4`。
- `src/storage/memory/db.ts:42-86` 在本地 libsql 不支持 F32/vector 扩展时降级建表/索引，因此向量召回可能不可用，但关键词和图召回仍可工作。

### 3. 抽取、路由和图协同层

- `src/middleware/memory/extractor.ts:97-246`：对完整对话做 LLM JSON 抽取；过滤六类节点和 `importance >= 0.3`；存节点、自动建立 `part_of` 关系，并用 embedding 与旧节点建立 `reinforces` 跨会话关联。
- `src/middleware/memory/extractor.ts:250-270`：LLM 先将用户输入路由为 `NONE` 或 1-3 个检索词；路由失败降级为原 query。
- `src/middleware/memory/extractor.ts:272-390`：先向量取最多 10 个锚点（阈值 0.65），锚点不足 5 个时用 SQL 关键词取最多 50 个候选；随后从首锚点做 2 跳遍历，并对其他锚点做 1 跳扩展；按重要性/强度排序后注入 system prompt。

## 聊天入口的实际启用条件

- `src/api/http/routes/chat.ts:989-1000`：`enableMemory = toolProfile !== 'code' && process.env.ENABLE_LONG_TERM_MEMORY !== 'false'`。这两个条件同时满足才会并行执行三脑召回。
- `src/api/http/routes/chat.ts:1304-1331`：同一个 `enableMemory` 条件才会在请求结束后异步抽取并写入长期记忆。
- `src/api/http/routes/chat.ts:774-783`：客户端可透传 `requestedInlineMemoriesXml`，但同样被 `toolProfile !== 'code'` 包住；code profile 连客户端自身记忆 XML 也不会注入。
- `src/tools/tool-profile.ts:29-38`：`GENERAL_SERVICE_TOOLS` 明确包含 `remember、recall、search_memory、list_memories、forget、link_memories`，`isCodeProfileTool` 将其排除。
- `src/tools/memory/memory-tool.ts:1-160`：general profile 注册五个记忆工具；code profile 没有这些工具。
- `src/tools/get-context/get-context-tool.ts:105-128`：`get_current_context` 只有非 code profile 才读取/展示记忆节点。
- Aether IDE 固定发送 code profile：`D:/dev/aether-code/src/main/engine/tool-profile.ts:1-2` 定义 `X-Aether-Tool-Profile: code`；`D:/dev/aether-code/src/renderer/src/core/engine/useChat.ts:779-791` 发送聊天请求，未发送记忆 XML 字段。因此 IDE 代码会话当前实际上是“项目上下文 + 会话历史”，不是三脑长期记忆。

## 历史、上下文压缩与记忆边界

- `src/api/http/routes/chat.ts:1333-1346` 在 `currentPromptTokens > contextWindow * AUTO_COMPACT_THRESHOLD_RATIO`（默认 0.92）后异步触发 `autoCompactSession`；这是会话历史压缩，不是长期记忆抽取，二者独立。
- `src/core/agent-context/factory.ts:35-58`：code profile 不设置本地 `tokenBudget`；general profile 只有显式 `options.tokenBudget` 或正数 `TOKEN_BUDGET` 才有预算，并可受 OSM 倍率影响。
- `src/api/http/routes/chat.ts:741`：code 的 `RequestBudget` 为 `Infinity`；general 使用 `AGENT_TOTAL_TOKEN_LIMIT`。
- `src/core/subagent/runner.ts:76-88,166-176`：code 子代理默认无 deadline、无累计 token 限制；general 使用 `SUBAGENT_DEADLINE_MS/SUBAGENT_TOKEN_LIMIT` 并从父预算分叉。
- `src/main.ts:73-74` 启动 default tenant 的 24 小时记忆 consolidation daemon；`src/storage/memory/consolidation.ts:7-62` 只按时间衰减 strength 并报告 weak nodes，不自动删除节点或自动合并重复节点。

## 发现的缺陷/影响

1. **Aether IDE code profile 完全关闭三脑记忆**（高影响）：既无自动召回，也无自动抽取，也无记忆工具。`ENABLE_LONG_TERM_MEMORY=true` 无法覆盖 `toolProfile !== 'code'`。
2. **自动抽取没有去重/幂等键**（中高影响）：每次长于 50 字符的请求都可能生成相同节点；只建立相似边，不更新旧节点。长期运行会膨胀节点和召回噪声。
3. **抽取在 `setImmediate` 后台运行，未纳入请求生命周期**（中影响）：客户端可能已收到完成状态，但 LLM 抽取仍在运行；进程重启会丢失该次抽取，失败只写日志。
4. **embedding 失败时没有稳定的降级标记/指标**（中影响）：向量层不可用时仍会正常返回，但只能依赖关键词；UI/运维看不到召回质量下降。
5. **图扩展排序和去重较粗**（中影响）：只对第一个 anchor 做 2 跳，对其余 anchor 做 1 跳；最终按 `importance/strength`，没有时间、新旧冲突或边类型权重，可能把旧冲突事实置于新决定前。
6. **跨租户边操作需审查调用面**（高风险边界）：节点读取按 tenant 过滤，但 `src/tools/memory/memory-tool.ts` 的 `link_memories` 直接插入边；应确保 source/target 节点都属于当前 tenant，否则可能产生跨租户引用（数据库 FK 本身未限制 tenant 一致性）。
7. **衰减守护进程只启动 default tenant**（中影响）：`main.ts` 传入固定 `'default'`；如果生产请求使用其他 tenant，自动 consolidation 不会覆盖这些租户，除非调用 API 手动触发。
8. **设置默认值与执行默认值存在文档漂移**（低中影响）：`settings.ts:55,75` 对外展示 `TOKEN_BUDGET=80000` 等默认，而 agent context 在 env 未配置时不设置本地预算；旧研究文档仍记录 60k/120k 口径，需统一产品说明。

## 已执行的非破坏性验证

命令（未启动 Electron、未触碰真实用户数据库/密钥）：

```text
npx vitest run src/middleware/memory/__tests__/extractor.test.ts src/tools/__tests__/tool-profile.test.ts src/api/http/routes/__tests__/tool-profile-routes.test.ts src/core/agent-context/__tests__/factory.test.ts src/storage/memory/__tests__/db.test.ts --reporter=dot
```

结果：5 个测试文件、63 个测试全部通过。覆盖抽取 JSON 解析/提示词、profile 隔离、code/general 注册集合、MCP/skill 不越权、路由 header 权威性、上下文预算决策和记忆数据库在无向量扩展时的降级建表。

## 建议的落地顺序

1. 先在能力握手中明确 `memory: { recall, extract, tools, inline }`，让 Aether IDE 明确展示 code profile 当前关闭长期记忆，而不是静默缺少入口。
2. 若产品要求 IDE 也具备三层记忆，增加独立 `memory` capability 或将记忆工具作为 code 的可选扩展；不要直接把 general 全工具集合塞进 code。
3. 抽取写入增加 tenant/session/query 指纹与相似节点 upsert，冲突事实按时间和 `contradicts` 关系处理；抽取失败记录可观测指标。
4. consolidation 按活跃 tenant 调度，并在删除/链接前校验两端 tenant 一致；将弱节点“候选遗忘”与实际删除分成明确操作。
5. 在 Aether 前端提供记忆开关、查看/编辑/删除/导出入口和“本轮是否使用记忆”状态；远端模式沿用相同能力声明和测试矩阵。

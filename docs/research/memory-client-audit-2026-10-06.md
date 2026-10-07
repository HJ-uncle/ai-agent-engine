# 三层记忆体与 Aether Code 客户端深度审计

日期：2026-10-06  
范围：`D:\dev\ai-agent-engine` 引擎、`D:\dev\aether-code` Electron 客户端及同仓库的 `multi-agent-console` 记忆面板。  
方式：只读代码审计；没有读取真实用户数据库、密钥或生产数据，也没有修改产品代码、运行测试。

## 结论先行

当前引擎确实实现了一个“向量 + 关系 + 图遍历”的三路召回方案，但它不是严格意义上按生命周期分层的“三层记忆体”。代码里没有独立的工作记忆层、情景记忆层、语义/长期记忆层及其明确晋升策略；现状是同一张 `memory_nodes` 表上的不同索引和查询路径。自动提取和召回主要由普通聊天路由触发。

对 Aether Code 来说，记忆功能目前没有完成端到端接入：客户端协议白名单没有 `/memory/*`，客户端也没有记忆 API、设置页或图谱入口；更关键的是客户端固定发送 `X-Aether-Tool-Profile: code`，引擎在 `code` profile 下明确关闭长期记忆和记忆工具。因此在 Aether 的正常代码 Agent 对话里，记忆不会自动召回、不会后台提取，记忆工具也不会出现在可执行工具集中。现有图谱 UI 属于独立的 `multi-agent-console`，不属于 Aether Code。

## “三层”现状到底是什么

### 1. 向量层（代码注释称“海马体”）

`buildMemoryRecallBlock` 首先调用模型 embedding，再用 `recallSimilar` 做余弦距离检索（`src/middleware/memory/extractor.ts:287-299` 附近）。节点表含 `embedding_json` 和 `F32_BLOB(1536)`，由 `vector32(?)` 写入（`src/storage/memory/schema.ts`、`src/storage/memory/memory-manager.ts:78-124`）。没有 embedding 时会跳过向量召回并继续走关键词路径。

### 2. 关系层（代码注释称“皮层”）

向量锚点不足时，`listNodes` 对 `summary`/`detail` 做 `LIKE` 关键词查询，并按重要性排序（`src/middleware/memory/extractor.ts:301-319`；`src/storage/memory/memory-manager.ts:198-240`）。SQLite 的租户、会话、类型、重要性、强度和时间索引定义在 `src/storage/memory/schema.ts`。

### 3. 图层（代码称“联络图”）

召回先对第一个锚点做最多两跳 `traversePath`，再对其余锚点补充一跳关联（`src/middleware/memory/extractor.ts:322-348`）。边类型包括 `reinforces`、`contradicts`、`leads_to`、`part_of`、`similar_to`、`tagged_with`（`src/storage/memory/schema.ts`）。自动提取时，`relatedTo` 只通过字符串包含关系建立 `part_of`，跨会话相似 embedding 则建立 `reinforces`（`src/middleware/memory/extractor.ts:189-240`）。

这三条路径共享同一组节点和边，属于三路检索/索引，不是三个独立存储层。`memory_nodes.type` 目前只有 `fact`、`preference`、`decision`、`lesson`、`narrative`、`milestone`（`src/storage/memory/schema.ts`），这些是内容类型，不等于工作、情景、语义三层。

## 写入、召回和生命周期

普通聊天在 `toolProfile !== 'code'` 且 `ENABLE_LONG_TERM_MEMORY` 未设为 `false` 时并行执行知识库 RAG 和记忆召回（`src/api/http/routes/chat.ts:988-1000`）。回答完成后用 `setImmediate` 异步从完整历史提取记忆，默认重要性阈值为 `0.3`（`src/api/http/routes/chat.ts:1304-1329`）。提取过程会再调用 embedding，并写入节点和部分关联（`src/middleware/memory/extractor.ts:97-187`）。

`MemoryConsolidator` 可手动/定时执行衰减；HTTP 接口返回强度低于阈值的候选项，但当前接口不自动删除候选（`src/api/http/routes/memory.ts:161-182`）。引擎管理器提供 `decayNodes`、`consolidate`，但从当前调用链没有证据表明每个租户都有可靠的自动清理策略。长期增长、重复提取、旧节点合并和冲突解决仍需产品规则。

## Aether Code 客户端的真实覆盖情况

### 客户端没有记忆 UI/API 入口

对 `D:\dev\aether-code\src` 的只读搜索只发现聊天工具名称映射 `remember`、`recall`、`list_memories`，以及与消息折叠有关的“memory”命名；没有 `/memory` API client、记忆设置页、节点列表、编辑/删除、召回调试面板或图谱页面。现有知识库设置页是独立资源（例如 `KnowledgeSettingsView.tsx:313-412`），不能管理 `memory_nodes`。

`multi-agent-console/src/web/components/panels/MemoryGraphPanel.tsx` 才有一个图谱面板，并调用 `memoryApi.getGraph()`；该目录是另一个 Web 控制台，不是 Aether Code Electron 渲染器。

### Aether 的远端协议明确拒绝记忆路由

远端可读路由白名单在 `D:\dev\aether-code\src\main\engine\protocol.ts:95-118`，没有 `/api/v1/memory/*`；远端可写路由也没有对应规则（`protocol.ts:120-171`）。因此即使引擎本身注册了 memory routes，Aether 远端客户端的 `remoteRequestError` 也会在请求前拒绝，提示“尚未接入远端服务”。

客户端所有普通引擎请求和 SSE 都带 `X-Aether-Tool-Profile: code`（`protocol.ts:174-179`，常量定义于 `tool-profile.ts:1-2`）。引擎聊天路由因此把 `enableMemory` 计算为 false（`chat.ts:988-990`），并且 code profile 的工具集合只保留编程工具；记忆工具被列为 `GENERAL_SERVICE_TOOLS`，`isCodeProfileTool` 明确排除它们（`src/tools/tool-profile.ts:20-38`）。这解释了为什么 Aether 的 Agent 对话看不到/用不到三层记忆。

## 引擎 HTTP CRUD 能力盘点

引擎在 `/api/v1` 下注册了以下路由（`src/api/http/routes/memory.ts`）：

| 路由 | 现状 | 备注 |
|---|---|---|
| `POST /memory/remember` | 可写节点 | 兼容旧 key/value 形状，实际创建 `fact` 节点并加标签 |
| `GET /memory/recall/:key` | 可读 | 通过标签查找；声明了 `sessionId` 查询参数 |
| `GET /memory/list` | 可读 | 支持分页参数，但内部最多取 1000 条再分页 |
| `GET /memory/graph` | 可读 | 返回节点和边 |
| `DELETE /memory/:id` | 可删 | 租户范围删除 |
| `PUT /memory/:id` | 可改 | 可改 summary/type/importance |
| `POST /memory/link` | 可写边 | 手工建立关联 |
| `POST /memory/consolidate` | 可整理 | 执行衰减并返回弱节点候选，不删除 |

引擎全局 hook 会要求 instance token；之后再解析 API key/JWT 租户，未提供凭据时默认 `tenantId=default`（`src/api/http/middleware.ts:44-63`、`src/auth/middleware.ts`）。因此 direct HTTP 可用性取决于 `AETHER_INSTANCE_TOKEN`/认证配置，客户端没有帮用户完成这条链路。

## 已确认的实现风险与契约疑点

1. **Aether 远端完全不可达（P0 接入缺口）**：协议白名单没有 memory 路由，且固定 code profile 关闭 memory。需要先定义客户端是否要消费长期记忆，再补协议、API client、会话选择和 UI；不能只把按钮接到引擎 URL。
2. **会话隔离契约不一致（P1）**：`GET /memory/recall/:key` 接收 `sessionId`，但 `SQLiteMemoryManager.recallByTags` 调用 `listNodes({ tags, ... })` 时没有把 `ctx.sessionId` 转成 `filter.sessionId`（`memory-manager.ts:198-222、recallByTags`）。因此同一租户可能召回其他会话的同标签节点。`/memory/list` 则会显式按 `filter.sessionId` 过滤，行为不一致。需要明确“长期记忆按租户共享”还是“按会话隔离”，并统一接口文档和实现。
3. **前端 API 路径与后端不一致（P1）**：`multi-agent-console/src/core/api/index.ts` 的 recall 调用使用查询参数 `/memory/recall?key=...&sessionId=...`，后端实际只有 `/memory/recall/:key`（`routes/memory.ts:34-45`）。该面板的 recall 目前不能按预期命中。
4. **边写入缺少节点归属校验（P1）**：`POST /memory/link` 只把请求的 `sourceId`、`targetId` 和当前租户写入 `memory_edges`（`routes/memory.ts:145-158`），没有确认两个节点存在且属于同一租户，也没有拒绝自环。应在事务中验证节点租户、节点存在、类型和强度范围。
5. **HTTP 编辑返回成功但不报告不存在节点（P1）**：`PUT /memory/:id` 更新后始终返回 `{success:true}`（`routes/memory.ts:119-143`），没有检查 `rowsAffected`，也没有校验 `type` 枚举、`importance` 范围、空 summary。客户端会误报成功。
6. **图谱 session 过滤字段可疑（P2）**：`/memory/graph` 的 session 条件使用 `source_session_id`（`routes/memory.ts:78-83`），而节点主会话字段是 `session_id`。自动提取同时写两个字段，但手工写入可只写 source 或使其为空，导致图谱和列表的会话边界不同。
7. **自动提取成本和重复风险（P2）**：每次非 code 聊天结束后异步调用一次 LLM，并可能对每条记忆重复调用 embedding（`extractor.ts:156-165、218-227`）；没有内容指纹或幂等键，同一偏好可能不断新增。需要去重、预算、重试和可观测性。
8. **遗忘机制尚未闭环（P2）**：`decay_rate` 有字段和衰减方法，但 consolidate 接口只返回候选，不提供用户确认、批量删除、归档或恢复；长期数据库体积和隐私生命周期没有产品层闭环。
9. **权限粒度不足（P2）**：memory routes 没有 `requireRoles`，所有拥有有效 instance token 且落入同一 tenant 的调用者都可编辑/删除/连边。若多人共享 tenant，应增加 owner/user scope、审计和管理权限。
10. **响应契约混合旧 KV 与新图谱（P2）**：`/memory/list` 将 `type` 映射为 `key`、`summary` 映射为 `value`（`routes/memory.ts:48-60`），会丢失 tags、importance、strength、session 等字段；新客户端无法实现完整 CRUD。
11. **工具注册与实现存在旧名漂移（P2）**：`GENERAL_SERVICE_TOOLS`、OSM/子 Agent 允许名单和 OpenAI 参数映射仍包含 `search_memory`，但 `createMemoryTools()` 实际只返回 `remember`、`recall`、`list_memories`、`forget`、`link_memories`（`src/tools/memory/memory-tool.ts:5-146`）。需要决定是实现 `search_memory` 还是清理所有旧契约，避免模型生成不存在的工具。

## 三层记忆体建议的可交付拆分

### D0：先定语义和边界

- 明确三层是“工作/会话上下文、情景事件、长期语义/程序知识”，还是继续沿用“向量/关系/图三路检索”。两者不能在 UI 中都叫“三层记忆”。
- 定义每层的写入者、保留期、是否跨会话、用户可见性、删除和导出语义；把 `tenantId`、`userId`、`sessionId` 的优先级写进协议。

### D1：统一数据契约

- 以 `MemoryNode`/`MemoryEdge` 作为唯一 API 模型，不再把图节点伪装成 key/value。
- 为 recall、list、graph、link、update、delete 增加严格 schema、404/409、分页游标和 `rowsAffected` 结果。
- 修正 recall 的 session 语义和 graph 的主会话字段；link 时做同租户节点校验和事务。

### D2：Aether 客户端接入

- 增加主进程 engine client、renderer API、远端协议白名单和错误提示；embedded/remote 使用同一契约。
- 明确 code profile 是否允许只读 `recall`，或新增 `memory` profile；不要静默把 code Agent 的长期记忆打开。
- 在设置中增加记忆总览、类型/会话/强度筛选、编辑、删除、批量遗忘、图谱和导出；所有异步刷新按 engine source/session 防止串数据。

### D3：Agent 对话入口

- 在聊天输入 `/memory` 或资源入口中提供“查看/保存/忘记/引用记忆”；工具提示要说明当前会话与跨会话范围。
- 让用户能看到本轮召回了哪些记忆，并可逐条禁止、纠正或提升/降低重要性。
- 提取失败不能阻塞回答；写入须幂等、去重并显示可审计状态。

### D4：远端安全和隔离

- instance token 只负责实例归属，tenant/user 仍需独立认证；禁用默认 tenant 的生产降级。
- 补 memory 的远端只读/写规则，逐条验证 remote workspace 不被触碰；加入跨租户、跨会话、伪造 edge、删除不存在节点的测试。

### D5：性能与生命周期

- 向量以原生 blob 绑定，避免 embedding JSON 双写；批量写使用事务和重试退避。
- 建立内容 hash、冲突/重复合并、归档和硬删除策略；consolidate 返回候选后要有明确确认或自动策略。
- 记录召回命中率、延迟、token 成本、提取失败、用户纠正率，支持按租户清理和数据导出。

### D6：验收矩阵

- Embedded 与 remote 各跑一套：创建→召回→编辑→连边→图谱→删除→刷新/重启→跨会话/跨租户隔离。
- Agent 对话覆盖记忆保存、自动提取、召回、拒绝写入、忘记、重复消息和中断恢复。
- UI 覆盖亮/暗主题、窄面板、键盘、长文本、空状态、错误/超时、分页和实时同步。

## 当前与 Claude 2.1.266 的比较边界

仓库中的 Claude 2.1.266 证据文件主要是 CLI 的 auth/help 文本，未提供可验证的记忆 API 或客户端实现。不能把二进制字符串或帮助文案当作已实现的“三层记忆”证据。当前可以确定的差距是：Aether 引擎内部已有三路检索原型和 CRUD，而 Aether Code 客户端没有将其接入；因此在用户实际使用的代码 Agent 路径上，可用能力差距是“客户端不可用”，而不是单纯召回算法差异。若要做公平 Claude 对比，应先取得同场景的可调用 API、工具清单、记忆持久化和删除/导出行为，再按上述 D0-D6 矩阵复测。

## 建议优先级

先完成 D0-D2，解决语义、隔离、协议和客户端入口；随后做 D3-D4，确保 Agent 和 remote 可用且安全；最后做 D5-D6，把成本、生命周期和真机验收补齐。当前不建议继续扩展图算法或新增 memory UI 视觉细节，因为客户端协议和 code profile 仍会在入口处阻断真实使用。

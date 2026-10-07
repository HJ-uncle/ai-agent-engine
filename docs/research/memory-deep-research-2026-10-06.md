# 三层记忆体深度调研与 Claude 2.1.266 对比（2026-10-06）

> 本文前半部分保留 2026-10-06 的改造前基线。2026-10-07 已完成会话级记忆改造，最新验收结果见文末“改造后状态”。

## 结论

当前引擎已经有可运行的“向量 + 关系 + 图”三路记忆检索原型，但还不能称为完整的三层记忆产品。三路检索共享同一张 `memory_nodes` 事实表；它们不是工作记忆、情景记忆、长期语义记忆三个独立生命周期层。更严重的是，Aether Code 的正常 `code` profile 会关闭长期记忆召回、自动提取、inline memory 和记忆工具，远端协议也没有开放 `/api/v1/memory/*`，所以用户在 IDE Agent 对话中实际用不到这套能力。

本次没有修改产品代码，没有读取真实用户数据库或秘钥。结论分为三类：代码静态证据、隔离临时数据库实测、已有单元测试。三类证据没有混写成“已交付”。

## 一、当前实现的真实结构

### 1. 存储事实源

`src/storage/memory/schema.ts` 创建独立的 `memory.db`，包含 `memory_nodes`、`memory_edges`、`memory_tags`、`memory_node_tags`、`memory_graph_meta`。节点支持 `preference/decision/fact/lesson/narrative/milestone`，并保存 tenant/session、来源、重要性、强度、衰减率、情绪字段、摘要和 embedding。

这张表既承载内容，也承载跨会话长期记忆。`type` 是内容类型，不是生命周期层级。没有单独的 work/episode/semantic 表，也没有节点晋升状态或保留策略。

### 2. 三路检索

- **关系/关键词路**：`listNodes` 通过 tenant、session、type、strength、importance、tags 和 `summary/detail LIKE` 查询。
- **向量路**：`recallSimilar` 使用 `F32_BLOB(1536)`、`vector32` 和 `vector_distance_cos` 做余弦距离检索。
- **图路**：`traversePath`、`getNeighbors`、`getRelatedNodes` 通过 `memory_edges` 做一跳/多跳扩展；边类型包括 `reinforces`、`contradicts`、`leads_to`、`part_of`、`similar_to`、`tagged_with`。

`buildMemoryRecallBlock` 的顺序是：LLM 查询意图路由 → 向量取锚点 → 关键词兜底 → 首锚点两跳图扩展、其他锚点一跳扩展 → 按 importance/strength 排序后拼进 system prompt。它是启发式合并，不是冲突解析器。

### 3. 写入与生命周期

普通聊天结束后，抽取器要求模型输出 JSON，过滤重要性低于 `0.3` 的条目，写入节点，并尝试生成 embedding、建立 `part_of`/`reinforces` 边。写入在 `setImmediate` 后台执行，因此回答完成或进程重启不保证这次抽取已经落盘。

巩固守护进程默认启动后延迟一分钟，之后每 24 小时运行；当前只按时间衰减 strength 并返回弱节点候选，不做自动合并、归档、删除或恢复。主进程只为 `default` tenant 启动守护进程。

## 二、隔离数据库实测发现

以下探针使用随机临时 `DATA_DIR`，没有触碰真实数据：

| 场景 | 结果 | 影响 |
|---|---|---|
| `getNeighbors(node, ['reinforces'])` | 返回空；不带类型可返回邻居 | 带 edge type 的图召回当前失效 |
| `getRelatedNodes(ids, ['reinforces'])` | 返回空；不带类型可返回邻居 | 带 edge type 的关联过滤当前失效 |
| 租户 A 节点连到租户 B 节点 | 成功写入 | 跨租户边可被制造，破坏隔离边界 |
| 3 维 embedding 写入 | 失败：`dimensions are different: 3 != 1536` | 模型维度不是 1536 时写入直接失败 |
| 1536 维 embedding + 相似召回 | 成功 | 仅在固定维度且向量扩展可用时成立 |
| 两次 consolidation，2 天旧节点、decay=.1 | strength `1.0 → 0.8 → 0.6` | 同一段历史时间被重复扣除 |
| 低强度节点 | 只列为候选 | “遗忘”没有删除/归档闭环 |

另外，schema 的 F32/vector 初始化可以降级为 BLOB，但节点写入和相似召回仍无条件调用 `vector32`/`vector_distance_cos`；因此“表能创建”不等于“向量能力可用”。Agent `remember` 默认不传 embedding，手工记录的节点通常只能走关系/图路径。

## 三、客户端和远端的真实断点

### Aether Code

Aether Code 的 engine header 固定为 `X-Aether-Tool-Profile: code`。引擎中的 `enableMemory` 要求 `toolProfile !== 'code'` 且 `ENABLE_LONG_TERM_MEMORY !== 'false'`，所以把环境变量改成 `true` 也不能打开 code 会话记忆。code profile 同时排除 `remember`、`recall`、`list_memories`、`forget`、`link_memories`，`get_current_context` 也不读取长期记忆。

客户端目前没有 memory API client、设置页、节点 CRUD、图谱入口或“本轮召回了哪些记忆”的可视状态；搜索到的 `remember/recall/list_memories` 只是名称映射。现有 `multi-agent-console` 图谱面板不属于 Aether Code 主客户端。

### 远端

`D:\dev\aether-code\src\main\engine\protocol.ts` 的远端读写白名单没有 `/api/v1/memory/*`，因此远端请求在客户端协议层就会被拒绝，不能到达引擎 memory routes。即使引擎本地 memory CRUD 可用，remote embedded 两条路径也没有同一套契约。

### HTTP CRUD 契约问题

引擎有 `/memory/remember`、`/memory/recall/:key`、`/memory/list`、`/memory/graph`、`PUT/DELETE /memory/:id`、`/memory/link`、`/memory/consolidate`，但存在以下不一致：recall 的 `sessionId` 没有真正传入 `listNodes` 的 session filter；console 调用的是 `/memory/recall?key=`，后端实际是路径参数；link 不校验两端节点存在、同 tenant 或自环；PUT 不检查 rowsAffected、不校验 type/importance/空摘要；graph 用 `source_session_id` 过滤而列表使用 `session_id`；list 将新节点伪装成旧 key/value，丢失 tags、strength、importance 和来源字段；memory routes 没有细粒度 RBAC。

另有能力清单漂移：允许名单和 OpenAI 参数映射仍包含 `search_memory`，但 `createMemoryTools()` 没有实现该工具。

## 四、与 Claude 2.1.266 的证据对比

Claude 证据来自 `docs/research/claude-2.1.266-evidence` 中的 help、binary excerpts、embedded command index 和 `sdk-tools.d.ts`。这些是能力证据，不代表我们已在 Claude 进程中重放完整 E2E。

| 维度 | 当前引擎 | Claude 2.1.266 证据 | 差距判断 |
|---|---|---|---|
| 记忆模型 | 同一节点库上的向量/SQL/图三路检索 | User/Project/Local/Managed 指令层级 + auto-memory 文件目录 | 产品语义不同；我们缺少作用域层 |
| 用户可见性 | 引擎有 CRUD，但 Aether Code 无入口 | `/memory` 可编辑 CLAUDE.md 和 memory 设置 | Claude 明显领先 |
| 自动记忆开关 | `ENABLE_LONG_TERM_MEMORY` 只对非 code profile 生效；code 无法打开 | `autoMemoryEnabled`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`，并有 `/pause-memory` | Claude 的控制面和可解释性领先 |
| 项目记忆 | 没有 canonical memory 文件投影 | `project_memory_list/read`，项目记忆可显式读取 | Claude 明显领先 |
| 召回算法 | embedding + LIKE + 图扩展，已实现原型 | 证据重点是文件/作用域加载和工具访问，未证明同等向量图算法 | 我们的结构化检索更强，但实际客户端不可用 |
| 来源/审计 | 保存 source 字段，但注入块只输出 type/summary/tags | 文件路径和 memory type 是可定位来源 | Claude 的可审计性领先 |
| 冲突/遗忘 | `contradicts` 类型存在，但无自动冲突排序；弱节点只列候选 | 自动记忆有启停、目录和治理控制的证据 | 我们的生命周期闭环明显不足 |
| 客户端/远端 | Aether Code 没有 memory API/UI，remote 白名单也未开放 | CLI/SDK 暴露 memory 命令和 project memory 工具 | 当前用户路径上差距是“不可用” |
| 数据形态 | 独立 SQLite，可跨会话、可图检索 | 可读写文件，随项目/配置迁移 | 我们检索灵活，Claude 迁移与人工审查更好 |

不能据此宣称 Claude 有与当前引擎完全相同的三路向量图实现；可确定的差距是 Claude 已把记忆做成可见、可控、分层的产品能力，而当前引擎主要停留在后端原型。

## 五、按性价比排序的整改任务

### D0：统一产品语义

明确 UI 中的“三层”到底指：

- L0 工作记忆：当前 prompt/run 和短期上下文；
- L1 情景记忆：按 session/事件可回放片段；
- L2 长期语义记忆：跨会话偏好、事实、决策和知识。

把“向量/关系/图”改称“召回引擎三路”，不要与生命周期层混称。写清 tenant/user/session 优先级、跨会话默认值、用户可见性、删除/导出语义。

### D1：先修后端正确性和隔离

修正两个 graph 参数绑定错误；将 link 和 tag 写入收束到事务化 manager，并验证节点存在、同 tenant、非自环和强度范围；统一 session 字段；给 graph meta 加 tenant；统一衰减公式并按 `last_strength_update` 做增量扣除；embedding 写入前校验维度并保存 provider/model；向量不可用时返回明确 capability 状态。

### D2：补统一 HTTP/remote 契约

用 `MemoryNode/MemoryEdge` 作为唯一响应模型，补严格 schema、404/409、游标分页和 rowsAffected；修复 recall 路径；把 `/memory/*` 加入远端白名单；增加 memory capability handshake。instance token 只证明实例，不要让默认 tenant 代替用户授权。

### D3：接入 Aether Code

增加 memory API client、设置/管理入口、查看/编辑/删除/归档/恢复/导入导出和图谱；允许用户选择“仅本轮召回”或“自动提取”；code profile 采用独立 memory capability 或可选只读扩展，不直接把 general 工具全集塞入代码会话；输入框提供 `/memory` 入口，并显示本轮召回来源。

### D4：让 Agent 对话闭环

补 `remember` 的 embedding 或明确写入路径；抽取加入内容 fingerprint、幂等 upsert、冲突/contradicts 识别、失败指标和重试；提供 pause memory、单条纠正、忘记和恢复；把异步抽取状态反馈给客户端。

### D5：生命周期和性能

按活跃 tenant 调度 consolidation；弱记忆候选与实际归档/硬删除分开；增加审计日志、导出和用户确认；减少 embedding JSON 双写；加 busy 重试、批量事务、召回命中率/延迟/token 成本指标。

### D6：验收矩阵

Embedded 与 remote 各执行：创建 → 召回 → 编辑 → 连边 → 图谱 → 删除 → 重启恢复 → 跨 session/tenant 隔离。Agent 对话覆盖自动提取、手工 remember、向量不可用降级、重复消息、冲突事实、pause/forget。UI 覆盖空态、错误、超时、分页、长文本、键盘和刷新同步。

## 六、测试结果

本次独立串行回归：

```text
npx vitest run \
  src/middleware/memory/__tests__/extractor.test.ts \
  src/tools/get-context/__tests__/get-context-tool.test.ts \
  src/tools/__tests__/tool-profile.test.ts \
  src/api/http/routes/__tests__/tool-profile-routes.test.ts \
  src/core/agent-context/__tests__/factory.test.ts \
  --pool=forks --maxWorkers=1 --minWorkers=1

5 files passed, 65 tests passed

npx vitest run src/storage/memory/__tests__/db.test.ts \
  --pool=forks --maxWorkers=1 --minWorkers=1

1 file passed, 1 test passed
```

这些测试验证了 schema 初始化、抽取解析、profile 隔离、路由 profile、上下文工厂和 code/general 工具边界；它们没有证明完整 CRUD、向量矩阵、图过滤、跨租户隔离、consolidation 或 Aether remote E2E 已通过。上述缺陷来自隔离探针和静态审计，不能被 66 个通过测试抵消。

详细分项报告：

- [存储审计](D:/dev/ai-agent-engine/docs/research/memory-storage-audit-2026-10-06.md)
- [抽取/召回/生命周期审计](D:/dev/ai-agent-engine/docs/research/memory-pipeline-audit-2026-10-06.md)
- [Aether 客户端与远端审计](D:/dev/ai-agent-engine/docs/research/memory-client-audit-2026-10-06.md)

## 七、改造后状态（2026-10-07）

### 会话级记忆已经可用

记忆设置现在按 `tenantId + sessionId` 持久化，支持三种模式：

- `off`：当前会话不读取、不写入长期记忆；
- `global`：使用租户级共享记忆；
- `session`：只使用当前会话的记忆，其他会话和其他租户不可见。

节点、标签、向量召回、图边、图遍历、衰减和巩固都带同一作用域条件。旧数据库中的历史节点会幂等迁移到 `global`，不会根据旧的 `session_id` 猜测为私有记忆。向量扩展不可用时，系统自动使用 `embedding_json` 的余弦距离回退路径。

聊天请求会读取并保存当前会话的记忆模式；自动召回、自动抽取、`remember`/`recall`/`list_memories`/`forget`/`link_memories` 和上下文工具都会沿用这个模式。模型不能通过工具参数改写会话目标，子代理也不能跨租户或跨会话读取记忆。Aether Code 已提供会话级设置入口，并把设置通过引擎服务端持久化，避免渲染层缓存污染新会话。

### 当前仍属于“三路召回 + 作用域”的实现

这次改造解决的是“全局记忆是否能限定到单独会话”和安全隔离问题。`memory_nodes` 仍是一张事实表，向量、关键词、图关系仍是三种召回路径；它们不等于工作记忆、情景记忆、长期语义记忆三个独立生命周期层。若要完成严格三层模型，后续仍需为工作记忆、情景事件和长期语义记忆定义独立保留、晋升、冲突、归档和恢复策略。

### 会话级回归结果

在独立临时数据库中串行执行：

```text
src/storage/memory/__tests__/session-scope.test.ts       5/5
src/api/http/routes/__tests__/memory-scope.test.ts       3/3
src/tools/memory/__tests__/memory-tool-scope.test.ts     3/3
src/middleware/memory/__tests__/extractor.test.ts       22/22
src/storage/memory/__tests__/db.test.ts                  1/1
合计                                                     34/34
```

覆盖全局/会话互斥可见性、跨租户阻断、标签和图边作用域、向量回退、HTTP CRUD、会话模式持久化、自动抽取和记忆工具策略。`npx tsc --noEmit` 通过。完整仓库并行测试还会触发 Windows 子进程权限、临时目录清理和系统资源限制，相关失败不属于会话记忆断言；会话级验收使用串行隔离运行作为准据。

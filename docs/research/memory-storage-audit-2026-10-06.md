# 三层记忆存储深度审计（2026-10-06）

范围：`D:\dev\ai-agent-engine/src/storage/memory` 及其记忆抽取、HTTP 路由调用方。审计只读代码和临时目录数据库；没有读取真实用户数据库、密钥或生产数据，也没有修改产品代码。

## 结论

引擎已经有一套“SQL 节点 + 向量列 + 图边”的三路记忆原型，但它们不是三个独立的生命周期层。`memory_nodes` 是唯一事实源，关系筛选、向量相似度和图遍历只是三种查询路径。当前实现可以在 1536 维 embedding 存在且向量扩展可用时完成三路查询；默认 Agent 工具写入的节点不带 embedding，且本地无向量扩展时向量写入会失败。因此“已具备完整三层记忆”和“长期运行可自动遗忘”都不能从当前代码得到支持。

## 存储结构和能力边界

### SQL/关系路径

`schema.ts:10-60` 建立 `memory_nodes`，包括 `tenant_id`、`session_id`、六种 `type`、强度、重要性、来源、衰减字段，以及 `embedding_json` 和 `embedding`。`memory-manager.ts:198-279` 通过 tenant、类型、强度、重要性、会话、标签和 `summary/detail LIKE` 组合过滤，排序列使用白名单，默认最多 50 条。

这条路径是可靠的基础 CRUD，但 `recallByTags`（`memory-manager.ts:281-283`）没有把 `ctx.sessionId` 转成 `filter.sessionId`，同一租户内同标签的不同会话会混在一起。是否跨会话共享需要产品决策，当前 API 的 `sessionId` 参数会让调用者误以为它已经隔离。

### 向量路径

Schema 声明 `F32_BLOB(1536)` 和 `libsql_vector_idx(embedding)`（`schema.ts:32-42`）。写入用 `vector32(?)`，参数是 `JSON.stringify(input.embedding)`（`memory-manager.ts:78-123`）；召回用 `vector_distance_cos`，按距离阈值和 limit 排序（`memory-manager.ts:297-320`）。

实测 1536 维向量创建和 `recallSimilar` 成功；3 维向量创建失败并返回 `SQLITE_ERROR: vector index(insert): dimensions are different: 3 != 1536`。实现没有在边界层检查维度，也没有把模型 embedding 维度映射到 1536，因此更换 embedding 模型会在记忆写入时失败。`embedding_json` 与二进制列双写，增加空间和序列化成本。

`db.ts:37-61` 对建表时的 F32/vector 语句做 BLOB 替换并吞掉 fallback 错误；但 `createNode` 和 `updateNode` 仍无条件调用 `vector32(?)`（`memory-manager.ts:97-120、166-172`）。所以“schema 可降级”不等于“向量写入/召回可降级”。现有 `db.test.ts` 只验证无向量扩展时表和索引名称存在，并未验证 embedding 写入或相似召回。

### 图路径

节点边表和六种 edge type 位于 `schema.ts:62-112`，递归 CTE 在 `memory-manager.ts:412-456` 实现多跳遍历。

`getNeighbors` 的 SQL 只有四个基础参数加可选 edge type，但行 399 传入 `[nodeId,nodeId,tenantId,nodeId,...args.slice(1)]`，无类型时也多传两个 nodeId；当前 libsql 客户端会忽略尾部参数，带类型时第五个参数变成 nodeId 而不是 edge type，因而类型过滤返回空结果。`getRelatedNodes` 行 479-490 在提供 edgeTypes 时先把 edge type 放进参数数组，再放节点 ID，绑定顺序与 SQL 相反，类型过滤同样失效。两项均已在临时隔离数据库重现。

`createEdge`（`memory-manager.ts:325-353`）只写入当前 `ctx.tenantId`，不验证 source/target 节点存在且属于同一 tenant；数据库外键只能验证 ID 存在，不能验证两端租户一致。临时测试成功创建租户 A 节点到租户 B 节点的边。HTTP `/memory/link`（`routes/memory.ts:145-158`）和 Agent `link_memories`（`tools/memory/memory-tool.ts:125-142`）还绕过 manager 直接插入，边强度、节点归属和同租户约束都由调用者自律。

标签关联同样只按 node ID 和 tag tenant 操作。`_attachTags`（`memory-manager.ts:679-711`）、`addTag`、`removeTag` 没有先验证节点租户；知道其他租户节点 ID 的调用者可建立跨租户标签关联。节点列表本身仍按 tenant 过滤，但不能把这种间接访问当作完整租户隔离。

## 生命周期、衰减和并发

`MemoryConsolidator.runConsolidation`（`consolidation.ts:45-81`）按 `unixepoch() - last_accessed` 扣强度，却只更新 `last_strength_update`，不更新 `last_accessed`。同一节点连续运行两次会重复扣同一段历史时间。隔离 probe 将两天旧、衰减率 0.1 的节点从 1.0 连续运行得到 `0.8 -> 0.6000000000000001`，而不是第二轮只扣很短的新时间。`SQLiteMemoryManager.decayNodes`（`memory-manager.ts:525-541`）又采用 `last_strength_update`，两套公式不一致。

`main.ts:71-74` 只为固定 `default` tenant 启动 daemon；其他 tenant 只能手动调用 HTTP consolidation。consolidation 只报告弱节点，不删除、归档或合并节点（`consolidation.ts:68-77`；`routes/memory.ts:161-182`）。`memory_graph_meta` 的 key 没有 tenant 列，`consolidate` 写入的 `last_consolidation` 会由不同租户互相覆盖，`getGraphMeta` 也会读到全局元数据（`schema.ts:3-7`、`memory-manager.ts:543-607`）。

`initMemoryDb`（`db.ts:64-90`）在 schema 完成前就设置 `initialized = true`，并且每条 schema 失败只记录 warning；并发初始化调用可能提前返回，关键表创建失败也不会让启动失败。WAL 和 `synchronous=NORMAL` 是合理的默认，但 SQLite 仍是单写者，当前没有 busy 重试/退避或压力测试契约。

## 调用链中的真实可用性

普通聊天只有在 `chat.ts:988-1000` 的 `toolProfile !== 'code'` 且没有关闭环境开关时才召回记忆；回答结束后 `setImmediate` 异步抽取（`chat.ts:1304-1329`）。`memory-tool.ts:26-34` 的 `remember` 不传 embedding，因此 Agent 手工记录默认只能走 SQL/图路径。抽取器虽尝试调用 adapter embedding（`extractor.ts:156-177`），但没有维度校验、去重键或幂等更新；相同事实会不断新增节点。

`buildMemoryRecallBlock` 先向量、再关键词、最后图扩展（`extractor.ts:307-366`），图扩展只对首个锚点两跳、其余锚点一跳；这是可用的启发式召回，不是冲突解决或时间感知的记忆层级。代码 Agent profile 被显式排除长期记忆，不能据此向用户承诺所有 Agent 会话都具备三层记忆。

## 已执行的隔离验证

以下命令没有启动 Electron，也没有使用真实数据：

```text
npx vitest run src/storage/memory/__tests__/db.test.ts
✓ 1 test passed
```

临时 Vitest probes 使用随机临时目录 `DATA_DIR`，覆盖邻居/关联类型过滤、跨租户 edge、3/1536 维 embedding 和连续 consolidation。源码 probe 在命令结束后删除；数据库目录由测试进程释放后清理。关键输出：

```text
neighbors [ 'n2' ]
neighbors type []
related [ 'n2' ]
related type []
cross ... tenantId: 'A' ... targetNodeId: <tenant-B node>
embedding ERR ... dimensions are different: 3 != 1536
created 1536 number
similar [ 'vector' ]
strengths 0.8 0.6000000000000001 delta 0.19999999999999996
```

## 与已有声明的差异

`docs/test-reports/full-system-test-report.md:20-23` 把高频 50 节点/100 边、自动遗忘和 1536 维并发相似度写成通过或部分通过，但仓库内存储测试目前只有一个 schema 初始化用例；没有同等范围的可复现 manager、租户、向量并发或 daemon 测试。`docs/test-reports/architecture-and-memory-test-report.md:16-18` 的 11/4/4ms 性能数字也没有随代码提供基准脚本，不能作为当前硬证据。此前平台审计对重复衰减和 default tenant 遗漏的判断（`docs/research/2026-09-29-platform-audit.md:120`）与本次实测一致。

## 建议顺序

1. 先定义“三层”语义：继续称三路检索，或新增工作/情景/长期生命周期字段；补充跨会话和用户可见性规则。
2. 修正 graph 参数绑定、边/标签端点租户校验、session 过滤和全局 graph meta；将 HTTP/工具 link 收束到 manager 的事务实现。
3. 在写入边界校验 embedding 维度并记录 provider/model；无向量扩展时明确降级为 SQL/图，不返回半成功状态。
4. 合并 decay 公式，按活跃 tenant 调度；把“弱节点候选”与删除/归档/用户确认分成明确 API，并为重复抽取增加内容指纹和幂等键。
5. 增加真实 manager/HTTP/Agent 的隔离测试、向量可用/不可用矩阵和 SQLite busy 重试压力测试，再讨论性能数字和生产可交付结论。

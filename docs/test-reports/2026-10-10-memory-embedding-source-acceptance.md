# 记忆提取、语义服务解耦与长期召回预算专项

本专项修改源代码，没有编译或替换引擎 dist、SDK、TGZ 或客户端 stage。原 R4 正式结果仍为 FAIL（49/50），原 85 条无向量记忆及原告警证据没有回填或改写。

## 修复与验证

- `RetryingAdapter` / `FallbackAdapter` 只在底层有实际实现时提供可选 `embed`，消除 Anthropic 聊天适配器被误认为有向量端点的问题。
- 提取与召回使用独立 OpenAI 兼容 embedding client，支持 DB/env 配置；聊天模型交叉切换不改变已配置向量服务。严格验证返回模型、batch 索引、数量、维度及有限数值。
- 新 `embedding_space` 绑定规范服务地址、模型及维度；召回不比较不同模型空间，包括维度相同的模型。1536 维保留原 native vector 路径，其他维度使用 JSON cosine，避免污染原 native 索引。
- 旧无向量、未知空间及旧模型空间节点可分批恢复回填。已成功行在重启后不重复回填；失败行保留重试资格。回填写入按原 summary/detail 做 CAS，避免在用户编辑后写入旧内容的向量。
- 超长单轮记忆提取按有效 contextWindow 分段，每段完整文本保留、避免拆开 UTF-16 字符，input/output 预算严格预检；尾部条件不会被原 2000 字符截断。聊天传入本轮实际窗口 override。节点与自动图关联按 scope 精确身份在事务中去重，五并发重试不会重复创建同一节点/边。
- 召回的 model projection 不超过 `min(8000, effectiveWindow×8%)` 估算 tokens，单条不超过 2000。全文仍在记忆数据库，注入内容带 memoryId、来源 session、可用 turnId、时间和标签；明确当前用户更正及系统规则优先，超预算条目可回查原始会话/标签记忆。未宣称将所有原文永久塞入 100K 窗口。
- 2501 节点 / 2500 边真实数据库测试发现原 `OR` 图 join 可卡住召回超过 60 秒。修复为端点索引分支 `UNION`，增加 scope/source 与 scope/target 索引，保留每一跳的节点、边租户/会话校验。
- 设置 API 可读写 embedding 配置；key 加密存储、返回遮掩、遮掩占位不会覆盖真 key。顺便修复原 `<8` 字符 key 被原样返回的遮掩缺口。

## 配置

| 配置 | 作用 |
| --- | --- |
| `EMBEDDING_BASE_URL` | 独立 OpenAI 兼容服务，如 `http://127.0.0.1:12501/v1`；也接受完整 `/embeddings` 地址并规范化 |
| `EMBEDDING_MODEL` | 服务返回的实际 embedding 模型身份，必须与配置一致 |
| `EMBEDDING_DIMENSIONS` | 向量维度，默认 1536；本地 multilingual MiniLM 服务为 384 |
| `EMBEDDING_API_KEY` | 独立服务 key；localhost/loopback 服务允许无 key，远程服务必须配置 |
| `EMBEDDING_SEND_DIMENSIONS` | 仅服务支持请求 `dimensions` 字段时启用；默认 false |

独立服务未配置时继续原可用聊天 embed / 词法与 scoped 图降级；Anthropic 聊天本身不提供 embed，所以该路径不会假装语义功能已经恢复。旧未标记向量不会与新配置服务空间混用，而是等待回填。

## 证据与限制

- 旧专项扩大回归：21 文件 / 204 测试 PASS，证据 `.tmp/memory-embedding-source-acceptance-20261009.json`。此轮发生在记忆注入预算及图查询优化前，不能替代后续全量。
- 高容量原失败：`.tmp/memory-embedding-heavy-scope-fixed-20261010.json`；2501/2500 已完整落库，但原图召回超过 60 秒并使 cleanup 等待。保留失败，不因后续修复改算通过。
- 图索引修复后：2 文件 / 22 测试 PASS，证据 `.tmp/memory-embedding-indexed-heavy-20261010.json`。2501 节点 / 2500 边 case 的总耗时为 17.027 秒，包含逐节点/逐边真实 CRUD、召回与完整性验证，不能把这个总耗时描述为单次召回延迟。
- 当前 `npm run typecheck` PASS。统一完整引擎回归及双端新构建由主任务执行；本专项不独立判定 SDK/stage 新产物通过。
- HTTP 语义测试使用明确的本地 fixture，验证协议、空间、scope 与恢复链路，不代表实际 provider 模型质量。主任务另外准备了真实 ONNX multilingual MiniLM 本地服务；只有在新 runtime 中完整提取、回填、跨语言召回及隔离实际通过后才能记真实语义 PASS。
- 已确认 `chat.ts` 的 `fullHistory` 实际来自当前 `getByConversationId(turnId)`，是本轮增量；“每次都提取整个会话”的早期怀疑已撤回。
- 摘要及记忆仍是模型生成的有损信息。原文可检索、明确证据身份和现行指令优先能够降低损失；不得宣称任何压缩都能保证工作精度完全不变或已经验证 7×24 连续运行。

# 会话存储占用与分层优化：源码依据

日期：2026-11-05。针对用户看到的“数据库约 74.1 MiB、会话历史约 140 MiB”进行源码分析。本分报告不直接读取真实数据库；下述实测由主报告的只读统计提供。本次未修改引擎代码。

## 0. 实测后的第一优先级：历史维护正文长期重复保留

主报告只读 `dbstat` 已确认，这个实例的主因**不是子代理**：`collaboration_history_maintenance` 仅116行却占约54.066 MiB表页，`payload_json` 合计56,380,297 bytes；对比 `subagent_events` 61行约323,584 bytes，checkpoints 61行约180 KiB。security_audit_log 的表与索引也是另一个大项。数据库和会话文件仍在活动增长，用户截图与稍后现场扫描不必完全一致。

这使优先顺序非常明确：**先修 history maintenance 完成后的正文回收，再处理安全审计日志保留策略；子代理版本压缩应排在实际占用分析之后。** 后文子代理/bootstrap 是能力与潜在增长分析，不应误读为本实例主要来源。

### 0.1 payload 到底复制了什么

`appendMaintenanceRows` 构造：

```text
payload = {
  kind: "summary" | "update",
  plan: {
    fileIdentity, offset, bytes, hash,
    encoded: 本批要追加的全部 JSONL 行文本,
    prefixHash: 原文件前缀摘要
  },
  retired: 被摘要淘汰的消息 ID,
  retained: 必须保留的消息 ID,
  before: 原文件 revision
}
```

然后 `reserveHistoryMaintenance` 对 payload 再做 `JSON.stringify`，存 `payload_json`。所以它**不是每次复制整个会话文件**；问题在于本批 `update` 本身可能很大：microcompact 将工具结果变成短 placeholder，同时 `archiveContent` 保存完整旧工具输出。这份输出通常同时存在于：

1. 原 JSONL tool 消息的 content。
2. 新追加 update 行的 archiveContent（以及 metadata 中可能已有的显示字段）。
3. SQLite maintenance payload.plan.encoded 中序列化的该 update 行。

SQL 中 encoded 是嵌套 JSON 字符串，还要承担转义开销。批量目标为128行或8 MiB，单条超过8 MiB时允许原样保留；它限制的是批次处理量，不是最终长期存储上限。`prefixHash` 只是 hash，不是整文件正文；不要把54 MiB误解释成该字段保存了整个历史。

证据：[jsonl-history.ts:1417](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1417)、[jsonl-history.ts:1439](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1439)、[jsonl-history.ts:1452](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1452)、[jsonl-history.ts:1463](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1463)、[jsonl-history.ts:1759](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1759)、[history-maintenance.ts:78](D:/dev/ai-agent-engine/src/core/collaboration/history-maintenance.ts:78)。

### 0.2 为什么需要 pending 正文，为什么 committed 后仍占空间

预约先提交 SQLite，再按精确 offset 写文件。若在中途崩溃，恢复代码需要完整 encoded bytes 来补齐未写完的后缀，因此 **pending payload 不能只放 RAM，不能简单按年龄删除**。

恢复读取只选择 `state='pending'`：核对 payload hash、epoch、原用户 anchor、peer 原始物理行；将预约后缀补齐、sync、重读验证；随后在写事务中把被 retired 的 peer deliveries 标成 suppressed，并把 maintenance 行改成 committed。现有最后一步只 UPDATE state/committed_at，没有清掉大 payload。

全 `src` 非测试源码检索中，读取该表 `payload_json` 的唯一生产路径是上述 pending 恢复；未见对 committed payload 的读取、GC或外部持久 pin。`invalidateJSONLDeliveries` 也只是将 pending 改 invalidated，没有删除正文。**提交后继续永久保存大 encoded，当前代码上没有恢复必要性。** 这是比泛化拆分整个存储架构更直接的优化点。

证据：[jsonl-history.ts:1709](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1709)、[jsonl-history.ts:1714](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1714)、[jsonl-history.ts:1732](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1732)、[jsonl-history.ts:1741](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1741)、[jsonl-delivery-schema.ts:40](D:/dev/ai-agent-engine/src/core/collaboration/jsonl-delivery-schema.ts:40)。

### 0.3 最小改造方案

**先截断未来增长：** 在“文件已 sync、已验证原字节”的最后 SQL 事务内，原子提交 peer suppression + terminal maintenance receipt + payload 瘦身。保留以下小字段：maintenance ID、tenant/session/backend、root run/attempt/invocation、epoch、anchor ID、原预约 payload digest、plan fileIdentity/offset/bytes/hash/prefixHash、kind、retired/retained 的必要摘要或计数、committed_at、payload 原始字节数及明确的 pruned 状态。若还要保留 anchor_fingerprint，可将其中 canonical user 正文改为版本化 digest；该字段目前也并非纯 hash，但本次主要占用已经确认在 payload_json。

不能无说明地将 payload_json 改 `{}` 却继续把 `payload_hash` 当成“当前 payload 的 hash”。推荐增加 `payload_pruned_at/payload_version` 或拆为小 manifest 与 pending payload 表，明确 hash 指向原预约内容；约束 pruned 行不可重新变成 pending。旧 reader 只读 pending，兼容迁移相对集中。SQLite backend 的 maintenance payload 原本只是小型变更审计，不必按相同方式激进处理。

**再处理存量：** 先备份/统计 `state+kind`；分批处理 committed，验证其原有终态（必要时核对文件预约区间 hash）后转小凭据；invalidated 只有在 epoch 已被永久撤销、不会恢复执行时才处理，保留失败诊断期限；pending 要完成恢复或明确报错隔离，不能当垃圾删。payload 瘦身不会自动缩小已分配 `.db`，先观察 freelist/live bytes，再在维护窗口选 VACUUM。

**进一步减少140 MiB级 JSONL本身的重复：** microcompact 的 update 可只记录原始工具消息 ID/版本/hash 和 placeholder，不再复制 archiveContent，归档读取从原始 message+最近显式编辑版本恢复原文。现有 `collectUpdate/applyUpdate` 已有兼容旧 microcompact 的回退逻辑，但新格式仍需显式版本化，覆盖“原文先编辑再 microcompact、重复 microcompact、重启、分页搜索、截断、图片恢复”等场景。这样先减少每次新维护的 encoded，再配合 committed 瘦身，能同时降低 SQL 与 JSONL 增长，而不是仅把54 MiB从一个位置搬到另一个位置。

证据：[jsonl-history.ts:112](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:112)、[jsonl-history.ts:130](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:130)、[jsonl-history.ts:1696](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1696)。

验收应复用现有 reservation ACK丢失、半写、fsync失败、final ACK丢失、重启恢复、epoch撤销测试；其中当前测试直接读取 committed payload 以校验批次数，需要改为验证小 manifest/原预约 digest，而非保留整个正文才能通过测试。另加“数百次完成维护后 DB 活跃 payload 不随已归档输出线性增长”的容量回归。

证据：[production-compaction.test.ts:305](D:/dev/ai-agent-engine/src/core/collaboration/__tests__/production-compaction.test.ts:305)、[production-compaction.test.ts:342](D:/dev/ai-agent-engine/src/core/collaboration/__tests__/production-compaction.test.ts:342)、[production-compaction.test.ts:406](D:/dev/ai-agent-engine/src/core/collaboration/__tests__/production-compaction.test.ts:406)、[production-compaction.test.ts:450](D:/dev/ai-agent-engine/src/core/collaboration/__tests__/production-compaction.test.ts:450)。

### 0.4 第二大项安全审计已有手动清理入口

`security_audit_log` 按安全决策持续 INSERT target/details/reason；时间、分类+时间、租户+时间有三个索引。主报告测得31,379行、约18,415,616 bytes表页与3,002,368 bytes索引。源码有 `purgeOlderThan(days)` 和 admin 的 `DELETE /security/audit-log?days=...`（默认30天）；本次未见自动周期调用。因此无需把审计放RAM，应该补可配置保留期/归档与定时清理，保留必要拒绝/错误审计，避免不加区分地永久存所有允许事件。若需长期合规留痕，可先导出到压缩冷档后删除热库行；实际执行须沿用产品审计保留要求。

证据：[audit-log.ts:38](D:/dev/ai-agent-engine/src/security/audit-log.ts:38)、[audit-log.ts:105](D:/dev/ai-agent-engine/src/security/audit-log.ts:105)、[security.ts:85](D:/dev/ai-agent-engine/src/api/http/routes/security.ts:85)、[011_add_security_and_perf.ts:29](D:/dev/ai-agent-engine/src/storage/sqlite/migrations/011_add_security_and_perf.ts:29)。

## 1. 判断前提

SQLite 本身也是磁盘存储；这里真正需要划分的是 **易失内存、需要事务的持久状态、可外置的大正文**，而不是“数据库”和“磁盘”二选一。

数据库名称含 `subagent` 或 `parent_turn` 也不能证明空间全是子代理任务产物。尤其 `parent_turn_bootstraps` 保存的是**父会话当前轮的累计流投影**，开启 durable recovery 后，没有子代理的父会话也会初始化这些表并写快照。需要按表与 JSON 字段测量后决定优化对象。

三个高价值候选是：

1. 父轮次反复保存累计投影，旧 checkpoint 不覆盖；大正文可能在多个 checkpoint 中重复。
2. 子代理输出进展在 event/header checkpoint 内重复累计文本；工具完整参数/输出同时存在于版本表和子会话 transcript。
3. JSONL 原文、microcompact 归档字段、维护精确字节预约、旧 `.bak` 的重复与长期保留。

证据：[parent-publication.ts:44](D:/dev/ai-agent-engine/src/core/subagent/parent-publication.ts:44)、[parent-publication.ts:86](D:/dev/ai-agent-engine/src/core/subagent/parent-publication.ts:86)、[turn-bootstrap.ts:92](D:/dev/ai-agent-engine/src/core/subagent/turn-bootstrap.ts:92)。

## 2. 数据具体在哪里被重复保存

| 数据 | 当前持久副本 | 为什么保留 | 优化方向 |
|---|---|---|---|
| 子代理累计输出 | `subagent_checkpoints.header.partialOutput` + `subagent_events.headerPatch.partialOutput`；最新 `subagent_runs.snapshot` 另有一份 | 精确历史 seq、恢复、增量重放 | 输出正文独立不可变引用；真正字段差量；按承诺的恢复窗口保留版本 |
| 子代理工具参数 | tool started 的 `subagent_tool_versions.detail.args`，completed 新版本又带原 args；子会话 JSONL assistant toolCall.args | 版本详情/执行历史 | 单独 args blob，版本只引用，不重复复制 args |
| 子代理工具输出 | completed detail.output、summary/outputPreview、有些后续取消版本；子会话 JSONL tool content；microcompact archiveContent | UI详情与模型/归档视图各自所需 | 原始正文 CAS，bounded preview 独立，history 与工具表共享原文引用 |
| 子代理旧版 v1 | 每个 `subagent_events.event.snapshot` 带完整 toolCalls；最新 run snapshot、terminal outbox | 老协议 exact snapshot | 离线迁移为共享不可变正文+索引；保留等价序列解码，不能直接丢旧事件 |
| 父会话当前轮投影 | 每次 `parent_turn_bootstraps.snapshot_json`；大于 96 KiB 时还有 `parent_turn_bootstrap_body_chunks` 正文 + bounded preview | 断线/重启/审批继续的准确已发布视图 | 内容去重/段式引用；释放已无 pin 的旧 bootstrap |
| 父轮子代理引用 | bootstrap refs，短期 recovery lease refs，published child versions | 固定 E/R/U/atSeq，不能用“最新值”冒充旧值 | 小引用保留；可归并重复清单，但受有效 lease 约束 |
| 用户原始输入 | `user_root_admission_seeds.seed_json` 或 server seed；历史 user 消息；父投影 user frame | 原请求身份、ACK丢失恢复、正文显示 | 正文共享引用；保留 request key/digest/namespace 与 seed 精确类型 |
| 协作消息 | `collaboration_messages.body`；用户 controller 还有 `payload_body`；JSONL delivery 的完整 `encoded_row`；真实 JSONL 行 | 接收幂等、来源校验、补齐半写 | 共享原文字节，但不可只删除 receipt 正文而不改认证逻辑 |
| 历史维护 | `collaboration_history_maintenance.payload_json` 包含 summary/update 的完整 encoded 预约；JSONL 中又有同样行 | 精确偏移恢复、退休 peer 原身份验证 | pending 保留原字节；committed/invalidated 可依赖引用安全做瘦身/归档 |
| root run | `root_runs.state` 保存运行配置、pending、receipt；每次 UPDATE | 继续运行/权限状态 | 通常是控制面，小字段应保留；大的 inline 配置可独立版本引用 |

证据：[store.ts:384](D:/dev/ai-agent-engine/src/core/subagent/store.ts:384)、[store.ts:489](D:/dev/ai-agent-engine/src/core/subagent/store.ts:489)、[store.ts:538](D:/dev/ai-agent-engine/src/core/subagent/store.ts:538)、[child-recovery-schema.ts:46](D:/dev/ai-agent-engine/src/core/subagent/child-recovery-schema.ts:46)、[index.ts:171](D:/dev/ai-agent-engine/src/storage/root-admission/index.ts:171)、[server-seed.ts:51](D:/dev/ai-agent-engine/src/storage/root-admission/server-seed.ts:51)、[jsonl-delivery-schema.ts:14](D:/dev/ai-agent-engine/src/core/collaboration/jsonl-delivery-schema.ts:14)、[controller-origin.ts:25](D:/dev/ai-agent-engine/src/core/collaboration/controller-origin.ts:25)、[history-maintenance.ts:65](D:/dev/ai-agent-engine/src/core/collaboration/history-maintenance.ts:65)。

## 3. 子代理 event/checkpoint 放大的具体机制

现代 v2 已经比 v1 好很多：run record 与可变状态拆开；工具详细正文只按工具版本存，不再每次把所有 toolCalls 塞进 event。用于 UI 的 view 上限是 64 条工具、32 条活动工具、256 KiB，工具 args preview 约 1 KiB、output preview 2 KiB。不能据此推断磁盘详情也只保存 2 KiB；完整 detail 仍在版本表中。

`runner.onOutput` 最多每 200 ms 写一次 `output.updated`。partialOutput 由 store 限制在 8192 UTF-8 bytes；`persistDelta` 每次都：

1. INSERT 一份当前可变状态到 checkpoint header。
2. UPDATE 最新 run snapshot。
3. INSERT event，其 headerPatch 实际从当前 header 的 stateKeys 提取，**并非只保存前后有变化的键**。

因此 output.updated 长时间持续发生时，每条 checkpoint 与 event 都可能携带近似相同的 8 KiB 文本。理论上持续 10 分钟、每秒 5 次、两份 8 KiB 文本就是约 **46.9 MiB** 正文，尚未计 JSON/索引开销；这是增长模型示例，不能作为实际数据库归因。最新 snapshot 是 UPDATE，主要带来写放大/WAL，而不是每次多保留一行。

工具完成时通过 `json_patch(detail,...)` 基于上个版本生成完整新 detail，保留 started 时 args；这避免把大 args 传回 JS，却没有消除磁盘上的 args 重复。取消活动工具也 INSERT 新完整版本。

legacy v1 的 `persist()` 每次保存完整 snapshot，包括截至当时所有 toolCalls；有大量工具/输出时随运行历史增长更明显。`ensureModern` 只在该 run 再次被修改时升级，原 v1 event 明确保持原字节，所以旧数据占用不会因为当前写入路径已经优化就自动下降。

证据：[runner.ts:241](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:241)、[store.ts:34](D:/dev/ai-agent-engine/src/core/subagent/store.ts:34)、[store.ts:371](D:/dev/ai-agent-engine/src/core/subagent/store.ts:371)、[store.ts:384](D:/dev/ai-agent-engine/src/core/subagent/store.ts:384)、[store.ts:445](D:/dev/ai-agent-engine/src/core/subagent/store.ts:445)、[store.ts:505](D:/dev/ai-agent-engine/src/core/subagent/store.ts:505)、[store.ts:538](D:/dev/ai-agent-engine/src/core/subagent/store.ts:538)、[view.ts:3](D:/dev/ai-agent-engine/src/core/subagent/view.ts:3)、[view.ts:96](D:/dev/ai-agent-engine/src/core/subagent/view.ts:96)。

## 4. 父轮 bootstrap 可能比子代理详情更值得优先看

durable publication 开启时，run/subagentEvent/toolEnd/toolResult/usage/ask/permission 被视为 important，每次都触发 checkpoint；普通文本达到默认 1 秒或 64 events 也可触发。每个 checkpoint 保存当时**累计 current-turn projection**。新 checkpoint INSERT，新 head 指向新 ID，之前的 checkpoint 仍留着。

纯子代理 view 会先拆为 `runId+atSeq+projectionIndex` 引用，已有优化；但是父轮普通文本、工具参数/结果等仍在 ordinary projection。正文 ≤96 KiB 直接保存，超过则保存最多 96 KiB preview 和按 codepoint 切分的原正文 chunks；单份正文最大 8 MiB。这是分块与响应限额，**不是压缩，更不是相邻 checkpoint 去重**。如果工具输出长期留在累计投影中，它会随每次后续 capture 重复保存。

源码有明确 `PublishedTurnBootstraps.release()` 和 `PublishedRecoveryLeases.prune()`，但本次在 `src` 非测试代码里搜索，未找到正常生产生命周期调用这两个方法的路径。capture 后单纯更新 head 不会自动回收旧 checkpoint，关闭 renderer 也按设计不释放 durable pin。应将“GC 方法存在”与“自动回收在运行”区分开。

这一机制也适用于没有实际子代理的父会话；是否在某个部署启动，要看注册 chatRoutes 时 `durableChildRecovery` 与 `newStreamPublication` 选项，不能只依据类名推断启用。

证据：[parent-publication.ts:86](D:/dev/ai-agent-engine/src/core/subagent/parent-publication.ts:86)、[chat.ts:531](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:531)、[chat.ts:1476](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:1476)、[turn-bootstrap.ts:50](D:/dev/ai-agent-engine/src/core/subagent/turn-bootstrap.ts:50)、[turn-bootstrap.ts:92](D:/dev/ai-agent-engine/src/core/subagent/turn-bootstrap.ts:92)、[turn-bootstrap-body.ts:13](D:/dev/ai-agent-engine/src/core/subagent/turn-bootstrap-body.ts:13)、[turn-bootstrap-body.ts:36](D:/dev/ai-agent-engine/src/core/subagent/turn-bootstrap-body.ts:36)、[child-recovery-projection.ts:11](D:/dev/ai-agent-engine/src/core/subagent/child-recovery-projection.ts:11)、[turn-bootstrap.ts:220](D:/dev/ai-agent-engine/src/core/subagent/turn-bootstrap.ts:220)。

## 5. 建议的三层职责

| 放在哪里 | 应放内容 | 原因及限制 |
|---|---|---|
| 内存，允许丢失 | 活动 SSE 订阅队列、尚未发布的 token 合并缓冲、LRU 活动历史、可重建 JSON 索引、临时计算、工作者 promise/AbortController | 崩溃可从已提交状态重建；必须有数量/字节/TTL 上限 |
| SQLite，小而可靠 | session/tenant/run/attempt ID、版本号、状态转移、request key/digest、admission/finish/projection receipt、outbox 状态、lease/pin/watermark、blob manifest/ref、用量去重键、权限 pending 和恢复配置 | 需要事务、比较并交换、唯一约束、重启后可信；通常省不了多少磁盘却决定正确性 |
| 持久正文存储 | tool args/output、图像/附件、完整消息原文、modelInputContent、摘要证据、密集历史输出片段、大 snapshot body | 大而通常不可变；适合内容寻址、压缩、冷归档；SQL 留 digest/长度/codec/schema/tenant/ref |

“用户已看到的输出”可以只保存 checkpoint+delta，不必每个 token 一个 DB 事务；但被 exact checkpoint/receipt 引用的正文必须持久。不能把现有 checkpoint 从 SQLite 直接改为 RAM，却继续向前端承诺同样的重启恢复与固定版本读取。

同理，未 ACK outbox、pending delivery 的 encoded bytes、审批 pending、已受理 request key、已完成工具的 effect receipt、usage invocation ID 都不能仅放 RAM。否则会出现 ACK 丢失重放后重复执行/重复计费、删除后复活、使用新 checkpoint 冒充旧版本等问题。

现有 RAM 预算并不小：StreamBus replay 默认 2048 events/8 MiB，单 subscriber 也默认 2048/8 MiB；projection 限 4096 slots、文本字段512 Ki chars、子代理区域4 MiB、浏览器图像约16 Mi chars。多个活动/保留会话要叠加评估。因此将大量磁盘历史搬到 RAM 可能恶化内存压力。

证据：[stream-bus.ts:106](D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-bus.ts:106)、[stream-projection.ts:13](D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-projection.ts:13)、[store.ts:521](D:/dev/ai-agent-engine/src/core/subagent/store.ts:521)、[store.ts:780](D:/dev/ai-agent-engine/src/core/subagent/store.ts:780)。

## 6. 可实施优化的先后顺序

### A. 先停增长：增量存正文，不重复累计快照

优先根据真实表体积选择：若 parent_turn_bootstrap_body_chunks/snapshot_json 主导，先将 ordinary projection 的大 payload 拆成内容寻址 immutable blob，checkpoint 只保存 frame 顺序、引用、hash 与 exact fence。相邻 checkpoint 未变工具输出引用相同 blob；累计文本采用可共享 prefix 的 append segments/manifest，避免仅给整份累积字符串算 hash 仍产生 N 份前缀副本。

如果 subagent event/checkpoint 主导，先把 partialOutput 从 scalar header 拆出来；event 真正保存发生变化的 state keys，body 用独立引用。可把同一 checkpoint 的 header 内容只存一次、event 引用，但需要保持增量 API 的解码输出不变。

稀疏完整 checkpoint + delta 重放可进一步减量，但不是删几行即可：当前 `readHeader` 精确要求 seq checkpoint，丢失时拒绝，不能返回最新替代。需新存储版本与有界重建路径（例如每 N 个事件或每 M 字节建 baseline，读取 atSeq 从最近前驱 baseline 回放），并验证与当前结果逐字段等价。

降低 output 写频率（如按时间+字节增长合并）只能作为辅助。重要工具结果、权限、终态、需要发布 exact evidence 的状态仍应在对外可见前提交。合并策略需调整“已发布 seq 的可恢复性”协议，不能偷偷跳过承诺。

### B. 先做正文去重，后考虑从 SQLite 迁出

可先保留 SQLite，但新增 `payload_blobs(tenant_id,sha256,codec,raw_bytes,body BLOB)`，tool versions/checkpoint/messages 引用它。这样可以在同一 DB 事务完成，验证风险较小。待正文体量与读取模式证明有必要，再将 blob 放到 `state/blobs/<tenant>/<hash-prefix>/<hash>`。

工具参数应单独去重，完成版引用开始版 args；output 也作为独立 blob。summary 保持小 preview，以便列表/卡片无需解压/读取大文件。图片尽量存原二进制内容、metadata 只放引用；JSON 内 base64 有额外编码开销，遇到每轮快照复制会再次放大。

压缩可选 gzip/Brotli/zstd（按运行时能力），先测代表性合成/脱敏样本，不预报固定收益。纯文字通常可压，已压缩 PNG/JPEG/PDF 不一定有收益。按大小阈值压缩并记录 codec/schema，不能对已有 JSON 字段直接写压缩字节让 `json_extract` 失效。

### C. 补“引用安全”的 GC，再回收空间

先定义 retention contract：最新与当前活动 run 永久 pin；审批等待/可续跑 root 的 head pin；有效客户端恢复 lease pin；故障排查历史按明确保留期限。旧 checkpoint 可在这些引用解除后过期。若产品不需要永久精确 rewind，可以让过期 selector 返回显式 recovery-required，而不能静默改指向最新。

接入自动 release/prune 调度时，先实现 dry-run 与将删除对象数/字节数输出到指标；通过 exact read 与 restart 测试后再启用删除。对 ACK 完成的 outbox，可把大 event 瘦身为 terminal seq/digest/ref，但 `ownedParentProjection` 目前要求 outbox 行存在，所以不能只删 ACK 行而不改读契约。execution/projection/usage 去重凭据体积小，应比正文保留更久。

数据库 DELETE 释放页供 SQLite 复用，不必然减小 `.db` 文件。实际腾空间需在备份后维护窗口执行合适的 VACUUM/重建；`wal_checkpoint` 处理 WAL，不负责压缩主库。应分别展示 logical live bytes、free pages、allocated DB bytes、WAL bytes，避免把可复用空闲页误当仍在使用的正文。

### D. JSONL 冷归档和物理整理最后做

普通 transcript 可设计 segment+index，封存段压缩、新段继续 append；但现有 collaboration receipts 将 `file_identity+row_offset+row_bytes+row_hash` 作为认证来源。直接重写/压缩当前 `.jsonl`、移动行或替换 inode，会让已保留的来源认证失败。只有全部 pending 写/维护已完成，持久 epoch 正确转换，pin/old selector 已处理并经过版本迁移后，才允许物理整理。

JSONL microcompact 保留原文是上下文优化，不是磁盘压缩。原消息中的 tool output、update.archiveContent、metadata preview/证据可能重复引用同一内容；内容寻址后分别保留模型 placeholder 与原文引用，可降低这些副本。`.bak` 的过期清理需要产品明确“清空后可恢复多久”，不能当无意义临时文件直接删除。

## 7. GC 必须尊重的引用图

```text
active root / waiting approval / attempt
  -> latest parent bootstrap head + run head
  -> parent_turn_bootstraps (fence E/R/U + body manifest)
     -> parent_turn_bootstrap_refs (runId, atSeq, sourceAtSeq)
     -> exact subagent checkpoint
        -> 每个 tool 在 atSeq 之前最近的一版 detail

live recovery lease
  -> 固定 publication revision / eventSequence / usageRevision
  -> projection refs / parent bootstrap

unacknowledged terminal outbox / execution receipt
  -> terminal seq checkpoint + stable message ID

pending collaboration delivery / history maintenance
  -> 原文件身份 + 精确 offset/hash/encoded bytes + 原入场 anchor
```

需要特别注意：

- 子代理读详情使用“每个工具在 atSeq 之前最近版本”。保留 seq 集合不等于只保留同名 seq 的 tool_versions；要保留满足每个 pin 的前驱版本。
- `canonicalAt` 还使用 tool.started/tool.completed 事件索引核对 expected seq。删旧 events 也可能破坏版本完整性验证，需要同步改变证明结构。
- `PublishedRecoveryLeases.prune` 已按 live leases + parent bootstraps + sourceAtSeq 所引用的历史 published version 收紧 retention floor；并保留 floor 之前最后一个 event mark。该方法只清 publication/usage/mark，不负责 subagent checkpoints/tool details 的 GC。
- lease 默认10分钟，最多全局5000/每父会话100；issue/prune 清理失效 lease。但 durable bootstrap 是另外的长期 pin，没有因为 lease10分钟到期就自动释放。
- bootstrap release 明确不删除 `parent_turn_bootstrap_handoffs`：它是一次性 activation 去重事实，不是正文 pin；删掉可能让另一个 checkpoint 复用已接受 attempt。
- `resetParentChildRecovery` 删除 publication/usage 状态，但没有删除 bootstrap/body_chunks；`deleteRunsForParent` 删子代理运行资料也没有覆盖所有 bootstrap/admission/collaboration 表。破坏性清理不等于完整关联 GC。
- discovery 自身已有 4096 revision 保留窗口，不需要把所有表都当作“完全未做清理”。

证据：[store.ts:104](D:/dev/ai-agent-engine/src/core/subagent/store.ts:104)、[store.ts:298](D:/dev/ai-agent-engine/src/core/subagent/store.ts:298)、[store.ts:360](D:/dev/ai-agent-engine/src/core/subagent/store.ts:360)、[store.ts:798](D:/dev/ai-agent-engine/src/core/subagent/store.ts:798)、[recovery-leases.ts:49](D:/dev/ai-agent-engine/src/core/subagent/recovery-leases.ts:49)、[recovery-leases.ts:350](D:/dev/ai-agent-engine/src/core/subagent/recovery-leases.ts:350)、[turn-bootstrap.ts:220](D:/dev/ai-agent-engine/src/core/subagent/turn-bootstrap.ts:220)、[child-usage-authority.ts:125](D:/dev/ai-agent-engine/src/core/subagent/child-usage-authority.ts:125)、[discovery.ts:6](D:/dev/ai-agent-engine/src/core/subagent/discovery.ts:6)、[discovery.ts:117](D:/dev/ai-agent-engine/src/core/subagent/discovery.ts:117)。

## 8. 外置正文的崩溃一致性方案

推荐新增不可变 blob manifest，而非 DB 存一个随意可覆盖的文件路径。

写入顺序：生成 canonical bytes → 临时 blob → flush/sync → 原子安装为最终 hash 路径 → SQL 事务插 manifest/ref 和状态 → 提交后发布 ACK。磁盘已有内容但 SQL 未提交，只产生可回收 orphan；SQL 不应指向还没持久化的 blob。

读取验证 tenant、schema、codec、原始长度和 digest；正文缺失/损坏显式报错，不伪造空结果。压缩 checksum 与原文身份 hash 分开定义，尤其现有 JSONL exact bytes/hash 必须仍能还原同一字节序列。

删除顺序：SQL 事务解除引用/推进 generation → commit → 延迟清理零引用 blob。并发写者租约、旧恢复读者的 grace period 必须计入；不凭单次 refcount=0 直接删除可能正在安装/读取的文件。定期 mark-and-sweep 从权威引用校验 refcount，修复崩溃造成的孤儿。

按租户命名空间隔离 hash/访问权限，避免跨租户 dedup 暴露内容存在性；备份需包含 blob 与 DB 一致版本。密钥/加密策略独立于压缩，原文引用不得绕过原先租户授权。

## 9. 给实际统计的归因口径

主报告可把每个表归到以下指标，而不是只看总大小：

| 指标 | 能回答的问题 |
|---|---|
| 表/索引 allocated bytes、payload bytes、unused bytes | 是正文、索引还是空闲页在占空间？ |
| subagent_events 按 schemaVersion/kind 统计 sum/avg/max bytes | 旧 v1 还是 modern output.updated 是增长源？ |
| checkpoints 与 events 的 partialOutput bytes | 重复累计输出占多少？ |
| tool_versions detail 的 args/output bytes 与版本次数 | 开始/完成/取消重复了哪些大正文？ |
| bootstrap snapshot/chunks 按 root/session 与 checkpoint 数量 | 是少数大轮次反复快照，还是很多历史会话？ |
| bootstrap body digest 去重前后 bytes（不输出正文） | 若共享内容能省多少？注意累积前缀不同 hash 仍可重复 |
| outbox acknowledged/terminal 数量及 bytes | 是否 ACK 后仍保留大快照？ |
| maintenance state、encoded plan bytes；delivery state、encoded_row bytes | 待完成恢复必留量与已结束可瘦身量分别是多少？ |
| root/admission/collaboration 与已删除 root 的 orphan 计数 | 关联回收是否落空？ |
| JSONL 主/子会话、.bak、各 row type、各 content 字段 bytes | 140 MiB 是子会话原文、备份还是裁剪副本？ |

所有统计只输出数量与字节，不输出内容/凭据。优化收益应依据这些实测，而不是承诺任意“减少80%”。

## 10. 最小改造验收条件

1. 已受理输入和已完成工具跨重启不重复、不丢失；ACK丢失重试与部分文件写入仍能恢复。
2. 所有未过期 atSeq/checkpoint/lease 返回同一可见内容；过期选择器显式失效，不替换成最新。
3. 删除后旧 writer/旧receipt不能复活消息；billing invocation 不重计；审批等待可继续。
4. blob 迁移新旧双读兼容，完成前保留原 inline 数据；迁移校验 hash/行数/使用量/可回放内容，而非只看文件体积。
5. 用同一合成长跑工作负载比较：逻辑正文增长/分钟、DB+WAL写入字节、峰值RSS、p95写入与恢复延迟、GC回收字节、pin保留字节。

以上是基于当前源码的实施建议。真实占用主因、预期收益与执行顺序应以主报告实测调整。

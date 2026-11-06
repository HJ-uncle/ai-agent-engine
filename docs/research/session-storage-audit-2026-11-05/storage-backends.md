# 会话存储后端深度调研

调研日期：2026-11-05。对象：`D:/dev/ai-agent-engine` 当前工作树，包含原有未提交修改。本文未修改引擎源代码，未读取实际会话、实际数据库或 `.env`；测试及故障探针只操作合成临时数据。这里讨论存储后端；会话 API、运行控制面和多代理生命周期由主报告交叉整理。

## 1. 最重要的结论

1. 默认历史后端是 **JSONL 文件**；仅当 `HISTORY_BACKEND === 'sqlite'` 才走 SQLite。选择 JSONL 不代表摆脱 SQLite：用户入场 ACK、条件结果投影、协作维护/认证依赖 SQLite 中的状态表。
2. 同一会话至少存在三种不同视图：完整物理日志、经过编辑/删除折叠的用户归档、经过摘要/工具裁剪的模型活动上下文。`getFullHistory()` 返回第三类中的未加 token 窗口版本，名称中的 “Full” **不代表压缩前全部历史**。
3. JSONL 压缩保留原文；SQLite 全量压缩会事务性删除被摘要的正文，只留摘要、近期消息和计费用量凭据。两种后端不可视作无损互换。
4. “append 成功”的持久性分级明显：普通 JSONL `appendFile`、用户入场 `fsync+ACK`、条件结果 `pending+fsync+receipt`、协作精确字节凭据并不相同。
5. 已复现两个普通 JSONL 路径缺口：半行尾后追加的消息在热缓存可见、冷读丢失；压缩后重复普通 UUID 会重复归档并累计 usage。条件结果专用路径有更强保护，不能把这两个发现泛化为所有写入路径都失效。
6. 删除不等于擦除：JSONL 单条/单轮删除只追加标记；clear 把原文件改名成 `.bak`；迁移时旧 SQLite 行保留。当前历史模块没有自动物理回收、保留期或跨存储一致备份机制。

核心入口：[factory.ts:15](D:/dev/ai-agent-engine/src/storage/conversation/factory.ts:15)、[jsonl-history.ts:252](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:252)、[history.ts:344](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:344)。

## 2. 物理布局和实例边界

```text
DATA_DIR=./data/agent.db          # 名称叫 DIR，实际含义是 SQLite 文件路径
data/
  agent.db                     # 主控制面数据库；SQLite 模式下也存正文
  agent.db-wal / agent.db-shm   # SQLite WAL/共享内存运行文件，实际存在与否由 SQLite 决定
  sessions/
    <tenantId>/
      <sessionId>.jsonl         # 消息 + summary/update/tombstone/usage 行
      <sessionId>.migrated      # 迁移时间戳或 cleared；不是正文
      <sessionId>.jsonl.<time>.bak # clear 后保留的原文件
      <sessionId>.jsonl.tmp     # 懒迁移临时文件，成功后 rename
```

`getDb()` 使用 `file:${path.resolve(DATA_DIR)}`，不是远程 libSQL URL；`JSONLConversationHistory` 在构造时冻结 `dataPath` 与 `rootDir`，后者是 `dirname(dataPath)/sessions`。`projectionDb()` 会拒绝实例构造后环境变量改绑到别的数据库，防止旧文件借用新数据源的执行凭据。

**配置陷阱（代码可确定，未做部署实测）：** 两个数据库文件若位于同一个目录，比如 `/data/a.db` 与 `/data/b.db`，其 JSONL 根目录都为 `/data/sessions`。相同 tenant/session 会使用同一归档文件，单改数据库文件名不形成完整数据隔离。需要不同父目录，或未来显式引入独立历史根路径。

证据：[db.ts:47](D:/dev/ai-agent-engine/src/storage/sqlite/db.ts:47)、[jsonl-history.ts:252](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:252)、[jsonl-history.ts:830](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:830)。

## 3. 身份模型和 schema

| 标识 | 含义与边界 |
|---|---|
| `tenantId` | 逻辑租户隔离；SQL 查询条件及 JSONL 目录边界 |
| `sessionId` | 多轮会话；JSONL 文件边界、SQL 分区键 |
| `conversationId` | 一轮对话；工具和助手消息属于同轮，不是整个会话 |
| `message.id` / `message_id` / `uuid` | 稳定消息身份，用于编辑、去重、投影凭据 |
| SQLite `id` | 自增物理 row ID；普通压缩重建会改变近期行 ID |
| JSONL `dbSeq` | 消息/summary 的逻辑序号，作为 `dbId` 返回；update/tombstone 通常是 0，因此不能称所有物理行严格递增 |
| `parentUuid` | 追加时上一条活动消息 UUID；当前读路径没有将它解释为可选分支 DAG |
| `toolCallId` / anchor | 调用和结果关联；条件写入还要求原消息 ID、轮次、工具调用身份均匹配 |
| epoch / revision / file identity | 清理、改写、数据库重连后撤销旧写入权，作用与业务 ID 不同 |

### SQLite 表

| 表 | 主键/关键列 | 作用 |
|---|---|---|
| `conversations` | `id INTEGER PRIMARY KEY AUTOINCREMENT`; tenant/session/conversation/message ID、role、content、reasoning、tool call、tokens、usage、model、metadata、created_at | 活动历史正文 |
| `sessions` | `(session_id, tenant_id)`；agent_id、metadata、created_at | 会话 agent 绑定及元数据；正文不在本表 |
| `conversation_usage_archive` | `(tenant_id,session_id,message_id)`；原 row_id、conversation_id、token_usage | 压缩/孤立前缀清理后保存计费用量，不能恢复原消息正文 |
| `conversation_projection_receipts` | `(tenant_id,session_id,message_id)`；anchor、backend、disposition、reservation_epoch、anchor_sequence | 子代理/工具条件投影幂等与删除后不复活 |
| `conversation_projection_epochs` | `(tenant_id,session_id)`；epoch | JSONL clear 后撤销旧预约 |

协作专用表另有物理 JSONL/SQLite delivery 与 history maintenance 凭据，独立于上表中的普通条件投影凭据，不应合并理解。

`conversations.message_id` 只有普通索引，没有全局 UNIQUE；普通 append 通过 SQL `INSERT ... SELECT ... WHERE NOT EXISTS` 在 tenant/session 范围去重。`getMessageById` 可接收 session，而 `deleteMessage/updateMessageContent/deleteByConversationId` 只要求 tenant，存在“同一租户跨会话同 ID”的 API 语义差异：SQLite 会批量影响匹配行，JSONL 单消息定位通常采用第一个匹配文件。因此稳定 ID 应全局生成，不能随意复用短 ID。

证据：[001_initial.ts:6](D:/dev/ai-agent-engine/src/storage/sqlite/migrations/001_initial.ts:6)、[002_add_message_id.ts:3](D:/dev/ai-agent-engine/src/storage/sqlite/migrations/002_add_message_id.ts:3)、[009_add_sessions.ts:12](D:/dev/ai-agent-engine/src/storage/sqlite/migrations/009_add_sessions.ts:12)、[025_conversation_usage_archive.ts:9](D:/dev/ai-agent-engine/src/storage/sqlite/migrations/025_conversation_usage_archive.ts:9)、[030_conversation_projection_receipts.ts:5](D:/dev/ai-agent-engine/src/storage/sqlite/migrations/030_conversation_projection_receipts.ts:5)、[history.ts:227](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:227)、[history.ts:439](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:439)、[jsonl-history.ts:1782](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1782)。

### JSONL 信封与消息载荷

信封含 `uuid,parentUuid,type,timestamp,sessionId,tenantId,isSidechain,dbSeq,conversationId`；`cwd/version` 在类型中可选，普通 append 并未保证写入。注释写“Claude Code 格式”只能理解为格式借鉴，不能当成外部产品导入兼容承诺。

payload 保留正文、多模态数组、`modelInputContent`、思考内容、工具参数/结果、tokens、usage、createdAt、modelId、metadata、轮次。编辑不直接改原行；`update` 覆盖可见内容，`tombstone` 处理删除/截断，`summary` 设置活动可见下界及 retained UUID，`usage` 仅承载 SQLite 懒迁移来的历史计费凭据。

SQLite 用 `metadata.__aetherModelInputContent` 内部字段保存“真实提供给模型的内容”；读时剥离为 `modelInputContent`，防止外部 metadata 伪造同名内部字段。UI 原文与模型读取的附件提取文本/多模态快照可不同。普通编辑会清除旧模型快照与工具证据，避免改了显示文本却仍喂旧附件内容。

证据：[jsonl-history.ts:47](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:47)、[jsonl-history.ts:608](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:608)、[model-input-content.ts:6](D:/dev/ai-agent-engine/src/storage/conversation/model-input-content.ts:6)、[jsonl-history.ts:130](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:130)。

## 4. 写入链路及持久性强弱

| 路径 | 步骤 | 已有保障 | 尚不能推导出的保障 |
|---|---|---|---|
| SQLite 普通 append | 校验时间 → 稳定 ID → 单条条件 INSERT | 单 SQL 原子性；与活动行、usage archive 去重 | 完整请求/外部工具副作用 exactly-once |
| JSONL 普通 append | 会话队列 → 恢复待完成维护 → load → 活动 UUID 去重 → appendFile → stat → 更新缓存 | 单进程多实例串行；写失败不先推进缓存/序号；外部文件变化触发失效 | 单条 fsync、跨进程文件互斥、归档 UUID 全局去重 |
| 用户入场 JSONL | 原始 seed 校验 → 普通 append → 从文件复核 → handle.sync → SQLite ACK | 明确用户输入的落盘和 ACK 顺序；source 身份检查 | 文件与 SQL 的共同原子提交；需上层状态机协调 |
| SQLite 条件结果 | 写事务内检查原工具 anchor → 插入结果 → 写 disposition receipt → commit | anchor 判定与 INSERT 同一物理事务；删除不能插入其间 | 所有普通 append 都同样受此 anchor 保护 |
| JSONL 条件结果 | pending receipt → 校验 epoch/anchor → 补断尾换行 → append → sync → appended receipt | ACK 丢失可扫描原日志去重；已删/已摘要 anchor 抑制投影 | 任意 JSONL 文件系统操作与 SQL 全局原子性 |
| JSONL 协作/维护 | 预约 exact bytes/offset/hash/identity → 验证/补齐部分后缀 → sync → 验证原字节 → SQL committed | 对自身预约区间做精确恢复；前缀和来源认证 | 对外部任意改写无限容错；冲突会显式拒绝 |

普通 JSONL 注释“Append is durable”在代码上对应 `appendFile` 完成；不能据此声称断电后必存。`fsync` 路径更强，但硬件/文件系统级掉电语义未在本次调研实测。

证据：[history.ts:227](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:227)、[history.ts:283](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:283)、[jsonl-history.ts:730](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:730)、[jsonl-history.ts:799](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:799)、[jsonl-history.ts:857](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:857)、[jsonl-history.ts:328](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:328)。

## 5. 读取、归档、搜索、分页不是同一查询

| 方法 | JSONL | SQLite |
|---|---|---|
| `getHistory` | 折叠活动视图，再可选 token 窗口 | 活动表，清理孤立前缀后 token 窗口 |
| `getFullHistory` | 同一活动视图，不再 token 窗口 | 当前活动表，不再 token 窗口 |
| `getArchive` | 恢复被 summary 隐藏的正文、恢复 microcompact 工具输出；仍服从编辑/删除 | 当前活动表，恢复内部 microcompact 工具备份；无法恢复全量压缩已删除正文 |
| `getArchive(page)` | 固定文件句柄及初始长度，两遍扫描；只实例化本页消息 | 后端没有等价原生分页参数实现；上层需自行处理 |
| `searchArchive` | 两遍扫描；先折叠修改标记，再按内容/模型输入包含关系匹配 | 本类未实现此可选方法 |
| `getByConversationId` | 遍历 tenant 所有 JSONL 的活动视图 | tenant 范围当前表查询 |
| `getMessageById` | 指定 session 时可从活动缓存退回归档搜索 | 当前表；已全量压缩移除的正文查不到 |
| `listSessions` | 遍历当前 `.jsonl`，读活动视图与计费；按文件 mtime 排序 | SQL 聚合当前 user/assistant 行、关联 sessions、按消息时间排序 |

JSONL 分页的“内存有界”不能理解为 O(1)：它仍持有 update、tombstone、UUID→原序号等索引，至少随日志中标记和身份量增长；单个巨型行也需要完整构造。时间上每页/每次搜索通常 O(整个文件长度)，不是数据库索引定位。已有 25,000 消息冷读测试验证不会先整文件 `readFile`，但不代表百万条低延迟分页已被证明。

`loadSession` 和未分页 `getArchive` 仍使用 `readFile+split+JSON.parse` 全量读。冷读时完整原始文件字符串和中间 row 数组在内存中同时存在；活动缓存的 64 MiB 上限不是冷读峰值 RSS 上限。

SQLite 读取 `getRawMessages()` **会写库**：存在 user 时，把其前的 assistant/tool 孤立前缀 usage 归档并删除正文；system 前缀保留，没有 user 时不做这一删除。迁移读取也会经过该路径。不能把所有“读历史”操作理解成绝对无副作用。

证据：[jsonl-history.ts:448](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:448)、[jsonl-history.ts:1006](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1006)、[jsonl-history.ts:1096](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1096)、[jsonl-history.ts:1192](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1192)、[history.ts:371](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:371)、[jsonl-archive-pagination.test.ts:31](D:/dev/ai-agent-engine/src/storage/conversation/__tests__/jsonl-archive-pagination.test.ts:31)。

## 6. 压缩、窗口、删除的差异

### 上下文压缩

两种后端都将摘要生成拆成 prepare / 网络摘要 / commit；摘要期间释放 tenant lock，其他会话可运行。同会话新入场等待压缩；编辑/清理会 cancel 压缩。commit 再做 revision/digest CAS，避免过期摘要覆盖期间新消息。SQLite 在真正 write transaction 内重读比较所有字段；JSONL 比较文件 revision 与 nextSeq 后追加 summary。

保留边界使用 `compressionSplitIndex`，既支持最近 N 条，也支持按真实模型输入 token 预算保留；不切开已识别的工具调用—结果交换。协作维护额外 pin 原始用户入场消息和待完成 dispatch。

JSONL `summary` 只改变活动可见下界，旧行还在。SQLite 普通 compress 是归档 usage、删除该 session 当前所有正文、重新插入 summary + recent；在特权维护下则保留被 pin 的物理原行，仅删除 retired rows。普通压缩保存近期 message UUID/时间/metadata/tool/model 但其 row ID 会重建。

### Microcompact

默认保留最近 10 条消息内的工具结果，超长结果可提前裁剪。模型内容改为 `[tool result cleared]`，原文在 JSONL update 的 `archiveContent`、SQLite metadata 的 `__aetherMicroCompactArchive` 中保留。JSONL 一批最多目标 128 行或 8 MiB，单条巨型历史行不会截断。它主要减少模型上下文；JSONL 物理日志反而会增长，SQLite 也不意味着数据库文件缩小。

### 默认窗口和 inheritContext 的实测差异

SQLite 默认 `HISTORY_MAX_TOKENS=20000` 再乘 OSM；超窗优先保留首条 system、至少最近两条，预算不是绝对硬上限。JSONL 默认 `maxTokens` 为 undefined，不读这个环境配置；仅显式传参才从尾部累加 tokens，甚至允许超大末条导致空窗口。两者使用 stored tokens，与模型 admission 真实 token 估计也不是同一概念。

`inheritContext=false`：SQLite 只返回最后一条 user；JSONL 返回最后 user 开始的后续全部消息。探针在 `HISTORY_MAX_TOKENS=1, OSM_MODE=off` 下，同样 4 条各 20 tokens 的合成消息，SQLite 返回 2 条，JSONL 返回 4 条；inherit=false 分别 `[user]` 与 `[user,assistant]`。这是后端行为差异，具体请求是否受影响需结合 agent loop 调用点，不能仅凭差异断言模型输入超限。

证据：[serialization.ts:67](D:/dev/ai-agent-engine/src/storage/conversation/serialization.ts:67)、[compression.ts:11](D:/dev/ai-agent-engine/src/storage/conversation/compression.ts:11)、[history.ts:725](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:725)、[jsonl-history.ts:1558](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1558)、[history.ts:849](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:849)、[jsonl-history.ts:1402](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1402)、[history.ts:154](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:154)、[jsonl-history.ts:1798](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1798)。

### 删除和回退

| 操作 | JSONL | SQLite |
|---|---|---|
| 单消息删除 | 追加 message tombstone，原文留盘 | 当前正文与 usage archive SQL DELETE |
| 单轮删除 | 遍历 tenant 文件，追加 conversation tombstone | tenant+conversation_id 删除正文与 usage |
| 截断 | 只屏蔽该 tombstone 之前且 dbSeq 大于锚点的行；后来 append 不受旧截断影响 | 按 row ID 删除 suffix，同时处理 usage archive |
| clear | 推进持久 epoch → 撤销 delivery → rename `.bak`，失败退化 clear tombstone → `.migrated=cleared` | 单 write batch 撤销 delivery 并删正文/usage |
| 防复活 | generation fencing + 本实例 5 秒墓碑 + 持久投影 epoch/receipt | generation fencing + 模块级 5 秒墓碑 + 持久投影 receipt |

clear 的 `.migrated` 防止重新从旧 SQLite 懒迁移“复活”。5 秒墓碑只是额外兜底，不能独立替代持久运行撤销。JSONL 墓碑存于当前实例；SQLite 墓碑 key 为 tenant/session、未含 DATA_DIR。同进程动态切换数据库时，同名 tenant/session 可能受到另一个数据源墓碑影响；正常单数据源部署不会仅因此受影响。

SQLite SQL DELETE 也不是安全擦除承诺：未见该历史模块设置 `secure_delete` 或主动 VACUUM。clear 后仍存在 identity-only projection receipts，是防重放设计的一部分；隐私硬删除需另行定义是否保留这些身份凭据。

证据：[jsonl-history.ts:1261](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1261)、[jsonl-history.ts:152](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:152)、[history.ts:453](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:453)、[history.ts:601](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:601)、[serialization.ts:110](D:/dev/ai-agent-engine/src/storage/conversation/serialization.ts:110)。

## 7. 并发和一致性模型

1. **进程内 tenant 锁：** `serializeConversationHistory` 对除了 compress 之外的方法按 DATA_DIR+tenant 排队，包含读方法；可重入 AsyncLocalStorage 避免同链路死锁。ID-only 操作可能跨会话，因而使用 tenant 粒度。长归档读取或 list 仍可能阻塞同租户其他会话。
2. **进程内 JSONL session 队列：** 模块全局 Map，key 为 rootDir+tenant/session，多个 history 实例共享，避免同进程追加交错。它不是 OS 文件锁。
3. **运行代数：** `bindHistoryGeneration` 捕获 generation，破坏性修改递增，旧 run 后续 append 报错。generation/mutation/compression 映射都是内存状态；进程重启后的执行权依赖持久控制面。
4. **SQLite 物理写事务：** `LocalSqliteProcessClient` 单独子进程持有 native SQLite 连接。所有普通操作排队；事务活跃时允许同 tx 请求越过其他请求抵达 COMMIT，避免死锁。write 模式 `BEGIN IMMEDIATE`。
5. **JSONL 与 SQLite 跨存储：** 没有二者共用事务；高保障路径通过 pending/committed 凭据、epoch、原字节校验恢复。不能只备份任一侧而假设运行恢复完全成立。
6. **多进程边界：** 普通 JSONL 的 nextSeq/parentUuid 来自本地读到的状态，未见通用跨进程排他写锁。外部变化检测能让缓存重读，不能倒推出并发生成序号绝对唯一。多实例共享同目录尤其需验证 owner/路由约束。

SQLite 连接默认 WAL、synchronous=NORMAL、约 20,000 KiB page cache、256 MiB mmap、busy timeout 5 秒、foreign_keys=ON。这些属于吞吐与延迟配置；NORMAL 不等同于每个提交都 fsync 的断电保证。子进程隔离避免 native SQLite 等锁拖住主 Node event loop。关闭凭据核对 ACK、进程退出、stdio 结束，并在重连时变更 epoch；完整关闭比单纯调用 `close()` 更重要。

证据：[serialization.ts:135](D:/dev/ai-agent-engine/src/storage/conversation/serialization.ts:135)、[jsonl-history.ts:404](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:404)、[local-process-client.ts:129](D:/dev/ai-agent-engine/src/storage/sqlite/local-process-client.ts:129)、[local-process-runtime.ts:84](D:/dev/ai-agent-engine/src/storage/sqlite/local-process-runtime.ts:84)、[local-process-runtime.ts:97](D:/dev/ai-agent-engine/src/storage/sqlite/local-process-runtime.ts:97)、[db.ts:158](D:/dev/ai-agent-engine/src/storage/sqlite/db.ts:158)。

## 8. 计费与 token 口径

`tokens` 为消息上下文估计；`usage` 为提供方调用计费。`getTokenCount` 是加窗口后的 stored token 总和，`getRawTokenCount` 是活动上下文的 stored token 总和；二者都不是所有历史调用账单。

账单字段限定为 15 项（prompt/completion/total/cache/reasoning/system/tool/RAG 等）。缺 total 时由 prompt+completion 回退，不把正文长度估计当计费。JSONL 账单扫描物理归档，summary 不抹除以前调用，usage 类型迁移行计费但不进入上下文。SQLite 将被压缩调用移入 usage archive，`UNION ALL + NOT EXISTS` 避免近期保留行重复累计。session 和 turn 总量在 SQLite 单个查询快照读出。

用户主动删除/截断会同时影响可见计费统计，所以这个“会话总用量”不是独立、不可变的财务台账。若要合规计费、对账或成本审计，应分离 immutable provider invocation ledger 与可编辑会话视图。

证据：[usage.ts:4](D:/dev/ai-agent-engine/src/storage/conversation/usage.ts:4)、[history.ts:562](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:562)、[jsonl-history.ts:1522](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1522)。

## 9. 缓存、索引与规模上限

| 层 | 策略 | 现实限制 |
|---|---|---|
| JSONL 活动视图 | 每 history 实例 LRU，64 sessions / 64 MiB 估计；按 mtime/ctime/size/ino/dev 失效 | 不限制 cold read 峰值；新实例无共享活动缓存 |
| JSONL usage | 每实例最多 64 条缓存，revision 校验；正常 append 增量更新 | 维护/外部写后全归档重扫 |
| JSONL 物理快照 | 全进程 LRU 4 entries / 32 MiB 估计，key 包括 owner、dataPath、db/epoch、tenant/session、identity/revision | cache 命中仍打开/stat 并校验路径；巨型 snapshot 不缓存；不跨 owner 复用 |
| SQLite 历史索引 | `(tenant_id,session_id,created_at)`，message_id，conversation_id，agent_id 等 | 没有会话正文 FTS；message_id 非 unique；list 包含聚合和相关子查询 |
| JSONL 单 ID 查找 | 若无已知 session，扫描该 tenant 所有 `.jsonl` | 会话越多越慢，没有持久全局 message→session 索引 |

normal append 在热状态不再重读全日志，但会复制 messages 数组维护旧快照稳定，且对当前 active messages 用 `.some()` 查重。极长未压缩活动上下文累计追加仍存在 O(n²) 数组复制/扫描趋势。压缩减少模型上下文，却不降低 JSONL 原文件大小与归档扫描成本。

list 的 backend 语义也有差异：JSONL messageCount 包括所有活动 role，SQLite list 只计 user/assistant；JSONL lastAt 是文件 mtime（编辑/压缩也变化），SQLite 是消息 created_at；JSONL 标题源自目前活动的第一 user，可能随压缩而变化。上层若展示统一字段，应明确这些不是天然相同统计口径。

证据：[jsonl-history.ts:235](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:235)、[jsonl-history.ts:435](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:435)、[jsonl-physical-cache.ts:3](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-physical-cache.ts:3)、[jsonl-history.ts:730](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:730)、[history.ts:618](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:618)、[jsonl-history.ts:1625](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1625)。

## 10. 迁移、切换和备份

SQLite schema 启动执行 001–030 的 up，使用幂等创建、补列和局部兼容修复；同一数据库 init Promise 复用，失败可重试，重开 client 会重新初始化。这里没有统一 schema version ledger、整体 30 步单一事务或自动整库迁移前快照。部分兼容 ALTER 使用宽泛 catch，CLI migrate 还对多步错误只记录 skipped；启动 init 与 CLI 不是完全相同流程（CLI 源码缺少 019_subagent_runs 的调用）。正式升级应测试启动路径和迁移命令两者。

JSONL 懒迁移条件是“文件不存在且没有非空 .migrated”；读 SQLite 当前完整活动视图和 usage archive，构造临时文件后 rename，再写 migrated。SQLite 旧行不删除，空 SQLite 不写永久 migrated，explicit clear 则永久写 cleared。迁移不会找回 SQLite 已摘要删除的正文，只把其计费转 usage 行。

两个重要操作边界：

- **回退后端不是同步切换。** JSONL 新消息没有持续反写 SQLite；回到 sqlite 会看到旧 SQLite 当前内容。再次切 jsonl 若文件已存在，也不会自动合并 sqlite 新写入，形成分叉风险。
- **迁移读异常被视作空数据。** `migrateFromSqlite` 捕获读取异常后设置 rows=[]。若随后 append 创建新 JSONL，以后“文件不存在”的迁移条件不再成立，旧 SQLite 内容可能一直被遮蔽。该错误窗口由代码可确定，本次未注入 SQLite 读取失败复现。

备份至少需覆盖主 SQLite 的一致快照、sessions 目录、.migrated、确有保留需求的 .bak，以及报告其他章节覆盖的 workspace/附件/记忆等。运行中的 WAL 库不应仅复制 `.db` 文件并称完整备份；应使用 SQLite backup API，或停止写入并完成关闭再复制。跨 SQL/JSONL 的一致恢复需要写入屏障/协调快照，当前历史模块没有统一接口。`scripts/longrun/orchestrate.mjs` 有测试工作负载准备时的 SQLite backup，这不等于产品的全会话备份能力。

证据：[db.ts:96](D:/dev/ai-agent-engine/src/storage/sqlite/db.ts:96)、[db.ts:107](D:/dev/ai-agent-engine/src/storage/sqlite/db.ts:107)、[migrate.ts:1](D:/dev/ai-agent-engine/src/storage/sqlite/migrate.ts:1)、[jsonl-history.ts:655](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:655)。

## 11. 路径与数据安全边界

JSONL 拒绝空路径段、`..`、分隔符、控制字符、Windows 设备名、尾部点/空格；确认归档仍位于 tenant 目录，并对 tenant、归档、marker、tmp 做 lstat 符号链接拒绝，含 dangling link。已有相应测试。此处没有宣称能抵抗同机恶意进程在 lstat 与 open 之间替换路径；普通文件读写未采用完整 handle-based/no-follow 原子路径约束。

正文、思考、工具参数/输出、模型输入快照、metadata 均按 JSON/SQL 文本落盘；本模块没有透明加密、敏感字段脱敏或单租户独立密钥机制。实际磁盘权限/磁盘加密由部署环境决定。物理备份、迁移旧表、旧 update 行和 .bak 都可能继续包含已经从 UI 删除的内容。

逻辑租户隔离不等于归档自认证：普通 `loadSession/getArchive/scanArchive` 主要信任文件路径并解析行；协作物理读取才有 scoped row 过滤、来源 epoch 和 exact bytes/hash 认证。不能把协作专用认证当作整份普通 transcript 的防篡改签名。

证据：[jsonl-history.ts:363](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:363)、[jsonl-history.ts:388](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:388)、[jsonl-history.ts:167](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:167)、[jsonl-origin.ts:76](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-origin.ts:76)、[jsonl-archive.test.ts:133](D:/dev/ai-agent-engine/src/storage/conversation/__tests__/jsonl-archive.test.ts:133)。

## 12. 故障实证、风险优先级与建议

### 已复现 A：普通 append 在半行后产生冷热分裂

先写合法 before 消息，模拟崩溃在尾部留下 `{"type":"assistant","payload":`，再普通 append 一条 after。方法返回成功；热实例看到 `[before,after]`，新实例只能看到 `[before]`。原因：普通 append 不补换行，把 after JSON 拼进坏行，loadSession parse 失败跳过整行；而缓存根据本次 encoded 单独生成了 after。这是真实可执行探针验证，不是假设掉电真的发生过。

建议高优先级统一普通 append 的断尾修复、重读验证与 fsync 策略。专用条件投影已实现补 LF，可提取共享 append primitive，但需保留 exact-byte receipts 的预约边界，避免盲目重写物理偏移。

证据：[jsonl-history.ts:754](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:754)、[jsonl-history.ts:509](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:509)；对照专用保护：[jsonl-history.ts:901](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:901)。

### 已复现 B：压缩后普通 UUID 重试重复归档/usage

写入 6 条独立 ID、各 2 计费 tokens，压缩保留最近 2 条，然后普通 append 第一条 ID。归档同 ID 有 2 份，usage 为 14，而唯一调用总额本应 12。普通去重只看活动投影，旧 ID 已被 summary 隐藏。它不等于条件子代理投影的幂等机制有同样缺口；后者会查持久 receipt 和原始日志。

建议建立普通消息持久身份索引/receipt，或实现低成本物理 ID 查询，并明确 duplicate payload mismatch 的行为。不要把 UUID 查重局限在压缩后的缓存。

证据：[jsonl-history.ts:739](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:739)、[jsonl-history.ts:1538](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:1538)。

### 其他需优先治理的边界

| 优先级 | 事项 | 证据级别 | 建议 |
|---|---|---|---|
| 高 | JSONL/SQLite 回切造成新旧视图分叉 | 源码确认无反向同步 | 显式迁移工具、后端变更检测和拒绝无迁移切换 |
| 高 | `.bak`/tombstone/迁移旧表残留敏感内容 | 源码确认 | 分离逻辑删除、可恢复清空、物理擦除；定义保留期和导出策略 |
| 高 | 多进程普通 JSONL 写缺统一文件租约 | 局部代码风险，未并发压力复现 | 明确单 writer 归属；跨进程 owner/CAS 或文件锁 |
| 中 | 同目录不同 DATA_DIR 文件共享 sessions | 路径推导确定 | 租户/实例独立父目录，或显式历史 root namespace |
| 中 | 懒迁移错误吞掉后可能遮蔽旧数据 | 源码错误窗口，未故障注入 | 区分真正不存在、空库、读取失败；失败不得继续建立新 transcript |
| 中 | 默认窗口/继承/列表语义不一致 | 窗口继承已复现 | 统一接口契约，补 backend parity tests |
| 中 | 冷读/归档 O(file) 与 tenant 锁阻塞 | 算法确认；已有 25k 功能测试 | 持久 offset/ID 索引、分页 revision 游标、只读快照锁分离 |
| 中 | 普通写与特殊写 durability 不同 | 源码确认 | 明确 durable ack 定义；按消息重要性统一 fsync/批量 flush |
| 中 | SQL read path 可删孤立正文 | 源码确认 | 显式维护动作、保留可审计证据，避免读方法意外写 |
| 中 | 迁移 CLI 与启动路径不一致 | 源码确认 | 单一 migration registry、严格错误分类、版本记账 |

## 13. 本次验证范围

执行了两组已有测试和一个可复现探针。已有测试共 **210 项，208 通过、2 失败**；两个失败都来自 `history-compress-tombstone.test.ts` 的过期 `db.js` mock 缺失 `getDbEpoch`，在构造 history 时失败，不能解读为已证实 compress 功能回归。没有为了让调研变绿而修改测试或源代码。

| 命令/对象 | 结果 | 覆盖 |
|---|---|---|
| `npx vitest run src/storage/conversation/__tests__ --maxWorkers=1 --minWorkers=1 --reporter=dot` | 15 文件，184 pass / 2 fail，32.36 秒 | 压缩冲突/取消/事务回滚、usage、归档、25k 分页、cache、路径隔离、modelInput、工具 evidence、anchor |
| `npx vitest run src/storage/sqlite/local-process-client.test.ts src/storage/sqlite/db-process-lifecycle.test.ts src/storage/__tests__/startup-migrations.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot` | 3 文件，24 pass，5.33 秒 | 单物理连接事务队列、busy、子进程退出/重连、初始化、8 MiB 旧表重复启动不重写 |
| `npx tsx docs/research/session-storage-audit-2026-11-05/storage-probe.ts` | exit 0，输出已保存于 verification JSON | 半行后冷热差异、压缩 UUID 重复计费、默认窗口与 inheritContext 差异 |

测试 fixture 由 `vitest.setup.ts` 自动重定向到 `.e2e-tmp`；探针使用 OS 临时目录并验证路径后清理。未测试真实断电、网络文件系统、百万消息规模、完整多实例部署、真实生产数据恢复。因此这些能力不应从单元测试通过推断。

探针：[storage-probe.ts](D:/dev/ai-agent-engine/docs/research/session-storage-audit-2026-11-05/storage-probe.ts)。机器可读结果：[storage-verification.json](D:/dev/ai-agent-engine/docs/research/session-storage-audit-2026-11-05/storage-verification.json)。

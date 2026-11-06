# 会话存储关联生态与恢复边界

调研日期：2026-11-05。基于当前工作树源码，包括既有未提交修改；本次不修改业务代码，不读取真实数据库、会话内容或凭据。本文中的行号指本次阅读时的源码。事实与架构推断分开表达。

## 1. 核心结论

会话恢复横跨 SQLite、JSONL、独立记忆数据库、工作区绑定文件、真实项目文件和进程内执行对象。它并不是“保存聊天消息之后，重启就能原地继续执行”的系统。

- **运行记录可以恢复，执行过程不自动恢复。** 主运行、子运行和命令进程都明确把未完成执行标为 interrupted；避免自动重放可能已产生外部副作用的工具。
- **JSONL 模式依然依赖 SQLite。** root admission、root runs、subagent outbox、mailbox、投递凭证、记忆之外的计划/命令/文件变更状态都不在 JSONL 内。
- **硬删除会话不是完整数据抹除。** 目前删除链路清理聊天历史、部分子任务/主运行、Agent 绑定和默认私有目录；多个关联数据域及原始用户输入副本保留。
- **完整备份不是只复制 agent.db。** 还需要 history 文件、memory.db、绑定文件、change-snapshots、私有工作区和外部项目，且需要一致性边界。
- **多连接竞争有局部保证，不等于多进程生产实例可共享同一数据目录。** 启动恢复会全表标记未完成运行，执行权限和历史锁等仍有进程内状态，缺少覆盖全体系的分布式 owner/lease。

## 2. 身份及存储地图

| 数据域 | 主要持久结构 | 关键身份 | 来源 |
|---|---|---|---|
| 一次主运行 | root_runs.state JSON + seq | tenant/session/run/turn/attempt/message IDs | `src/storage/root-runs/index.ts:44`, `:142` |
| 用户请求准入 | engine_database_namespace、user_root_admissions、user_root_admission_seeds | namespace + generation + tenant + session + requestKey；bodyDigest | `src/storage/root-admission/index.ts:106` |
| 服务端/Cron 请求种子 | server_root_admission_seeds | tenant + rootRun；原始输入 seed、receipt | `src/storage/root-admission/server-seed.ts:37` |
| 子运行 | subagent_runs/events/outbox/usage_invocations | tenant + run；父 session + toolCall；独立 childSession | `src/storage/sqlite/migrations/019_subagent_runs.ts:4` |
| 子运行增量模型 | subagent_records/checkpoints/tools/tool_versions | run + seq；tool + revision | `src/core/subagent/durable-schema.ts:4` |
| 子运行幂等与投影 | subagent_execution_receipts、subagent_projection_receipts | tenant + run + requestKey/seq | `src/core/subagent/store.ts:72` |
| 协作消息 | collaboration_roots/participants/invocations/messages | rootRun + rootAttempt；participant、invocation、requestKey | `src/core/collaboration/schema.ts:12` |
| SQLite/JSONL 投递凭证 | collaboration_deliveries、collaboration_jsonl_deliveries、各自 epochs | history session/message + epoch + invocation | `src/core/collaboration/delivery-schema.ts:10`, `jsonl-delivery-schema.ts:11` |
| 可选发布恢复 | parent_publication_*、parent_turn_bootstrap_*、child_recovery_* | stream/generation/revision/event sequence/usage revision | `src/core/subagent/child-recovery-schema.ts:5` |
| 工作区选择 | workspace-bindings.json | tenant + NUL + session；root + epoch | `src/workspace/manager.ts:52`, `:76` |
| 语义记忆 | 独立 memory/memory.db | tenant + scope + session | `src/storage/memory/db.ts:19`, `memory-manager.ts:15` |
| 会话任务计划 | todos、task_plans、task_plan_items | tenant + session；todoId；revision | `src/storage/todo/index.ts:188` |
| 定时自动化 | cron_jobs、cron_runs、cron_notifications | tenant + job；schedule revision + occurrence；rootRun | `src/storage/cron/runs.ts:36` |
| 命令任务 | command_jobs、command_job_output | tenant + session + job；output seq | `src/core/command-jobs/manager.ts:94` |
| 文件变更 | file_changes + change-snapshots/*.bin | tenant + session + run/turn；path + hashes | `src/storage/changes/index.ts:89`, `:151` |
| 后台队列 | jobs + job_execution_claims | tenant + job + claimId | `src/storage/task-queue/sqlite-queue.ts:183` |

这些身份不能互换：session 是长期容器，turn 是对话轮次，rootRun 是执行，attempt 是某次可执行尝试。恢复审批时可以保留 run/turn，但生成新 attempt。

## 3. 主运行准入、幂等与重启

### 3.1 主运行保存什么

`RootRun` 保存状态、模型、工作区路径、created/updated/finished、pending ask/permission、压缩状态和消息锚点；私有 `StoredRun` 另存 request、attemptId。公共读取会剥离私有 request 与 attemptId，重新按白名单构造 requestConfig（`root-runs/index.ts:44-105`, `:154`）。

request 恢复配置采用白名单，递归滤除名称匹配 apiKey/secret/password/authorization/token/headers/env 的字段（`:75-85`）。这能减少连接凭据落盘，但不意味着任意用户正文、systemPrompt、metadata、inline definitions 都经过内容级脱敏；它们仍可能含敏感内容。

### 3.2 请求幂等并非仅靠消息 ID

现代用户准入保存数据库 namespace/generation、requestKey、规范化 bodyDigest、前驱 run/attempt/version。事务内同时校验前驱必须为终态、检查会话无 running/waiting root、创建 root 并写入 receipt + user seed（`root-admission/index.ts:138-183`；`root-runs/index.ts:253`）。

相同 key/body 可返回原 receipt；同 key 不同 body 拒绝；前驱改变拒绝。COMMIT ACK 异常后会精确查找已经提交的 receipt，而不是盲目再建一个运行。原始用户输入的 immutable seed 保留在 SQLite，使 JSONL 写入失败后仍可修复。

`projectTerminalAdmissionUsers` 只修复仍存在且已终结的 root，最多每批 8 条、通常 256 KiB；第一条允许更大以避免队头永久饥饿。它只补用户消息，不调用模型、不制造 assistant 输出（`root-admission/projection.ts:54-83`）。

### 3.3 重启恢复的真实动作

`initializeOwnedExecutionStartup()` 依次初始化 root recovery、子运行 recovery、mailbox recovery、pending 子结果投影；HTTP server 在接受请求前调用（`execution-owner.ts:336-351`，`api/http/server.ts:76`）。

- root `running` → `interrupted`，错误码 ENGINE_RESTARTED，说明 execution was not resumed。
- 正在进行的 compaction → failed，原历史保留。
- root `waiting` 不被这段启动规则打断，pending 请求作为持久数据留下。
- 处理 pending 回答时验证 tenant/session/run/request/toolCall/toolName；相同答案幂等，不同重复答案拒绝；继续执行生成新 attemptId（`root-runs/index.ts:424-451`）。

上述规则见 `root-runs/index.ts:117-135`。它保证执行状态不假装仍然运行，不提供机器指令/模型流位置的精确续跑。

## 4. 子代理历史、增量、结果投影

子运行有独立 childSessionId，但其运行控制记录在共享 SQLite。`subagent_runs` 有 `(tenant,parent_session,parent_tool_call)` 唯一约束，可避免同一个父工具调用重复创建子任务（migration 019:4-18）。

新模型将稳定 record、轻量 header checkpoints、当前 tools 和 tool versions 分离，避免每个增量复制完整工具历史。events 用 `(tenant,run,seq)` 有序保存；旧的 snapshot/event 仍可兼容读取（`durable-schema.ts:4-15`，`store.ts:361-404`）。

子代理 observer 写入时机：

- partial output 最多约每 200 ms 写一次；崩溃时最近未写的部分可能丢失。
- 工具开始和结束分别写入工具增量，包含参数、状态、输出、时间。
- 模型物理请求 attempts 对 usage 做账，避免只按成功返回漏算失败重试。
- viewer 发送失败不会抹除已持久化事件，也不会因为读者掉线杀死有效工作。

证据：`runner.ts:213`, `:247-280`。

终态事件和 `subagent_outbox` 在同一事务产生（`store.ts:401-404`, `:549-556`）。随后投影到父历史：稳定 ID 为 `subagent-result:<runId>`；只有父消息/toolCall/turn 锚点仍有效才 append，返回 appended/duplicate/suppressed。写后才 ACK，失败保留 outbox，可重试补投影，避免父历史先删后被迟到子结果复活（`projection.ts:6-63`）。

启动 recovery 对 queued/running/cancelling 子运行写 `interrupted`、取消 active tools、usage.unknown=true；错误信息明确“状态未知，未自动重跑”（`store.ts:864-878`）。这不是重新 dispatch queued 子任务。

## 5. mailbox、消费回执和权限边界

协作存储保存消息正文、hash、字节数、sender/recipient、immutable acceptance 时间、requestKey。唯一约束包括 sender participant + invocation + requestKey，避免重试重复接受（`collaboration/schema.ts:35-49`）。

必须区分：消息被 accepted/queued、被消费并写入模型历史、被下一次模型调用实际使用、任务成功完成。这些不是同一事实。SQL 投递表与 JSONL 投递表记录历史 epoch、锚点和投递状态，公共 receipt 通过投影解释状态；不能仅看 messages.state 判定已送达。

JSONL 消费是跨 SQLite 与文件的两步持久化：先保存 pending append 计划（file identity/offset/bytes/hash/encoded_row），再同步写文件，再确认集成；由精确计划处理不确定 ACK（`jsonl-delivery.ts:31`, `:141-171`；schema:14-21）。历史变动前先提升 epoch，把旧投递 suppressed，避免旧执行权限继续对新历史生效（`jsonl-delivery-schema.ts:31-46`）。SQLite 版本在同一物理 write transaction 内执行 epoch 更新、投递 invalidation 与历史改动（`delivery-schema.ts:52-63`）。

执行权不来自公开 runId。`ExecutionOwner`、producer、consumer 等是 WeakMap 中的私有 capability；引用具体 DB 实例、attempt/generation。root 关闭先 fence，再 drain children，持久终态后撤销 producer（`execution-owner.ts:10-54`, `:245-267`）。这些进程内对象不会因为数据库存在同名行而复活。

启动把 collaboration root 的 open/draining 标为 interrupted；尚未完成投递的 queued 消息标 interrupted/reason=engine_restarted_before_consumer（`store.ts:343-349`）。已保存消息不能据此推断重启后仍会自动发给模型。

## 6. 可选发布恢复协议不是默认运行能力

仓库存在完整的 parent publication、bootstrap body、子视图版本和签名 recovery lease 机制。lease 冻结 revision/usage/event fence，以免分页混合不同时间点；默认 TTL 10 分钟，全局 5,000、单 parent 100，校验 token scope/digest/expiry，GC floor 不能越过有效 lease（`recovery-leases.ts:37-53`, `:349`）。

**可达性限制：** chatRoutes 的 newStreamPublication/liveChildRecovery/durableChildRecovery 必须分别显式 true，modernChildren 和 durableChildren 才成立（`api/http/routes/chat.ts:518-531`）。默认 buildServer 注册 chatRoutes 没传这些 options（`api/http/server.ts:115`）。因此不能把该模块存在等同于默认服务具备完整持久 SSE 快照恢复。即便打开，它恢复的是已发布证据/视图，不是自动重跑工具。

## 7. 工作区绑定与真实文件

### 7.1 三种位置需要分清

- 私有会话目录：`WORKSPACE_ROOT/tenant/session`，`getPath` 固定返回它（`manager.ts:182-185`）。
- scratch directory：允许 ctx.scratchDir 覆盖私有目录（`:188-190`）。
- working directory：优先从 binding 文件解析，可能是外部真实项目；未绑定时依鉴权和 context 决定（`:193-210`）。

硬删除会话调用 getPath，**不会递归删除绑定的外部项目**。反过来，删掉私有目录也不等于删掉工作产物：产物可能写在外部项目，child scratch 也可能是其他 session 目录。

### 7.2 binding 如何持久化

位置优先级：AETHER_WORKSPACE_BINDINGS_FILE；若设置 DATA_DIR，则在该数据库文件同目录 workspace-bindings.json；否则在 workspace root 下 .aether-workspace-bindings.json。注意 DATA_DIR 在本项目语义是 DB 文件路径（`:52-59`）。

文件 v1 包含 tenant/session/workspaceRoot/epoch；读取拒绝符号链接、非法条目、重复 session、相对路径和非法 epoch；无法访问原选择时明确报错，避免静默跳回另一个目录（`:62-94`）。写入为 0600 独占临时文件、fsync 文件、rename 替换（`:97-121`）。没有发现这里对父目录 fsync 的调用，因此断电级目录项持久性不能仅凭文件 fsync 声称完整保证。

绑定变更用全局状态写锁及 session lease；读 guard 比较 root+epoch，写操作 dispatch 前再次校验（`:219-269`, `:356-410`）。鉴权时做 allowedRoots、realpath、跨租户项目重叠检测（`:125-154`）。

### 7.3 Git 的 lease 和恢复证据

Git lease 使用 resource + generation + PID birth identity + Windows job/supervisor 的可核验证据。不能仅因 PID 消失或时间过去就删除锁；只有精确 native closure、零活跃成员和 generation 匹配，才能归档 recovered lease（`repository-lease.ts:26-69`, `:156-173`）。session binding lease 的自动恢复还要求 repository receipt 与该 session 锁匹配（`binding-git-recovery.ts:19-79`）。

锁释放证明写者结束，**不证明 Git/文件副作用回滚**。代码明确区分 not_started 与 may_have_effects（`repository-lease.ts:16-19`）。无法证明关闭时 quarantine，优先保留证据和拒绝新写。

### 7.4 整体快照缺口

`WorkspaceManager.snapshot()` 与 `restore()` 都是直接 throw 的 P1 占位（`manager.ts:504-510`）。因此聊天历史、文件变更记录、Git 历史和完整会话工作区快照是不同能力，不应混为一谈。

## 8. 长期记忆与聊天历史是独立产品语义

memory.db 位于 `dirname(DATA_DIR)/memory/memory.db`，使用独立 LocalSqliteProcessClient（`memory/db.ts:19-38`）。节点含 type、summary/detail、source session、source context snapshot、strength/importance/decay、embedding/embedding_json/space，另存 edges/tags（`memory/schema.ts:32-147`）。

所有节点/图访问以 tenant + scope 过滤；session scope 再强制 sessionId。global scope 的含义是租户共享，不是所有租户共享；边的两端必须同 tenant/scope（`memory-manager.ts:9-18`, `:215-217`）。

当前默认是 globalEnabled=false、sessionDefaultEnabled=true。两个开关独立，可以同时启用；服务端 ENABLE_LONG_TERM_MEMORY=false 能使 effectiveScopes 为空。legacy “global” 选择不会自动开启新全局开关（`settings.ts:41-48`, `:74-101`）。关闭记忆开关是停止读写/召回能力，不能当成删除既存 memory 数据。

抽取由模型从 user/assistant 文本生成记忆，按完整 content 去重并保留高 importance，写入 sourceSessionId；召回结合 embedding、关键字、图邻居，最终是有预算的模型输入投影（`middleware/memory/extractor.ts:94`, `:142-262`, `:342-453`）。记忆并非原始逐字聊天备份。

“遗忘守护”当前做强度 decay 并列出低强度候选，**没有真正删除这些弱记忆**（`consolidation.ts:35-49`）。main 默认只为 tenant='default'/global 开一个 daemon（`main.ts:69-70`），不能声称所有租户/session 都自动整理。

## 9. 任务计划、Cron、后台任务、命令和文件变更

| 域 | 保证与行为 | 限制 |
|---|---|---|
| Todo/计划 | getPlan 用读事务；updatePlan 在一个写事务中校验身份、替换仅本 session 的计划条目、更新 revision（todo/index.ts:188-248） | 会话删除未联动删计划；不是模型执行进度的自动续跑点 |
| Cron | occurrence claim 带 job revision/schedule revision 和 immutable snapshot；同事务绑定 root；root 终态同事务投影 Cron 状态（cron/runs.ts:88-140, :167-185） | 重启前尚未 admission 的 occurrence 被 interrupted，明确不 replay（scheduler/cron-dispatch.ts:106）；历史任务定义可以继续触发未来 occurrence |
| SQLiteTaskQueue | pending→running + claimId 同事务，只有胜者执行；完成必须匹配 claimId（sqlite-queue.ts:183-224） | 构造不会把 running 改 pending；重启后旧 running 任务没有自动补偿/抢占，外部效果需要另行核验（:44-46） |
| command_jobs | stdout/stderr 分 seq 持久化，output 与 snapshot cursor 同 batch，version 防迟到覆盖（manager.ts:94-102, :153-196） | 重启标 interrupted，不 reattach/rerun，先前命令进程状态未知；命令前内存文件快照丢失时 changeTracking unavailable（:112-123） |
| 命令保留策略 | 终态默认全局最多 500、每 session 100、7 天，清理 output 与 job；活跃任务保留（manager.ts:131-150） | 这是命令历史保留，不是整个聊天、outbox、记忆的统一 TTL |
| file_changes | 小文本最多 100,000 bytes 保存原文；大/二进制保存完整 .bin；hash 对全量 bytes；记录 tenant/session/run/turn/path（change-recorder.ts:8, :37-64；changes/index.ts:151-199） | 文件、snapshot 与 SQL 不在一个数据库事务；snapshot 临时文件 rename 此处未 fsync；只备份 DB 无法还原大文件 |

文件变更 revert 有 current hash、后续修改、多 session 变化等保护；它是有条件的文件版本回退，不是任意时间点工作区 restore（`changes/index.ts:350-484`）。

## 10. 硬删除与清空的范围矩阵

入口使用 mutation fence，先 invalidate/abort root，再停止并 join owned execution、子运行、command jobs，之后重新读取目标并删除。这部分避免活跃线程在删除后继续回写（`conversation.ts:112-135`）。但这条链路不是跨所有文件/数据库的单个 ACID 事务。

| 数据 | 清空历史 | 硬删 session | 依据/解释 |
|---|---|---|---|
| 父历史 | 清理 | 清理 | conversation.ts:241-245 / :261-265 |
| 子历史、主子运行主要记录 | 清理 | 清理 | conversation.ts:94-103；subagent/store.ts:798-829 |
| sessions 的 Agent 绑定 | 保留 | clearBinding | conversation.ts:247, :266 |
| 私有 root/tenant/session | 保留 | 默认删除，可 keepWorkspace=true | conversation.ts:269-277 |
| 外部绑定项目真实文件 | 保留 | 保留 | 删除调用 getPath，不是 getWorkingDirectory |
| workspace-bindings.json 的选择 | 未清理 | 未清理 | manager 无 unbind，删除链路没有 binding 文件修改 |
| user/server admission seed + receipts | 未清理 | 未清理 | root-runs.deleteTurns:457-462 仅删 root_runs；schema 无 root 外键级联 |
| collaboration 消息正文/投递记录 | 未统一清理，历史 epoch 会失效 | 未统一清理 | invalidate 以 suppressed/epoch 表达，不物理删消息 |
| subagent execution/projection receipts | 不在 deleteRuns 表列表内 | 不在列表内 | store.ts:801、:819 |
| memory.db 节点/边/session 设置 | 未联动 | 未联动 | conversation 删除链路无 memory DB 调用 |
| todos/计划、file_changes/snapshots | 未联动 | 未联动 | 删除链路无对应 store 调用 |
| command_jobs/output | 停执行，不立即删记录 | 同左 | cancelScope，后续按独立 TTL 清理 |
| Cron 定义/运行/通知 | 未联动 | 未联动 | 可能仍保存已删除 sessionId 为未来目标 |

**已证实的生命周期缺口：** 原始用户消息在 admission seeds 有副本，即使用户从聊天界面删除了消息，不能据此声明内容从持久介质消失。session ID 复用还可能重新命中保留的 workspace binding、session 记忆或任务计划。后者是由键设计及删除范围推导的风险，未在真实用户数据上做复现。

删除私有目录的异常只记录日志，最终 API 仍可能返回 success（conversation.ts:273-281）；因此返回成功也不是文件清理完成的强证明。

## 11. 多实例与灾难恢复限制

已验证局部跨连接准入唯一性不应升级解读为完整多实例支持：

1. root startup 查询所有 running；subagent startup 查询所有 queued/running/cancelling；mailbox startup 更新所有 open/draining，没有对应实例 owner/heartbeat 生存判定。第二个实例启动可能把第一个还在执行的任务标 interrupted。
2. ExecutionOwners、subagent pool、AbortController/Promise、history serialization 等是进程内协调物。数据库事务不能替它们提供跨进程取消和 drain。
3. workspace 文件锁有更强的物理锁/进程证据，但它只保护指定文件或仓库资源，不代表根执行、JSONL 日志、memory 和整个生命周期都有统一租约。
4. 恢复/备份若移动绝对 workspace binding、文件变更 path，目标机路径与 allowedRoots 也必须处理；恢复 DB 本身不会重定位项目。

这些是源码结构推断，未执行两个生产服务竞争同一真实数据目录的破坏性实验。

## 12. 备份、排障与改进优先级

完整备份清单：主 DB 的一致性快照及 schema；history 根目录；memory/memory.db；workspace-bindings.json；change-snapshots；private workspaces；external bound projects；若保留运行恢复证据，关联 lease/native close/recovery archives 需保留并核验。不要直接把旧锁当成可执行权限。

建议为每个 session 提供数据归属清单和 dry-run purge：列出所有表、文件、外部项目引用、保留原因、受保留策略约束的回执，并输出“逻辑删除/物理删除/仅停止/保留”结果。需要 immutable receipt 时，可将正文从永久凭证拆出并建立可删正文引用或明确 retention。

建议优先级：

1. 统一 session 删除/重命名的生命周期事务与补偿日志，补 workspace unbind、记忆/计划/Cron/seed 清理政策；对失败返回可核验结果。
2. 明确单实例数据目录契约；若要多实例，先加实例租约和 fenced recovery，禁止启动即全表认领失联状态。
3. 定义完整 backup/restore manifest 与一致性时点，完成 WorkspaceManager snapshot/restore 或明确产品能力边界。
4. 给 outbox/receipts/events/seeds/history archives 增加可观察的体积、最老 pending age、保留时长和 GC 证据；不要仅靠命令 TTL。
5. 对 recovery feature flags 给出默认、部署开启方式、端到端可达性测试；区分“源码协议具备”和“生产路径开启”。

## 13. 本次测试证据

运行命令：`npx vitest run src/storage/root-runs/root-runs.test.ts src/storage/root-admission/__tests__/admission.test.ts src/workspace/__tests__/manager-persistence.test.ts src/storage/memory/__tests__/session-scope.test.ts src/core/collaboration/__tests__/durable-mailbox.test.ts src/core/subagent/__tests__/recovery-leases.test.ts --maxWorkers=1 --minWorkers=1`。

结果：6 文件、109 tests，108 passed，1 failed，约 23 秒。

- root admission 25/25：跨两真实 SQLite connections 幂等、stale predecessor、COMMIT ACK 丢失、JSONL fsync/ACK 故障与重开修复。
- durable mailbox 32/32。
- recovery leases 16/16。
- root runs 14/14。
- memory session scope 5/5。
- workspace persistence 16/17；唯一失败为新进程测试缺构建产物 `D:/dev/owned-compiled/workspace/manager.js`。该测试用 `AETHER_GIT_TEST_COMPILED_ROOT` 或默认 `../owned-compiled` 指定产物（test:55），失败在 import 阶段，并未执行绑定恢复断言。不能将此失败解释成已复现的持久化 bug，也不能声称本次跨进程恢复验证通过。

所有选中测试使用临时目录/专用数据库。未运行真实模型、真实用户会话恢复或生产删除；测试通过证明对应断言，不证明未覆盖的完整灾难恢复、并行生产实例及全数据抹除。

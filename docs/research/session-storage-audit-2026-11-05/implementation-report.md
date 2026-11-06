# 会话存储优化实施与验收

2026-11-05。引擎 `D:/dev/ai-agent-engine` 与桌面 `D:/dev/aether-code` 的工作树增量改动；保留既有修改。下文记录首轮源码实施与隔离副本验证，当时未操作原库。用户随后授权的真实库维护已于 17:13 完成：主库 65.89 → 22.35 MiB，全表数据核验一致，详见 [真实库维护结果](live-maintenance-2026-11-05.md)。

## 1. 可量化的结果

通过 SQLite backup API，从真实数据库的只读连接取得一致性副本。所有迁移、回收和 VACUUM 都在独立临时目录执行；校验完成后删除该副本，仅保存不含正文的统计报告。

| 指标 | 副本迁移前 | 副本迁移后 |
|---|---:|---:|
| 主库物理大小（迁移后包含离线 VACUUM） | 87.29 MiB | 25.52 MiB |
| 物理缩减 | — | 61.77 MiB，约 70.8% |
| 终态维护记录 | 116 | 116 |
| 终态维护 payload 正文 | 56,380,297 bytes | 89,559 bytes |
| 迁移的审计事件 | 31,379 | 31,379 |
| 审计全部字段逐条汇总 SHA-256 | 同一摘要 | 同一摘要 |
| SQLite integrity_check | — | ok |

这不是对运行中原库的缩减承诺，也不是整个 state 目录缩减 70.8%。JSONL、图片、记忆库等不在上述主库数字中。仅进行逻辑迁移时，副本 `.db` 仍是 87.29 MiB，freelist 增至 13,838 页；离线 VACUUM 后才归还磁盘空间。

复核数据：[optimization-snapshot-result.json](D:/dev/ai-agent-engine/docs/research/session-storage-audit-2026-11-05/optimization-snapshot-result.json)。可重复验证脚本：[verify-optimization-snapshot.mts](D:/dev/ai-agent-engine/docs/research/session-storage-audit-2026-11-05/verify-optimization-snapshot.mts)。审计对比保留 target、details 原始 JSON 文本、reason、租户、会话、事件 ID、决策、规则和时间；本次没有用删除事件来获得缩减。

## 2. 已实施的存储变化

| 层 | 实施内容 | 保留的可靠性条件 |
|---|---|---|
| 维护事务 | committed / invalidated 大 payload 转为版本化终态 manifest，sidecar 记录原摘要、字节数及新摘要 | pending 完整原文保留；文件 sync/校验成功后，与 peer retirement 同事务完成；损坏记录不猜测、不丢弃 |
| microcompact | 新 update 保存 messageId + 原文摘要，原文来自原消息或最近显式编辑，不再复制 archiveContent | 兼容旧 archiveContent；重启、分页、搜索、编辑后再压缩均还原正确；来源摘要不符报错 |
| 大正文 | JSONL 正文中 ≥16 KiB 的字符串写入按租户隔离的内容寻址 gzip 文件；JSONL 保留私有引用 | 先写临时文件并 sync，再发布不可变文件，再写 JSONL；读时验证长度/SHA-256；正文不存在或损坏明确失败 |
| 安全审计 | 每次安全判断仍写事件，≥512 bytes 的证据正文共享存储并压缩；存量分批 backfill | 不删除策略复查，不合并不同事件；tenant 是正文主键的一部分；查询透明还原 |
| 审计保留 | 普通 allow 默认 30 天、重要事件默认 180 天后迁出在线库 | 先持久 gzip JSONL、校验，再事务保存归档凭据/删除在线行；归档不自动删除；0 可禁用对应期限 |
| 封存历史 | 已 clear 的 JSONL 备份支持流式 gzip、manifest、双摘要验证、显式删除源和原字节恢复 | 活动 `.jsonl` 不匹配；恢复不覆盖已有文件、不直接创建活动文件；冷档仍需对应 blobs |
| 正文回收 | 默认只读扫描；显式离线模式才删除至少 7 天、没有引用的 blob | 扫描活动/备份/冷档及 SQLite pending/encoded_row；未知格式、损坏或变化的来源拒绝清理；外部冷档目录必须全部列入 |
| 普通追加 | 分隔失败遗留半行，sync 后更新缓存；已被 summary 隐藏的有效 ID 仍参与去重 | 避免“热缓存可见、重启丢失”和重复归档/计费；不移动先前物理字节 |
| 内存 | microcompact 的 outputPreview 上限 2,048 字符；blob 不保留额外解码缓存 | 原正文仍可从 archive/search 取得；既有会话缓存与物理快照预算继续生效 |

正文文件布局：`state/blobs/<sha256(tenantId)>/<hash前两位>/<sha256内容>.gz`。只外置正文，不外置消息 ID、会话 ID、toolCall ID 等控制字段。多模态图片、模型输入快照、reasoning、工具参数与 metadata 均在引擎读取时恢复。孤立 UTF-16 surrogate 和过深扩展字段保留 inline，避免序列化改变内容。

新 JSONL 的顶层 `storageBlobs` 和 update 的 `archiveReference` 是内部格式，不属于 HTTP、SSE 或 Message 类型。旧 JSONL 继续可读；**旧引擎不认识新 blob 格式，回退引擎时必须使用升级前的完整状态备份，不能只更换旧可执行文件**。复制/备份会话时应包含 sessions、blobs、数据库与冷档，不能只复制 `.jsonl`。

## 3. 前端是否需要修改

**容量诊断需要修改，消息展示协议无需增加 blob 接口。** 已同步修改桌面端：

- 主库 DB/WAL/SHM、活动 JSONL、备份、标记、正文 blobs、审计归档、历史冷档分别计数。
- 显示 SQLite 页分配、空闲页、Top12 表/索引、维护记录状态；不把表页和文件容量重复相加。
- 明确文件数不是会话数、memory.db 是磁盘长期记忆、freelist 不是已经归还操作系统的空间。
- 采样时间、缓存状态、部分统计原因与旧运行时降级可见；未知值不显示为 0。
- SQLite 明细使用独立只读子进程，2.5 秒/128 KiB 上限；不加载引擎、不执行迁移、不查询正文。

已逐项审计 history、archive、snapshot、SSE、search_history、工具结果、图片、子代理 transcript、published recovery 与附件消费者。引擎负责完整解引用，前端继续使用原 Message 结构。桌面没有安全审计日志 API 的查询/清空消费者，新增归档接口不要求改现有界面。

完整前端审计：[session-storage-frontend-compatibility-2026-11-05.md](D:/dev/aether-code/docs/session-storage-frontend-compatibility-2026-11-05.md)。部署时桌面打包的引擎运行时也必须包含本次新实现；仅更新监控 UI 不会改变存储行为。

## 4. 启动、停机和维护

引擎 schema 初始化包含 migration 031。main 完成配置与监听后启动审计维护和终态维护；停机先关闭服务器，再停止并等待维护，最后关闭数据库。没有在普通只读 API 或诊断调用中触发迁移。

- `HISTORY_MAINTENANCE_ENABLED=false` 关闭自动终态迁移；默认启动延迟 30 秒，空闲巡检 1 小时，积压时每秒处理一有界批次。
- `AUDIT_MAINTENANCE_ENABLED=false` 关闭自动审计迁移/归档。`AUDIT_RETENTION_ALLOW_DAYS=30`、`AUDIT_RETENTION_IMPORTANT_DAYS=180`；期限 0 代表该档不迁出。
- 每批同时限制条数与字节预算；单条超大历史记录可独立前进，避免永久积压。损坏终态记录保留并报告。
- 不在后台执行 VACUUM。需要物理收缩时使用明确的离线维护步骤；不要删除活动 WAL/SHM 文件。

操作说明及参数：[session-storage-maintenance.md](D:/dev/ai-agent-engine/docs/operations/session-storage-maintenance.md)。运维命令默认只读；真实原库的离线维护尚未执行。

## 5. 尚未启用的架构变化与实际边界

- **活动 JSONL 没有原地重写、分段或整体压缩。** 原有协作回执认证 fileIdentity/offset/bytes/hash；直接重写会破坏恢复依据。本次对新写入去重与外置，对已 clear 的封存备份提供冷档。旧活动文件中既有 archiveContent/图片重复不会因更新源码立即消失。
- 不把 pending、run 状态、审批、outbox、幂等键、lease/pin 或已发布恢复状态移入易失内存。`memory.db` 继续是磁盘持久库。
- 不改子代理运行协议和默认 durable-publication 功能开关，不按猜测删除 checkpoint。实测所有 subagent 表约 0.98 MiB，优先解决的是维护 payload 与审计证据。
- 新 blob 降低磁盘重复，但请求完整历史/图片时仍需解码完整正文。当前同步解引用服务于既有同步物理扫描；这不是无限大小消息或零峰值内存的承诺。
- 正文只在实际读取时校验。JSONL 未变且缓存已热时可以继续返回先前完整且校验过的内容；冷读/归档/搜索触及损坏 blob 才会报错。没有把每次缓存命中变成全目录完整性扫描。
- 后台终态/audit 生命周期由 main 启动；只调用 buildServer 的嵌入式宿主需自行接入对应 start/stop。
- 本次测试修改的是源码和隔离构建产物，没有强制重启真实应用或替换用户运行时。

## 6. 验证记录

引擎覆盖：真实临时 SQLite 事务、预约/提交 ACK 丢失、部分写、sync 失败、跨进程恢复、epoch 撤销、pending 不变、分批迁移、审计 tenant 隔离/归档失败、blob 哈希/长度/路径/租户/UTF-16、图片与编辑后压缩、分页/搜索、封存恢复及离线工具。

主库一致性副本中 116 条终态记录全部完成瘦身，0 条损坏跳过；31,379 条审计证据摘要完全一致，integrity_check=ok。未运行原库 VACUUM。

前端 typecheck 通过；完整 main/preload/renderer 隔离构建通过；55 个定向契约用例覆盖通过；真实 Electron IPC/UI 2/2 通过，单 worker，明暗主题已目视确认，测试实例正常关闭。常规构建曾因用户正在使用的旧 `out/renderer/assets` 无法清理而 EPERM，使用新隔离产物完成构建及 E2E，没有结束用户应用。

最终引擎 `npm run typecheck` 与 `npm run build` 通过。29 个相关测试文件共 **332/332 项通过**，包括全部 conversation 测试、production compaction、maintenance/CLI/lifecycle、audit、公开 HTTP blob 接口和启动迁移；机器结果见 [implementation-tests.json](D:/dev/ai-agent-engine/docs/research/session-storage-audit-2026-11-05/implementation-tests.json)。

构建期间同一工作区另有模型接口改动，第一次因构建输入变化被 manifest 校验拒绝，第二次遇到对方尚未写完的类型/迁移文件；保留该工作，没有改动其实现。待其文件落齐后完整构建通过。一次 129 个工具结果故障恢复测试涉及 258 次持久追加，明确设置 15 秒超时；旧物理篡改测试改为显式 inline 旧格式 fixture，继续验证真实字节变化，而不是篡改已被外置的不存在正文。原有 SQLite mock 补齐当前 adapter 的 getDbEpoch、字符串 SQL 和 close 契约，没有跳过断言。

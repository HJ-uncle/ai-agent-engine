# 会话存储维护与封存 JSONL 冷归档

维护记录只在终态瘦身；`pending` 保存精确恢复正文。已经 `clear()` 封存的 JSONL 可以流式 gzip 冷归档。活动 `.jsonl` 从不被这些工具重写，所有示例默认需要操作者显式指定数据路径。

## 维护记录的事务与哈希契约

`collaboration_history_maintenance.payload_json` 在 pending 状态仍含完整 JSONL append plan，包括 encoded、offset、bytes、hash 和 prefixHash。JSONL 写入并 fsync、物理范围验证成功之后，调用方在原 peer suppression 事务中调用 `finalizeHistoryMaintenance(tx, id)`。

终态写入版本 1 manifest：

- `format = aether-history-maintenance-terminal`、`schemaVersion = 1`、state、kind。
- `originalPayloadHash` 校验预约时完整 JSON 字节；`originalPayloadBytes` 记录该 UTF-8 字节数。
- `plan` 只保留 fileIdentity、offset、bytes、hash、prefixHash、lineCount，不保留 encoded。
- retired、retained、sourceRows、retiredRowIds 数组仅保留 count 和数组 JSON 的 SHA-256。
- 原表 `payload_hash` 始终校验当前 `payload_json`；瘦身之后它校验 manifest，不再表示原正文。

新增 `collaboration_history_maintenance_compactions` sidecar 与 manifest 在同一个 SQL 事务中写入，保留原正文哈希/字节数、manifest 哈希/字节数及时间。原表列数不变，兼容旧的 14 列 INSERT。提交确认丢失后可以幂等重试，不需要重新读取已剪除正文。

epoch 撤销时 pending 转为 invalidated 并瘦身，与 epoch/peer 状态同事务提交。损坏正文不会阻止撤销：该条只改为 invalidated，原字节保留供诊断，后续迁移计入 `skippedCorrupt`。所有普通 SQL 错误均回滚事务。

## 自动维护

`startHistoryMaintenance(db, options)` 应在 DB 初始化后启动，并在关闭 DB 前 `await job.stop()`。不应在同一实例上重复启动。停止时取消后续调度、等待当前工作；取消只在已提交批次之间生效。

| 环境变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `HISTORY_MAINTENANCE_ENABLED` | 启用 | `false` 禁用后台迁移 |
| `HISTORY_MAINTENANCE_STARTUP_DELAY_MS` | 30000 | 启动延迟 |
| `HISTORY_MAINTENANCE_INTERVAL_MS` | 3600000 | 一轮扫描结束后的间隔 |
| `HISTORY_MAINTENANCE_BACKLOG_DELAY_MS` | 1000 | 继续处理积压的间隔 |
| `HISTORY_MAINTENANCE_BATCH_SIZE` | 16 | 单事务最大候选数 |
| `HISTORY_MAINTENANCE_MAX_ROWS` | 128 | 每次唤醒最大候选数 |
| `HISTORY_MAINTENANCE_MAX_BYTES` | 8388608 | 每次唤醒的原正文读取预算 |

存量迁移仅选择 committed/invalidated 且无 sidecar 的记录。先查询 ID 和大小，再逐条读取正文，避免批量大字符串同时驻留。单条旧记录超过预算时允许独立处理，避免永远无法前进。每批提交释放 SQL 锁，以 maintenance_id 为 keyset 游标。每轮完成后下一周期从头扫描，因此跳过的损坏记录仍可重新诊断。

`getHistoryMaintenanceStorageStats(db)` 返回聚合数量和 UTF-8 字节数，不返回正文，也不初始化不存在的表。`reclaimedPayloadBytes` 表示逻辑净减少量（最低为 0），不表示 `.db` 文件已经缩小；少量原本很小的 payload 可能比版本化 manifest 更小。

## 运维命令

默认使用原生只读 SQLite 连接，只做统计：

运维 SQLite CLI 使用 `node:sqlite`，本次实际验证环境为 **Node 24.20.0**。其他提供该模块的 Node 版本须先在隔离副本验证；引擎自身的 SQLite 运行时不因这些独立脚本改变。

```powershell
npx tsx scripts/maintain-session-storage.ts --database D:/state/agent.db
```

显式执行一份有界预算；加 `--all` 持续分批处理本轮游标后的候选：

```powershell
npx tsx scripts/maintain-session-storage.ts --database D:/state/agent.db --apply --all
```

可加 `--max-rows 128 --batch-size 16 --max-payload-bytes 8388608`。输出包含 scanned、compacted、skippedCorrupt、原字节/终态字节、游标及 hasMore。损坏记录保留，不可把 hasMore=false 理解成不存在损坏行。

常规维护不会 VACUUM。物理收缩必须先关闭访问该库的**所有引擎实例**，留足临时副本空间，再显式执行：

```powershell
npx tsx scripts/maintain-session-storage.ts --database D:/state/agent.db --apply --all --vacuum --engine-stopped
```

`--engine-stopped` 是操作者对停机状态的声明，不是进程发现机制。工具会请求 SQLite exclusive maintenance lock，checkpoint 成功后才 VACUUM；无法独占时失败。禁止对仍使用该库的在线引擎运行此选项。

## 封存 JSONL 冷归档

工具只匹配当前 `clear()` 生成的 `session.jsonl.<timestamp>.bak` 和兼容的 `.jsonl.bak[.suffix]`，不会遍历目录链接。默认仅列举前 128 个封存文件和 hasMore，不创建冷档目录：

```powershell
npx tsx scripts/history-cold.ts --sessions-dir D:/state/sessions
```

默认冷目录为 sessions 的同级 `history-cold`，也可以显式传 `--cold-dir`。`--max-files` 控制本次最多处理的文件数；保留源的模式下再次运行可能重复遇到前一批，此时按需要提高上限。

```powershell
# 写冷档；默认保留封存源
npx tsx scripts/history-cold.ts --sessions-dir D:/state/sessions --apply

# 确认持久化和完整校验后，显式移除已封存源
npx tsx scripts/history-cold.ts --sessions-dir D:/state/sessions --apply --remove-source
```

压缩和恢复均使用流，不把完整备份或 gzip 放入 RAM。每条清单包含源相对路径、原始字节数/SHA-256、压缩字节数/SHA-256、时间和版本。文件名用源路径哈希与内容哈希生成。gzip 和清单先写临时文件、flush，再用同卷 hard link 原子无覆盖发布。现有同内容档案会校验后复用，不覆盖损坏档案。

源移除还会重新读取源并比对 SHA-256、字节数、文件 identity/size/mtime/ctime。任一步失败都保留源。目标文件系统必须支持同卷 hard link；不支持时安全失败。Windows 不提供可移植目录 fsync，工具仍对 gzip/manifest 使用可写句柄 FlushFileBuffers；其他平台还同步目录。断电可能留下未发布的临时文件或没有清单的孤立 gzip，源在发布与验证前不会删除。

校验/恢复：

```powershell
npx tsx scripts/history-cold.ts --cold-dir D:/state/history-cold --verify D:/state/history-cold/<hash>/<hash>.jsonl.gz.manifest.json
npx tsx scripts/history-cold.ts --cold-dir D:/state/history-cold --restore D:/state/history-cold/<hash>/<hash>.jsonl.gz.manifest.json --destination D:/restore/session.jsonl.bak
# 确认目标路径后加 --apply 写出；默认上条只读清单并显示恢复计划
```

恢复验证 gzip 两层哈希与精确长度后才发布文件，不覆盖现有目标，也不允许目标为活动 `.jsonl`。清单只证明该封存文件的原始物理字节，并不代表完整会话备份：如果 JSONL 引用外部 tool-result blobs，迁移/恢复必须同时保留相关 blob 存储。此工具不删除 blob、SQLite 收据、工具附件或其他会话资料。

## 内容 blob 离线 GC

只有未被任何被扫描来源引用、且 mtime 至少超过 7 天的 `blobs/<tenantHash>/<hash前2>/<hash>.gz` 才可作为孤儿候选。默认只读统计，不删除文件：

```powershell
npx tsx scripts/history-blob-gc.ts --database D:/state/agent.db
```

关闭所有引擎及其他历史/归档写入进程后，显式执行：

```powershell
npx tsx scripts/history-blob-gc.ts --database D:/state/agent.db --apply --engine-stopped
```

apply 在整个扫描/删除期间持有 SQLite exclusive 事务。停机声明依旧是操作者责任，它不能发现所有外部文件写入进程。`--minimum-age-days` 可以延长保留期，不能少于 7 天。此工具没有后台自动删除模式。

标记范围包括：

- sessions 下全部活动 `.jsonl`、封存 `.bak`、已知迁移 `.jsonl.tmp`，不按 UI 可见性或 tombstone 丢弃旧行引用。
- 默认 history-cold 下所有 gzip 的**解压原始内容**，同时校验配套 manifest 的原始和压缩 SHA-256。
- SQLite 的全部 maintenance recovery plan（包括所有 pending；对仍有旧正文的终态也保守标记），先验证 payload/plan 哈希。
- 所有 `collaboration_*` 表的 `encoded_row`，不限状态，并在字段存在时验证 row_hash/row_bytes。

所有 `storageBlobs` v1 引用验证 tenant 哈希、codec、hash、bytes、字段 path 白名单、数组边界与 null 占位符。工具还流式校验所有 `.gz` 内容与文件名哈希，检查所有引用均有对应 blob。年轻孤儿不会删除，`.tmp` blob 文件也不会由本工具删除。

任何损坏、未知格式/文件、目录链接、越界引用、读取失败、缺失引用、无 manifest 的冷 gzip、扫描期间源变化都会在删除前拒绝整轮 sweep，退出码为 2。JSONL 单行默认最多 32 MiB，超限同样拒绝；可通过 `--max-line-bytes` 显式调高，最高 256 MiB。报告不输出正文。

**冷档引用会阻止 blob 被清理。** 如果使用了外部冷档目录，必须逐个提供 `--cold-dir D:/other/history-cold`；默认本地目录仍会扫描，额外目录不存在会拒绝。工具无法发现未登记到调用参数中的外部副本；外部 JSONL 导出若仍依赖此 blob 存储，应保留在被扫描的 sessions 封存集合中，或连同对应 blob 一起做独立备份。不能只复制 gzip/manifest 后删除其仍依赖的 blob。

所有读取与源稳定性校验都在首次 unlink 前完成。文件删除本身不是跨文件事务；若操作系统在删除过程中返回错误，报告会保留已删除的数量/字节，剩余候选留待下一次显式离线检查。

## 验证

新增测试覆盖 pending 字节保持、终态事务原子性、commit ACK 丢失后重启、sidecar 写失败回滚、epoch 撤销、损坏记录保留、分页预算/超大单行、批次间失败、后台 stop 等待、默认只读 CLI、显式离线 VACUUM，以及冷档流式读取、精确恢复、源被修改、清单发布失败、压缩内容损坏、路径越界和禁止覆盖。

生产 compaction 回归另外覆盖 reservation/final ACK 丢失、部分 JSONL 写入、sync ACK 丢失、独立进程重启和 prefix 被篡改。所有验证均使用临时 fixture，不操作真实库。

本实现阶段的专项验证：maintenance storage 13 项、生命周期 3 项、运维 CLI 3 项、冷档 7 项、blob GC 11 项均通过；生产 compaction 24 项通过；TypeScript `tsc --noEmit` 通过。项目级整合结果以本次主任务最终构建/回归报告为准。

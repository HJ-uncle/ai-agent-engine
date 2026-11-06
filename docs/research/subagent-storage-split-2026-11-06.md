# Subagent 存储拆分与 SQLite 占用核查

日期：2026-11-06。本文对应本轮对 `subagent` 大字段外置的实现与只读核查。

## 结论

SQLite 在当前引擎中是**本地磁盘数据库**，不是内存数据库。它保存的是运行恢复所需的权威状态：run 身份、状态、顺序号、权限快照、用量、幂等回执和查询索引。SQLite 连接会使用页缓存；当前源码默认连接级缓存约 20,000 KiB、mmap 地址空间上限 256 MiB，但 mmap 上限不等于实际占用同等物理内存。

子代理的大型参数、工具输出、详情和重复正文不适合长期内嵌在 SQLite JSON 字段。本轮已增加数据库旁的内容寻址 gzip sidecar：

```text
<实际 SQLite 文件路径>.subagent-payloads/<租户哈希>/<哈希前缀>/<内容哈希>.gz
```

SQLite 只保存引用、状态和索引；sidecar 保存大型正文。内存中只保留当前请求、有限页和压缩流缓冲，不缓存完整正文。写入顺序是“临时文件写入并同步 → 不可变发布并校验 → SQLite 事务提交引用”。SQLite 回滚产生的孤儿文件由后续离线 GC 处理，本轮不提供在线删除，避免误删仍被引用的正文。

## 截图数据的含义

截图中的数据库分配约 98 MiB，其中：

- `subagent_events` 约 36.7 MiB；
- `subagent_checkpoints` 约 23.7 MiB；
- `subagent_tool_versions` 约 15.9 MiB；
- `subagent_tools` 约 7.34 MiB；
- `subagent_outbox` 约 1.75 MiB。

这不是“98 MiB 已全部加载到内存”的证据。它表示 SQLite 文件页分配；内存消耗还取决于缓存、当前查询、JSON 解码、模型输入和并发执行。

同一台机器上当前 Aether 开发窗口的实际路径已经通过 Electron profile、引擎子进程端口和 `DATA_DIR` 注入链确认：

```text
C:\Users\wb.xielin02\AppData\Roaming\aether-code\engine\state\agent.db
```

该文件主库约 91.5 MiB，subagent 表和索引约 1.03 MiB，包含 2 个 run、61 个 event；最大的对象是 `collaboration_history_maintenance` 和 `security_audit_log`。它是当前 Aether 窗口使用的数据库，截图中的更大数字来自另一份历史 QA profile。

对该路径先执行只读统计，再在引擎子进程优雅退出后执行了带备份的全量迁移。68 个现代字段被外置到 37 个 gzip CAS 文件，逻辑内联 JSON 从约 0.68 MiB 降至约 0.27 MiB；`subagent_records`、状态列和索引未改动。SQLite 文件未 VACUUM，避免破坏当前 Windows 硬链接 profile 的路径一致性。当前路径由桌面主进程传入的 `snapshot.dataDir` 定位，不能凭环境变量猜数据库路径。

扫描还定位到截图数字完全匹配的历史 QA 数据库：

```text
D:\dev\aether-code\.ae\qa\all-mode-stress\six-20261013T040524055Z-zJKUUi\agent.db
```

它有 3,128 个 v1 事件、约 323.3 MiB 事件 JSON。v1 事件必须保持原始字节，以支持 SQLite 的 `json_each(snapshot.toolCalls)`、精确历史归档和旧协议读取；迁移工具因此只创建了安全备份并报告 `skippedLegacy`，没有改写这份历史 QA 数据，避免把旧数据变成无法恢复的占位符。

## 为什么不能把全部 subagent 放进内存数据库

内存数据库会失去电脑重启后的历史、恢复依据、父子归属、消息回执和成果索引。它也不能解决模型上下文增长；运行中的 ReAct 历史仍需压缩，文件产物仍需落盘。

合理分层是：

| 数据 | 位置 |
|---|---|
| run/child 身份、状态、水位、权限、用量、回执、索引 | SQLite 磁盘 |
| 大型工具参数、输出、详情、重复正文 | `.subagent-payloads` 内容寻址文件 |
| 普通会话正文 | 现有 JSONL/SQLite 历史后端 |
| 压缩摘要、计划、短预览 | SQLite 或普通历史中的小字段 |
| 取消句柄、进程、SSE、并发队列、热对象 | 内存，重启后重建 |
| 图片、视频、Office 成果 | 独立文件/资产目录，数据库只保存引用 |

不要把 SQLite 主库文件、WAL、SHM、JSONL 和 sidecar 的文件大小混成“运行内存”。也不要为了减少内存而把唯一恢复数据改成纯内存。

## 已实现内容

- `src/core/subagent/payload-files.ts`：实际数据库旁目录、租户隔离、SHA-256、gzip、原子 hard-link 发布、有界 range 读取、损坏检测、`:memory:` 测试隔离。
- `src/core/subagent/payload-codec.ts`：state、summary、event、detail 的字段级引用；大详情按约 256 KiB UTF-8 块读取，分页不会每次解压整个多 MiB 正文。
- `src/core/subagent/store.ts`：保留 SQLite 状态和索引；现代子代理读取时透明解引用，旧 v1/inline 记录继续可读。运行热路径默认只外置大于 16 KiB 的正文，避免每个短预览产生小文件；离线迁移可用更紧阈值回收历史重复正文。Delta 不重复保存已有 toolUpsert 能提供的 `latestActivity`，精确 checkpoint 仍保持历史读取能力。
- `src/core/subagent/payload-migration.ts` 与 `scripts/migrate-subagent-payloads.ts`：默认只读统计；实际迁移要求 `--database --apply --engine-stopped`，先生成包含 WAL 提交内容的 SQLite 备份和配套 sidecar/blob 目录，支持 table+rowid 续传、原值 CAS、单行事务和失败重试。不执行 VACUUM，不自动删除文件。
- Aether 存储诊断把 `<database>.subagent-payloads` 计入已有的“共享正文与附件（磁盘）”桶，不增加新的前端类型。

## 迁移方式

先关闭所有引擎实例，确认数据库路径，再只读检查：

```powershell
npx tsx scripts/migrate-subagent-payloads.ts --database "<实际路径>"
```

确认备份目录可用后，才执行：

```powershell
npx tsx scripts/migrate-subagent-payloads.ts --database "<实际路径>" --apply --engine-stopped --all
```

`--apply` 不会直接覆盖备份；备份目录已存在、源路径含符号链接、数据库不是普通文件或未声明引擎停止时会拒绝。迁移只降低后续 SQLite 写入量，不会自动让 SQLite 文件立即缩小；旧空页需另行离线维护，且必须在确认没有进程使用数据库后才考虑 VACUUM。

## 验证

- payload 文件：17/17 通过；内容哈希、租户隔离、缺失/损坏、range、同步失败和临时数据库清理均覆盖。
- codec：9/9 通过；多 MiB Unicode 详情分页只读相交块，保留 UTF-8 边界和 JSON 字节顺序。
- 离线迁移：10/10 通过；WAL 备份、sidecar 复制、CAS 冲突、失败保留旧值、取消续传和 v1 保留均覆盖。
- 存储集成：3/3 通过；数据库重开后详情、历史分页、终态投影和同 child 续跑仍可读取。
- 高负载耐久：13/13 通过；10,000 个工具变更通过水位恢复、历史分页、终态投影和内存驻留上限检查，耗时约 102 秒。
- TypeScript 全仓检查已通过；仓库其他任务可能存在未提交改动，未覆盖或回滚。

本轮已对当前 Aether 数据库执行迁移并保留一致性备份；没有删除原始数据或执行 VACUUM。历史 v1 QA 数据保持原样并保留迁移前备份，待设计好兼容 `json_each` 的归档压缩方案后再处理。

# 截图数据核对与手动采样调整

2026-11-05。用户确认截图来自本机当前 Aether 窗口。此次不对真实库执行删除、checkpoint 或 VACUUM。

## 截图的数字是否合理

截图中：page_count=16,868、freelist_count=11,179、page_size=4,096。

- 分配页大小：16,868 × 4,096 = **65.890625 MiB**，与主库显示 65.9 MiB 相符。
- 空闲页：11,179 × 4,096 = **43.667969 MiB**，与显示 43.7 MiB 相符。
- 非 freelist 页：5,689 页 = **22.222656 MiB**。它仍包含表、索引、页内未用空间和结构开销，不等于纯业务正文。
- 五个子代理业务表约 17.22 MiB，约占该样本非 freelist 页的 77.5%。此前另一份样本中子代理约 0.98 MiB 的结论，不能套用到本截图。
- WAL 8.22 MiB 是另一个磁盘文件，与主库空间分别计数。WAL checkpoint 与 VACUUM 是不同操作；checkpoint 不会自动收缩主库 freelist。

因此截图算术自洽。如果该样本是目标库的当前状态，离线 VACUUM 可显著减少空闲页，但新写入、WAL 和页内重排会影响最终大小，不能直接承诺精确减少 43.7 MiB。

## 采样来源差异与运行句柄验证

15:58:12 使用原生 SQLite 只读连接与文件枚举检查截图显示的同一路径，得到：

| 观察值 | 截图 15:55:43 | 工具只读 15:58:12 |
|---|---:|---:|
| state 总文件大小 | 约 220 MiB | 437.69 MiB |
| JSONL | 约 140 MiB / 13 文件 | 338.68 MiB / 158 文件 |
| 主库 | 65.9 MiB | 87.29 MiB |
| page_count | 16,868 | 22,346 |
| freelist_count | 11,179 | 444 |
| maintenance committed | 10 | 116 |
| subagent_events 表页 | 7.24 MiB | 0.309 MiB |

实际读取路径均为 `C:/Users/wb.xielin02/AppData/Roaming/aether-code/engine/state/agent.db`。独立 Node 与以 Node 模式启动的相同 Electron 可执行文件，两者文件大小读取结果均为 91,529,216 bytes。运行中引擎 `/health` 与 `/meta` 可用；未重启或替换该实例。

源码核对：host 向引擎注入的 dataDir 与 EngineSnapshot 一致；目录统计和 SQLite probe 都来自该 snapshot.dataDir；路径、文件分类、SQLite 明细作为同一个对象缓存，没有发现把新路径与另一份容量拼接的逻辑，也没有固定截图数字或 mock 诊断生产入口。此前 E2E 是独立 2.9 MiB / 7 文件的小型 fixture，与截图不符。

继续使用 Windows 只读句柄元数据定位运行中 SQLite worker（PID 64876），得到同名路径的主库 **69,091,328 bytes = 65.890625 MiB**、WAL **8,619,072 bytes = 8.219788 MiB**，与截图精确相符。仅使用 DuplicateHandle、GetFileType、GetFinalPathNameByHandle、GetFileSizeEx 和文件 ID 查询；没有读取/改变 SQLite 句柄的文件位置、没有执行清理。

运行句柄的 NTFS 文件标识为 `0x0002000000076167`，普通路径读取的 inode 为 `562949953582657`；二者不同。同一路径文字对应了不同文件对象，不能把普通工具读取的旧对象当作当前引擎数据。后续按 NTFS 文件 ID 反查已定位原因：Codex MSIX 的 AppData 文件虚拟化。普通工具实际读取的是 `AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming/aether-code/engine/state/agent.db`，引擎读取的才是实际 Roaming 文件。通过 Windows CIM 隐藏启动已安装 Node 的只读脚本，成功得到与活动 worker 完全一致的 `562949953904999` 文件 ID 与 69,091,328 字节；没有修改系统安全设置。

结论：**截图的主库/WAL大小已经与运行中引擎句柄核对一致，页数计算也自洽。** 具体表页及 freelist 值来自截图中的实际只读探针，本次没有借用其他文件对象的 SQL 读数冒充复核。后续原库维护应首先确保目标文件对象与当前引擎一致，不直接对同名但不同对象的文件执行 VACUUM。

证据：[live-engine-db-handles.json](D:/dev/ai-agent-engine/docs/research/session-storage-audit-2026-11-05/live-engine-db-handles.json)、[screenshot-followup-audit.json](D:/dev/ai-agent-engine/docs/research/session-storage-audit-2026-11-05/screenshot-followup-audit.json)。上一轮 87.29 → 25.52 MiB 的隔离副本实验仍证明该副本迁移的收益，但不代表本次 65.9 MiB 活动文件的测量结果。

## 采样策略

原资源 UI 每 5 秒请求一次诊断；进程树与存储分别用 15 秒/60 秒缓存。截图的 735 ms 是一次采集耗时，不等于消耗了 735 ms CPU；频繁启动进程探针仍有可避免的开销。

按用户要求修改 `D:/dev/aether-code`：进入监控页读取一次，之后只由顶部“刷新监控数据”触发。移除诊断轮询与倒计时，显式刷新请求新数据并去重并发请求。引擎连接 /health 的独立职责保留。CPU/I/O/ELU 缺少两次样本时显示“需再次刷新”，不伪造零速率。来源变化重新采集，离开页面后的迟到响应不更新另一份页面状态。

## 子代理新增减重

`runner` 向 `store` 传累计输出预览，内容先截断，最终以 8,192 UTF-8 bytes 有界保存。达到上限后不同回调可能变成完全相同的预览，原实现仍为它们新增 event、checkpoint 和 seq。

本次在 `appendHeader()` 的写事务内，仅对单独 `partialOutput` 字段、`output.updated` 且归一化内容完全相同的调用跳过重复写入；用量、工具、状态、终态和取消工具操作不跳过。实际不同内容照常形成新版本。两连接并发及重启后同样适用。

子代理超时使用独立 deadline 计时器，不依赖 updatedAt。updatedAt 继续表示该精确状态版本的最后有效变更时间，不伪造心跳、不修改旧 seq。没有删除既有 checkpoint、event、tool_versions 或已 ACK 的身份行。更激进的旧版本回收仍需尊重 published watermark、bootstrap、lease 与幂等回执。

## 本轮验证与生效边界

- 引擎：7 套相关回归共 94/94 通过，其中 8 项为新去重用例；typecheck 与完整 build 通过。旧 projection 测试 mock 补齐 getDbEpoch 导出，没有跳过断言。
- 前端：37/37 契约测试、4/4 真实 Electron 测试通过（单 worker、隔离数据与产物），完整构建包含 typecheck 通过，测试实例均已关闭。
- 新桌面产物位于 `D:/dev/aether-code/.e2e-tmp/manual-monitor-build-20261105`。源码已更新，但没有强制重启用户正在使用的窗口；完整行为需加载新构建。引擎的独立 /health 检测保留，不属于本次移除的资源/磁盘诊断轮询。
- 这轮未对当前活动数据库进行物理收缩；43.7 MiB 空闲页不会因修改采样频率自动归还磁盘。

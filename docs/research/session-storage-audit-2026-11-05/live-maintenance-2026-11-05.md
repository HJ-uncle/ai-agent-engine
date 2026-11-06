# 真实库维护结果

2026-11-05，Asia/Shanghai。17:13 完成最终收缩，17:14 复核活动 worker 文件句柄及引擎健康。此次维护未操作桌面窗口、未强杀或重启引擎，未删除会话、子代理记录、JSONL、审计或等待中的交互。

## 物理结果

目标是实际 Roaming 目录中的 `aether-code/engine/state/agent.db`，文件 ID 始终为 `562949953904999`（`0x2000000076167`）。

| 指标 | 收缩前 | 收缩后 |
|---|---:|---:|
| 主数据库实际文件大小 | 69,091,328 bytes / 65.89 MiB | 23,437,312 bytes / 22.35 MiB |
| 主库释放空间 | — | 45,654,016 bytes / 43.54 MiB |
| 最终维护后的空闲页 | — | 0 |
| 最终 checkpoint | — | busy=0，WAL=0 |

17:14 运行中主 SQLite worker 的原生句柄再次确认主库为 23,437,312 bytes。引擎正常写入后 WAL 已重新增长到 271,952 bytes；这属于运行日志，不应通过反复清理强制保持为零。最初 8.22 MiB WAL 已在第一轮 checkpoint 回收。

## 备份与数据核验

- 首轮一致性备份：`D:/backups/aether-code/storage-20261105-1700/agent.db`。
- 最终维护前最新一致性备份：`D:/backups/aether-code/storage-20261105-final/agent.db`，SHA-256 `54ea9ac6ce32e2363a0aec1834d74777d2d4b5fd1c90268b8186b2dec1ac59d2`。
- 使用 SQLite 在线 backup API 纳入已提交 WAL，未忽略 WAL、未复制活动主文件冒充一致快照。
- 每次实际 VACUUM 前，先在备份副本执行并核验。原库清理前后的 97 张表、6,603 行记录的数量及带类型内容摘要、schema 摘要一致；`subagent_runs` 和 maintenance 的 rowid 映射另行比较且一致。包括 1,262 条子代理事件、1,262 个检查点和 21 个 root run。
- 备份与原库 `PRAGMA integrity_check` 均为 `ok`。
- 一次 guard 因 root `waiting` 状态拒绝。核对源码后确认该状态是执行已挂起、等待交互；最终在线维护允许这一持久等待状态，但仍拒绝 running/queued 工作、子代理和命令任务。等待中的 root 和 pending 交互全文包含在全表摘要中，未变更。

## 两个环境问题

1. **MSIX 文件虚拟化**：Codex 普通路径读取实际映射到包的 LocalCache 副本（87.29 MiB）。按文件 ID 反查定位后，通过 Windows CIM 隐藏启动已安装 Node，验证能访问与 Aether 相同的真实文件对象。没有修改安全设置或文件权限。
2. **Windows mmap 阻止物理缩短**：第一轮在线 VACUUM 已将逻辑页减少且全表校验通过，但文件 EOF 仍为 65.89 MiB。引擎原连接配置了 256 MiB mmap；SQLite Windows 实现对映射文件截断失败可以保留尾部空间并返回成功。最终通过临时本地 Node 调试连接调用已加载的同一个数据库客户端，将 mmap 临时设为 0，再执行备份与核验流程。维护结束在 finally 中恢复 268,435,456 bytes mmap，并关闭临时 inspector；9229 端口已确认关闭。引擎及原 worker PID 均保持运行。

这是一次有备份、身份核对和完整校验的定向在线维护。现有运维 CLI 仍按默认离线要求使用，未伪报 `--engine-stopped`，未将 VACUUM 加入后台定时任务。

## 前端

顶部、运行时、存储标题和页底刷新入口均改为纯图标，保留 title、aria-label、加载 Spinner、禁用态及“不自动轮询”说明。完整 build/typecheck、18 项契约测试和 3 个真实 Electron 用例分批通过；最后资源页面使用最新产物复验通过。测试使用隔离目录与端口，未操作用户窗口。

监控按用户要求手动刷新，维护完成后不会自动改写旧采样数字；点击刷新图标即可读取最新容量。

证据：[最终维护结果](live-final-vacuum-result.json)、[映射恢复与调试关闭](live-mmap-maintenance-result.json)、[运行句柄复核](live-engine-after-vacuum-handles.json)、[首次在线维护](live-online-vacuum-result.json)。

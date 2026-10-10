# r4 长期会话归档缓存、MCP 与技能脚本验收

本轮修复了三个实际问题：JSONL 每次追加后重读整份归档；回退会话后旧截断标记永久隐藏新消息；技能脚本没有接收用户取消信号。MCP 另增加指定服务的显式请求超时，原默认值保持不变。生产源码于 2026-10-10 本轮专项完成后冻结，供父任务构建 r4；未覆盖或改写旧 r3 包、活动测试会话或 supervisor 证据。

## 真实归档测量

脚本：`.tmp/longrun-perf-20261010/jsonl-benchmark.ts`。直接加载生产 `JSONLConversationHistory`，真实创建 JSONL 文件，正文每条 1024 字节。摘要覆盖旧消息后只保留 20 条原消息及 1 条摘要；每个规格连续进行 5 次 append + getFullHistory。隔离进程统计实际 `fs.promises.readFile` 次数及字节，使用 `node --expose-gc --import tsx`。不调用模型、不 mock 存储。

原始证据分别保留：

- 修复前：`.tmp/longrun-perf-20261010/jsonl-benchmark-results.json`
- 缓存修复后：`.tmp/longrun-perf-20261010/jsonl-benchmark-results-after-r4.json`
- 最终 r4 源码：`.tmp/longrun-perf-20261010/jsonl-benchmark-results-final-r4.json`

每份记录包含时间、Node 版本、生产源文件 SHA-256、每次实际读文件字节、耗时与内存采样。fixture 逐文件删除，脚本与结果保留。

|归档原消息数|文件大小|修复前追加读取均值|最终修复后均值|修复前 5 次重读|最终修复后重读|
|---:|---:|---:|---:|---:|---:|
|1,000|1.34 MB|4.12 ms|0.78 ms|6.71 MB / 5 次|0|
|10,000|13.48 MB|27.49 ms|1.08 ms|67.41 MB / 5 次|0|
|50,000|67.70 MB|134.39 ms|2.19 ms|338.51 MB / 5 次|0|

5 个会话各 10,000 条归档、同租户一次并行追加读取波次：生产租户锁包装路径从约 142.24 ms 降为约 3.31 ms，整文件读取从 5 次 / 67.65 MB 降为 0。原始直接并行路径从约 125.94 ms 降为约 6.92 ms。样本少，数字不能用作吞吐上限或 SLA。

50,000 条规格操作结束后 RSS 从约 863.54 MB 降为约 294.99 MB；这是操作后的采样，不是峰值。最终冷读约 152.67 ms，仍须全文件解析。暖追加优化没有解决无限增长归档的冷加载峰值，后续应以 checkpoint/流式折叠继续治理；不能把这些数据称为 7×24 小时实跑已通过。

## JSONL 追加与缓存

原 `append()` 只写磁盘并更新 lastUuid/rawTokens，设 `mtimeMs=0`，没有更新 messages/byId/size；下一次读取因签名不匹配必然整文件重读。仅刷新 mtime 会让新消息不可见，因此不能这样修。

新实现先成功追加，再根据落盘 JSON 更新活动消息、byId、原始 token、parentUuid 链、nextSeq 及文件签名；写失败不会提前推进序号或让消息可见。消息载荷依据序列化后的真实内容还原，调用方之后修改输入对象不改变已保存的缓存。追加替换活动数组，旧读取快照不会被新消息改变。

缓存签名增加 ctime、设备与 inode，检测外部追加、文件替换、恢复 mtime 的同大小重写。异常尾部大小或身份变化使缓存失效，下次读取重建。实例之间共享同物理数据根目录、同会话的写队列，防止本进程多个 history 实例分配重复 dbSeq；完成后清理 queue entry。

只缓存活动投影及必要的删除规则；LRU 最多 64 个投影，估计字节预算约 64 MiB。预算计入序列化载荷和每条/索引的额外估值，不代表精确 V8 堆字节上限。淘汰缓存不删除会话、归档或用户数据，也不设置总会话数量上限。跨操作系统进程的任意并发重写不提供文件锁事务保证，部署仍须保持同一数据根目录的写入归属。

## 截断后继续开发

旧逻辑对全部墓碑取 `min(afterSeq)`，之后所有 `dbSeq > afterSeq` 的新消息也被删除，导致“回退 / 重新发送 / 重新生成”后消息消失。四条读取路径均有这一问题：活动模型视图、完整归档、分页归档及归档检索。

新规则只删除截断墓碑之前且 `dbSeq > afterSeq` 的旧行。多次截断不会复活已删旧分支，墓碑后的新任务继续可见。后续旧摘要若包含被回退内容，会随截断失效；若更早摘要仍有效则恢复它。截断进入已压缩历史时，恢复剩余原始消息，避免摘要继续带入被丢弃的未来事实。统一的 ordinal + suffix-minimum 索引使每行判定为 O(log 截断次数)，不依赖永久序号上限。

## MCP 配置与取消

`timeoutMs` 是可选服务字段，整数范围 0–2,147,483,647 ms。未填保留原传输/阶段默认；0 表示该服务单次操作无自动 deadline；正数表示指定毫秒。JSON 导入导出、服务 CRUD、全局/项目层、inline loader、连接测试及 Agent 工具调用均传递此字段；PUT/PATCH 的 null 删除覆盖并恢复默认。非法值在保存/导入/构造客户端时拒绝，防止 Node 大计时器溢出变成 1 ms。

|阶段|未配置默认|
|---|---:|
|JSON-RPC / stdio RPC / legacy SSE RPC / SSE endpoint|15,000 ms|
|HTTP initialize notification|5,000 ms|
|REST discovery|10,000 ms|
|REST tool call|30,000 ms|
|普通 guardedHttp 网络策略 deadline|30,000 ms|

原 guardedHttp 将请求超时与网络策略取最小值，0 会触发立即取消。新逻辑区分 0 与默认值；只有明确配置 MCP 服务时，才能为该请求替换时间上限。其他 HTTP 调用仍受网络策略约束。协议、域名、DNS、私网、重定向、响应字节等检查保持原行为；未修改全局 network policy。full-access 原来也带有该网络 deadline，本轮没有把它默认为不限。

调用取消信号仍贯通 HTTP/stdio/SSE。stdio 清理 pending、timer 和 abort listener；每个 Agent stdio 调用使用独立客户端，断开时回收该调用拥有的进程树。对远端 HTTP/SSE 服务，只能保证本地请求取消及连接释放，不能保证远端业务进程遵守取消。

连接测试路由监听客户端 HTTP 断开，把 signal 传至 toTools → listTools → connect，并在 finally disconnect。已用真实 HTTP 连接中途 destroy 验证无限初始化的父/子进程回收。

客户端同步由 `client_sync_audit` 完成：Aether 的 McpServer/McpDraft/mcpPayload/FormState、JSON 导入导出、主进程透传，及 console 的共享类型/两个编辑器均采用相同语义。Aether 管理连接测试的客户端 120 s 默认也作限定覆盖：0 只保留连接取消 signal、正数附加响应余量；其他管理请求维持原行为。真实 UI CRUD/JSON 和打包验证由父任务在 r4 包上执行，不能以纯契约测试代替它们。

## 技能脚本

`run_skill_script` 保留默认 60,000 ms，正式支持整数 timeoutMs=0。通过 spawn 创建仅该调用拥有的进程树，用户取消或 deadline 触发时复用已有 `stopCommandProcessTree`；POSIX 使用独立进程组，Windows 使用 PID 身份、创建时间及原始 ChildProcess 防护，拒绝把重用 PID 当成自有进程。

取消返回 cancelled / Cancelled，超时返回 failed / TimedOut，并保留发生前的实际输出。清理无法确证时返回 interrupted 并附 processCleanupError，不声称取消成功。

输出持续排空，原 exec 的 10 MiB maxBuffer 不再终止高输出脚本。模型结果保留约 10 MiB 有界尾部，outputTruncated 明确标记；完整 UTF-8 输出写入项目 `.ae/skill-runs/<uuid>.log`，metadata.outputArchivePath 供后续读取。日志写失败会显式报告 outputArchiveError，不假称完整证据已保存。磁盘空间/进程权限仍是实际运行条件；永久服务、跨重启 job 跟踪和输出分页应使用持久化 CommandJob 能力。

## 测试结果

第一次组合专项 4 文件 35/35：技能脚本新增 6、MCP 新增 5、既有 MCP e2e 13、安全边界 11。真实 stdio 工具延迟 15,500 ms：原默认失败，0 与 20,000 ms 均完成；不是 fake timer 或替代模型响应。

最终组合专项 5 文件 49/49：

- JSONL append/cache：11 项。
- JSONL 完整 archive：10 项。
- JSONL 冷分页 archive：12 项，包含 25,000 条归档真分页。
- 压缩后归档约束与重启：9 项。
- MCP deadline / CRUD / JSON / loader / abort / HTTP 断开：7 项。

技能执行 6 项验证真实 shell/Node 输出、0 不限、非法时限拒绝、已取消不启动、用户取消父/子回收、超时父/子回收、11 MiB 输出不中断且完整日志可读取。父进程 PID 仍存活，未终止无关测试任务。

最终 `npm run typecheck` 通过；相关文件 `git diff --check` 通过（仅 LF→CRLF 提示）。此前 settings/continuation 修复证据在 `2026-10-10-longrun-runtime-limits.md`。父任务负责冻结 r4 的全量测试、客户端真实回归、多模型会话和新六小时运行；本文不声明这些阶段已经完成。

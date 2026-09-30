# 会话历史消失只读审查（2026-09-30）

## 结论

当前正式前端请求会话列表和当前会话历史时均不带分页参数，因此本次现象不是默认分页截断：

- `SessionHistoryView.tsx` 请求 `GET /conversation/sessions`，没有 `current/pageSize`。
- `useChat.ts` 恢复请求 `GET /chat/snapshot?sessionId=...`。
- `/chat/snapshot` 调用 `getFullHistory()`；`/conversation/history` 也只有在同时收到 `current` 和 `pageSize` 时才调用 `paginateArray`。
- `paginateArray` 没有默认 page size；缺少任一参数时原样返回整个数组。

## 可复现的“前面轮次消失”链路

默认历史后端是 JSONL（`src/storage/conversation/factory.ts`）。自动压缩位于
`src/core/agent-loop/react.ts`：

1. 计算完整请求估算 token；
2. 当 raw token > `0.92 * min(tokenBudget, model.contextWindow)` 时调用 `history.compress`；
3. 传入 `keepRecentTokens = 20% * effectiveBudget`。

JSONL 历史文件本身采用 append-only，旧行仍然存在。但
`src/storage/conversation/jsonl-history.ts:loadSession` 读取最后一个 `summary` 行的
`leafSeq`，会跳过 `dbSeq <= leafSeq` 的旧消息，只返回摘要消息和其后的 recent 消息。
`src/renderer/src/core/engine/chat-history.ts:replayMessages` 对 `system` 摘要行不渲染，因此 UI 中旧轮次看起来完全消失。重启后仍然如此，因为每次读取都会应用同一 summary floor。

截图显示会话累计使用量约 679k tokens，足以触发该阈值，和这一链路相符。

这不是普通分页，也不是旧 JSONL 行被物理删除；它是“模型上下文压缩投影”直接复用于“用户可见聊天记录”的设计耦合。当前没有读取压缩前完整 transcript 的 API，UI 也没有“展开压缩历史”入口。

## 另一个容易混淆的来源

`src/renderer/src/core/engine/source.ts` 为嵌入引擎和每个远端 base URL 使用独立 storage key。
`SessionHistoryView` 在引擎源改变时先执行 `setSessions([])`，然后从新源重新拉取。
切换本地↔远端、不同远端或远端实例重启后，旧源会话不会显示在新源列表中，这是源隔离行为，不是删除。

正式内嵌引擎由 `src/main/engine/host.ts` 注入绝对
`app.getPath('userData')/engine/state/agent.db` 作为 `DATA_DIR`。只有开发中直接启动引擎且未传 `DATA_DIR` 时，才会按 cwd 使用相对 `./data/agent.db`，从而可能读到另一份 sessions 目录。

## 修复建议

1. 将“模型上下文视图”和“用户 transcript 视图”分开：
   - 保留当前压缩后的 `getHistory` 供模型使用；
   - 增加仅供回放的 archive/full-transcript 读取，遍历 JSONL 原始消息并在 tombstone/truncate 后保留被 summary 覆盖的历史；
   - 或在 summary 行记录可展开的 transcript 引用，前端显示“已压缩 N 轮，展开历史”。
2. `/chat/snapshot` 默认继续返回 compact context 以控制启动成本，同时增加显式 `includeArchivedHistory=1`（或单独 endpoint），禁止把大历史默认注入模型。
3. 在 UI 显示压缩提示，避免用户将摘要折叠误判为数据丢失。
4. 统一所有开发/测试启动入口传绝对 `DATA_DIR`，并在握手/诊断中返回实际数据目录（脱敏）或稳定 data-store identity，便于发现源切换。
5. 增加测试：
   - 触发 JSONL compress 后，`getHistory` 保持压缩语义；
   - archive endpoint 仍可读 summary floor 之前的用户/助手轮次；
   - restart 后 archive 与 compact snapshot 一致；
   - source 切换时历史明确按 source 隔离；
   - 无 current/pageSize 的会话列表和历史不被截断。


## 现场只读探针（10.219.14.186:12323，2026-09-30）

在不携带写请求、未重启进程的条件下，`GET /api/v1/conversation/sessions` 返回 6 个会话；显式 `?current=1&pageSize=2` 返回 2 个且 `pagination.total=6`，证明分页只有显式传参才启用。逐个读取这 6 个 `/chat/snapshot`：b963… 为 35 行、8add… 为 28 行、d6d4… 为 6 行、f048… 为 54 行、a300… 为 58 行、2e703… 为 24 行；均无 `system`/`isCompactSummary` 行。b963… 的内容包含截图中的“子代理未完成/…”文本，当前会话历史完整返回。

因此截图对应的远端实例不是分页截断，也未观测到该实例的 summary 压缩。若用户界面显示更早会话，需核对当时连接的实例地址、`instanceId`、`DATA_DIR` 和租户；源切换时前端会先清空旧列表。

## 本轮已落地的保护

- 新增 `GET /conversation/archive?sessionId=...`。JSONL 会应用删除、更新、截断和清空墓碑，但不应用 summary 的 `leafSeq`，因此可显式展开压缩前仍保留的消息；SQLite 返回当前可恢复的紧凑投影。
- `/chat/snapshot` 增加 `historyCompacted` 标记，默认仍只返回紧凑历史，避免把完整归档自动送入模型。
- ChatView 在检测到压缩时显示“加载仍保留在归档中的更早对话”，点击后才读取归档；远端只读白名单已同步放行该 GET 路由。
- 修正 JSONL 清空回退墓碑 `dbSeq=0` 时的边界判断，避免旧行在文件锁异常时重新出现。

验证：JSONL/路由相关测试 15/15、前端远端连接协议 E2E 8/8、前端 `typecheck` 与 `build` 均通过。当前运行中的旧引擎实例未重启；新接口要在重连到包含本次引擎构建的实例后生效。

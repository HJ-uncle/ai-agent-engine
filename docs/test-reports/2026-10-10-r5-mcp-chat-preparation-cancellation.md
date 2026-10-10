# r5 MCP 正式会话准备阶段取消回归

## 修复范围

`timeoutMs: 0` 明确表示 MCP 操作不受固定时限中断。正式 `/chat` 创建工具注册表时原先尚未把取消信号传入 MCP 初始化，因此永不回应 initialize 的服务可能令请求一直停留在准备阶段，用户取消也无法终止它。

- `src/api/http/routes/chat.ts` 为准备阶段单独维护按租户、会话划分的取消控制器集合。`/chat/cancel` 取消该会话所有准备请求；HTTP 断开在 root admission 前取消本次请求。准备结束后移除监听及集合项；已启动 Code root 的断开保留与重连行为沿用原有实现。
- `src/tools/registry-factory.ts` 将调用方信号传到 MCP loader，并在准备前后检查取消。
- `src/tools/mcp/loader.ts` 将信号传到本地及 inline 服务发现。取消不会被“服务不可用，跳过”逻辑吞掉；等待所属客户端清理完成后结束准备。

取消准备返回 HTTP 499，业务码 49900。准备阶段不会创建 durable root；取消后不留下会话 busy 状态。

## 验证

新增 `src/api/http/routes/__tests__/chat-mcp-discovery-cancel.test.ts` 三项真实传输、进程与数据库回归：

1. 请求级 inline stdio MCP 的 initialize 永不响应，`/chat/cancel` 回收 Node 父进程及其子进程。
2. 本地 `mcp.json` 的 stdio MCP 同样永不响应，取消必须终止准备，不能跳过服务后继续调用模型。
3. 通过真实 HTTP 请求进入 Code 工具准备阶段，客户端断开后回收 owned tree。

三项均断言取消前没有调用 Agent strategy，没有 root 运行记录，没有 active stream，`/chat/status` 返回不运行；随后同会话通过真实 HTTP SSE 完成一轮并形成 succeeded root。后续 Agent strategy 使用 fixture，不调用外部模型。本报告证明正式 HTTP、MCP、取消、进程回收及下一轮 admission，不作为真实 LLM 长时验收证据。

专项结果：

- `.tmp/r5-mcp-chat-regression.json`：44/44，通过新取消回归 3 项、chat recovery 14 项、MCP e2e 13 项、tool profile 14 项。
- `.tmp/r5-mcp-deadlines.json`：7/7，包含真实 15.5 秒操作、默认 15 秒 deadline、显式 0/20 秒 override、HTTP policy、initialize 取消与管理 HTTP 断开。
- `.tmp/r5-typecheck.log`：`npm run typecheck` 通过。
- `git diff --check`：通过。

## r4 全量两项 fixture 超时处理

r4 全量保留原始结果：1526 项中 1523 通过、2 失败、1 跳过。两个失败 MCP e2e 的耗时分别约 5166 ms、5052 ms，超出 Vitest 默认 5000 ms。单独执行原始 13 项时全部通过，对应两项约 2743 ms、2876 ms；专项组合执行对应两项约 2394 ms、2378 ms。场景包含 Windows CIM owned-tree 查询和清理，在完整套并行负载下耗时增加。

仅 `mcp-e2e.test.ts` 中这两项真实进程 integration fixture 增加 20000 ms 测试时限。未修改全局 Vitest 时限，未修改产品 MCP 的默认 deadline，也未覆盖 r4 原始包或测试证据。r5 全量验证由主任务在冻结源码重新构建后执行。

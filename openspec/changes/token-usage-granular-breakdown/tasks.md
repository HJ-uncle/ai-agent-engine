## 1. 后端类型定义

- [x] 1.1 更新 `src/core/agent-loop/react.ts` 中的 `TokenUsage` 接口，新增 `ragTokens`、`builtinToolsTokens`、`mcpToolsTokens`、`toolResultsTokens` 字段
- [x] 1.2 更新 `ReActOptions.promptBreakdown` 类型，添加新增字段的 Pick

## 2. Registry Factory 分类

- [x] 2.1 修改 `src/tools/registry-factory.ts` 的 `createToolRegistry()` 返回值，增加 `toolCategories: { builtinTools, mcpTools, skillTools }` 字段
- [x] 2.2 在注册各类工具时收集工具名到对应分类数组
- [x] 2.3 修改 `src/tools/mcp/loader.ts` 的 `registerMCPTools()` 返回已注册的 MCP 工具名列表

## 3. 路由层 promptBreakdown 扩展

- [x] 3.1 修改 `src/api/http/routes/chat.ts`：分离 RAG prompt token 计算（`ragTokens = estimateTokens(ragPrompt)`），系统提示词 token 计算排除 RAG 部分
- [x] 3.2 修改 `src/api/http/routes/chat.ts`：使用 `toolCategories` 分别计算 `builtinToolsTokens` 和 `mcpToolsTokens`
- [x] 3.3 修改 `src/api/http/routes/chat.ts`：将新字段传入 `promptBreakdown`
- [x] 3.4 修改 `src/api/http/routes/messages.ts`：同步上述 3.1–3.3 变更

## 4. ReAct 循环 usage 计算

- [x] 4.1 修改 `src/core/agent-loop/react.ts`：在工具执行循环中累加 `toolResultsTokens`
- [x] 4.2 修改 `src/core/agent-loop/react.ts`：usage 对象中使用 `builtinToolsTokens`、`mcpToolsTokens` 替代 `systemToolsTokens`（并保留 `systemToolsTokens = builtinToolsTokens + mcpToolsTokens`）
- [x] 4.3 修改 `src/core/agent-loop/react.ts`：usage 对象中添加 `ragTokens` 和 `toolResultsTokens`

## 5. 前端类型 & 累加逻辑

- [x] 5.1 更新 `multi-agent-console/src/types/index.ts` 中的 `TokenUsage` 接口，添加 4 个新字段
- [x] 5.2 更新 `multi-agent-console/src/hooks/useChat.ts` 中的 usage 累加逻辑，包含新字段
- [x] 5.3 更新 `multi-agent-console/src/store/session.ts` 中的 usage 累加逻辑

## 6. 前端 UI 展示

- [x] 6.1 更新 `multi-agent-console/src/components/ChatArea.tsx` 的 `TOKEN_META` 数组为 8 项
- [x] 6.2 调整 `TokenDetailsContent` 组件宽度以适应更多行

## 7. 观测与日志

- [x] 7.1 更新 `src/observability/qa-logger.ts` 的 markdown 表格输出，包含 8 个分类
- [x] 7.2 更新 `src/storage/conversation/history.ts` 的 session token 聚合 SQL，增加新字段的 json_extract

## 8. SDK & 文档

- [x] 8.1 更新 `sdk/client.ts` 中的 TokenUsage 类型定义
- [x] 8.2 更新 `docs/docs/api-spec.md` 中的 usage 字段说明

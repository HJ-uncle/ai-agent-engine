## Why

当前 Token 详情面板只有 5 个粗略分类（系统提示词、历史消息、技能/工具、系统工具、生成内容），知识库 (RAG)、MCP 工具、单个 Skill 的 token 消耗全部混合在一起，用户无法判断哪些组件消耗最多，也无法针对性优化。需要将 Token 统计拆分为 8 个精细类别，覆盖知识库、MCP、内置工具、Skill、工具调用结果等维度。

## What Changes

- **拆分 `systemPromptTokens`**：将 RAG 上下文从系统提示词中分离，新增独立的 `ragTokens` 字段
- **拆分 `systemToolsTokens`**：区分内置系统工具定义 (`builtinToolsTokens`) 和 MCP 工具定义 (`mcpToolsTokens`)
- **新增 `toolResultsTokens`**：统计工具调用返回内容在后续迭代中占用的 token
- **保留 `skillTokens`**：后续可扩展为每个 Skill 独立统计（本次先保持整体统计）
- **更新前端 `TokenDetailsContent` 组件**：展示 8 项分类明细
- **更新 SSE `__usage__` 事件**：新增字段传给前端
- **向后兼容**：保持 `promptTokens` / `completionTokens` / `totalTokens` 汇总字段不变

## Capabilities

### New Capabilities
- `token-granular-breakdown`: 精细化 Token 消耗统计，涵盖 8 个独立分类（系统提示词、知识库 RAG、技能 Prompt、内置工具定义、MCP 工具定义、历史消息、工具调用结果、生成内容）

### Modified Capabilities
- `observability`: Token 使用量记录需支持新增字段（ragTokens、builtinToolsTokens、mcpToolsTokens、toolResultsTokens）

## Impact

- **后端**：`src/core/agent-loop/react.ts`（TokenUsage 接口 + usage 计算逻辑）、`src/api/http/routes/chat.ts` + `messages.ts`（promptBreakdown 传参）、`src/tools/registry-factory.ts`（需分类返回工具 token）、`src/observability/qa-logger.ts`（日志格式）
- **前端**：`multi-agent-console/src/types/index.ts`（TokenUsage 类型）、`multi-agent-console/src/components/ChatArea.tsx`（TOKEN_META + UI）、`multi-agent-console/src/hooks/useChat.ts`（usage 累加逻辑）
- **数据库**：`token_usage` JSON 字段无需迁移，直接新增 key 即可向后兼容
- **SDK**：`sdk/client.ts` TokenUsage 类型需同步更新

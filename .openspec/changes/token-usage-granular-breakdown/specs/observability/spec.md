## MODIFIED Requirements

### Requirement: Token usage persistence
The system SHALL record `promptTokens` and `completionTokens` to SQLite after every LLM call, associated with the `requestId` and `tenantId`. The `token_usage` JSON field SHALL additionally include `ragTokens`, `builtinToolsTokens`, `mcpToolsTokens`, and `toolResultsTokens` when available.

#### Scenario: Token usage stored with new fields
- **WHEN** an LLM call completes and the usage object includes `ragTokens`, `builtinToolsTokens`, `mcpToolsTokens`, and `toolResultsTokens`
- **THEN** a row SHALL be inserted into the `conversations` table with `token_usage` JSON containing all 11 fields (7 original + 4 new)

#### Scenario: QA log includes granular breakdown
- **WHEN** the QA logger formats a completed conversation
- **THEN** the markdown table SHALL include rows for all 8 display categories: 系统提示词, 知识库(RAG), 技能 Prompt, 内置工具, MCP 工具, 历史消息, 工具调用结果, 生成内容

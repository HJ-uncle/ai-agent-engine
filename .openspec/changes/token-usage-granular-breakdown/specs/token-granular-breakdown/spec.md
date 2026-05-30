## ADDED Requirements

### Requirement: Token usage includes RAG tokens as independent category
The system SHALL compute `ragTokens` as the estimated token count of the RAG (knowledge base) context injected into the system prompt, and report it separately from `systemPromptTokens`.

#### Scenario: RAG context present
- **WHEN** a knowledge base retrieval returns chunks that are injected into the system prompt
- **THEN** `ragTokens` SHALL equal `estimateTokens(ragPrompt)` and `systemPromptTokens` SHALL exclude the RAG portion

#### Scenario: No RAG context
- **WHEN** no knowledge base chunks are retrieved
- **THEN** `ragTokens` SHALL be 0

### Requirement: Token usage distinguishes builtin tools from MCP tools
The system SHALL report `builtinToolsTokens` (token count of built-in tool definitions) and `mcpToolsTokens` (token count of MCP tool definitions) as separate fields, replacing the combined `systemToolsTokens`.

#### Scenario: Both builtin and MCP tools registered
- **WHEN** the tool registry contains both built-in tools and MCP tools
- **THEN** `builtinToolsTokens` SHALL equal the estimated tokens for built-in tool definitions only, and `mcpToolsTokens` SHALL equal the estimated tokens for MCP tool definitions only

#### Scenario: No MCP tools
- **WHEN** no MCP servers are configured or connected
- **THEN** `mcpToolsTokens` SHALL be 0 and `builtinToolsTokens` SHALL equal the full tool definitions token count

### Requirement: Token usage includes tool results tokens
The system SHALL compute `toolResultsTokens` as the cumulative estimated token count of all tool call result messages appended during the ReAct loop, and include it in the usage breakdown.

#### Scenario: Multiple tool calls in a conversation round
- **WHEN** the ReAct loop executes 3 tool calls with results of 100, 200, and 150 estimated tokens respectively
- **THEN** `toolResultsTokens` SHALL be 450

#### Scenario: No tool calls
- **WHEN** the model generates a direct answer without tool calls
- **THEN** `toolResultsTokens` SHALL be 0

### Requirement: Backward-compatible systemToolsTokens field
The system SHALL continue to include `systemToolsTokens` in the usage object, computed as `builtinToolsTokens + mcpToolsTokens`, to maintain backward compatibility.

#### Scenario: Legacy client reads usage
- **WHEN** a client reads the usage object and only checks `systemToolsTokens`
- **THEN** `systemToolsTokens` SHALL equal the sum of `builtinToolsTokens` and `mcpToolsTokens`

### Requirement: Frontend displays 8-category token breakdown
The frontend Token details popover SHALL display 8 categories: 系统提示词, 知识库(RAG), 技能 Prompt, 内置工具, MCP 工具, 历史消息, 工具调用结果, 生成内容, each with a distinct color and proportional bar.

#### Scenario: All categories have non-zero values
- **WHEN** a usage object contains non-zero values for all 8 breakdown fields
- **THEN** the popover SHALL render 8 labeled rows with colored indicators and formatted token counts

#### Scenario: Some categories are zero or undefined
- **WHEN** a usage object has `mcpToolsTokens` as 0 or undefined
- **THEN** that category SHALL still appear in the list with value "0" and its bar segment SHALL have zero width

### Requirement: Registry factory returns tool categories
The `createToolRegistry()` function SHALL return a `toolCategories` object containing `builtinTools`, `mcpTools`, and `skillTools` arrays listing the tool names in each category.

#### Scenario: Mixed tool sources
- **WHEN** the registry contains read_file (builtin), mcp_search (MCP), and list_skills (skill)
- **THEN** `toolCategories.builtinTools` SHALL include "read_file", `toolCategories.mcpTools` SHALL include "mcp_search", and `toolCategories.skillTools` SHALL include "list_skills"

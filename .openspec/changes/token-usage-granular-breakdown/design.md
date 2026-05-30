## Context

当前系统的 token 统计架构：
- **后端** `TokenUsage` 接口（`react.ts`）有 7 个字段：`systemPromptTokens`、`systemToolsTokens`、`messagesTokens`、`skillTokens`、`promptTokens`、`completionTokens`、`totalTokens`
- **前端** `TOKEN_META`（`ChatArea.tsx`）渲染 5 个彩色条目
- 统计入口在 `chat.ts` / `messages.ts` 的 `promptBreakdown` 参数，预计算后传给 `ReActStrategy`
- RAG 上下文直接拼入 `fullSystemPrompt`，其 token 被混入 `systemPromptTokens`
- 工具定义不区分来源（内置 vs MCP），统一计算为 `systemToolsTokens`
- 工具调用返回值的 token 被纳入 `messagesTokens`，无独立可见度

## Goals / Non-Goals

**Goals:**
- 将 Token 详情从 5 个拆分为 8 个精细分类
- 每个分类从后端计算、SSE 传输到前端展示全链路打通
- 向后兼容：`promptTokens`、`completionTokens`、`totalTokens` 汇总值不变，旧版前端仍可正常渲染
- 累加逻辑（多轮工具调用循环）对新字段同样有效

**Non-Goals:**
- 不拆分每个 Skill 的独立 token 统计（本次先合并为 `skillTokens`，预留扩展）
- 不拆分每个 MCP Server 的独立统计（合并为 `mcpToolsTokens`）
- 不改变 token 估算算法（`estimateTokens` 函数不变）
- 不改变数据库 schema（`token_usage` 仍是 JSON text 字段）

## Decisions

### D1: 新增 4 个字段，保留 3 个原字段

```typescript
interface TokenUsage {
  // 原有字段（保留）
  systemPromptTokens: number   // 纯系统 prompt（不含 RAG）
  skillTokens: number          // 技能 prompt
  messagesTokens: number       // 会话历史
  completionTokens: number     // 模型生成
  promptTokens: number         // 汇总：所有输入 token
  totalTokens: number          // 汇总：promptTokens + completionTokens

  // 拆分原 systemToolsTokens
  builtinToolsTokens: number   // 内置工具定义 token
  mcpToolsTokens: number       // MCP 工具定义 token

  // 新增
  ragTokens: number            // 知识库 RAG 上下文 token
  toolResultsTokens: number    // 工具调用返回内容 token

  // 废弃（向后兼容保留）
  systemToolsTokens: number    // = builtinToolsTokens + mcpToolsTokens
}
```

**理由**：新增字段而非替换，确保旧前端不 break。`systemToolsTokens` 保留为计算属性。

### D2: promptBreakdown 扩展

`chat.ts` / `messages.ts` 构建 `promptBreakdown` 时：
- 分开计算 `ragTokens = estimateTokens(ragPrompt)`
- `systemPromptTokens = estimateTokens(pureSystemPrompt)`（不含 RAG）
- 从 `createToolRegistry()` 返回分类工具列表，分别计算 `builtinToolsTokens` 和 `mcpToolsTokens`

### D3: registry-factory 返回分类工具统计

`createToolRegistry()` 返回值增加 `toolCategories`：
```typescript
{
  registry: ToolRegistry
  memory: SQLiteMemoryStore
  externalSkills: ExternalSkill[]
  toolCategories: {
    builtinTools: string[]   // 内置工具名列表
    mcpTools: string[]       // MCP 工具名列表
    skillTools: string[]     // Skill 工具名列表
  }
}
```

### D4: 工具调用结果 token 在 ReAct 循环内累加

在 `react.ts` 的工具执行循环中，累加每个 `toolMsg.tokens` 到一个 `toolResultsTokens` 变量，最终写入 usage。

### D5: 前端 TOKEN_META 扩展为 8 项

```typescript
const TOKEN_META = [
  { key: "systemPromptTokens", color: "#818cf8", label: "系统提示词" },
  { key: "ragTokens",          color: "#34d399", label: "知识库(RAG)" },
  { key: "skillTokens",        color: "#c084fc", label: "技能 Prompt" },
  { key: "builtinToolsTokens", color: "#fbbf24", label: "内置工具" },
  { key: "mcpToolsTokens",     color: "#f97316", label: "MCP 工具" },
  { key: "messagesTokens",     color: "#38bdf8", label: "历史消息" },
  { key: "toolResultsTokens",  color: "#a78bfa", label: "工具调用结果" },
  { key: "completionTokens",   color: "#fb7185", label: "生成内容" },
]
```

## Risks / Trade-offs

- **[估算精度]** RAG / 工具定义的 token 是本地 `estimateTokens` 估算，与 LLM API 返回的 `prompt_tokens` 有差异 → 使用 API 真实值做整体校准，分项仅作参考展示（已有机制）
- **[前端兼容]** 旧 session 的历史 usage 数据缺少新字段 → 前端对 `undefined` 值默认显示 0，不影响展示
- **[性能]** 新增 token 估算调用次数（RAG 单独估算、工具分类估算）→ `estimateTokens` 是纯 CPU 字符串操作，开销可忽略

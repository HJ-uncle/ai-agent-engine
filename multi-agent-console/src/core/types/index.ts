// ── API 响应类型 ─────────────────────────────────────────────────────────────────
export interface StandardResponse<T = any> {
  code: number
  message: string
  data: T | null
  pagination?: PaginationMeta
  metadata?: any
  timestamp: number
}

export interface PaginationMeta {
  current: number
  pageSize: number
  total: number
  totalPages: number
}

// ── Agent 类型 ────────────────────────────────────────────────────────────────
export interface Agent {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  model?: string
  temperature?: number
  skills: string[]
  mcpServers: string[]
  knowledgeBases: string[]
  allowedTools: string[]
  tenantId: string
  createdAt: number
  updatedAt: number
}

export interface CreateAgentInput {
  name: string
  description?: string
  systemPrompt?: string
  model?: string
  temperature?: number
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
}

export interface UpdateAgentInput extends Partial<CreateAgentInput> {}

// ── 消息类型 ──────────────────────────────────────────────────────────────────
export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'sending' | 'streaming' | 'done' | 'error'

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens: number
  systemPromptTokens?: number
  messagesTokens?: number
  skillTokens?: number
  systemToolsTokens?: number
  // Granular breakdown
  ragTokens?: number
  builtinToolsTokens?: number
  mcpToolsTokens?: number
  toolResultsTokens?: number
  userInputTokens?: number
  // ── DeepSeek 专有指标 ──────────────────────────────────────────────────
  /** KV Cache 命中的 token 数（计费按 0.1元/百万） */
  cacheHitTokens?: number
  /** KV Cache 未命中的 token 数（按正常输入价计费） */
  cacheMissTokens?: number
  /** R1/V3 thinking 模式的推理 token 数 */
  reasoningTokens?: number
}

export interface ThinkingStep {
  type: 'thinking' | 'tool_start' | 'tool_end'
  text?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: Record<string, unknown> | string
  outputPreview?: string
  success?: boolean
}

export interface Message {
  id: string
  role: MessageRole
  content: string | any[]
  status: MessageStatus
  createdAt: number
  backendMessageId?: string | null
  usage?: TokenUsage | null
  durationMs?: number
  thinkingSteps?: ThinkingStep[]
  reasoningContent?: string
  toolCall?: { id: string; name: string; args: any }
  toolCallId?: string
  toolName?: string
  conversationId?: string | null
  modelId?: string
}

// ── 会话类型 ──────────────────────────────────────────────────────────────────
export interface Session {
  id: string
  title: string
  createdAt: number
  lastMessage?: string
  agentId?: string
  inheritContext?: boolean
  workspacePaths?: string[] // 自定义工作区路径列表
  compressStats?: {
    originalTokens: number
    compressedTokens: number
    ratio: string
  } | null
}

// ── SSE 事件类型（对齐后端 sse-sink.ts 映射后的格式）──────────────────────────
export type SseEventType =
  | 'text_delta'
  | 'thinking'
  | 'tool_start'
  | 'tool_args'
  | 'tool_end'
  | 'usage'
  | 'error'
  | 'done'
  | 'token_usage'
  | 'ask_user'
  | 'user_msg_id'

export interface SseEvent {
  type: SseEventType
  content?: string
  text?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  args?: any
  toolCallId?: string
  output?: string
  outputPreview?: string
  success?: boolean
  usage?: TokenUsage
  error?: string
  data?: any
  userMsgId?: string
}

// ── Knowledge 类型 ────────────────────────────────────────────────────────────
export interface KnowledgeDocument {
  id: string
  filename: string
  contentType?: string
  size?: number
  chunkCount?: number
  tenantId: string
  createdAt: number
  updatedAt?: number
}

export interface KnowledgeSearchResult {
  id: string
  filename: string
  content: string
  score: number
  chunkIndex?: number
}

// ── MCP Server 类型（对齐后端 McpServerRecord）────────────────────────────────
export interface McpServer {
  id: string
  name: string
  description: string
  enabled: boolean
  transportType: 'stdio' | 'sse' | 'http' | 'streamableHttp'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  isBuiltIn: boolean
  githubUrl?: string
  registryId?: string
  createdAt: number
  updatedAt: number
  /** 来源层级：project（.aether/mcp.json）| global（~/.aether/mcp.json，多项目共享） */
  scope?: 'project' | 'global'
  /** 运行时状态（前端本地维护，后端不返回） */
  status?: 'running' | 'stopped' | 'error' | 'unknown'
  /** 工具数量缓存（测试连接后填充） */
  toolCount?: number
}

export type CreateMcpServerInput = Omit<McpServer, 'createdAt' | 'updatedAt' | 'status' | 'toolCount'>

// ── Memory 类型 ───────────────────────────────────────────────────────────────
export interface MemoryEntry {
  id: string
  key: string
  value: string
  sessionId?: string
  tenantId?: string
  createdAt: number
  updatedAt?: number
}

// ── Task 类型 ─────────────────────────────────────────────────────────────────
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  name?: string
  description?: string
  status: TaskStatus
  input?: Record<string, any>
  output?: Record<string, any>
  error?: string
  tenantId?: string
  createdAt: number
  updatedAt?: number
  startedAt?: number
  completedAt?: number
}

export interface CreateTaskInput {
  name?: string
  description?: string
  input?: Record<string, any>
}

// ── Tool 类型 ─────────────────────────────────────────────────────────────────
export interface Tool {
  name: string
  displayName?: string
  description?: string
  parameters?: Record<string, any>
  category?: string
  source?: 'builtin' | 'mcp' | 'skill'
}
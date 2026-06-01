import type { Logger } from 'pino'

// ─── JSON Schema ───────────────────────────────────────────────────────────────

export interface JSONSchema {
  type: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  description?: string
  enum?: unknown[]
  items?: JSONSchema
  [key: string]: unknown
}

// ─── Message Types ─────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface Message {
  id?: string          // unique message ID
  role: MessageRole
  content: string | any[]
  reasoningContent?: string // for Deepseek R1 thinking mode
  toolCall?: ToolCall
  toolCallId?: string  // for tool result messages
  toolName?: string    // for tool result messages
  tokens?: number
  usage?: Record<string, number> | null
  createdAt?: number
  modelId?: string      // real model name used for this message
  metadata?: any        // extra business metadata
}

// ─── Tool Types ────────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  durationMs?: number
  needsConfirmation?: boolean
  pendingAction?: PendingAction
}

export interface PendingAction {
  type: string
  [key: string]: unknown
}

export class ToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly code: string = 'TOOL_ERROR',
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

export class DuplicateToolError extends ToolError {
  constructor(toolName: string) {
    super(`Tool "${toolName}" is already registered`, toolName, 'DUPLICATE_TOOL')
    this.name = 'DuplicateToolError'
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(toolName: string) {
    super(`Tool "${toolName}" not found`, toolName, 'TOOL_NOT_FOUND')
    this.name = 'ToolNotFoundError'
  }
}

// ─── Tool Interface ────────────────────────────────────────────────────────────

export interface Tool {
  readonly name: string
  readonly displayName?: string
  readonly description: string
  readonly parameters: JSONSchema
  execute(args: unknown, ctx: AgentContext): Promise<ToolResult>
}

// ─── Storage Interfaces (forward declarations) ────────────────────────────────

export interface ConversationHistory {
  append(message: Message, ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<string>
  /** Returns windowed messages for LLM context (applying token window). */
  getHistory(ctx: Pick<AgentContext, 'tenantId' | 'sessionId' | 'inheritContext'>): Promise<Message[]>
  /** Returns ALL stored messages without any windowing/truncation. */
  getFullHistory(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<Message[]>
  clear(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<void>
  summarize(ctx: AgentContext): Promise<void>
  /** 物理删除某条消息（及其对应的数据库行） */
  deleteMessage(messageId: string, tenantId: string): Promise<void>
  /** 更新消息内容（用于编辑） */
  updateMessageContent(messageId: string, tenantId: string, content: string | any[], tokens: number, metadata?: any): Promise<void>
  /** 删除某个 ID 之后的所有消息（用于回滚） */
  deleteMessagesAfterId(dbId: number, sessionId: string, tenantId: string): Promise<void>
  /** Returns the windowed token count (tokens in the messages returned by getHistory). */
  getTokenCount(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<number>
  /** Returns the raw total token count across ALL stored messages (before windowing). */
  getRawTokenCount(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<number>
  /**
   * Compress old messages by replacing them with an LLM-generated summary.
   * Keeps the last `keepRecent` messages untouched.
   */
  compress(
    ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>,
    summarizeFn: (messages: Message[]) => Promise<string>,
    keepRecent?: number,
  ): Promise<void>
}

// ─── Tool Registry Interface ───────────────────────────────────────────────────

export interface IToolRegistry {
  register(tool: Tool): void
  unregister(name: string): void
  list(): Array<{ name: string; displayName?: string; description: string; parameters: JSONSchema }>
  execute(name: string, args: unknown, ctx: AgentContext): Promise<ToolResult>
  has(name: string): boolean
}

// ─── AgentContext ──────────────────────────────────────────────────────────────

export interface AgentContext {
  tenantId: string
  sessionId: string
  workspaceDir: string
  workspacePaths?: string[] // 自定义工作区路径列表
  tools: IToolRegistry
  history: ConversationHistory
  logger: Logger
  tokenBudget: number
  requestId?: string
  signal?: AbortSignal
  inheritContext?: boolean
  /** 当前请求绑定的模型名（供工具按模型能力做不同处理） */
  modelName?: string
  /** 当前模型的能力集（来自 model-capabilities 注册表） */
  modelCaps?: import('../model-capabilities/index.js').ModelCapabilities
}

// ─── AgentContext Factory Options ─────────────────────────────────────────────

export interface CreateAgentContextOptions {
  sessionId: string
  tenantId?: string
  workspacePaths?: string[] // 自定义工作区路径列表
  tools: IToolRegistry
  history: ConversationHistory
  logger: Logger
  tokenBudget?: number
  requestId?: string
  signal?: AbortSignal
  inheritContext?: boolean
}

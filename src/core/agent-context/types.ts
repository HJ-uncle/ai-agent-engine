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
  content: string
  reasoningContent?: string // for Deepseek R1 thinking mode
  toolCall?: ToolCall
  toolCallId?: string  // for tool result messages
  toolName?: string    // for tool result messages
  tokens?: number
  usage?: Record<string, number> | null
  createdAt?: number
}

// ─── Tool Types ────────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  durationMs?: number
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

export interface MemoryStore {
  remember(key: string, value: string, ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<void>
  recall(key: string, ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<string | null>
  list(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<any[]>
  forget(key: string, ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<void>
}

export interface ConversationHistory {
  append(message: Message, ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<void>
  getHistory(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<Message[]>
  clear(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<void>
  summarize(ctx: AgentContext): Promise<void>
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
  tools: IToolRegistry
  memory: MemoryStore
  history: ConversationHistory
  logger: Logger
  tokenBudget: number
  requestId?: string
  signal?: AbortSignal
}

// ─── AgentContext Factory Options ─────────────────────────────────────────────

export interface CreateAgentContextOptions {
  sessionId: string
  tenantId?: string
  tools: IToolRegistry
  memory: MemoryStore
  history: ConversationHistory
  logger: Logger
  tokenBudget?: number
  requestId?: string
  signal?: AbortSignal
}

import type { Logger } from 'pino'
import type { ToolProfile } from '../../tools/tool-profile.js'
import type { RequestBudget } from '../subagent/budget.js'
import type { ResolvedModelConfig } from '../llm-adapter/resolve-model.js'
import type { LLMRequestAttemptEvent } from '../llm-adapter/types.js'
import type { RunObserver, SubagentEvent } from '../subagent/types.js'

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
  /**
   * 文件改动记录（write_file / delete_file 成功后附带）。
   * ReAct loop 会据此向客户端发 __file_change__ 帧，驱动 diff 视图与改动确认面板。
   * 结构见 storage/changes（FileChange），此处用 Record 避免核心类型反向依赖存储层。
   */
  metadata?: Record<string, unknown>
  change?: Record<string, unknown>
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
  clear(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>, options?: { tombstone?: boolean }): Promise<void>
  summarize(ctx: AgentContext): Promise<void>
  /** 物理删除某条消息（及其对应的数据库行） */
  deleteMessage(messageId: string, tenantId: string): Promise<void>
  /** 更新消息内容（用于编辑） */
  updateMessageContent(messageId: string, tenantId: string, content: string | any[], tokens: number, metadata?: any): Promise<void>
  /** 删除某个 ID 之后的所有消息（用于回滚） */
  deleteMessagesAfterId(dbId: number, sessionId: string, tenantId: string): Promise<void>
  /** 删除一整轮（该 conversation_id 的所有行），返回删除条数 */
  deleteByConversationId(conversationId: string, tenantId: string): Promise<number>
  /** 按 messageId 查询单条消息（含 dbId / conversationId） */
  getMessageById(messageId: string, tenantId: string): Promise<(Message & { conversationId?: string; dbId: number }) | null>
  /** 按 conversationId 查询整轮消息 */
  getByConversationId(conversationId: string, tenantId: string): Promise<(Message & { conversationId?: string })[]>
  /** 会话列表（供历史面板展示） */
  listSessions(tenantId: string): Promise<Array<{ sessionId: string; lastMessage?: string; lastAt?: number; messageCount: number; title?: string; lastReply?: string }>>
  /** 会话 token 使用统计 */
  getSessionUsage(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<Record<string, number>>
  /** Returns the windowed token count (tokens in the messages returned by getHistory). */
  getTokenCount(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<number>
  /** Returns the raw total token count across ALL stored messages (before windowing). */
  getRawTokenCount(ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>): Promise<number>
  /**
   * Compress old messages by replacing them with an LLM-generated summary.
   *
   * 第三参支持两种形态：
   * - `keepRecent?: number`（旧）：按条数保留最近 N 条原文
   * - `{ keepRecentTokens?: number }`（新，推荐）：从尾部按 token 预算回溯保留，
   *   保底 floor(n/2) 条 —— 对齐 Claude Code 的保留策略
   *
   * 返回值：压缩前后 token 统计（供手动压缩端点回显 / 审计日志用）
   */
  compress(
    ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>,
    summarizeFn: (messages: Message[]) => Promise<string>,
    keepRecent?: number | { keepRecentTokens?: number },
  ): Promise<{ preTokens: number; postTokens: number }>
  /**
   * Micro-compact：把最近 keepRecent 条消息之前的 tool 结果内容替换为占位符，
   * 不动对话结构、不调 LLM，通常在全量压缩前先跑一次（对齐 Claude Code 的清理策略）。
   * 返回清理条数与释放的 token 数；无可清理内容时返回 { cleared: 0, freedTokens: 0 }。
   */
  microCompactToolResults(
    ctx: Pick<AgentContext, 'tenantId' | 'sessionId'>,
    opts?: { keepRecent?: number },
  ): Promise<{ cleared: number; freedTokens: number }>
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
  cwd?: string
  projectRoot?: string
  scratchDir?: string
  resolvedModel?: ResolvedModelConfig
  onRequestAttempt?: (event: LLMRequestAttemptEvent) => void | Promise<void>
  toolProfile?: ToolProfile
  requestBudget?: RequestBudget
  finalizationReserveTokens?: number
  runObserver?: Partial<RunObserver>
  emitSubagentEvent?: (event: SubagentEvent) => void | Promise<void>
  rootSessionId?: string
  parentSessionId?: string
  parentConversationId?: string
  parentMessageId?: string
  parentToolCallId?: string
  conversationId?: string
  currentMessageId?: string
  runId?: string

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
  /** 当前正在执行的工具调用 ID（ReAct 循环执行前注入），供子代理等工具按调用粒度注册取消句柄 */
  currentToolCallId?: string
  inheritContext?: boolean
  /** 当前请求绑定的模型名（供工具按模型能力做不同处理） */
  modelName?: string
  /** 当前模型的能力集（来自 model-capabilities 注册表） */
  modelCaps?: import('../model-capabilities/index.js').ModelCapabilities
  /** 按用途指派：子代理默认模型（客户端设置下发；空 = 跟随 modelName） */
  subagentModel?: string
  /** 按用途指派：轻任务模型（vision-proxy 等旁路调用；空 = env/主模型回退） */
  utilityModel?: string
}

// ─── AgentContext Factory Options ─────────────────────────────────────────────

export interface CreateAgentContextOptions {
  cwd?: string
  projectRoot?: string
  scratchDir?: string
  resolvedModel?: ResolvedModelConfig
  onRequestAttempt?: (event: LLMRequestAttemptEvent) => void | Promise<void>
  toolProfile?: ToolProfile
  requestBudget?: RequestBudget
  finalizationReserveTokens?: number
  runObserver?: Partial<RunObserver>
  emitSubagentEvent?: (event: SubagentEvent) => void | Promise<void>
  rootSessionId?: string
  parentSessionId?: string
  parentConversationId?: string
  parentMessageId?: string
  parentToolCallId?: string
  conversationId?: string
  currentMessageId?: string
  runId?: string
  modelName?: string
  modelCaps?: import('../model-capabilities/index.js').ModelCapabilities
  subagentModel?: string
  utilityModel?: string
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

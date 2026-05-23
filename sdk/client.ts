/**
 * AI Agent Engine Client SDK
 * ============================================================================
 * 封装所有 API 端点，支持 SSE 流式对话。
 *
 * 架构原则：服务端 src/api/http/routes/ 下的每一个完成的 API，
 *          SDK 默认同步提供对应的类型化客户端方法。
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 统一响应格式
// ═══════════════════════════════════════════════════════════════════════════════

interface StandardResponse<T = unknown> {
  code: number
  message: string
  data: T
  pagination?: Pagination
  timestamp: number
}

interface Pagination {
  current: number
  pageSize: number
  total: number
  totalPages: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 客户端配置 & 基础类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentClientOptions {
  /** 服务地址，默认 http://localhost:12323 */
  baseUrl?: string
  /** API Key（AUTH_ENABLED=true 时需要） */
  apiKey?: string
  /** 请求超时（ms），默认 60000 */
  timeout?: number
}

export interface TokenUsage {
  systemPromptTokens: number
  systemToolsTokens: number
  messagesTokens: number
  skillTokens: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  conversationId: string | null
  ragTokens?: number
  builtinToolsTokens?: number
  mcpToolsTokens?: number
  toolResultsTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
}

export interface ChatOptions {
  /** 对话内容 */
  message: string
  /** 会话 ID，不传则自动生成 */
  sessionId?: string
  /** 指定使用的 Agent ID */
  agentId?: string
  /** 系统提示词 */
  systemPrompt?: string
  /** 最大 ask_user 调用次数 */
  maxAskUserCount?: number
  /** 思考模式 */
  thinkingMode?: boolean
  /** 是否继承上下文 */
  inheritContext?: boolean
  /** 工作区路径列表 */
  workspacePaths?: string[]
  /** 工具调用响应（用户交互回复） */
  toolResponse?: {
    toolCallId: string
    name: string
    output: string
  }
  /** 附件 */
  attachments?: Array<{
    name: string
    content: string
    type: string
    encoding?: 'utf-8' | 'base64'
  }>
  /** RAG 检索 TopK */
  ragTopK?: number
  /** 请求级模型覆盖 */
  model?: string
  modelApiKey?: string
  modelBaseUrl?: string
  modelProvider?: string
  /**
   * 模型能力 override（最高优先级）
   * 用于陌生模型，或 SDK 调用方明确告知模型能力。
   * 例：{ vision: true, toolCalling: true, thinking: false }
   * 未声明的能力会回退到内置规则 / db override。
   */
  capabilities?: {
    vision?: boolean
    video?: boolean
    audio?: boolean
    thinking?: boolean
    toolCalling?: boolean
    jsonMode?: boolean
    search?: boolean
    caching?: boolean
    parallelTools?: boolean
    streamUsage?: boolean
    prefix?: boolean
  }
  /** 项目资源透传 */
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
  inlineSkills?: Array<{
    id: string
    name: string
    description?: string
    version?: string
    promptContent?: string
    skillPath?: string
  }>
  inlineMcpServers?: Array<{
    id: string
    name: string
    transportType?: string
    url?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    headers?: Record<string, string>
  }>
}

export interface ChatResult {
  content: string
  usage: TokenUsage | null
  conversationId: string | null
}

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolCallId?: string
  toolName?: string
  tokens?: number
  usage?: TokenUsage
  reasoningContent?: string
  conversationId?: string
  dbId?: number
  createdAt?: number
}

export interface ConversationDetail {
  conversationId: string
  messageCount: number
  messages: Message[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface Agent {
  id: string
  tenantId: string
  name: string
  description?: string
  systemPrompt?: string
  skills: string[]
  mcpServers: string[]
  knowledgeBases: string[]
  allowedTools: string[] | null
  createdAt: number
  updatedAt: number
}

export interface CreateAgentInput {
  name: string
  description?: string
  systemPrompt?: string
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
}

export type UpdateAgentInput = Partial<CreateAgentInput>

// ═══════════════════════════════════════════════════════════════════════════════
// Session 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionBinding {
  started: boolean
  agentId: string | null
  agent: {
    id: string
    name: string
    description?: string
  } | null
}

// ═══════════════════════════════════════════════════════════════════════════════
// Memory 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface MemoryEntry {
  id: string
  key: string
  value: string
  sessionId: string
  createdAt: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface ToolSchema {
  name: string
  displayName?: string
  description: string
  parameters: Record<string, unknown>
  source?: 'builtin' | 'skill'
}

export interface ExternalSkill {
  name: string
  description: string
  enabled: boolean
  order: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface Job {
  id?: string
  jobId?: string
  type: string
  payload: Record<string, unknown>
  status?: string
  result?: unknown
  error?: string
  createdAt?: number
  updatedAt?: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// Model 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface ModelRecord {
  id: string
  tenantId: string
  provider: string
  modelId: string
  apiKey: string
  baseUrl: string
  displayName: string
  isEnabled: boolean
  version?: string
  createdAt: number
  updatedAt: number
}

export interface ModelWhitelistEntry {
  provider: string
  modelId: string
  displayName: string
  thinkingMode: boolean
  thinkingConfig?: Record<string, unknown>
  responseThinkingField?: string
}

export interface ModelTestResult {
  success: boolean
  latency?: number
  thinkingSupported?: boolean
  error?: string
}

export interface CreateModelInput {
  provider: string
  modelId: string
  apiKey: string
  baseUrl: string
  displayName?: string
  version?: string
}

export interface UpdateModelInput {
  apiKey?: string
  baseUrl?: string
  displayName?: string
  isEnabled?: boolean
  version?: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// Settings 类型
// ═══════════════════════════════════════════════════════════════════════════════

export type SettingsUpdate = Record<string, string | number | boolean | null>

// ═══════════════════════════════════════════════════════════════════════════════
// Todo 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface Todo {
  id: string
  tenantId: string
  title: string
  description?: string
  priority: 'low' | 'medium' | 'high'
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'
  dueAt?: number
  sessionId?: string
  createdAt: number
  updatedAt: number
}

export interface CreateTodoInput {
  title: string
  description?: string
  priority?: 'low' | 'medium' | 'high'
  dueAt?: string | number
  sessionId?: string
}

export interface UpdateTodoInput {
  title?: string
  description?: string
  priority?: 'low' | 'medium' | 'high'
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled'
  dueAt?: string | number
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cron 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface CronJob {
  id: string
  tenantId: string
  name: string
  cronExpr: string
  message: string
  sessionId: string
  agentId?: string
  description?: string
  enabled: boolean
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface CreateCronJobInput {
  name: string
  cronExpr: string
  message: string
  sessionId: string
  agentId?: string
  description?: string
  enabled?: boolean
}

export type UpdateCronJobInput = Partial<Omit<CreateCronJobInput, 'sessionId'>>

// ═══════════════════════════════════════════════════════════════════════════════
// Security 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface PolicyRule {
  id?: number
  name: string
  pattern: string
  description: string
  enabled: boolean
  createdAt?: number
}

export interface NetworkPolicy {
  enabled: boolean
  blockPrivateIPs: boolean
  whitelist: string[]
  blacklist: string[]
  allowedProtocols?: string[]
}

export interface AuditLogEntry {
  id: number
  tenantId: string
  sessionId: string
  toolName: string
  args: string
  result: string
  blocked: boolean
  reason?: string
  createdAt: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// LSP 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface LspAdapter {
  name: string
  available: boolean
  languages: string[]
  version?: string
}

export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  line: number
  column: number
  source: string
}

export interface LspDiagnosticResult {
  file: string
  diagnostics: LspDiagnostic[]
  cached?: boolean
}

// ═══════════════════════════════════════════════════════════════════════════════
// Performance 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface PerformanceStats {
  sqlite: {
    journal_mode: string
    synchronous: number
    cache_size: number
    temp_store: number
    mmap_size: number
    busy_timeout: number
    foreign_keys: number
  }
  toolPool: {
    size: number
    active: number
    pending: number
  }
  toolStats: Array<{
    tool: string
    count: number
    avgMs: number
    successRate: number
  }>
}

// ═══════════════════════════════════════════════════════════════════════════════
// DeepSeek 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface DeepSeekStatus {
  enabled: boolean
  hasApiKey: boolean
  baseUrl: string
  currentModel: string
  isReasoner: boolean
  features: Record<string, string>
}

export interface DeepSeekFimResult {
  content: string
  promptTokens: number
  completionTokens: number
}

export interface DeepSeekJsonResult {
  raw: string
  parsed: unknown
  usage: {
    promptTokens: number
    completionTokens: number
    cacheHitTokens: number
    cacheMissTokens: number
    reasoningTokens: number
  }
}

export interface DeepSeekPrefixResult {
  content: string
  continuation: string
  usage: {
    promptTokens: number
    completionTokens: number
    cacheHitTokens: number
    cacheMissTokens: number
  }
}

export interface DeepSeekPricesConfig {
  models: Array<{
    modelId: string
    normalPrice: { input: number; output: number; cacheHit: number }
    discountPrice?: { input: number; output: number; cacheHit: number }
    discountUntil?: string
    effectivePrice?: {
      input: number; output: number; cacheHit: number; isDiscounted: boolean
    }
  }>
  lowBalanceThreshold: number
  updatedAt: string
}

export interface DeepSeekBalance {
  balance: number
  currency: string
  isAvailable: boolean
  lowBalance: boolean
  lowBalanceThreshold: number
  updatedAt: string
}

export interface DeepSeekModelsResult {
  models: string[]
  fallback: boolean
  cached?: boolean
  reason?: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// Terminal 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface TerminalCreateResult {
  terminalId: string
  cwd: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// Workspace 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface FileTreeNode {
  name: string
  type: 'file' | 'dir'
  children?: FileTreeNode[]
  size?: number
  path?: string
}

export interface RecentWorkspace {
  name: string
  path: string
  hasSession: boolean
}

export interface FileInfo {
  name: string
  path: string
  size: number
  type: string
  mtime: number
  isImage: boolean
  workspacePath: string
}

export interface FileContent {
  content: string
  isBinary?: boolean
  totalSize?: number
  originalLength?: number
}

export interface WorkspaceUploadResult {
  path: string
  size: number
  filename: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// Knowledge Base 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface KBDocument {
  id: string
  tenantId: string
  filename: string
  contentType: string
  chunkCount: number
  createdAt: number
}

export interface KBSearchResult {
  chunkId: string
  documentId: string
  filename: string
  content: string
  score: number
  chunkIndex: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface McpServerRecord {
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
}

export type CreateMcpServerInput = Omit<McpServerRecord, 'createdAt' | 'updatedAt'>
export type UpdateMcpServerInput = Partial<Omit<McpServerRecord, 'id' | 'createdAt' | 'updatedAt'>>

export interface MCPTestResult {
  success: boolean
  toolCount?: number
  tools?: Array<{ name: string; description: string }>
  error?: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// Conversation Compress 类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface CompressResult {
  success: boolean
  message: string
  stats: {
    originalTokens: number
    compressedTokens: number
    ratio: string
  }
  usage: TokenUsage
}

// ═══════════════════════════════════════════════════════════════════════════════
// AgentClient 主类
// ═══════════════════════════════════════════════════════════════════════════════

export class AgentClient {
  readonly baseUrl: string
  private headers: Record<string, string>
  private timeout: number

  constructor(options: AgentClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:12323').replace(/\/$/, '')
    this.timeout = options.timeout ?? 60000
    this.headers = {
      'Content-Type': 'application/json',
      'X-Client-Version': 'sdk',
    }
    if (options.apiKey) {
      this.headers['X-Api-Key'] = options.apiKey
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 内部工具方法
  // ═══════════════════════════════════════════════════════════════════════════

  private genRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }

  /**
   * 内部 fetch 封装：自动处理统一响应格式 {code, message, data}
   * - 所有 /api/v1/* 端点返回 StandardResponse 包装
   * - /health、/metrics 等白名单端点可能返回裸数据
   * - 选项 raw: true 时返回原始响应（适用于流式端点或 text/plain 格式）
   * - 选项 rawText: true 时返回原始文本（用于 Prometheus 等 text/plain 端点）
   */
  private async fetch<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    opts?: { raw?: boolean; rawText?: boolean },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`
    if (query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, v)
      }
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    const headers: Record<string, string> = { ...this.headers }
    headers['X-Request-ID'] = this.genRequestId()

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`AgentClient error ${res.status}: ${err}`)
    }

    // text/plain 响应（Prometheus 格式等）
    if (opts?.rawText) {
      return (await res.text()) as unknown as T
    }

    const json = await res.json()

    if (opts?.raw) return json as T

    // 自动解包 StandardResponse
    if (json && typeof json === 'object' && 'code' in json) {
      const sr = json as StandardResponse<T>
      if (sr.code !== 200) {
        throw new Error(`API Error [${sr.code}]: ${sr.message}`)
      }
      return sr.data as T
    }

    return json as T
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. 健康检查
  // ═══════════════════════════════════════════════════════════════════════════

  /** 检查服务是否正常运行 */
  async health(): Promise<{ status: string; timestamp: string }> {
    return this.fetch('GET', '/health', undefined, undefined, { raw: true })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. AI 对话（SSE 流）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 发送对话消息，返回 AsyncIterable<string>，逐 token 输出
   *
   * @example
   * for await (const chunk of client.chat({ message: '你好' })) {
   *   process.stdout.write(chunk)
   * }
   */
  async *chat(options: ChatOptions): AsyncIterable<string> {
    const url = `${this.baseUrl}/api/v1/chat`
    const headers: Record<string, string> = { ...this.headers }
    headers['X-Request-ID'] = this.genRequestId()

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!res.ok || !res.body) {
      const err = await res.text()
      throw new Error(`Chat error ${res.status}: ${err}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') return
          try {
            const parsed = JSON.parse(data) as { content?: string }
            if (parsed.content) yield parsed.content
          } catch {
            // 忽略解析错误
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * 发送对话消息，等待完整响应后返回字符串（非流式）
   */
  async chatComplete(options: ChatOptions): Promise<string> {
    let result = ''
    for await (const chunk of this.chat(options)) {
      result += chunk
    }
    return result
  }

  /**
   * 发送对话消息，返回完整内容 + Token 用量 + conversationId
   */
  async chatWithUsage(options: ChatOptions): Promise<ChatResult> {
    const url = `${this.baseUrl}/api/v1/chat`
    const headers: Record<string, string> = { ...this.headers }
    headers['X-Request-ID'] = this.genRequestId()

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!res.ok || !res.body) {
      const err = await res.text()
      throw new Error(`Chat error ${res.status}: ${err}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let content = ''
    let usage: TokenUsage | null = null
    let conversationId: string | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') break
          try {
            const parsed = JSON.parse(data) as {
              content?: string
              usage?: TokenUsage
            }
            if (parsed.content) content += parsed.content
            if (parsed.usage) {
              usage = parsed.usage
              conversationId = parsed.usage.conversationId
            }
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    return { content, usage, conversationId }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Agent 管理
  // ═══════════════════════════════════════════════════════════════════════════

  get agents() {
    const self = this
    const base = '/api/v1/agents'
    return {
      /** 列出所有 Agent (支持分页) */
      list: (opts?: { current?: number; pageSize?: number }): Promise<Agent[]> =>
        self.fetch('GET', base, undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 获取 Agent 详情 */
      get: (id: string): Promise<Agent> =>
        self.fetch('GET', `${base}/${encodeURIComponent(id)}`),

      /** 创建 Agent */
      create: (input: CreateAgentInput): Promise<Agent> =>
        self.fetch('POST', base, input),

      /** 更新 Agent */
      update: (id: string, input: UpdateAgentInput): Promise<Agent> =>
        self.fetch('PUT', `${base}/${encodeURIComponent(id)}`, input),

      /** 删除 Agent */
      delete: (id: string): Promise<{ id: string }> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. 会话 & 对话历史
  // ═══════════════════════════════════════════════════════════════════════════

  get conversation() {
    const self = this
    return {
      /** 列出该租户下所有有对话记录的 session (支持分页) */
      getSessions: (opts?: { current?: number; pageSize?: number }): Promise<Array<{
        sessionId: string
        messageCount: number
        firstMessageAt: string
        lastMessageAt: string
      }>> =>
        self.fetch('GET', '/api/v1/conversation/sessions', undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 查询指定会话的所有历史消息 (支持分页) */
      getHistory: (sessionId: string, opts?: { current?: number; pageSize?: number }): Promise<Message[]> =>
        self.fetch('GET', '/api/v1/conversation/history', undefined, {
          sessionId,
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 清空指定会话的历史消息记录 */
      clearHistory: (sessionId: string): Promise<{ success: boolean }> =>
        self.fetch('DELETE', '/api/v1/conversation/history', undefined, { sessionId }),

      /** 按 conversationId 查询单轮对话消息 (支持分页) */
      getConversation: (conversationId: string, opts?: { current?: number; pageSize?: number }): Promise<Message[]> =>
        self.fetch('GET', `/api/v1/conversations/${encodeURIComponent(conversationId)}`, undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 压缩会话历史（生成摘要替换旧消息） */
      compress: (sessionId: string): Promise<CompressResult> =>
        self.fetch('POST', '/api/v1/conversation/compress', undefined, { sessionId }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. 会话管理
  // ═══════════════════════════════════════════════════════════════════════════

  get sessions() {
    const self = this
    return {
      /** 查询会话的 Agent 绑定状态 */
      getBinding: (sessionId: string): Promise<SessionBinding> =>
        self.fetch('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/binding`),

      /** 硬删除整个会话记录及关联 (可选 keepWorkspace) */
      delete: (sessionId: string, keepWorkspace?: boolean): Promise<{ success: boolean; sessionId: string }> =>
        self.fetch('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, undefined, {
          ...(keepWorkspace ? { keepWorkspace: 'true' } : {}),
        }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. 消息管理
  // ═══════════════════════════════════════════════════════════════════════════

  get messages() {
    const self = this
    return {
      /** 获取单条消息的 Token 使用量 */
      getTokens: (messageId: string): Promise<{ messageId: string; tokens: number }> =>
        self.fetch('GET', `/api/v1/messages/${encodeURIComponent(messageId)}/tokens`),

      /** 获取指定会话的总 Token 消耗 */
      getSessionTokens: (sessionId: string): Promise<{ sessionId: string; totalTokens: number }> =>
        self.fetch('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/tokens`),

      /** 硬删除单条消息 */
      delete: (messageId: string): Promise<{ success: boolean; messageId: string }> =>
        self.fetch('DELETE', `/api/v1/messages/${encodeURIComponent(messageId)}`),

      /**
       * 编辑用户消息并重新生成响应 (SSE 流)
       */
      async *edit(
        messageId: string,
        content: string,
        opts?: { systemPrompt?: string; maxAskUserCount?: number; thinkingMode?: boolean },
      ): AsyncIterable<string> {
        const url = `${self.baseUrl}/api/v1/messages/${encodeURIComponent(messageId)}`
        const headers: Record<string, string> = { ...self.headers }
        headers['X-Request-ID'] = self['genRequestId']()

        const res = await fetch(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ content, ...opts }),
          signal: AbortSignal.timeout(self['timeout'] as number),
        })

        if (!res.ok || !res.body) {
          const err = await res.text()
          throw new Error(`Message edit error ${res.status}: ${err}`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              if (data === '[DONE]') return
              try {
                const parsed = JSON.parse(data) as { content?: string }
                if (parsed.content) yield parsed.content
              } catch { /* ignore */ }
            }
          }
        } finally {
          reader.releaseLock()
        }
      },

      /**
       * 对指定 AI 响应重新生成 (SSE 流)
       */
      async *regenerate(
        messageId: string,
        opts?: { systemPrompt?: string; maxAskUserCount?: number; thinkingMode?: boolean },
      ): AsyncIterable<string> {
        const url = `${self.baseUrl}/api/v1/messages/${encodeURIComponent(messageId)}/regenerate`
        const headers: Record<string, string> = { ...self.headers }
        headers['X-Request-ID'] = self['genRequestId']()

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(opts ?? {}),
          signal: AbortSignal.timeout(self['timeout'] as number),
        })

        if (!res.ok || !res.body) {
          const err = await res.text()
          throw new Error(`Message regenerate error ${res.status}: ${err}`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              if (data === '[DONE]') return
              try {
                const parsed = JSON.parse(data) as { content?: string }
                if (parsed.content) yield parsed.content
              } catch { /* ignore */ }
            }
          }
        } finally {
          reader.releaseLock()
        }
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. 记忆管理
  // ═══════════════════════════════════════════════════════════════════════════

  get memory() {
    const self = this
    const base = '/api/v1/memory'
    return {
      /** 存储记忆 */
      remember: (key: string, value: string, sessionId: string): Promise<{ success: boolean }> =>
        self.fetch('POST', `${base}/remember`, { key, value, sessionId }),

      /** 读取记忆 */
      recall: (key: string, sessionId: string): Promise<{ key: string; value: string | null }> =>
        self.fetch('GET', `${base}/recall/${encodeURIComponent(key)}`, undefined, { sessionId }),

      /** 列出所有记忆条目 (可选 sessionId 过滤、分页) */
      list: (opts?: { sessionId?: string; current?: number; pageSize?: number }): Promise<MemoryEntry[]> =>
        self.fetch('GET', `${base}/list`, undefined, {
          ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 删除记忆条目 */
      delete: (id: string): Promise<{ success: boolean }> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. 工具管理
  // ═══════════════════════════════════════════════════════════════════════════

  get tools() {
    const self = this
    return {
      /** 获取所有工具列表（含内置工具和技能工具，支持分页） */
      list: (opts?: { current?: number; pageSize?: number; agentId?: string }): Promise<ToolSchema[]> =>
        self.fetch('GET', '/api/v1/tools', undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
          ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        }),

      /** 获取系统内置工具列表（排除技能工具，支持分页） */
      listSystem: (opts?: { current?: number; pageSize?: number; agentId?: string }): Promise<ToolSchema[]> =>
        self.fetch('GET', '/api/v1/system-tools', undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
          ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        }),

      /** 获取自定义技能列表（支持分页） */
      listExternalSkills: (opts?: { current?: number; pageSize?: number }): Promise<ExternalSkill[]> =>
        self.fetch('GET', '/api/v1/external-skills', undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. 任务管理
  // ═══════════════════════════════════════════════════════════════════════════

  get tasks() {
    const self = this
    const base = '/api/v1/tasks'
    return {
      /** 创建异步任务 */
      submit: (type: string, payload: Record<string, unknown> = {}): Promise<{ jobId: string }> =>
        self.fetch('POST', base, { type, payload }),

      /** 获取任务列表 (支持分页) */
      list: (opts?: { current?: number; pageSize?: number }): Promise<Job[]> =>
        self.fetch('GET', base, undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 查询任务状态 */
      get: (jobId: string): Promise<Job> =>
        self.fetch('GET', `${base}/${encodeURIComponent(jobId)}`),

      /** 取消任务 */
      cancel: (jobId: string): Promise<{ cancelled: boolean }> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(jobId)}`),

      /** 等待任务完成（轮询） */
      waitFor: async (jobId: string, pollIntervalMs = 1000, timeoutMs = 60000): Promise<Job> => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const job = await self.fetch<Job>('GET', `${base}/${encodeURIComponent(jobId)}`)
          if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
            return job
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs))
        }
        throw new Error(`Task ${jobId} timed out after ${timeoutMs}ms`)
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. 模型管理
  // ═══════════════════════════════════════════════════════════════════════════

  get models() {
    const self = this
    const base = '/api/v1/models'
    return {
      /** 获取模型白名单列表 */
      getWhitelist: (): Promise<ModelWhitelistEntry[]> =>
        self.fetch('GET', `${base}/whitelist`),

      /** 获取当前租户已配置的模型列表 */
      list: (): Promise<ModelRecord[]> =>
        self.fetch('GET', base),

      /** 添加新的模型配置（需要 admin 角色） */
      create: (input: CreateModelInput): Promise<ModelRecord> =>
        self.fetch('POST', base, input),

      /** 更新模型配置（需要 admin 角色） */
      update: (id: string, input: UpdateModelInput): Promise<ModelRecord> =>
        self.fetch('PUT', `${base}/${encodeURIComponent(id)}`, input),

      /** 删除模型配置（需要 admin 角色） */
      delete: (id: string): Promise<{ id: string }> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),

      /**
       * 测试模型连接
       * @param id 模型 ID，传入 'new' 可测试未保存的配置
       * @param params 可选的临时模型参数（provider, modelId, apiKey, baseUrl）
       */
      test: (id: string, params?: {
        provider?: string
        modelId?: string
        apiKey?: string
        baseUrl?: string
      }): Promise<ModelTestResult> =>
        self.fetch('POST', `${base}/${encodeURIComponent(id)}/test`, params),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. 系统设置
  // ═══════════════════════════════════════════════════════════════════════════

  get settings() {
    const self = this
    return {
      /** 获取当前系统运行时配置 */
      get: (): Promise<Record<string, unknown>> =>
        self.fetch('GET', '/api/v1/settings'),

      /** 更新系统运行时配置 */
      update: (updates: SettingsUpdate): Promise<{ updated: boolean }> =>
        self.fetch('PUT', '/api/v1/settings', updates),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. 待办管理
  // ═══════════════════════════════════════════════════════════════════════════

  get todos() {
    const self = this
    const base = '/api/v1/todos'
    return {
      /** 获取待办列表 (支持按 sessionId、status 过滤和分页) */
      list: (opts?: {
        sessionId?: string
        status?: 'pending' | 'in_progress' | 'done' | 'cancelled'
        current?: number
        pageSize?: number
      }): Promise<Todo[]> =>
        self.fetch('GET', base, undefined, {
          ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(opts?.status ? { status: opts.status } : {}),
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 创建待办 */
      create: (input: CreateTodoInput): Promise<Todo> =>
        self.fetch('POST', base, input),

      /** 更新待办 */
      update: (id: string, input: UpdateTodoInput): Promise<Todo> =>
        self.fetch('PUT', `${base}/${encodeURIComponent(id)}`, input),

      /** 删除待办 */
      delete: (id: string): Promise<{ deleted: boolean }> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. 定时任务
  // ═══════════════════════════════════════════════════════════════════════════

  get cron() {
    const self = this
    const base = '/api/v1/cron'
    return {
      /** 获取定时任务列表 (支持分页) */
      list: (opts?: { current?: number; pageSize?: number }): Promise<CronJob[]> =>
        self.fetch('GET', base, undefined, {
          ...(opts?.current != null ? { current: String(opts.current) } : {}),
          ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
        }),

      /** 创建定时任务 */
      create: (input: CreateCronJobInput): Promise<CronJob> =>
        self.fetch('POST', base, input),

      /** 更新定时任务 */
      update: (id: string, input: UpdateCronJobInput): Promise<CronJob> =>
        self.fetch('PUT', `${base}/${encodeURIComponent(id)}`, input),

      /** 删除定时任务 */
      delete: (id: string): Promise<{ deleted: boolean }> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),

      /** 启用定时任务 */
      enable: (id: string): Promise<CronJob> =>
        self.fetch('POST', `${base}/${encodeURIComponent(id)}/enable`, {}),

      /** 禁用定时任务 */
      disable: (id: string): Promise<CronJob> =>
        self.fetch('POST', `${base}/${encodeURIComponent(id)}/disable`, {}),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. 安全策略
  // ═══════════════════════════════════════════════════════════════════════════

  get security() {
    const self = this
    const base = '/api/v1/security'
    return {
      /** 命令安全策略 */
      policies: {
        /** 获取所有策略列表 */
        list: (opts?: { current?: number; pageSize?: number }): Promise<PolicyRule[]> =>
          self.fetch('GET', `${base}/policies`, undefined, {
            ...(opts?.current != null ? { current: String(opts.current) } : {}),
            ...(opts?.pageSize != null ? { pageSize: String(opts.pageSize) } : {}),
          }),

        /** 创建新策略 */
        create: (input: Omit<PolicyRule, 'id' | 'createdAt'>): Promise<PolicyRule> =>
          self.fetch('POST', `${base}/policies`, input),

        /** 更新策略 */
        update: (id: number, input: Partial<PolicyRule>): Promise<PolicyRule> =>
          self.fetch('PUT', `${base}/policies/${id}`, input),

        /** 删除策略 */
        delete: (id: number): Promise<{ deleted: boolean }> =>
          self.fetch('DELETE', `${base}/policies/${id}`),

        /** 重置为默认策略 */
        reset: (): Promise<{ reset: boolean }> =>
          self.fetch('POST', `${base}/policies/reset`, {}),
      },

      /** 网络策略 */
      networkPolicy: {
        /** 获取当前 SSRF 网络策略配置 */
        get: (): Promise<NetworkPolicy> =>
          self.fetch('GET', `${base}/network-policy`),

        /** 更新 SSRF 网络策略 */
        update: (input: Partial<NetworkPolicy>): Promise<NetworkPolicy> =>
          self.fetch('PUT', `${base}/network-policy`, input),

        /** 重置为默认网络策略 */
        reset: (): Promise<NetworkPolicy> =>
          self.fetch('POST', `${base}/network-policy/reset`, {}),
      },

      /** 审计日志 */
      auditLog: {
        /** 查询审计日志 */
        query: (opts?: {
          current?: number
          pageSize?: number
          category?: string
          decision?: string
          since?: number
        }): Promise<AuditLogEntry[]> => {
          const queryParams: Record<string, string> = {
            current: String(opts?.current ?? 1),
            pageSize: String(opts?.pageSize ?? 50),
          }
          if (opts?.category) queryParams.category = opts.category
          if (opts?.decision) queryParams.decision = opts.decision
          if (opts?.since) queryParams.since = String(opts.since)
          return self.fetch('GET', `${base}/audit-log`, undefined, queryParams)
        },

        /** 清理指定天数以前的审计日志 */
        purge: (days?: number): Promise<{ removed: number; days: number }> =>
          self.fetch('DELETE', `${base}/audit-log`, undefined, { days: String(days ?? 30) }),
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 15. LSP 诊断
  // ═══════════════════════════════════════════════════════════════════════════

  get lsp() {
    const self = this
    const base = '/api/v1/lsp'
    return {
      /** 列出已安装的诊断 adapter 及其可用性 */
      adapters: (): Promise<LspAdapter[]> =>
        self.fetch('GET', `${base}/adapters`),

      /** 对工作区指定文件执行诊断 */
      diagnose: (filePath: string, opts?: {
        content?: string
        adapters?: string[]
        sessionId?: string
        useCache?: boolean
      }): Promise<LspDiagnosticResult> =>
        self.fetch('POST', `${base}/diagnose`, { filePath, ...opts }),

      /** 清理过期缓存 */
      clearCache: (days?: number): Promise<{ removed: number; days: number }> =>
        self.fetch('DELETE', `${base}/cache`, undefined, { days: String(days ?? 7) }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 16. 性能统计
  // ═══════════════════════════════════════════════════════════════════════════

  get performance() {
    const self = this
    const base = '/api/v1/performance'
    return {
      /** 获取 SQLite 运行时 pragma 配置与统计 */
      stats: (): Promise<PerformanceStats> =>
        self.fetch('GET', `${base}/stats`),

      /** 动态调整工具并发池大小 */
      setToolPoolLimit: (limit: number): Promise<{ limit: number }> =>
        self.fetch('POST', `${base}/tool-pool`, { limit }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 17. DeepSeek 专有通道
  // ═══════════════════════════════════════════════════════════════════════════

  get deepseek() {
    const self = this
    const base = '/api/v1/deepseek'
    return {
      /** 通道探针：返回当前 DeepSeek 通道状态 */
      status: (): Promise<DeepSeekStatus> =>
        self.fetch('GET', `${base}/status`),

      /** Fill-in-Middle 代码补全 */
      fim: (prompt: string, suffix: string, opts?: {
        maxTokens?: number
        model?: string
      }): Promise<DeepSeekFimResult> =>
        self.fetch('POST', `${base}/fim`, { prompt, suffix, ...opts }),

      /** 强制 JSON Mode 调用 */
      json: (prompt: string, opts?: {
        systemPrompt?: string
        model?: string
      }): Promise<DeepSeekJsonResult> =>
        self.fetch('POST', `${base}/json`, { prompt, ...opts }),

      /** Chat Prefix Completion 续写 */
      prefix: (prompt: string, prefix: string, opts?: {
        systemPrompt?: string
        model?: string
      }): Promise<DeepSeekPrefixResult> =>
        self.fetch('POST', `${base}/prefix`, { prompt, prefix, ...opts }),

      /** 读取当前有效价格配置 */
      prices: (): Promise<DeepSeekPricesConfig> =>
        self.fetch('GET', `${base}/prices`),

      /** 持久化价格配置 */
      updatePrices: (config: DeepSeekPricesConfig): Promise<DeepSeekPricesConfig> =>
        self.fetch('PUT', `${base}/prices`, config),

      /** 代理查询 DeepSeek 账户余额 */
      balance: (): Promise<DeepSeekBalance> =>
        self.fetch('GET', `${base}/balance`),

      /** 动态拉取可用模型列表（5 分钟内存缓存） */
      models: (): Promise<DeepSeekModelsResult> =>
        self.fetch('GET', `${base}/models`),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 18. 终端
  // ═══════════════════════════════════════════════════════════════════════════

  get terminal() {
    const self = this
    const base = '/api/v1/terminal'
    return {
      /** 创建 PTY 会话，返回 terminalId 和实际 cwd */
      create: (sessionId: string, opts?: {
        cwd?: string
        cols?: number
        rows?: number
      }): Promise<TerminalCreateResult> =>
        self.fetch('POST', `${base}/create`, { sessionId, ...opts }),

      /** 手动终止并销毁指定 PTY 会话 */
      delete: (id: string): Promise<{ success: boolean }> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),

      /**
       * 获取 WebSocket URL（用于前端 xterm.js 连接）
       * 使用示例：new WebSocket(client.terminal.wsUrl(terminalId))
       */
      wsUrl: (id: string): string =>
        `${self.baseUrl}${base}/ws/${encodeURIComponent(id)}`.replace(/^http/, 'ws'),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 19. 工作区
  // ═══════════════════════════════════════════════════════════════════════════

  get workspace() {
    const self = this
    const base = '/api/v1/workspace'

    return {
      /** 获取工作区文件和目录树结构 */
      files: (sessionId?: string): Promise<FileTreeNode> =>
        self.fetch('GET', `${base}/files`, undefined, {
          ...(sessionId ? { sessionId } : {}),
        }),

      /** 获取最近使用的工作区列表 */
      recent: (): Promise<RecentWorkspace[]> =>
        self.fetch('GET', `${base}/recent`),

      /** 获取文件元数据 */
      fileInfo: (sessionId: string, filePath: string): Promise<FileInfo> =>
        self.fetch('GET', `${base}/file/info`, undefined, { sessionId, path: filePath }),

      /** 获取工作区文件内容 */
      fileContent: (sessionId: string, filePath: string): Promise<FileContent> =>
        self.fetch('GET', `${base}/file/content`, undefined, { sessionId, path: filePath }),

      /** 获取图片资源 URL（可直接用于 <img src>） */
      imageUrl: (sessionId: string, filePath: string): string =>
        `${self.baseUrl}${base}/image?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,

      /** 上传文件（JSON 方式） */
      writeFile: (
        sessionId: string,
        filePath: string,
        content: string,
        encoding?: 'utf-8' | 'base64',
      ): Promise<{ path: string; size: number }> =>
        self.fetch('POST', `${base}/file`, { sessionId, path: filePath, content, encoding }),

      /**
       * 通过 FormData 上传二进制文件（保留原始字节流）
       *
       * @example
       * const form = new FormData()
       * form.append('file', blob, 'report.xlsx')
       * form.append('sessionId', 'my-session')
       * form.append('path', 'uploads/report.xlsx')
       * const result = await client.workspace.uploadForm(form)
       */
      uploadForm: async (formData: FormData): Promise<WorkspaceUploadResult> => {
        const url = `${self.baseUrl}${base}/upload`
        const headers: Record<string, string> = { ...self.headers }
        delete headers['Content-Type'] // 让浏览器自动设置 multipart boundary
        headers['X-Request-ID'] = self['genRequestId']()

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: formData,
          signal: AbortSignal.timeout(self['timeout'] as number),
        })

        if (!res.ok) {
          const err = await res.text()
          throw new Error(`Upload error ${res.status}: ${err}`)
        }

        const json = await res.json()
        if (json && typeof json === 'object' && 'code' in json) {
          if ((json as StandardResponse).code !== 200) {
            throw new Error(`API Error [${(json as StandardResponse).code}]: ${(json as StandardResponse).message}`)
          }
          return (json as StandardResponse<WorkspaceUploadResult>).data
        }
        return json as WorkspaceUploadResult
      },

      /** 创建工作区文件 */
      createFile: (sessionId: string, filePath: string): Promise<{ path: string }> =>
        self.fetch('POST', `${base}/file/create`, { sessionId, path: filePath }),

      /** 创建工作区目录 */
      createFolder: (sessionId: string, folderPath: string): Promise<{ path: string }> =>
        self.fetch('POST', `${base}/folder/create`, { sessionId, path: folderPath }),

      /** 移动或重命名文件/目录 */
      moveFile: (sessionId: string, srcPath: string, destPath: string): Promise<{ path: string }> =>
        self.fetch('POST', `${base}/file/move`, { sessionId, srcPath, destPath }),

      /** 将文件/目录移入系统回收站 */
      trashFile: (sessionId: string, filePath: string): Promise<{ success: boolean }> =>
        self.fetch('POST', `${base}/file/trash`, { sessionId, path: filePath }),

      /** 使用 prettier 格式化文件内容 */
      formatFile: (sessionId: string, filePath: string, content: string): Promise<{ content: string }> =>
        self.fetch('POST', `${base}/file/format`, { sessionId, path: filePath, content }),

      /** 获取视频/二进制流 URL（支持 HTTP Range） */
      streamUrl: (sessionId: string, filePath: string): string =>
        `${self.baseUrl}${base}/file/stream?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,

      /** 获取文件下载 URL */
      downloadUrl: (sessionId: string, filePath: string): string =>
        `${self.baseUrl}${base}/file/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,

      /** 物理删除指定的工作区目录 */
      deleteRecentWorkspace: (sessionId: string): Promise<boolean> =>
        self.fetch('DELETE', `${base}/recent/${encodeURIComponent(sessionId)}`),

      /** 重命名工作区目录及关联的 sessionId */
      renameWorkspace: (oldName: string, newName: string): Promise<boolean> =>
        self.fetch('POST', `${base}/rename`, { oldName, newName }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 20. MCP 服务器配置 CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  get mcp() {
    const self = this
    const base = '/api/v1/mcp/servers'
    return {
      /** 列出所有 MCP 服务器 */
      list: (): Promise<McpServerRecord[]> =>
        self.fetch('GET', base),

      /** 获取单个 MCP 服务器配置 */
      get: (id: string): Promise<McpServerRecord> =>
        self.fetch('GET', `${base}/${encodeURIComponent(id)}`),

      /** 新增 MCP 服务器 */
      create: (data: CreateMcpServerInput): Promise<McpServerRecord> =>
        self.fetch('POST', base, data),

      /** 全量更新 MCP 服务器配置 */
      update: (id: string, data: UpdateMcpServerInput): Promise<McpServerRecord> =>
        self.fetch('PUT', `${base}/${encodeURIComponent(id)}`, data),

      /** 部分更新 MCP 服务器配置 */
      patch: (id: string, data: UpdateMcpServerInput): Promise<McpServerRecord> =>
        self.fetch('PATCH', `${base}/${encodeURIComponent(id)}`, data),

      /** 删除 MCP 服务器 */
      delete: (id: string): Promise<void> =>
        self.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),

      /** 启用 MCP 服务器 */
      enable: (id: string): Promise<McpServerRecord> =>
        self.fetch('POST', `${base}/${encodeURIComponent(id)}/enable`, {}),

      /** 禁用 MCP 服务器 */
      disable: (id: string): Promise<McpServerRecord> =>
        self.fetch('POST', `${base}/${encodeURIComponent(id)}/disable`, {}),

      /** 测试 MCP 服务器连接 */
      test: (id: string): Promise<MCPTestResult> =>
        self.fetch('POST', `${base}/${encodeURIComponent(id)}/test`, {}),

      /** 重启 MCP 服务器 */
      restart: (name: string): Promise<McpServerRecord> =>
        self.fetch('POST', `${base}/${encodeURIComponent(name)}/restart`, {}),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 21. 知识库 (RAG)
  // ═══════════════════════════════════════════════════════════════════════════

  get knowledge() {
    const self = this
    const base = '/api/v1/knowledge'
    return {
      /** 上传文档 */
      upload: (filename: string, content: string): Promise<KBDocument> =>
        self.fetch('POST', `${base}/documents`, { filename, content }),

      /** 列出当前租户的所有文档 */
      list: (): Promise<KBDocument[]> =>
        self.fetch('GET', `${base}/documents`),

      /** 删除文档 */
      delete: (id: string): Promise<void> =>
        self.fetch('DELETE', `${base}/documents/${encodeURIComponent(id)}`),

      /** 全文搜索知识库 */
      search: (query: string, limit = 5): Promise<KBSearchResult[]> =>
        self.fetch('POST', `${base}/search`, { query, limit }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 22. 指标统计
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 获取 Prometheus 格式的监控指标（纯文本）
   *
   * @example
   * const prometheusText = await client.getMetrics()
   * // 解析示例：
   * // const lines = prometheusText.split('\n').filter(l => l && !l.startsWith('#'))
   */
  async getMetrics(): Promise<string> {
    return this.fetch('GET', '/metrics', undefined, undefined, { rawText: true })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 默认导出
// ═══════════════════════════════════════════════════════════════════════════════

export const agent = new AgentClient()

export default AgentClient

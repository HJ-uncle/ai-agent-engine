/**
 * AI Agent Engine Client SDK
 * 封装所有 API 端点，支持 SSE 流式对话
 */

export interface AgentClientOptions {
  /** 服务地址，默认 http://localhost:12323 */
  baseUrl?: string
  /** API Key（AUTH_ENABLED=true 时需要） */
  apiKey?: string
  /** 请求超时（ms），默认 60000 */
  timeout?: number
}

export interface ChatOptions {
  /** 对话内容 */
  message: string
  /** 会话 ID，不传则自动生成 */
  sessionId?: string
  agentId?: string
  /** 系统提示词 */
  systemPrompt?: string
  /** 最大迭代次数 */
  maxIterations?: number
  toolResponse?: {
    toolCallId: string
    name: string
    output: string
  }
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
  // Granular breakdown
  ragTokens?: number
  builtinToolsTokens?: number
  mcpToolsTokens?: number
  toolResultsTokens?: number
}

export interface ChatStreamEvent {
  /** 内容片段 */
  content: string
  /** 是否结束 */
  done: boolean
}

export interface ChatResult {
  /** 完整回答内容 */
  content: string
  /** Token 消耗明细 */
  usage: TokenUsage | null
  /** 本次对话唯一 ID */
  conversationId: string | null
}

export interface ConversationDetail {
  conversationId: string
  messageCount: number
  messages: Message[]
}

export interface MemoryRecallResult {
  key: string
  value: string | null
}

export interface MemoryListResult {
  keys: string[]
}

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolCallId?: string
  toolName?: string
  tokens?: number
  createdAt?: number
}

export interface HistoryResult {
  messages: Message[]
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolsResult {
  tools: ToolSchema[]
}

export interface Job {
  jobId?: string
  id?: string
  type: string
  payload: Record<string, unknown>
  status?: string
  result?: unknown
  error?: string
  createdAt?: number
  updatedAt?: number
}

export interface Metrics {
  totalRequests: number
  totalTokens: number
  toolCallStats: Array<{
    toolName: string
    avgDurationMs: number
    count: number
    successRate: number
  }>
}

// ─── Knowledge Base 类型 ──────────────────────────────────────────────────────

export interface KBDocument {
  id: string
  tenantId: string
  filename: string
  contentType: string
  chunkCount: number
  createdAt: number
}

export interface SearchResult {
  chunkId: string
  documentId: string
  filename: string
  content: string
  /** BM25 relevance score (negative: lower = better) */
  score: number
  chunkIndex: number
}

// ─── MCP 类型 ────────────────────────────────────────────────────────────────

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

export class AgentClient {
  private baseUrl: string
  private headers: Record<string, string>
  private timeout: number

  constructor(options: AgentClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:12323').replace(/\/$/, '')
    this.timeout = options.timeout ?? 60000
    this.headers = {
      'Content-Type': 'application/json',
    }
    if (options.apiKey) {
      this.headers['X-Api-Key'] = options.apiKey
    }
  }

  // ─── 内部工具方法 ──────────────────────────────────────────────────────────

  private async fetch<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`
    if (query) {
      const params = new URLSearchParams(query)
      url += `?${params.toString()}`
    }

    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`AgentClient error ${res.status}: ${err}`)
    }

    return res.json() as Promise<T>
  }

  // ─── 1. 健康检查 ──────────────────────────────────────────────────────────

  /** 检查服务是否正常运行 */
  async health(): Promise<{ status: string; timestamp: string }> {
    return this.fetch('GET', '/health')
  }

  // ─── 2. AI 对话（SSE 流）─────────────────────────────────────────────────

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
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
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
            const parsed = JSON.parse(data) as { content: string }
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
   *
   * @example
   * const reply = await client.chatComplete({ message: '你好' })
   * console.log(reply)
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
   *
   * @example
   * const { content, usage, conversationId } = await client.chatWithUsage({ message: '你好' })
   * console.log(content)
   * console.log('Total tokens:', usage?.totalTokens)
   * console.log('Conversation ID:', conversationId)
   */
  async chatWithUsage(options: ChatOptions): Promise<ChatResult> {
    const url = `${this.baseUrl}/api/v1/chat`
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
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

  // ─── 3. 记忆 ─────────────────────────────────────────────────────────────

  /**
   * 存储记忆
   * @example
   * await client.remember('user_name', '张三', 'session-001')
   */
  async remember(key: string, value: string, sessionId: string): Promise<void> {
    await this.fetch('POST', '/api/v1/memory/remember', { key, value, sessionId })
  }

  /**
   * 读取记忆
   * @example
   * const { value } = await client.recall('user_name', 'session-001')
   */
  async recall(key: string, sessionId: string): Promise<MemoryRecallResult> {
    return this.fetch('GET', `/api/v1/memory/recall/${encodeURIComponent(key)}`, undefined, {
      sessionId,
    })
  }

  /**
   * 列出所有记忆 key
   */
  async listMemories(sessionId: string): Promise<MemoryListResult> {
    return this.fetch('GET', '/api/v1/memory/list', undefined, { sessionId })
  }

  // ─── 4. 对话历史 ─────────────────────────────────────────────────────────

  /**
   * 查询对话历史
   */
  async getHistory(sessionId: string): Promise<HistoryResult> {
    return this.fetch('GET', '/api/v1/conversation/history', undefined, { sessionId })
  }

  /**
   * 清除对话历史
   */
  async clearHistory(sessionId: string): Promise<void> {
    await this.fetch('DELETE', '/api/v1/conversation/history', undefined, { sessionId })
  }

  /**
   * 通过 conversationId 查询单轮对话的完整消息记录
   *
   * @example
   * const conv = await client.getConversation('uuid-xxx')
   * console.log(conv.messageCount, conv.messages)
   */
  async getConversation(conversationId: string): Promise<ConversationDetail> {
    return this.fetch('GET', `/api/v1/conversations/${encodeURIComponent(conversationId)}`)
  }

  // ─── 5. 工具列表 ─────────────────────────────────────────────────────────

  /**
   * 查询所有已注册的工具（含 Skills、MCP 工具）
   */
  async listTools(): Promise<ToolsResult> {
    return this.fetch('GET', '/api/v1/tools')
  }

  // ─── 6. 异步任务 ─────────────────────────────────────────────────────────

  /**
   * 提交异步任务
   * @example
   * const { jobId } = await client.submitTask('rebuild_index', { path: '/docs' })
   */
  async submitTask(
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ jobId: string }> {
    return this.fetch('POST', '/api/v1/tasks', { type, payload })
  }

  /**
   * 查询任务状态
   */
  async getTaskStatus(jobId: string): Promise<Job> {
    return this.fetch('GET', `/api/v1/tasks/${jobId}`)
  }

  /**
   * 取消任务
   */
  async cancelTask(jobId: string): Promise<{ cancelled: boolean }> {
    return this.fetch('DELETE', `/api/v1/tasks/${jobId}`)
  }

  /**
   * 等待任务完成（轮询）
   * @param jobId 任务 ID
   * @param pollIntervalMs 轮询间隔，默认 1000ms
   * @param timeoutMs 最大等待时间，默认 60000ms
   */
  async waitForTask(
    jobId: string,
    pollIntervalMs = 1000,
    timeoutMs = 60000,
  ): Promise<Job> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const job = await this.getTaskStatus(jobId)
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        return job
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
    throw new Error(`Task ${jobId} timed out after ${timeoutMs}ms`)
  }

  // ─── 7. 指标 ─────────────────────────────────────────────────────────────

  /**
   * 查询 Token 消耗和工具调用统计
   */
  async getMetrics(): Promise<Metrics> {
    return this.fetch('GET', '/metrics')
  }

  // ─── 8. MCP 服务器配置 CRUD ──────────────────────────────────────────────

  /**
   * MCP 服务器管理命名空间
   *
   * @example
   * // 列出所有 MCP 服务器
   * const servers = await client.mcp.list()
   *
   * // 新增一个 MCP 服务器
   * await client.mcp.create({
   *   id: 'my-mcp',
   *   url: 'https://my-mcp-server.com',
   *   headers: { 'X-Api-Key': 'secret' },
   *   transport: 'http',
   * })
   *
   * // 测试连接
   * const result = await client.mcp.test('my-mcp')
   * console.log(result.tools)
   */
  get mcp() {
    const base = '/api/v1/mcp/servers'
    return {
      /** 列出所有 MCP 服务器 */
      list: (): Promise<McpServerRecord[]> =>
        this.fetch('GET', base),

      /** 获取单个 MCP 服务器配置 */
      get: (id: string): Promise<McpServerRecord> =>
        this.fetch('GET', `${base}/${encodeURIComponent(id)}`),

      /** 新增 MCP 服务器 */
      create: (data: CreateMcpServerInput): Promise<McpServerRecord> =>
        this.fetch('POST', base, data),

      /** 全量更新 MCP 服务器配置 */
      update: (id: string, data: UpdateMcpServerInput): Promise<McpServerRecord> =>
        this.fetch('PUT', `${base}/${encodeURIComponent(id)}`, data),

      /** 部分更新 MCP 服务器配置（只传要改的字段） */
      patch: (id: string, data: UpdateMcpServerInput): Promise<McpServerRecord> =>
        this.fetch('PATCH', `${base}/${encodeURIComponent(id)}`, data),

      /** 删除 MCP 服务器 */
      delete: (id: string): Promise<void> =>
        this.fetch('DELETE', `${base}/${encodeURIComponent(id)}`),

      /** 启用 MCP 服务器 */
      enable: (id: string): Promise<McpServerRecord> =>
        this.fetch('POST', `${base}/${encodeURIComponent(id)}/enable`, {}),

      /** 禁用 MCP 服务器（不删除，只是标记 enabled: false） */
      disable: (id: string): Promise<McpServerRecord> =>
        this.fetch('POST', `${base}/${encodeURIComponent(id)}/disable`, {}),

      /** 测试 MCP 服务器连接，返回可用工具列表 */
      test: (id: string): Promise<MCPTestResult> =>
        this.fetch('POST', `${base}/${encodeURIComponent(id)}/test`, {}),
    }
  }

  // ─── 9. 知识库 (RAG) ─────────────────────────────────────────────────────

  /**
   * 知识库管理命名空间
   *
   * @example
   * // 上传文档
   * const doc = await client.knowledge.upload('guide.txt', 'Hello world...')
   *
   * // 搜索相关内容
   * const results = await client.knowledge.search('how to use RAG', 3)
   */
  get knowledge() {
    const base = '/api/v1/knowledge'
    return {
      /** 上传文档（JSON 方式，{ filename, content }） */
      upload: (filename: string, content: string): Promise<KBDocument> =>
        this.fetch('POST', `${base}/documents`, { filename, content }),

      /** 列出当前租户的所有文档 */
      list: (): Promise<KBDocument[]> =>
        this.fetch('GET', `${base}/documents`),

      /** 删除文档（by ID） */
      delete: (id: string): Promise<void> =>
        this.fetch('DELETE', `${base}/documents/${encodeURIComponent(id)}`),

      /** 全文搜索知识库，返回最相关的 chunks */
      search: (query: string, limit = 5): Promise<SearchResult[]> =>
        this.fetch('POST', `${base}/search`, { query, limit }),
    }
  }
}

// ─── 默认导出（单例） ────────────────────────────────────────────────────────

export const agent = new AgentClient()

export default AgentClient

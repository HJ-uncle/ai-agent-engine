import type {
  Agent, CreateAgentInput, UpdateAgentInput, SseEvent,
  KnowledgeBase, KnowledgeDocument, KnowledgeDocumentDetail, KnowledgeSearchResult,
  McpServer, CreateMcpServerInput,
  MemoryEntry, Task, CreateTaskInput, Tool,
} from '@core/types'

// 开发环境：proxy 配置代理到 localhost:12323，BASE_URL 留空即可走相对路径
// 生产环境：设置 VITE_API_URL 环境变量（如 https://your-api.example.com）
const BASE_URL = import.meta.env.VITE_API_URL ?? (process.env as any).REACT_APP_API_URL ?? ''
const API_PREFIX = `${BASE_URL}/api/v1`

// ── 后端响应格式（严格对齐 response.ts）─────────────────────────────────────
// StandardResponse: { code, message, data: T, timestamp }
// PaginatedResponse: { code, message, data: T[], pagination: { current, pageSize, total, totalPages }, timestamp }

export interface StandardResponse<T = any> {
  code: number
  message: string
  data: T | null
  pagination?: {
    current: number
    pageSize: number
    total: number
    totalPages: number
  }
  metadata?: any
  timestamp: number
}

// ── 通用请求 ──────────────────────────────────────────────────────────────────
async function request<T>(path: string, options?: RequestInit): Promise<StandardResponse<T>> {
  const defaultHeaders: Record<string, string> = {}
  // Only set Content-Type to application/json if there is a body, otherwise Fastify will complain on empty bodies (e.g. DELETE)
  if (options?.body) {
    defaultHeaders['Content-Type'] = 'application/json'
  }
  // 鉴权凭据（AUTH_ENABLED=true 时管理类接口需要；无凭据则匿名降级）
  try {
    const apiKey = localStorage.getItem('api_key')
    if (apiKey) defaultHeaders['x-api-key'] = apiKey
    const token = localStorage.getItem('auth_token')
    if (token) defaultHeaders['Authorization'] = `Bearer ${token}`
  } catch { /* localStorage 不可用（SSR 等）时忽略 */ }

  const res = await fetch(`${API_PREFIX}${path}`, {
    ...options,
    headers: { ...defaultHeaders, ...options?.headers },
  })
  const json: StandardResponse<T> = await res.json()
  if (json.code !== 200 && json.code !== 0) {
    let errorMessage = json.message ?? `Request failed (${json.code})`
    
    // Check for specific encryption error from backend
    if (errorMessage.includes('Unsupported state or unable to authenticate data')) {
      errorMessage = '解密失败：环境变量 ENCRYPTION_KEY 不匹配或未设置。请在 .env 文件中设置固定的 ENCRYPTION_KEY。'
    }
    
    throw new Error(errorMessage)
  }
  return json
}

// ── Agent API ─────────────────────────────────────────────────────────────────
export const agentApi = {
  // GET /agents → data: Agent[], pagination: {...}
  list: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Agent[]>(`/agents${qs}`)
    return {
      list: (res.data ?? []) as Agent[],
      total: res.pagination?.total ?? (res.data as Agent[])?.length ?? 0,
      pagination: res.pagination,
    }
  },

  // GET /agents/:id → data: Agent
  get: async (id: string) => {
    const res = await request<Agent>(`/agents/${id}`)
    return res.data as Agent
  },

  // POST /agents → data: Agent
  create: async (input: CreateAgentInput) => {
    const res = await request<Agent>('/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.data as Agent
  },

  // PUT /agents/:id → data: Agent
  update: async (id: string, input: UpdateAgentInput) => {
    const res = await request<Agent>(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
    return res.data as Agent
  },

  // DELETE /agents/:id → data: { id }
  delete: async (id: string) => {
    const res = await request<{ id: string }>(`/agents/${id}`, { method: 'DELETE' })
    return res.data as { id: string }
  },
}

// ── Conversation API ──────────────────────────────────────────────────────────
export const conversationApi = {
  // GET /conversation/sessions → data: Array<{ sessionId, lastMessage, lastAt, totalUsage? }>
  listSessions: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Array<{ sessionId: string; lastMessage: string; lastAt: number; totalUsage?: Record<string, number> }>>(
      `/conversation/sessions${qs}`
    )
    return {
      list: (res.data ?? []) as Array<{ sessionId: string; lastMessage: string; lastAt: number; totalUsage?: Record<string, number> }>,
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
    }
  },

  // GET /conversation/history?sessionId=xxx → data: Message[]
  getHistory: async (sessionId: string, params?: { current?: number; pageSize?: number }) => {
    const base = `/conversation/history?sessionId=${encodeURIComponent(sessionId)}`
    const qs = params ? `&${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<any[]>(`${base}${qs}`)
    return {
      list: (res.data ?? []) as any[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      metadata: res.metadata,
    }
  },

  // DELETE /conversation/history?sessionId=xxx
  clearHistory: async (sessionId: string) => {
    const res = await request<{ success: boolean }>(
      `/conversation/history?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    )
    return res.data
  },

  // DELETE /sessions/:sessionId
  deleteSession: async (sessionId: string, keepWorkspace?: boolean) => {
    const res = await request<{ success: boolean; sessionId: string }>(
      `/sessions/${encodeURIComponent(sessionId)}?keepWorkspace=${keepWorkspace ? 'true' : 'false'}`,
      { method: 'DELETE' }
    )
    return res.data
  },
}

// ── Messages API ──────────────────────────────────────────────────────────────
export const messagesApi = {
  // DELETE /messages/:messageId → 硬删除消息
  delete: async (messageId: string) => {
    const res = await request<{ success: boolean; messageId: string }>(
      `/messages/${messageId}`,
      { method: 'DELETE' }
    )
    return res.data
  },

  // GET /messages/:messageId/tokens
  getTokens: async (messageId: string) => {
    const res = await request<{ messageId: string; tokens: number }>(
      `/messages/${messageId}/tokens`
    )
    return res.data
  },

  // GET /sessions/:sessionId/tokens
  getSessionTokens: async (sessionId: string) => {
    const res = await request<{ sessionId: string; totalTokens: number }>(
      `/sessions/${sessionId}/tokens`
    )
    return res.data
  },
}

// ── Chat SSE ──────────────────────────────────────────────────────────────────
export interface ChatOptions {
  message: string | any[]
  sessionId: string
  agentId?: string
  systemPrompt?: string
  maxAskUserCount?: number
  thinkingMode?: boolean
  inheritContext?: boolean
  workspacePaths?: string[]
  toolResponse?: {
    toolCallId: string
    name: string
    output: string
  }
  attachments?: Array<{ name: string; content: string; type: string; encoding?: 'utf-8' | 'base64' }>
  signal?: AbortSignal
  onEvent?: (event: SseEvent) => void
  onDone?: () => void
  onError?: (error: Error) => void
}

export async function chatStream(options: ChatOptions): Promise<void> {
  const {
    message, sessionId, agentId, systemPrompt, maxAskUserCount, thinkingMode, inheritContext, workspacePaths, toolResponse, attachments,
    signal, onEvent, onDone, onError,
  } = options

  try {
    const body: Record<string, any> = { message, sessionId }
    if (agentId) body.agentId = agentId
    if (systemPrompt) body.systemPrompt = systemPrompt
    if (maxAskUserCount != null) body.maxAskUserCount = maxAskUserCount
    if (thinkingMode != null) body.thinkingMode = thinkingMode
    if (inheritContext != null) body.inheritContext = inheritContext
    if (workspacePaths) body.workspacePaths = workspacePaths
    if (toolResponse) body.toolResponse = toolResponse
    if (attachments) body.attachments = attachments

    const res = await fetch(`${API_PREFIX}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(body),
    })

    if (!res.ok || !res.body) {
      throw new Error(`HTTP error: ${res.status}`)
    }

    await parseSseStream(res.body, onEvent || (() => {}), onDone)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * 主动通知后端取消会话当前正在运行的流式生成。
 * 即使前端已经 abort 了 fetch，调用此接口可作为兜底，确保后端 agent 循环立即停止。
 * @returns 是否成功取消（false 表示后端没有该会话的运行中流）
 */
export async function cancelChat(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_PREFIX}/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!res.ok) return false
    const json = await res.json()
    return Boolean(json?.data?.cancelled)
  } catch {
    return false
  }
}

// ── SSE-driven edit & regenerate (call backend API) ──────────────────────────
export interface RegenerateOptions {
  messageId: string
  systemPrompt?: string
  maxIterations?: number
  thinkingMode?: boolean
  signal?: AbortSignal
  onEvent: (event: SseEvent) => void
  onDone?: () => void
  onError?: (err: Error) => void
}

export async function regenerateStream(options: RegenerateOptions): Promise<void> {
  const { messageId, systemPrompt, maxIterations, thinkingMode, signal, onEvent, onDone, onError } = options
  try {
    const body: Record<string, any> = {}
    if (systemPrompt) body.systemPrompt = systemPrompt
    if (maxIterations != null) body.maxIterations = maxIterations
    if (thinkingMode != null) body.thinkingMode = thinkingMode

    const res = await fetch(`${API_PREFIX}/messages/${messageId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(body),
    })

    if (!res.ok || !res.body) {
      throw new Error(`HTTP error: ${res.status}`)
    }

    await parseSseStream(res.body, onEvent, onDone)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

export interface EditMessageOptions {
  messageId: string
  content: string
  systemPrompt?: string
  maxIterations?: number
  thinkingMode?: boolean
  signal?: AbortSignal
  onEvent: (event: SseEvent) => void
  onDone?: () => void
  onError?: (err: Error) => void
}

export async function editMessageStream(options: EditMessageOptions): Promise<void> {
  const { messageId, content, systemPrompt, maxIterations, thinkingMode, signal, onEvent, onDone, onError } = options
  try {
    const body: Record<string, any> = { content }
    if (systemPrompt) body.systemPrompt = systemPrompt
    if (maxIterations != null) body.maxIterations = maxIterations
    if (thinkingMode != null) body.thinkingMode = thinkingMode

    const res = await fetch(`${API_PREFIX}/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(body),
    })

    if (!res.ok || !res.body) {
      throw new Error(`HTTP error: ${res.status}`)
    }

    await parseSseStream(res.body, onEvent, onDone)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

export interface ResumeStreamOptions {
  sessionId: string
  lastEventId?: string
  signal?: AbortSignal
  onEvent: (event: SseEvent) => void
  onDone?: () => void
  onError?: (err: Error) => void
}

export async function resumeStream(options: ResumeStreamOptions): Promise<void> {
  const { sessionId, lastEventId, signal, onEvent, onDone, onError } = options
  const tenantId = 'default'

  try {
    const url = new URL(`${API_PREFIX}/chat/stream`, window.location.origin)
    url.searchParams.set('sessionId', sessionId)
    if (lastEventId) {
      url.searchParams.set('lastEventId', lastEventId)
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-tenant-id': tenantId,
      },
      signal,
    })

    if (!res.ok) {
      throw new Error(`Failed to resume stream: ${res.status} ${res.statusText}`)
    }

    if (!res.body) {
      throw new Error('Response body is null')
    }

    await parseSseStream(res.body, onEvent, onDone)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

// ── Shared SSE parser ─────────────────────────────────────────────────────────
// 后端 sse-sink.ts 实际发送的格式：
//   普通文本:  data: {"content":"..."}
//   思考:      data: {"thinking":"..."}
//   工具开始:  data: {"toolStart":{"name":"...","args":{...}}}
//   工具结束:  data: {"toolEnd":{"name":"...","output":"...","success":true}}
//   用量:      data: {"usage":{...}}
//   结束:      data: [DONE]
//
// 前端统一转换为 SseEvent 格式后分发
async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  onDone?: () => void
) {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      let currentEventId: string | undefined = undefined

      for (const line of lines) {
        if (line.startsWith('id: ')) {
          currentEventId = line.slice(4).trim()
          continue
        }
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()

        // 结束标记
        if (!raw || raw === '[DONE]') {
          onDone?.()
          continue
        }

        let parsed: Record<string, any>
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue // 忽略非 JSON 行
        }

        // ── 映射后端格式 → 前端 SseEvent ──────────────────────────────────
        let event: SseEvent | null = null

        if (parsed.content !== undefined) {
          // 普通文本 delta
          event = { type: 'text_delta', content: parsed.content }
        } else if (parsed.thinking !== undefined) {
          // AI 思考文字
          event = { type: 'thinking', text: parsed.thinking }
        } else if (parsed.toolStart !== undefined) {
          // 工具调用开始
          const ts = parsed.toolStart as { name?: string; toolName?: string; args?: Record<string, unknown>; toolArgs?: Record<string, unknown>; toolCallId?: string }
          event = {
            type: 'tool_start',
            toolName: ts.name ?? ts.toolName ?? 'unknown',
            toolArgs: ts.args ?? ts.toolArgs ?? {},
            toolCallId: ts.toolCallId,
          }
        } else if (parsed.toolArgs !== undefined) {
          // 工具参数增量
          const ta = parsed.toolArgs as { toolCallId: string; args: string }
          event = {
            type: 'tool_args',
            toolCallId: ta.toolCallId,
            args: ta.args,
          }
        } else if (parsed.toolEnd !== undefined) {
          // 工具调用结束
          const te = parsed.toolEnd as { name?: string; output?: string; success?: boolean; error?: string; toolCallId?: string; outputPreview?: string }
          event = {
            type: 'tool_end',
            success: te.success ?? !te.error,
            output: te.output ?? te.error ?? '',
            outputPreview: te.outputPreview,
            toolCallId: te.toolCallId,
          }
        } else if (parsed.usage !== undefined) {
          // Token 用量
          event = { type: 'usage', usage: parsed.usage }
        } else if (parsed.permissionRequest !== undefined) {
          // Exec Policy 细粒度拦截审批卡片 (复用 ask_user 结构)
          event = { type: 'ask_user', data: parsed.permissionRequest.args }
        } else if (parsed.ask_user !== undefined) {
          // 提问卡片
          event = { type: 'ask_user', data: parsed.ask_user }
        } else if (parsed.userMsgId !== undefined) {
          // 用户消息落库通知：携带后端 message_id，前端据此更新 backendMessageId
          event = { type: 'user_msg_id', userMsgId: parsed.userMsgId as string }
        } else if (parsed.type !== undefined) {
          // 后端已经是标准格式（兼容）
          event = parsed as SseEvent
        }

        if (event) {
          if (currentEventId) {
            (event as any).lastEventId = currentEventId
          }
          onEvent(event)
          if (event.type === 'done') onDone?.()
        }
      }
    }

    // 流结束时也触发 done
    onDone?.()
  } finally {
    reader.releaseLock()
  }
}

// ── Knowledge API ─────────────────────────────────────────────────────────────
export const knowledgeApi = {
  // GET /knowledge/bases
  listBases: async () => {
    const res = await request<KnowledgeBase[]>('/knowledge/bases')
    return (res.data ?? []) as KnowledgeBase[]
  },

  // GET /knowledge/bases/:id
  getBase: async (id: string) => {
    const res = await request<KnowledgeBase>(`/knowledge/bases/${encodeURIComponent(id)}`)
    return res.data as KnowledgeBase
  },

  // POST /knowledge/bases
  createBase: async (payload: { name: string; description?: string }) => {
    const res = await request<KnowledgeBase>('/knowledge/bases', {
      method: 'POST', body: JSON.stringify(payload),
    })
    return res.data as KnowledgeBase
  },

  // PUT /knowledge/bases/:id
  updateBase: async (id: string, payload: { name?: string; description?: string }) => {
    const res = await request<KnowledgeBase>(`/knowledge/bases/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    })
    return res.data as KnowledgeBase
  },

  // DELETE /knowledge/bases/:id
  deleteBase: async (id: string) => {
    const res = await request<{ deleted: boolean }>(`/knowledge/bases/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res.data
  },

  // GET /knowledge/documents
  listDocuments: async (params?: { current?: number; pageSize?: number; knowledgeBaseId?: string }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<KnowledgeDocument[]>(`/knowledge/documents${qs}`)
    return {
      list: (res.data ?? []) as KnowledgeDocument[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },

  // GET /knowledge/documents/:id
  getDocument: async (id: string) => {
    const res = await request<KnowledgeDocumentDetail>(`/knowledge/documents/${encodeURIComponent(id)}`)
    return res.data as KnowledgeDocumentDetail
  },

  // POST /knowledge/documents (JSON 方式：{ filename, content, knowledgeBaseId? })
  ingest: async (payload: { filename: string; content: string; contentType?: string; knowledgeBaseId?: string | null }) => {
    const res = await request<KnowledgeDocumentDetail>('/knowledge/documents', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return res.data as KnowledgeDocumentDetail
  },

  // PUT /knowledge/documents/:id
  updateDocument: async (id: string, payload: { filename?: string; content?: string; contentType?: string; knowledgeBaseId?: string | null }) => {
    const res = await request<KnowledgeDocumentDetail>(`/knowledge/documents/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    })
    return res.data as KnowledgeDocumentDetail
  },

  // DELETE /knowledge/documents/:id
  deleteDocument: async (id: string) => {
    const res = await request<{ deleted: boolean }>(`/knowledge/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res.data
  },

  // POST /knowledge/search
  search: async (query: string, limit = 5, knowledgeBaseIds?: string[]) => {
    const res = await request<KnowledgeSearchResult[]>('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit, knowledgeBaseIds }),
    })
    return (res.data ?? []) as KnowledgeSearchResult[]
  },
}

// ── MCP Server API ────────────────────────────────────────────────────────────
export const mcpApi = {
  // All methods accept path/scope so callers editing a selected project or
  // global layer do not silently operate on the process cwd/default layer.
  _query: (params?: { path?: string; scope?: 'project' | 'global' }) => {
    const qs = new URLSearchParams()
    if (params?.path) qs.set('path', params.path)
    if (params?.scope) qs.set('scope', params.scope)
    const encoded = qs.toString()
    return encoded ? `?${encoded}` : ''
  },

  // GET /mcp/servers
  list: async (params?: { current?: number; pageSize?: number; path?: string; scope?: 'project' | 'global' }) => {
    const qsParams = new URLSearchParams()
    if (params?.current != null) qsParams.set('current', String(params.current))
    if (params?.pageSize != null) qsParams.set('pageSize', String(params.pageSize))
    if (params?.path) qsParams.set('path', params.path)
    if (params?.scope) qsParams.set('scope', params.scope)
    const encoded = qsParams.toString()
    const qs = encoded ? `?${encoded}` : ''
    const res = await request<McpServer[]>(`/mcp/servers${qs}`)
    return {
      list: (res.data ?? []) as McpServer[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },

  // GET /mcp/servers/:id
  get: async (id: string, params?: { path?: string; scope?: 'project' | 'global' }) => {
    const res = await request<McpServer>(`/mcp/servers/${encodeURIComponent(id)}${mcpApi._query(params)}`)
    return res.data as McpServer
  },

  // POST /mcp/servers
  create: async (input: CreateMcpServerInput) => {
    const res = await request<McpServer>('/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.data as McpServer
  },

  // PUT /mcp/servers/:id
  update: async (id: string, input: Partial<CreateMcpServerInput>, params?: { path?: string; scope?: 'project' | 'global' }) => {
    const res = await request<McpServer>(`/mcp/servers/${encodeURIComponent(id)}${mcpApi._query(params)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
    return res.data as McpServer
  },

  // PATCH /mcp/servers/:id
  patch: async (id: string, input: Partial<CreateMcpServerInput>, params?: { path?: string; scope?: 'project' | 'global' }) => {
    const res = await request<McpServer>(`/mcp/servers/${encodeURIComponent(id)}${mcpApi._query(params)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
    return res.data as McpServer
  },

  // DELETE /mcp/servers/:id（?scope=global 删除全局层定义）
  delete: async (id: string, scope?: 'project' | 'global', path?: string) => {
    const qs = mcpApi._query({ scope, path })
    const res = await request<boolean>(`/mcp/servers/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' })
    return res.data
  },

  // POST /mcp/servers/:id/enable
  enable: async (id: string, scope?: 'project' | 'global', path?: string) => {
    const res = await request<McpServer>(`/mcp/servers/${encodeURIComponent(id)}/enable${mcpApi._query({ scope, path })}`, { method: 'POST', body: '{}' })
    return res.data as McpServer
  },

  // POST /mcp/servers/:id/disable
  disable: async (id: string, scope?: 'project' | 'global', path?: string) => {
    const res = await request<McpServer>(`/mcp/servers/${encodeURIComponent(id)}/disable${mcpApi._query({ scope, path })}`, { method: 'POST', body: '{}' })
    return res.data as McpServer
  },

  // POST /mcp/servers/:id/test
  test: async (id: string, params?: { path?: string; scope?: 'project' | 'global' }) => {
    const res = await request<{ success: boolean; toolCount?: number; tools?: string[] }>(
      `/mcp/servers/${encodeURIComponent(id)}/test${mcpApi._query(params)}`,
      { method: 'POST', body: '{}' }
    )
    return res.data
  },

}

// ── Memory API ────────────────────────────────────────────────────────────────
export const memoryApi = {
  // POST /memory/remember
  remember: async (key: string, value: string, sessionId?: string) => {
    const body: any = { key, value }
    if (sessionId) body.sessionId = sessionId
    const res = await request<MemoryEntry>('/memory/remember', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return res.data as MemoryEntry
  },

  // GET /memory/recall?key=xxx&sessionId=xxx
  recall: async (key: string, sessionId?: string) => {
    const qs = new URLSearchParams({ key })
    if (sessionId) qs.set('sessionId', sessionId)
    const res = await request<{ key: string; value: string }>(`/memory/recall?${qs}`)
    return res.data
  },

  // GET /memory/list?sessionId=xxx
  list: async (sessionId?: string, params?: { current?: number; pageSize?: number }) => {
    const qs = new URLSearchParams()
    if (sessionId) qs.set('sessionId', sessionId)
    if (params?.current) qs.set('current', String(params.current))
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize))
    const res = await request<MemoryEntry[]>(`/memory/list?${qs}`)
    return {
      list: (res.data ?? []) as MemoryEntry[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
    }
  },

  // GET /memory/graph?sessionId=xxx
  getGraph: async (sessionId?: string) => {
    const qs = new URLSearchParams()
    if (sessionId) qs.set('sessionId', sessionId)
    const res = await request<{ nodes: any[], edges: any[] }>(`/memory/graph?${qs}`)
    return res.data!
  },

  // DELETE /memory/:id
  delete: async (id: string) => {
    const res = await request<{ success: boolean }>(`/memory/${id}`, { method: 'DELETE' })
    return res.data
  },

  // PUT /memory/:id
  update: async (id: string, data: { summary?: string; type?: string; importance?: number }) => {
    const res = await request<{ success: boolean }>(`/memory/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
    return res.data
  },

  // POST /memory/link
  link: async (sourceId: string, targetId: string, type: string, description?: string) => {
    const res = await request<{ success: boolean; id: string }>('/memory/link', {
      method: 'POST',
      body: JSON.stringify({ sourceId, targetId, type, description }),
    })
    return res.data
  },

  // POST /memory/consolidate
  consolidate: async () => {
    const res = await request<{ success: boolean; message: string; forgottenCandidates: any[] }>('/memory/consolidate', {
      method: 'POST',
    })
    return res.data
  },
}

// ── Tasks API ─────────────────────────────────────────────────────────────────
export const tasksApi = {
  // GET /tasks
  list: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Task[]>(`/tasks${qs}`)
    return {
      list: (res.data ?? []) as Task[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },

  // GET /tasks/:id
  get: async (id: string) => {
    const res = await request<Task>(`/tasks/${id}`)
    return res.data as Task
  },

  // POST /tasks
  create: async (input: CreateTaskInput) => {
    const res = await request<Task>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.data as Task
  },

  // PUT /tasks/:id
  update: async (id: string, input: Partial<Task>) => {
    const res = await request<Task>(`/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
    return res.data as Task
  },

  // DELETE /tasks/:id
  delete: async (id: string) => {
    const res = await request<{ success: boolean }>(`/tasks/${id}`, { method: 'DELETE' })
    return res.data
  },
}

// ── Tools API ─────────────────────────────────────────────────────────────────
export const toolsApi = {
  // GET /tools
  list: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Tool[]>(`/tools${qs}`)
    return {
      list: (res.data ?? []) as Tool[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },
  // GET /system-tools
  listSystemTools: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Tool[]>(`/system-tools${qs}`)
    return {
      list: (res.data ?? []) as Tool[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },
  // GET /external-skills
  listExternalSkills: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<any[]>(`/external-skills${qs}`)
    return {
      list: (res.data ?? []) as any[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },
}

// ── Sessions API ─────────────────────────────────────────────────────────────
export interface SessionBinding {
  started: boolean
  agentId: string | null
  agent: { id: string; name: string; description: string } | null
}

export const sessionsApi = {
  // GET /sessions/:sessionId/binding → 查询会话 Agent 绑定状态
  getBinding: async (sessionId: string): Promise<SessionBinding> => {
    const res = await request<SessionBinding>(`/sessions/${sessionId}/binding`)
    return res.data as SessionBinding
  },
  // DELETE /sessions/:sessionId/binding → 手动清除绑定
  clearBinding: async (sessionId: string): Promise<void> => {
    await request<{ success: boolean }>(`/sessions/${sessionId}/binding`, { method: 'DELETE' })
  },
}

// ── Workspace API ────────────────────────────────────────────────────────────────
export const workspaceApi = {
  // GET /workspace/files
  listFiles: async (sessionId?: string) => {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const res = await request<any>(`/workspace/files${qs}`)
    return res.data
  },
  // GET /workspace/recent
  listRecent: async () => {
    const res = await request<Array<{ name: string; path: string; hasSession?: boolean }>>(`/workspace/recent`)
    return res.data ?? []
  },
  // GET /workspace/file/info
  getFileInfo: async (sessionId: string, path: string) => {
    const qs = `?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
    const res = await request<{ name: string; path: string; size: number; type: string; mtime: number; isImage: boolean; workspacePath: string }>(`/workspace/file/info${qs}`)
    return res.data
  },
  // GET /workspace/file/content
  getFileContent: async (sessionId: string, path: string) => {
    const qs = `?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
    const res = await request<{ content: string; isBinary?: boolean }>(`/workspace/file/content${qs}`)
    return res.data
  },
  // DELETE /workspace/recent/:sessionId
  deleteRecent: async (sessionId: string) => {
    const res = await request<{ success: boolean }>(`/workspace/recent/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    return res.data
  },
  rename: async (oldName: string, newName: string) => {
    const res = await request<{ success: boolean }>('/workspace/rename', {
      method: 'POST',
      body: JSON.stringify({ oldName, newName })
    })
    return res.data
  },
  uploadFile: async (sessionId: string, path: string, content: string, encoding: 'utf-8' | 'base64' = 'utf-8') => {
    const res = await request<{ path: string; size: number }>('/workspace/file', {
      method: 'POST',
      body: JSON.stringify({ sessionId, path, content, encoding })
    })
    return res.data
  },

  /** Multipart 上传文件，保留二进制完整性（用于 xlsx、图片等二进制文件） */
  uploadFileBinary: async (sessionId: string, filePath: string, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('sessionId', sessionId)
    formData.append('path', filePath)

    const res = await fetch(`${API_PREFIX}/workspace/upload`, {
      method: 'POST',
      body: formData,
    })
    const json = await res.json()
    return json.data as { path: string; size: number; filename: string } | undefined
  },

  /** 技能列表（含技能根目录） */
  skillsList: async (opts?: { reload?: boolean }) => {
    const res = await request<{
      root: string
      globalRoot: string | null
      list: { name: string; description: string; enabled: boolean; order: number; scope: 'project' | 'global' }[]
    }>(`/skills${opts?.reload ? '?reload=1' : ''}`)
    return res.data
  },

  /** 技能详情（SKILL.md 全文 + 附件清单） */
  skillDetail: async (name: string) => {
    const res = await request<{
      name: string
      description: string
      enabled: boolean
      order: number
      scope: 'project' | 'global'
      dir: string
      content: string | null
      files: { path: string; size: number }[]
    }>(`/skills/${encodeURIComponent(name)}`)
    return res.data
  },

  /** 删除技能（按定义层删除目录 + 版本备份） */
  skillDelete: async (name: string) => {
    const res = await request<boolean>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
    return res.message
  },

  /** 手动创建技能（表单直建，无需压缩包） */
  skillCreate: async (input: {
    name: string
    description: string
    content: string
    scope: 'project' | 'global'
    overwrite?: boolean
  }) => {
    const res = await request<{ name: string; scope: string; dir: string }>('/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return { message: res.message, data: res.data }
  },

  // ── Skill 压缩包导入 ─────────────────────────────────────────────────────

  /** 直传模式上限（与后端 DIRECT_UPLOAD_LIMIT 一致） */
  SKILL_IMPORT_DIRECT_LIMIT: 5 * 1024 * 1024,
  /** 分片大小（与后端 CHUNK_SIZE 一致） */
  SKILL_IMPORT_CHUNK_SIZE: 2 * 1024 * 1024,

  /** XMLHTTPRequest multipart POST（fetch 不支持上传进度，故用 XHR） */
  _xhrUpload: (
    path: string,
    formData: FormData,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ code: number; message: string; data?: any }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API_PREFIX}${path}`)
      // 附带鉴权头（与 request() 封装一致）
      const apiKey = localStorage.getItem('api_key')
      if (apiKey) xhr.setRequestHeader('x-api-key', apiKey)
      const token = localStorage.getItem('auth_token')
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
      }
      xhr.onload = () => {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error(`响应解析失败（HTTP ${xhr.status}）`))
        }
      }
      xhr.onerror = () => reject(new Error('网络错误，上传中断'))
      xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
      xhr.send(formData)
    }),

  /** 查询分片续传位图（断点续传入口） */
  skillImportResumeInfo: async (filename: string, totalSize: number) => {
    const qs = `?filename=${encodeURIComponent(filename)}&totalSize=${totalSize}`
    const res = await request<{ importId: string | null; uploadedChunks: number[]; totalChunks: number }>(
      `/skills/imports/chunks${qs}`,
    )
    return res.data
  },

  /** 上传单个分片 */
  skillImportUploadChunk: (
    file: File,
    chunkIndex: number,
    totalChunks: number,
    importId: string | null,
    strategy: string,
    onProgress?: (loaded: number, total: number) => void,
    scope: 'project' | 'global' = 'project',
  ) => {
    const start = chunkIndex * workspaceApi.SKILL_IMPORT_CHUNK_SIZE
    const blob = file.slice(start, start + workspaceApi.SKILL_IMPORT_CHUNK_SIZE)
    const formData = new FormData()
    formData.append('file', blob)
    formData.append('filename', file.name)
    formData.append('totalSize', String(file.size))
    formData.append('totalChunks', String(totalChunks))
    formData.append('chunkIndex', String(chunkIndex))
    if (importId) formData.append('importId', importId)
    formData.append('conflictStrategy', strategy)
    formData.append('scope', scope)
    return workspaceApi._xhrUpload('/skills/imports/chunks', formData, onProgress)
  },

  /** 合并分片并触发导入 */
  skillImportMerge: async (importId: string) => {
    const res = await request<{ importId: string }>('/skills/imports/chunks/merge', {
      method: 'POST',
      body: JSON.stringify({ importId }),
    })
    return res.data
  },

  /** 导入状态查询（轮询用） */
  skillImportStatus: async (importId: string) => {
    const res = await request<{
      importId: string; filename: string; status: string; progress: number; stage: string | null
      skillNames: string[]; importedCount: number; errorCode: string | null; errorMessage: string | null
    }>(`/skills/imports/${encodeURIComponent(importId)}`)
    return res.data
  },

  /** 取消导入 */
  skillImportCancel: async (importId: string) => {
    await request(`/skills/imports/${encodeURIComponent(importId)}`, { method: 'DELETE' })
  },

  /**
   * 统一上传入口：≤5MB 直传，否则分片（带断点续传）。
   * @returns importId（上传/合并已受理，处理进度用 skillImportStatus 轮询）
   */
  skillImportUpload: async (
    file: File,
    opts: { strategy?: string; scope?: 'project' | 'global'; onProgress?: (percent: number, stage: string) => void; resumeImportId?: string | null },
  ): Promise<string> => {
    const strategy = opts.strategy ?? 'versioned'
    const scope = opts.scope ?? 'project'
    const CHUNK = workspaceApi.SKILL_IMPORT_CHUNK_SIZE

    if (file.size <= workspaceApi.SKILL_IMPORT_DIRECT_LIMIT) {
      opts.onProgress?.(5, '上传压缩包')
      const formData = new FormData()
      formData.append('file', file)
      formData.append('filename', file.name)
      formData.append('conflictStrategy', strategy)
      formData.append('scope', scope)
      const json = await workspaceApi._xhrUpload('/skills/imports', formData, (loaded, total) => {
        opts.onProgress?.(5 + Math.round((loaded / total) * 45), '上传压缩包')
      })
      if (json.code !== 200 || !json.data?.importId) throw new Error(json.message || '上传失败')
      return json.data.importId as string
    }

    // 分片模式（支持续传：优先显式传入的 resumeImportId，其次按文件名+大小找回）
    const totalChunks = Math.ceil(file.size / CHUNK)
    let importId = opts.resumeImportId ?? null
    let uploaded: Set<number> = new Set()
    if (!importId) {
      const info = await workspaceApi.skillImportResumeInfo(file.name, file.size)
      if (info?.importId) {
        importId = info.importId
        uploaded = new Set(info.uploadedChunks ?? [])
      }
    } else {
      const info = await workspaceApi.skillImportResumeInfo(file.name, file.size).catch(() => null)
      void info
    }
    if (importId && uploaded.size === 0) {
      const info = await workspaceApi.skillImportResumeInfo(file.name, file.size)
      if (info?.importId === importId) uploaded = new Set(info.uploadedChunks ?? [])
    }

    for (let i = 0; i < totalChunks; i++) {
      if (uploaded.has(i)) continue
      const json = await workspaceApi.skillImportUploadChunk(
        file, i, totalChunks, importId, strategy,
        (loaded, total) => {
          const base = (uploaded.size / totalChunks) * 50
          opts.onProgress?.(5 + Math.round(base + ((loaded / total) / totalChunks) * 50), `上传分片 ${i + 1}/${totalChunks}`)
        },
        scope,
      )
      if (json.code !== 200) throw new Error(json.message || `分片 ${i + 1} 上传失败`)
      importId = json.data.importId
      uploaded.add(i)
    }

    opts.onProgress?.(60, '合并分片')
    if (!importId) throw new Error('导入会话丢失')
    await workspaceApi.skillImportMerge(importId)
    return importId
  },

  // ── New file-ops (VS Code explorer refactor) ─────────────────────────────

  /** Create an empty file at the given path */
  createFile: async (sessionId: string, path: string) => {
    const res = await request<{ path: string }>('/workspace/file/create', {
      method: 'POST',
      body: JSON.stringify({ sessionId, path }),
    })
    return res.data
  },

  /** Create a directory at the given path */
  createFolder: async (sessionId: string, path: string) => {
    const res = await request<{ path: string }>('/workspace/folder/create', {
      method: 'POST',
      body: JSON.stringify({ sessionId, path }),
    })
    return res.data
  },

  /** Move a file/folder to system trash (safe delete) */
  deleteFile: async (sessionId: string, path: string) => {
    const res = await request<{ success: boolean }>('/workspace/file/trash', {
      method: 'POST',
      body: JSON.stringify({ sessionId, path }),
    })
    return res.data
  },

  /** Move / rename a file or folder */
  moveFile: async (sessionId: string, srcPath: string, destPath: string) => {
    const res = await request<{ path: string }>('/workspace/file/move', {
      method: 'POST',
      body: JSON.stringify({ sessionId, srcPath, destPath }),
    })
    return res.data
  },

  /** Read file as UTF-8 text */
  readFileText: async (sessionId: string, path: string): Promise<string> => {
    const qs = `?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
    const res = await request<{ content: string }>(`/workspace/file/content${qs}`)
    return res.data?.content ?? ''
  },

  /** Read file as base64-encoded binary */
  readFileBinary: async (sessionId: string, path: string): Promise<string> => {
    const qs = `?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}&encoding=base64`
    const res = await request<{ content: string }>(`/workspace/file/content${qs}`)
    return res.data?.content ?? ''
  },

  /** Write text content to a file */
  writeFile: async (sessionId: string, path: string, content: string) => {
    const res = await request<{ path: string; size: number }>('/workspace/file', {
      method: 'POST',
      body: JSON.stringify({ sessionId, path, content, encoding: 'utf-8' }),
    })
    return res.data
  },

  /** Format a file via prettier/eslint on the server */
  formatFile: async (sessionId: string, path: string, content: string): Promise<string> => {
    const res = await request<{ content: string }>('/workspace/file/format', {
      method: 'POST',
      body: JSON.stringify({ sessionId, path, content }),
    })
    return res.data?.content ?? content
  },
}

// ── Utility: path normalization ───────────────────────────────────────────────

/** Normalize path to always use '/' separators */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

// ── Terminal API ──────────────────────────────────────────────────────────────

export const terminalApi = {
  /** 创建 PTY 会话，返回 terminalId */
  create: async (sessionId: string, cwd?: string, cols = 120, rows = 30, workspacePaths?: string[]) => {
    const res = await request<{ terminalId: string; cwd: string }>('/terminal/create', {
      method: 'POST',
      body: JSON.stringify({ sessionId, cwd, cols, rows, workspacePaths }),
    })
    return res.data!
  },

  /** 更新已存在终端的工作区路径（工作区管理绑定新路径后调用） */
  updateWorkspaces: async (terminalId: string, workspacePaths: string[]) => {
    try {
      await request(`/terminal/${terminalId}/workspaces`, {
        method: 'POST',
        body: JSON.stringify({ workspacePaths }),
      })
    } catch { /* 后端未实现时静默失败 */ }
  },

  /** 关闭 PTY 会话 */
  kill: async (terminalId: string) => {
    await request(`/terminal/${terminalId}`, { method: 'DELETE' })
  },

  /**
   * 获取 WebSocket URL（ws:// 或 wss://）
   * 开发环境：直连后端 12323 端口（CRA proxy 不代理 WS upgrade）
   * 生产环境：同域，自动用 window.location.host
   */
  wsUrl: (terminalId: string): string => {
    // setupProxy.js 已配置 ws:true，WS upgrade 走同域 proxy
    // 生产/开发环境统一用 window.location.host（同域相对路径）
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/api/v1/terminal/ws/${terminalId}`
  },
}

// ── Health API ────────────────────────────────────────────────────────────────
export const healthApi = {
  check: async () => {
    const res = await fetch(`${BASE_URL}/health`)
    return res.ok
  },
}

// ── Models API ────────────────────────────────────────────────────────────────
export const modelsApi = {
  // GET /models/whitelist
  getWhitelist: async () => {
    const res = await request<any[]>('/models/whitelist')
    return res.data ?? []
  },
  // GET /models
  listModels: async () => {
    const res = await request<any[]>('/models')
    return res.data ?? []
  },
  // POST /models
  createModel: async (data: any) => {
    const res = await request<any>('/models', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    return res.data
  },
  // PUT /models/:id
  updateModel: async (id: string, data: any) => {
    const res = await request<any>(`/models/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
    return res.data
  },
  // DELETE /models/:id
  deleteModel: async (id: string) => {
    const res = await request<{ success: boolean }>(`/models/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    return res.data
  },
  // POST /models/:id/test
  testModel: async (id: string, data: any) => {
    const res = await request<any>(`/models/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
    return res.data
  },
  // POST /models/detect-capabilities — 基于内置规则推断能力
  detectCapabilities: async (data: { provider?: string; modelId: string; baseUrl?: string }): Promise<ModelCapabilities> => {
    const res = await request<ModelCapabilities>('/models/detect-capabilities', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    return res.data ?? {}
  },
  // GET /models/capability-defs — 能力元数据（label/desc/icon）
  getCapabilityDefs: async (): Promise<CapabilityDef[]> => {
    const res = await request<CapabilityDef[]>('/models/capability-defs')
    return res.data ?? []
  },
}

// ── Model Capabilities 类型 ───────────────────────────────────────────────────
export interface ModelCapabilities {
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

export interface CapabilityDef {
  key: keyof ModelCapabilities
  label: string
  description: string
  icon: string
  group: 'multimodal' | 'reasoning' | 'protocol' | 'optimization'
}

// ── Todo API ───────────────────────────────────────────────────────────────────
export interface Todo {
  id: string
  tenantId: string
  sessionId?: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'
  priority: 'low' | 'medium' | 'high'
  dueAt?: number
  createdAt: number
  updatedAt: number
}

export const todoApi = {
  list: async (params?: { sessionId?: string; status?: string }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Todo[]>(`/todos${qs}`)
    return (res.data ?? []) as Todo[]
  },
  create: async (input: { title: string; description?: string; priority?: string; dueAt?: string; sessionId?: string }) => {
    const res = await request<Todo>('/todos', { method: 'POST', body: JSON.stringify(input) })
    return res.data as Todo
  },
  update: async (id: string, input: Partial<{ title: string; description: string; status: string; priority: string; dueAt: string }>) => {
    const res = await request<Todo>(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(input) })
    return res.data as Todo
  },
  delete: async (id: string) => {
    await request(`/todos/${id}`, { method: 'DELETE' })
  },
}

// ── Settings API ───────────────────────────────────────────────────────────────
export const settingsApi = {
  get: async () => {
    const res = await request<Record<string, any>>('/settings')
    return res.data || {}
  },
  update: async (updates: Record<string, any>) => {
    const res = await request<{ updated: boolean }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(updates),
    })
    return res.data
  },
}

// ── DeepSeek 专有通道 API ─────────────────────────────────────────────────────
export interface DeepSeekStatus {
  enabled: boolean
  hasApiKey: boolean
  baseUrl: string
  currentModel: string
  isReasoner: boolean
  features: Record<string, string>
}

export const deepseekApi = {
  /** 探针：返回当前 DeepSeek 通道状态（是否启用、模型、特性列表） */
  status: async () => {
    const res = await request<DeepSeekStatus>('/deepseek/status')
    return res.data
  },
  /** Fill-in-Middle 代码补全 (β) */
  fim: async (params: { prompt: string; suffix: string; maxTokens?: number; model?: string }) => {
    const res = await request<{ content: string; promptTokens: number; completionTokens: number }>(
      '/deepseek/fim',
      { method: 'POST', body: JSON.stringify(params) },
    )
    return res.data
  },
  /** 强制 JSON Mode 调用 */
  json: async (params: { prompt: string; systemPrompt?: string; model?: string }) => {
    const res = await request<{ raw: string; parsed: any; usage: any }>(
      '/deepseek/json',
      { method: 'POST', body: JSON.stringify(params) },
    )
    return res.data
  },
  /** Chat Prefix Completion (β) */
  prefix: async (params: { prompt: string; prefix: string; systemPrompt?: string; model?: string }) => {
    const res = await request<{ content: string; continuation: string; usage: any }>(
      '/deepseek/prefix',
      { method: 'POST', body: JSON.stringify(params) },
    )
    return res.data
  },
  /** 获取当前有效价格配置（含折扣状态） */
  getPrices: async () => {
    const res = await request<any>('/deepseek/prices')
    return res.data
  },
  /** 持久化价格配置 */
  savePrices: async (config: any) => {
    const res = await request<any>('/deepseek/prices', {
      method: 'PUT',
      body: JSON.stringify(config),
    })
    return res.data
  },
  /** 查询账户余额 */
  getBalance: async () => {
    const res = await request<{
      balance: number
      currency: string
      isAvailable: boolean
      lowBalance: boolean
      lowBalanceThreshold: number
      updatedAt: string
    }>('/deepseek/balance')
    return res.data
  },
  /** 获取可用模型列表（5 分钟服务端缓存） */
  getModels: async () => {
    const res = await request<{ models: string[]; fallback: boolean; reason?: string }>(
      '/deepseek/models',
    )
    console.log(res.data);
    return res.data
  },
}

// ── Security Policy API ───────────────────────────────────────────────────────
export interface PolicyRule {
  id?: number
  name: string
  command: string
  argPattern?: string | null
  action: 'allow' | 'ask' | 'deny'
  priority: number
  enabled: boolean
  description?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface AuditEntry {
  id: number
  tenantId: string
  sessionId: string | null
  category: 'cmd' | 'network' | 'fs' | 'lsp'
  target: string
  details: any
  decision: 'allow' | 'ask' | 'deny' | 'error'
  ruleId: number | null
  reason: string
  createdAt: number
}

export interface NetworkPolicy {
  allowedProtocols: string[]
  denyListEnabled: boolean
  denyDomains: string[]
  denyCidrs: string[]
  allowListEnabled: boolean
  allowDomains: string[]
  blockPrivateIP: boolean
  dnsCacheTtl: number
  maxResponseBytes: number
  timeoutMs: number
}

export type SecurityMode = 'safe' | 'standard' | 'full-access'

export const securityApi = {
  // ── Policies ─────────────────────────────────────────────────────────────
  listPolicies: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<PolicyRule[]>(`/security/policies${qs}`)
    return {
      list: (res.data ?? []) as PolicyRule[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
    }
  },
  createPolicy: async (rule: PolicyRule) => {
    const res = await request<PolicyRule>('/security/policies', {
      method: 'POST', body: JSON.stringify(rule),
    })
    return res.data as PolicyRule
  },
  updatePolicy: async (id: number, rule: Partial<PolicyRule>) => {
    const res = await request<PolicyRule>(`/security/policies/${id}`, {
      method: 'PUT', body: JSON.stringify(rule),
    })
    return res.data as PolicyRule
  },
  deletePolicy: async (id: number) => {
    await request(`/security/policies/${id}`, { method: 'DELETE' })
  },
  resetPolicies: async () => {
    await request('/security/policies/reset', { method: 'POST' })
  },

  // ── Audit Log ────────────────────────────────────────────────────────────
  listAuditLog: async (params?: {
    current?: number; pageSize?: number
    category?: string; decision?: string; since?: number
  }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<AuditEntry[]>(`/security/audit-log${qs}`)
    return {
      list: (res.data ?? []) as AuditEntry[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
    }
  },
  purgeAuditLog: async (days: number) => {
    const res = await request<{ removed: number }>(`/security/audit-log?days=${days}`, {
      method: 'DELETE',
    })
    return res.data
  },

  // ── Network Policy ───────────────────────────────────────────────────────
  getNetworkPolicy: async () => {
    const res = await request<NetworkPolicy>('/security/network-policy')
    return res.data as NetworkPolicy
  },
  updateNetworkPolicy: async (policy: NetworkPolicy) => {
    const res = await request<NetworkPolicy>('/security/network-policy', {
      method: 'PUT', body: JSON.stringify(policy),
    })
    return res.data as NetworkPolicy
  },
  resetNetworkPolicy: async () => {
    const res = await request<NetworkPolicy>('/security/network-policy/reset', { method: 'POST' })
    return res.data as NetworkPolicy
  },

  // ── Security Mode (会话级) ────────────────────────────────────────────────
  getSecurityMode: async (sessionId: string) => {
    const res = await request<{ sessionId: string; mode: SecurityMode }>(`/security/mode?sessionId=${sessionId}`)
    return (res.data as any)?.mode as SecurityMode ?? 'safe'
  },
  setSecurityMode: async (sessionId: string, mode: SecurityMode) => {
    const res = await request<{ sessionId: string; mode: SecurityMode }>('/security/mode', {
      method: 'PUT', body: JSON.stringify({ sessionId, mode }),
    })
    return (res.data as any)?.mode as SecurityMode ?? mode
  },
}

// ── LSP API ────────────────────────────────────────────────────────────────
export interface LspAdapterInfo {
  name: string
  language: string
  extensions: string[]
  available: boolean
}

export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint'
  line: number
  column: number
  endLine?: number
  endColumn?: number
  code?: string
  message: string
  source: string
  fix?: { title: string; newText: string }
}

export interface LspDiagnoseResult {
  filePath: string
  language: string
  adapter: string
  diagnostics: LspDiagnostic[]
  durationMs: number
  fromCache: boolean
}

export const lspApi = {
  listAdapters: async () => {
    const res = await request<LspAdapterInfo[]>('/lsp/adapters')
    return (res.data ?? []) as LspAdapterInfo[]
  },
  diagnose: async (payload: { filePath: string; content?: string; adapters?: string[]; sessionId?: string; useCache?: boolean }) => {
    const res = await request<LspDiagnoseResult>('/lsp/diagnose', {
      method: 'POST', body: JSON.stringify(payload),
    })
    return res.data as LspDiagnoseResult
  },
  purgeCache: async (days = 7) => {
    const res = await request<{ removed: number }>(`/lsp/cache?days=${days}`, { method: 'DELETE' })
    return res.data
  },
}

// ── Performance API ───────────────────────────────────────────────────────
export interface PerformanceStats {
  sqlite: Record<string, string | number>
  toolPool: { size: number; active: number; pending: number }
  toolStats: Array<{ tool: string; count: number; avgMs: number; successRate: number }>
}

export const performanceApi = {
  getStats: async () => {
    const res = await request<PerformanceStats>('/performance/stats')
    return res.data as PerformanceStats
  },
  setToolPoolLimit: async (limit: number) => {
    const res = await request<{ limit: number }>('/performance/tool-pool', {
      method: 'POST', body: JSON.stringify({ limit }),
    })
    return res.data
  },
}

import type {
  Agent, CreateAgentInput, UpdateAgentInput, SseEvent,
  KnowledgeDocument, KnowledgeSearchResult,
  McpServer, CreateMcpServerInput,
  MemoryEntry, Task, CreateTaskInput, Tool,
} from '../types'

// 开发环境：proxy 配置代理到 localhost:3000，BASE_URL 留空即可走相对路径
// 生产环境：设置 REACT_APP_API_URL 环境变量（如 https://your-api.example.com）
const BASE_URL = process.env.REACT_APP_API_URL ?? ''
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
  timestamp: number
}

// ── 通用请求 ──────────────────────────────────────────────────────────────────
async function request<T>(path: string, options?: RequestInit): Promise<StandardResponse<T>> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const json: StandardResponse<T> = await res.json()
  if (json.code !== 200 && json.code !== 0) {
    throw new Error(json.message ?? `Request failed (${json.code})`)
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
  // GET /conversation/sessions → data: Array<{ sessionId, lastMessage, lastAt }>
  listSessions: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Array<{ sessionId: string; lastMessage: string; lastAt: number }>>(
      `/conversation/sessions${qs}`
    )
    return {
      list: (res.data ?? []) as Array<{ sessionId: string; lastMessage: string; lastAt: number }>,
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
    }
  },

  // GET /conversation/history?sessionId=xxx → data: Message[]
  getHistory: async (sessionId: string, params?: { current?: number; pageSize?: number }) => {
    const base = `/conversation/history?sessionId=${encodeURIComponent(sessionId)}`
    const qs = params ? `&${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<Array<{ role: string; content: string; createdAt?: number }>>(
      `${base}${qs}`
    )
    return {
      list: (res.data ?? []) as Array<{ role: string; content: string; createdAt?: number }>,
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
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
  deleteSession: async (sessionId: string) => {
    const res = await request<{ success: boolean; sessionId: string }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
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
  message: string
  sessionId: string
  agentId?: string
  systemPrompt?: string
  maxIterations?: number
  signal?: AbortSignal
  onEvent: (event: SseEvent) => void
  onDone?: () => void
  onError?: (err: Error) => void
}

export async function chatStream(options: ChatOptions): Promise<void> {
  const {
    message, sessionId, agentId, systemPrompt, maxIterations,
    signal, onEvent, onDone, onError,
  } = options

  try {
    const body: Record<string, any> = { message, sessionId }
    if (agentId) body.agentId = agentId
    if (systemPrompt) body.systemPrompt = systemPrompt
    if (maxIterations != null) body.maxIterations = maxIterations

    const res = await fetch(`${API_PREFIX}/chat`, {
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

// ── SSE-driven edit & regenerate (call backend API) ──────────────────────────
export interface RegenerateOptions {
  messageId: string
  systemPrompt?: string
  maxIterations?: number
  signal?: AbortSignal
  onEvent: (event: SseEvent) => void
  onDone?: () => void
  onError?: (err: Error) => void
}

export async function regenerateStream(options: RegenerateOptions): Promise<void> {
  const { messageId, systemPrompt, maxIterations, signal, onEvent, onDone, onError } = options
  try {
    const body: Record<string, any> = {}
    if (systemPrompt) body.systemPrompt = systemPrompt
    if (maxIterations != null) body.maxIterations = maxIterations

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
  signal?: AbortSignal
  onEvent: (event: SseEvent) => void
  onDone?: () => void
  onError?: (err: Error) => void
}

export async function editMessageStream(options: EditMessageOptions): Promise<void> {
  const { messageId, content, systemPrompt, maxIterations, signal, onEvent, onDone, onError } = options
  try {
    const body: Record<string, any> = { content }
    if (systemPrompt) body.systemPrompt = systemPrompt
    if (maxIterations != null) body.maxIterations = maxIterations

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

      for (const line of lines) {
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
          const ts = parsed.toolStart as { name?: string; toolName?: string; args?: Record<string, unknown>; toolArgs?: Record<string, unknown> }
          event = {
            type: 'tool_start',
            toolName: ts.name ?? ts.toolName ?? 'unknown',
            toolArgs: ts.args ?? ts.toolArgs ?? {},
          }
        } else if (parsed.toolEnd !== undefined) {
          // 工具调用结束
          const te = parsed.toolEnd as { name?: string; output?: string; success?: boolean; error?: string }
          event = {
            type: 'tool_end',
            success: te.success ?? !te.error,
            output: te.output ?? te.error ?? '',
          }
        } else if (parsed.usage !== undefined) {
          // Token 用量
          event = { type: 'usage', usage: parsed.usage }
        } else if (parsed.type !== undefined) {
          // 后端已经是标准格式（兼容）
          event = parsed as SseEvent
        }

        if (event) {
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
  // GET /knowledge/documents
  listDocuments: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<KnowledgeDocument[]>(`/knowledge/documents${qs}`)
    return {
      list: (res.data ?? []) as KnowledgeDocument[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },

  // POST /knowledge/documents  (JSON 方式：{ filename, content })
  ingest: async (payload: { filename: string; content: string; contentType?: string }) => {
    const res = await request<KnowledgeDocument>('/knowledge/documents', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return res.data as KnowledgeDocument
  },

  // DELETE /knowledge/documents/:id
  deleteDocument: async (id: string) => {
    const res = await request<{ success: boolean }>(`/knowledge/documents/${id}`, { method: 'DELETE' })
    return res.data
  },

  // POST /knowledge/search
  search: async (query: string, topK = 5) => {
    const res = await request<KnowledgeSearchResult[]>('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query, topK }),
    })
    return (res.data ?? []) as KnowledgeSearchResult[]
  },
}

// ── MCP Server API ────────────────────────────────────────────────────────────
export const mcpApi = {
  // GET /mcp/servers
  list: async (params?: { current?: number; pageSize?: number }) => {
    const qs = params ? `?${new URLSearchParams(params as any).toString()}` : ''
    const res = await request<McpServer[]>(`/mcp/servers${qs}`)
    return {
      list: (res.data ?? []) as McpServer[],
      total: res.pagination?.total ?? (res.data as any[])?.length ?? 0,
      pagination: res.pagination,
    }
  },

  // GET /mcp/servers/:id
  get: async (id: string) => {
    const res = await request<McpServer>(`/mcp/servers/${id}`)
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
  update: async (id: string, input: Partial<CreateMcpServerInput>) => {
    const res = await request<McpServer>(`/mcp/servers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
    return res.data as McpServer
  },

  // PATCH /mcp/servers/:id
  patch: async (id: string, input: Partial<CreateMcpServerInput>) => {
    const res = await request<McpServer>(`/mcp/servers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
    return res.data as McpServer
  },

  // DELETE /mcp/servers/:id
  delete: async (id: string) => {
    const res = await request<{ success: boolean }>(`/mcp/servers/${id}`, { method: 'DELETE' })
    return res.data
  },

  // POST /mcp/servers/:id/enable
  enable: async (id: string) => {
    const res = await request<McpServer>(`/mcp/servers/${id}/enable`, { method: 'POST', body: '{}' })
    return res.data as McpServer
  },

  // POST /mcp/servers/:id/disable
  disable: async (id: string) => {
    const res = await request<McpServer>(`/mcp/servers/${id}/disable`, { method: 'POST', body: '{}' })
    return res.data as McpServer
  },

  // POST /mcp/servers/:id/test
  test: async (id: string) => {
    const res = await request<{ success: boolean; toolCount?: number; tools?: string[] }>(
      `/mcp/servers/${id}/test`,
      { method: 'POST', body: '{}' }
    )
    return res.data
  },

  // POST /mcp/servers/:name/restart
  restart: async (name: string) => {
    const res = await request<{ success: boolean }>(`/mcp/servers/${name}/restart`, { method: 'POST', body: '{}' })
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

  // DELETE /memory/:id
  delete: async (id: string) => {
    const res = await request<{ success: boolean }>(`/memory/${id}`, { method: 'DELETE' })
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
}

// ── Health API ────────────────────────────────────────────────────────────────
export const healthApi = {
  check: async () => {
    const res = await fetch(`${BASE_URL}/health`)
    return res.ok
  },
}

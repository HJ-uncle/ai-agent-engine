import { throwIfAborted } from '../../core/utils/abort.js'
import type { MCPClient, MCPServerConfig, MCPToolDefinition } from './types.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { guardedHttp, type NetworkContext } from '../../security/guarded-http.js'
import { extensionPolicy } from '../../security/tool-policy.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { validateOperationTimeout } from '../../core/utils/operation-timeout.js'
import { stopCommandProcessTree } from '../../core/command-jobs/process-tree.js'

let _rpcId = 1

interface JsonRpcResponse<T> {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

interface LegacySseSession {
  controller: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  endpoint?: string
  closed: boolean
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>
  resolveEndpoint: () => void
  rejectEndpoint: (error: unknown) => void
}

function parseSseEvent(frame: string): { event: string; data: string } {
  let event = 'message'
  const data: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '')
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return { event, data: data.join('\n') }
}

/**
 * MCP HTTP 客户端 —— 支持两种协议：
 *   1. MCP Streamable HTTP（JSON-RPC 2.0，POST 到同一 URL）
 *   2. 旧版 MCP SSE（GET 事件流 + POST /messages，结果按 id 回传）
 *   3. 兼容旧版 REST 风格（GET /tools, POST /tools/:name）
 *
 * 优先尝试 JSON-RPC，失败则自动降级到 REST。
 */
export class HTTPMCPClient implements MCPClient {
  private connected = false
  private cachedTools: MCPToolDefinition[] = []
  private mode: 'jsonrpc' | 'rest' = 'jsonrpc'
  private sessionId?: string
  private legacySse?: LegacySseSession
  private process?: ChildProcessWithoutNullStreams
  private processStartedAt = 0
  private stdioBuffer = Buffer.alloc(0)
  private stdioPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(private readonly config: MCPServerConfig, private readonly securityContext: NetworkContext = { tenantId: 'default', sessionId: '' }) {
    validateOperationTimeout(config.timeoutMs)
  }

  private requestSignal(defaultMs: number, signal?: AbortSignal): AbortSignal | undefined {
    const timeoutMs = this.config.timeoutMs ?? defaultMs
    return timeoutMs === 0 ? signal : signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  }

  private httpTimeoutOptions() {
    return { timeoutMs: this.config.timeoutMs, overridePolicyTimeout: this.config.timeoutMs !== undefined }
  }

  // ── JSON-RPC 2.0 请求 ─────────────────────────────────────────────────────
  private async rpc<T>(method: string, params: unknown = {}, signal?: AbortSignal, ctx = this.securityContext): Promise<T> {
    throwIfAborted(signal)
    const id = _rpcId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    if (this.config.transportType === 'stdio') {
      return this.stdioRpc<T>(id, body, signal)
    }
    if (this.config.transportType === 'sse') return this.legacySseRpc<T>(id, body, signal, ctx)
    const endpoint = this.config.url
    if (!endpoint) throw new Error('MCP server URL is not configured')

    const res = await guardedHttp(endpoint, ctx, 'mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.config.headers,
      },
      body,
      stream: true,
      signal: this.requestSignal(15_000, signal),
      ...this.httpTimeoutOptions(),
    })

    if (!res.ok) {
      throw new Error(`MCP JSON-RPC ${res.status}: ${await res.text()}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    const sessionHeader = res.headers.get('mcp-session-id')
    if (sessionHeader) this.sessionId = sessionHeader

    // Streamable HTTP may keep an SSE response open. Read only until the
    // matching JSON-RPC id, then cancel the reader so the request is released.
    if (contentType.includes('text/event-stream')) {
      if (!res.body) throw new Error('MCP SSE: empty response stream')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          buffer += decoder.decode(next.value, { stream: true })
          const events = buffer.split(/\r?\n\r?\n/)
          buffer = events.pop() ?? ''
          for (const event of events) {
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
            if (!data || data === '[DONE]') continue
            const json = JSON.parse(data) as JsonRpcResponse<T>
            if (json.id !== id) continue
            if (json.error) throw new Error(`MCP error: ${json.error.message}`)
            return json.result as T
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      throw new Error('MCP SSE: matching response not received')
    }

    // 普通 JSON
    const json = (await res.json()) as JsonRpcResponse<T>
    if (json.error) throw new Error(`MCP error: ${json.error.message}`)
    return json.result as T
  }

  private async stdioRpc<T>(id: number, body: string, signal?: AbortSignal): Promise<T> {
    if (!this.process) throw new Error('MCP stdio process is not running')
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined
    const promise = new Promise<T>((resolve, reject) => {
      this.stdioPending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const timeoutMs = this.config.timeoutMs ?? 15_000
      if (timeoutMs > 0) timeout = setTimeout(() => {
        const pending = this.stdioPending.get(id)
        if (pending) { this.stdioPending.delete(id); pending.reject(new Error('MCP stdio request timed out')) }
      }, timeoutMs)
    })
    this.process.stdin.write(`${body}\n`)
    if (signal) {
      const abort = () => {
        const pending = this.stdioPending.get(id)
        if (pending) { this.stdioPending.delete(id); pending.reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError')) }
      }
      abortHandler = abort
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    return promise.finally(() => {
      this.stdioPending.delete(id)
      if (timeout) clearTimeout(timeout)
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    })
  }

  private acceptStdioData(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.stdioBuffer = Buffer.concat([this.stdioBuffer, incoming])
    // Accept both newline-delimited JSON and Content-Length framed JSON.
    for (;;) {
      let payload: string | undefined
      const marker = this.stdioBuffer.indexOf(Buffer.from('\r\n\r\n'))
      if (marker >= 0 && /^Content-Length:\s*\d+/i.test(this.stdioBuffer.subarray(0, marker).toString('ascii'))) {
        const header = this.stdioBuffer.subarray(0, marker).toString('ascii')
        const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1])
        const start = marker + 4
        if (this.stdioBuffer.length - start < length) return
        payload = this.stdioBuffer.subarray(start, start + length).toString('utf8')
        this.stdioBuffer = this.stdioBuffer.slice(start + length)
      } else {
        const newline = this.stdioBuffer.indexOf(0x0a)
        if (newline < 0) return
        payload = this.stdioBuffer.subarray(0, newline).toString('utf8').trim()
        this.stdioBuffer = this.stdioBuffer.slice(newline + 1)
      }
      if (!payload) continue
      try {
        const message = JSON.parse(payload) as JsonRpcResponse<unknown>
        if (typeof message.id !== 'number') continue
        const pending = this.stdioPending.get(message.id)
        if (!pending) continue
        this.stdioPending.delete(message.id)
        if (message.error) pending.reject(new Error(`MCP error: ${message.error.message}`))
        else pending.resolve(message.result)
      } catch {
        // Server logs on stdout are ignored; only valid JSON-RPC responses resolve calls.
      }
    }
  }

  private async initialize(protocolVersion = '2025-06-18', signal?: AbortSignal): Promise<void> {
    const result = await this.rpc<{ protocolVersion?: string }>('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'aether-code', version: '2.0.0' },
    }, signal)
    if (!result) throw new Error('MCP initialize returned no result')
    if (this.config.transportType !== 'stdio' && this.config.url) {
      // Notification is best-effort: it must not hold the connection open waiting
      // for a response (notifications intentionally have no JSON-RPC id).
      await this.notifyHttp('notifications/initialized', {}, signal).catch(() => { throwIfAborted(signal) })
    } else if (this.process) {
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {}})}\n`)
    }
  }

  private async notifyHttp(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const endpoint = this.legacySse?.endpoint ?? this.config.url
    if (!endpoint) return
    const response = await guardedHttp(endpoint, this.securityContext, 'mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}), ...this.config.headers },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }), signal: this.requestSignal(5_000, signal),
      ...this.httpTimeoutOptions(),
    })
    if (!response.ok) throw new Error(`MCP notification ${response.status}`)
  }

  private async legacySseRpc<T>(id: number, body: string, signal?: AbortSignal, ctx = this.securityContext): Promise<T> {
    const session = this.legacySse
    if (!session?.endpoint || session.closed) throw new Error('MCP SSE session is not connected')
    throwIfAborted(signal)
    const deadline = new AbortController()
    const timeoutMs = this.config.timeoutMs ?? 15_000
    const timer = timeoutMs > 0 ? setTimeout(() => deadline.abort(new Error('MCP SSE request timed out')), timeoutMs) : undefined
    const requestSignal = AbortSignal.any([session.controller.signal, deadline.signal, ...(signal ? [signal] : [])])
    const pending = new Promise<T>((resolve, reject) => {
      session.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
    const abortHandler = () => {
      const item = session.pending.get(id)
      session.pending.delete(id)
      item?.reject(requestSignal.reason)
    }
    requestSignal.addEventListener('abort', abortHandler, { once: true })
    if (requestSignal.aborted) abortHandler()
    try {
      const acknowledgement = guardedHttp(session.endpoint, ctx, 'mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.config.headers },
        body,
        signal: requestSignal,
        stream: true,
        ...this.httpTimeoutOptions(),
      }).then(async response => {
        try {
          if (!response.ok) throw new Error(`MCP SSE POST ${response.status}`)
          // Legacy responses arrive on GET; some bridges also return JSON on POST.
          if ((response.headers.get('content-type') ?? '').includes('application/json') && response.status !== 202) {
            const json = (await response.json()) as JsonRpcResponse<T>
            const item = session.pending.get(id)
            if (json.id === id && item) {
              session.pending.delete(id)
              if (json.error) item.reject(new Error(`MCP error: ${json.error.message}`))
              else item.resolve(json.result)
            }
          }
        } finally {
          await response.body?.cancel().catch(() => undefined)
        }
      })
      // Attach handlers to both immediately: the GET result may precede POST's
      // acknowledgement, including errors and cancellation.
      const [result] = await Promise.all([pending, acknowledgement])
      return result
    } catch (error) {
      deadline.abort(error)
      throwIfAborted(signal)
      throw error
    } finally {
      clearTimeout(timer)
      requestSignal.removeEventListener('abort', abortHandler)
      session.pending.delete(id)
    }
  }

  private closeLegacySse(session: LegacySseSession, error: unknown): void {
    if (session.closed) return
    session.closed = true
    if (this.legacySse === session) {
      this.legacySse = undefined
      this.connected = false
      this.cachedTools = []
    }
    session.rejectEndpoint(error)
    for (const pending of session.pending.values()) pending.reject(error)
    session.pending.clear()
    session.controller.abort(error)
    void session.reader?.cancel().catch(() => undefined)
  }

  private async readLegacySse(session: LegacySseSession, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!session.closed) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() ?? ''
        if (buffer.length > 1024 * 1024 || frames.some(frame => frame.length > 1024 * 1024)) throw new Error('MCP SSE event exceeds 1 MiB')
        for (const frame of frames) {
          const parsed = parseSseEvent(frame)
          if (!parsed.data) continue
          if (parsed.event === 'endpoint') {
            const endpoint = new URL(parsed.data, this.config.url)
            const origin = new URL(this.config.url!)
            if (endpoint.origin !== origin.origin || endpoint.username || endpoint.password) throw new Error('MCP SSE endpoint must have the same origin as the stream')
            if (session.endpoint && session.endpoint !== endpoint.href) throw new Error('MCP SSE endpoint changed during the session')
            session.endpoint = endpoint.href
            session.resolveEndpoint()
            continue
          }
          if (parsed.event === 'end') {
            throw new Error('MCP SSE stream ended')
          }
          if (parsed.event !== 'message') continue
          let message: JsonRpcResponse<unknown>
          try { message = JSON.parse(parsed.data) as JsonRpcResponse<unknown> } catch { continue }
          if (typeof message.id !== 'number') continue
          const pending = session.pending.get(message.id)
          if (!pending) continue
          session.pending.delete(message.id)
          if (message.error) pending.reject(new Error(`MCP error: ${message.error.message}`))
          else pending.resolve(message.result)
        }
      }
      if (!session.closed) throw new Error('MCP SSE stream closed')
    } catch (error) {
      this.closeLegacySse(session, error)
    } finally {
      reader.releaseLock()
    }
  }

  /** Legacy MCP SSE handshake: keep GET open while POSTs return 202. */
  private async connectLegacySse(signal?: AbortSignal): Promise<void> {
    if (!this.config.url) throw new Error('MCP SSE URL is not configured')
    throwIfAborted(signal)
    let resolveEndpoint!: () => void
    let rejectEndpoint!: (error: unknown) => void
    const endpointPromise = new Promise<void>((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject })
    // Observe early cancellation while headers have not arrived yet.
    void endpointPromise.catch(() => undefined)
    const session: LegacySseSession = { controller: new AbortController(), closed: false, pending: new Map(), resolveEndpoint, rejectEndpoint }
    this.legacySse = session
    const abortHandler = () => this.closeLegacySse(session, signal?.reason ?? new DOMException('Operation cancelled', 'AbortError'))
    if (signal) signal.addEventListener('abort', abortHandler, { once: true })
    if (signal?.aborted) abortHandler()
    const timeoutMs = this.config.timeoutMs ?? 15_000
    const endpointTimer = timeoutMs > 0 ? setTimeout(() => this.closeLegacySse(session, new Error('MCP SSE endpoint timed out')), timeoutMs) : undefined
    try {
      const response = await guardedHttp(this.config.url, this.securityContext, 'mcp-discovery', {
        headers: { Accept: 'text/event-stream', ...this.config.headers },
        stream: true,
        signal: session.controller.signal,
        ...this.httpTimeoutOptions(),
      })
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel()
        throw new Error(`MCP SSE ${response.status}: expected an event stream`)
      }
      const reader = response.body.getReader()
      session.reader = reader
      void this.readLegacySse(session, reader)
      await endpointPromise
      throwIfAborted(signal)
    } catch (error) {
      this.closeLegacySse(session, error)
      throwIfAborted(signal)
      throw error
    } finally {
      clearTimeout(endpointTimer)
      if (signal) signal.removeEventListener('abort', abortHandler)
    }
  }

  // ── REST 降级：GET /tools ─────────────────────────────────────────────────
  private async restListTools(signal?: AbortSignal): Promise<MCPToolDefinition[]> {
    const res = await guardedHttp(`${this.config.url}/tools`, this.securityContext, 'mcp-discovery', {
      headers: this.config.headers,
      signal: this.requestSignal(10_000, signal),
      ...this.httpTimeoutOptions(),
    })
    if (!res.ok) throw new Error(`REST /tools ${res.status}`)
    const data = (await res.json()) as { tools: MCPToolDefinition[] }
    return data.tools ?? []
  }

  // ── REST 降级：POST /tools/:name ─────────────────────────────────────────
  private async restCallTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, ctx = this.securityContext): Promise<string> {
    const res = await guardedHttp(`${this.config.url}/tools/${encodeURIComponent(name)}`, ctx, 'mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.config.headers },
      body: JSON.stringify(args),
      signal: this.requestSignal(30_000, signal),
      ...this.httpTimeoutOptions(),
    })
    if (!res.ok) throw new Error(`REST /tools/${name} ${res.status}`)
    const data = (await res.json()) as { result?: string; content?: Array<{type:string;text?:string}> }
    // 兼容 MCP content 格式
    if (data.content) {
      return data.content.map((c) => c.text ?? '').join('\n')
    }
    return String(data.result ?? JSON.stringify(data))
  }

  // ── 公开接口 ──────────────────────────────────────────────────────────────

  async connect(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (this.config.transportType === 'stdio') {
      if (!this.config.command) throw new Error('MCP stdio command is not configured')
      this.processStartedAt = Date.now()
      const child = spawn(this.config.command, this.config.args ?? [], {
        env: { ...process.env, ...(this.config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
      this.process = child
      child.stdout.on('data', chunk => { if (this.process === child) this.acceptStdioData(chunk) })
      // Drain diagnostics so a chatty MCP server cannot block on a full stderr pipe.
      child.stderr.on('data', () => undefined)
      const failure = (error: Error) => { for (const pending of this.stdioPending.values()) pending.reject(error); this.stdioPending.clear() }
      child.once('error', error => { if (this.process === child) failure(error) })
      child.once('exit', code => { if (this.process === child && code !== 0) failure(new Error(`MCP stdio exited with code ${code ?? 'unknown'}`)) })
      try {
        try { await this.initialize('2025-06-18', signal) } catch (error) {
          // Older servers commonly advertise 2024-11-05 only.
          if (!(error instanceof Error) || !/protocol|version|initialize/i.test(error.message)) throw error
          await this.initialize('2024-11-05', signal)
        }
        const result = await this.rpc<{ tools: MCPToolDefinition[] }>('tools/list', {}, signal)
        this.cachedTools = result.tools ?? []
        this.mode = 'jsonrpc'
        this.connected = true
        return
      } catch (error) {
        await this.disconnect()
        throw error
      }
    }
    if (this.config.transportType === 'sse') {
      await this.connectLegacySse(signal)
      try {
        try { await this.initialize('2025-06-18', signal) } catch (error) {
          if (!(error instanceof Error) || !/protocol|version|initialize/i.test(error.message)) throw error
          await this.initialize('2024-11-05', signal)
        }
        const result = await this.rpc<{ tools: MCPToolDefinition[] }>('tools/list', {}, signal)
        this.cachedTools = result.tools ?? []
        this.mode = 'jsonrpc'
        this.connected = true
        return
      } catch (error) {
        await this.disconnect()
        throw error
      }
    }
    // 先尝试 JSON-RPC（MCP 标准）
    try {
      try { await this.initialize('2025-06-18', signal) } catch (error) {
        if (!(error instanceof Error) || !/protocol|version|initialize/i.test(error.message)) throw error
          await this.initialize('2024-11-05', signal)
      }
      const result = await this.rpc<{ tools: MCPToolDefinition[] }>('tools/list', {}, signal)
      this.cachedTools = result.tools ?? []
      this.mode = 'jsonrpc'
      this.connected = true
      return
    } catch (_jsonrpcErr) {
      throwIfAborted(signal)
      // A few older JSON-RPC MCP bridges omit initialize. Keep compatibility
      // by trying direct discovery before falling back to REST.
      try {
        const result = await this.rpc<{ tools: MCPToolDefinition[] }>('tools/list', {}, signal)
        this.cachedTools = result.tools ?? []
        this.mode = 'jsonrpc'
        this.connected = true
        return
      } catch {
        throwIfAborted(signal)
        // JSON-RPC failed, continue with REST discovery.
      }
      // JSON-RPC 失败，降级尝试 REST
    }

    try {
      this.cachedTools = await this.restListTools(signal)
      this.mode = 'rest'
      this.connected = true
    } catch (restErr) {
      // Lazy discovery is part of callTool(), so cancellation must preserve
      // the caller's AbortError instead of being wrapped as a connection
      // failure after the JSON-RPC/REST fallbacks all observe the abort.
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('MCP request aborted')
      throw new Error(
        `Failed to connect to MCP server "${this.config.name}": ${restErr instanceof Error ? restErr.message : restErr}`,
      )
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.cachedTools = []
    for (const pending of this.stdioPending.values()) pending.reject(new Error('MCP client disconnected'))
    this.stdioPending.clear()
    const child = this.process
    this.process = undefined
    this.stdioBuffer = Buffer.alloc(0)
    this.sessionId = undefined
    const sse = this.legacySse
    if (sse) {
      this.closeLegacySse(sse, new Error('MCP client disconnected'))
      await sse.reader?.cancel().catch(() => undefined)
    }
    if (child) await stopCommandProcessTree(child, this.processStartedAt)
  }

  async listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]> {
    throwIfAborted(signal)
    if (!this.connected) await this.connect(signal)
    return this.cachedTools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, ctx = this.securityContext): Promise<string> {
    throwIfAborted(signal)
    const denied = extensionPolicy(ctx)
    if (denied) throw new Error(denied.output)
    if (!this.connected) await this.connect(signal)
    if (this.mode === 'jsonrpc') {
      const result = await this.rpc<{
        content?: Array<{ type: string; text?: string }>
        result?: unknown
        isError?: boolean
      }>('tools/call', { name, arguments: args }, signal, ctx)
      if (result.isError) throw new Error(result.content?.map(c => c.text ?? '').join('\n') || 'MCP tool reported an error')

      // MCP 标准返回 content 数组
      if (result.content) {
        return result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n')
      }
      return JSON.stringify(result)
    }
    return this.restCallTool(name, args, signal, ctx)
  }

  async toTools(signal?: AbortSignal): Promise<Tool[]> {
    const definitions = await this.listTools(signal)
    // Discovery must not leave one child process or long-lived SSE stream per
    // chat registry alive. Those transports reconnect lazily on tool call.
    if (this.config.transportType === 'stdio' || this.config.transportType === 'sse') await this.disconnect()
    throwIfAborted(signal)
    const client = this

    return definitions.map((def): Tool & { source: string } => ({
      name: `mcp_${(this.config.id ?? this.config.name).replace(/[^a-zA-Z0-9_-]/g, '_')}_${def.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      source: 'mcp',
      preflight: async (_args, ctx) => extensionPolicy(ctx),
      description: `[MCP:${this.config.name}] ${def.description}`,
      parameters: {
        type: 'object',
        ...(def.inputSchema ?? {}),
      },
      async execute(rawArgs: unknown, _ctx: AgentContext): Promise<ToolResult> {
        const invocationClient = client.config.transportType === 'stdio' || client.config.transportType === 'sse'
          ? new HTTPMCPClient(client.config, { tenantId: _ctx.tenantId, sessionId: _ctx.sessionId })
          : client
        try {
          const output = await invocationClient.callTool(def.name, rawArgs as Record<string, unknown>, _ctx.signal, _ctx)
          return { success: true, output }
        } catch (err) {
          throwIfAborted(_ctx.signal)
          return {
            success: false,
            output: `MCP tool error: ${err instanceof Error ? err.message : 'unknown error'}`,
          }
        } finally {
          if (invocationClient !== client) await invocationClient.disconnect()
        }
      },
    }))
  }
}

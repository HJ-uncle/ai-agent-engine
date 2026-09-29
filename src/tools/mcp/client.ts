import { throwIfAborted } from '../../core/utils/abort.js'
import type { MCPClient, MCPServerConfig, MCPToolDefinition } from './types.js'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'

let _rpcId = 1

interface JsonRpcResponse<T> {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

/**
 * MCP HTTP 客户端 —— 支持两种协议：
 *   1. MCP Streamable HTTP（JSON-RPC 2.0，POST 到同一 URL）
 *   2. 兼容旧版 REST 风格（GET /tools, POST /tools/:name）
 *
 * 优先尝试 JSON-RPC，失败则自动降级到 REST。
 */
export class HTTPMCPClient implements MCPClient {
  private connected = false
  private cachedTools: MCPToolDefinition[] = []
  private mode: 'jsonrpc' | 'rest' = 'jsonrpc'

  constructor(private readonly config: MCPServerConfig) {}

  // ── JSON-RPC 2.0 请求 ─────────────────────────────────────────────────────
  private async rpc<T>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal)
    const id = _rpcId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    const res = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.config.headers,
      },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      throw new Error(`MCP JSON-RPC ${res.status}: ${await res.text()}`)
    }

    const contentType = res.headers.get('content-type') ?? ''

    // Streamable HTTP 可能返回 SSE —— 读取第一个 data: 行
    if (contentType.includes('text/event-stream')) {
      const text = await res.text()
      const dataLine = text.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) throw new Error('MCP SSE: no data line')
      const json = JSON.parse(dataLine.slice(5).trim()) as JsonRpcResponse<T>
      if (json.error) throw new Error(`MCP error: ${json.error.message}`)
      return json.result as T
    }

    // 普通 JSON
    const json = (await res.json()) as JsonRpcResponse<T>
    if (json.error) throw new Error(`MCP error: ${json.error.message}`)
    return json.result as T
  }

  // ── REST 降级：GET /tools ─────────────────────────────────────────────────
  private async restListTools(): Promise<MCPToolDefinition[]> {
    const res = await fetch(`${this.config.url}/tools`, {
      headers: this.config.headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`REST /tools ${res.status}`)
    const data = (await res.json()) as { tools: MCPToolDefinition[] }
    return data.tools ?? []
  }

  // ── REST 降级：POST /tools/:name ─────────────────────────────────────────
  private async restCallTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.config.url}/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.config.headers },
      body: JSON.stringify(args),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
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

  async connect(): Promise<void> {
    // 先尝试 JSON-RPC（MCP 标准）
    try {
      const result = await this.rpc<{ tools: MCPToolDefinition[] }>('tools/list')
      this.cachedTools = result.tools ?? []
      this.mode = 'jsonrpc'
      this.connected = true
      return
    } catch (_jsonrpcErr) {
      // JSON-RPC 失败，降级尝试 REST
    }

    try {
      this.cachedTools = await this.restListTools()
      this.mode = 'rest'
      this.connected = true
    } catch (restErr) {
      throw new Error(
        `Failed to connect to MCP server "${this.config.name}": ${restErr instanceof Error ? restErr.message : restErr}`,
      )
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.cachedTools = []
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.connected) await this.connect()
    return this.cachedTools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (this.mode === 'jsonrpc') {
      const result = await this.rpc<{
        content?: Array<{ type: string; text?: string }>
        result?: unknown
        isError?: boolean
      }>('tools/call', { name, arguments: args }, signal)
      if (result.isError) throw new Error(result.content?.map(c => c.text ?? '').join('\n') || 'MCP tool reported an error')

      // MCP 标准返回 content 数组
      if (result.content) {
        return result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n')
      }
      return JSON.stringify(result)
    }
    return this.restCallTool(name, args, signal)
  }

  async toTools(): Promise<Tool[]> {
    const definitions = await this.listTools()
    const client = this

    return definitions.map((def): Tool => ({
      name: `mcp_${this.config.name}_${def.name}`,
      description: `[MCP:${this.config.name}] ${def.description}`,
      parameters: {
        type: 'object',
        ...(def.inputSchema ?? {}),
      },
      async execute(rawArgs: unknown, _ctx: AgentContext): Promise<ToolResult> {
        try {
          const output = await client.callTool(def.name, rawArgs as Record<string, unknown>, _ctx.signal)
          return { success: true, output }
        } catch (err) {
          throwIfAborted(_ctx.signal)
          return {
            success: false,
            output: `MCP tool error: ${err instanceof Error ? err.message : 'unknown error'}`,
          }
        }
      },
    }))
  }
}

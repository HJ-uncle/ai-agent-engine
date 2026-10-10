import type { Tool } from '../../core/agent-context/index.js'

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPServerConfig {
  id?: string
  name: string
  transportType?: 'stdio' | 'sse' | 'http' | 'streamableHttp'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  /** Per-operation deadline in ms. Omitted preserves transport defaults; 0 disables the deadline. */
  timeoutMs?: number
}

export interface MCPClient {
  connect(signal?: AbortSignal): Promise<void>
  disconnect(): Promise<void>
  listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]>
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
  toTools(signal?: AbortSignal): Promise<Tool[]>
}

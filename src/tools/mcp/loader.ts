import { HTTPMCPClient } from './client.js'
import type { IToolRegistry } from '../../core/agent-context/index.js'
import { logger } from '../../observability/index.js'
import { listServers } from '../../storage/mcp/mcp-config.js'
import type { NetworkContext } from '../../security/guarded-http.js'

/**
 * 内联 MCP server 配置（来自客户端请求级透传，如 桌面客户端）
 * 仅作"运行时临时挂载"，不会写入 mcp.config.json。
 */
interface InlineMcpServer {
  id: string
  name: string
  transportType: 'stdio' | 'sse' | 'http' | 'streamableHttp'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/**
 * 从 mcp.config.json 读取所有已启用的 MCP 服务器，
 * 连接并将其工具注册到 registry。
 * 连接失败的服务器会被跳过（不影响其他工具）。
 *
 * @param inlineServers - 客户端透传的临时 MCP server 列表（可选）。
 *   仅追加 http/sse/streamableHttp 三种远程协议；stdio 跳过（agent-engine
 *   无法接管 客户端启动的 stdio 子进程）。inline server 通过 id 与
 *   本地 mcp.config.json 中的 server 去重，本地优先。
 */
export async function registerMCPTools(
  registry: IToolRegistry,
  toolFilter?: (name: string) => boolean,
  inlineServers?: InlineMcpServer[],
  securityContext?: NetworkContext
): Promise<string[]> {
  const registeredNames: string[] = []
  const localServers = listServers()

  // ── 合并 inlineServers（去重 + 仅保留远程协议） ─────────────────────────
  const localIds = new Set(localServers.map(s => s.id))
  const validInlineServers: InlineMcpServer[] = []
  if (Array.isArray(inlineServers) && inlineServers.length > 0) {
    for (const s of inlineServers) {
      if (!s || !s.id || !s.name) continue
      if (localIds.has(s.id)) {
        logger.debug({ id: s.id }, 'Inline MCP server overridden by local config, skipping')
        continue
      }
      if (s.transportType === 'stdio') {
        logger.info({ id: s.id }, 'Inline MCP stdio transport not supported across processes, skipping')
        continue
      }
      if (!s.url) {
        logger.warn({ id: s.id }, 'Inline MCP server has no url, skipping')
        continue
      }
      validInlineServers.push(s)
    }
  }

  if (localServers.length === 0 && validInlineServers.length === 0) return registeredNames

  // 本地 mcp.config.json 中的 server（保留原行为）
  await Promise.allSettled(
    localServers.map(async (server) => {
      // 跳过禁用的服务器
      if (!server.enabled) {
        logger.info({ id: server.id }, 'MCP server disabled, skipping')
        return
      }
      // stdio 类型暂不支持（需要子进程）
      if (server.transportType === 'stdio') {
        logger.info({ id: server.id }, 'MCP stdio transport not yet supported, skipping')
        return
      }
      if (!server.url) {
        logger.warn({ id: server.id }, 'MCP server has no url, skipping')
        return
      }

      const client = new HTTPMCPClient({
        name: server.name || server.id,
        url: server.url,
        headers: server.headers,
      }, securityContext)

      try {
        const tools = await client.toTools()
        tools.forEach((t) => {
          if (toolFilter && !toolFilter(t.name)) return
          try {
            registry.register(t)
            registeredNames.push(t.name)
          } catch { /* 工具名冲突时跳过 */ }
        })
        logger.info({ id: server.id, toolCount: tools.length }, 'MCP server registered')
      } catch (err) {
        logger.warn({ id: server.id, url: server.url, err }, 'MCP server unavailable, skipping')
      }
    }),
  )

  // 客户端 inline server（请求级临时挂载）
  await Promise.allSettled(
    validInlineServers.map(async (server) => {
      const client = new HTTPMCPClient({
        name: server.name || server.id,
        url: server.url!,
        headers: server.headers,
      }, securityContext)
      try {
        const tools = await client.toTools()
        tools.forEach((t) => {
          if (toolFilter && !toolFilter(t.name)) return
          try {
            registry.register(t)
            registeredNames.push(t.name)
          } catch { /* 工具名冲突时跳过 */ }
        })
        logger.info(
          { id: server.id, name: server.name, url: server.url, toolCount: tools.length },
          'Inline MCP server registered (request-level)'
        )
      } catch (err) {
        logger.warn(
          { id: server.id, name: server.name, url: server.url, err },
          'Inline MCP server unavailable, skipping'
        )
      }
    }),
  )

  return registeredNames
}

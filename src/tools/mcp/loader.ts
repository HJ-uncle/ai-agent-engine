import { HTTPMCPClient } from './client.js'
import type { IToolRegistry } from '../../core/agent-context/index.js'
import { logger } from '../../observability/index.js'
import { listServers } from '../../storage/mcp/mcp-config.js'

/**
 * 从 mcp.config.json 读取所有已启用的 MCP 服务器，
 * 连接并将其工具注册到 registry。
 * 连接失败的服务器会被跳过（不影响其他工具）。
 */
export async function registerMCPTools(registry: IToolRegistry): Promise<void> {
  const servers = listServers()
  if (servers.length === 0) return

  await Promise.allSettled(
    servers.map(async (server) => {
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
        name: server.id,
        url: server.url,
        headers: server.headers,
      })

      try {
        const tools = await client.toTools()
        tools.forEach((t) => {
          try { registry.register(t) } catch { /* 工具名冲突时跳过 */ }
        })
        logger.info({ id: server.id, toolCount: tools.length }, 'MCP server registered')
      } catch (err) {
        logger.warn({ id: server.id, url: server.url, err }, 'MCP server unavailable, skipping')
      }
    }),
  )
}

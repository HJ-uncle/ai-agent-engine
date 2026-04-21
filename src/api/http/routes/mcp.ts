/**
 * MCP 服务器配置 CRUD 路由
 * 所有操作直接读写 mcp.config.json
 *
 * GET    /api/v1/mcp/servers              列出所有
 * POST   /api/v1/mcp/servers              新增
 * GET    /api/v1/mcp/servers/:id          获取单个
 * PUT    /api/v1/mcp/servers/:id          全量更新
 * PATCH  /api/v1/mcp/servers/:id          部分更新
 * DELETE /api/v1/mcp/servers/:id          删除
 * POST   /api/v1/mcp/servers/:id/enable   启用
 * POST   /api/v1/mcp/servers/:id/disable  禁用
 * POST   /api/v1/mcp/servers/:id/test     测试连接并返回工具列表
 */

import type { FastifyInstance } from 'fastify'
import {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  toggleServer,
  type McpServerRecord,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
} from '../../../storage/mcp/mcp-config.js'
import { HTTPMCPClient } from '../../../tools/mcp/client.js'
import { logger } from '../../../observability/index.js'
import { success, fail, paginateArray } from '../response.js'

export async function mcpRoutes(fastify: FastifyInstance) {
  // ── List ────────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/mcp/servers', async (req, reply) => {
    const { current, pageSize } = req.query
    return reply.code(200).send(paginateArray(listServers(), current, pageSize))
  })

  // ── Create ──────────────────────────────────────────────────────────────────
  fastify.post<{ Body: CreateMcpServerInput }>('/mcp/servers', async (req, reply) => {
    const { id, name, transportType } = req.body

    if (!id || typeof id !== 'string') {
      return reply.code(200).send(fail(40001, 'id is required'))
    }
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(id)) {
      return reply.code(200).send(fail(40001, 'id must be lowercase alphanumeric with hyphens/underscores'))
    }
    if (!name) {
      return reply.code(200).send(fail(40001, 'name is required'))
    }
    if (!transportType) {
      return reply.code(200).send(fail(40001, 'transportType is required (stdio|sse|http|streamableHttp)'))
    }
    if (transportType !== 'stdio' && !req.body.url) {
      return reply.code(200).send(fail(40001, 'url is required for non-stdio transport'))
    }
    if (transportType === 'stdio' && !req.body.command) {
      return reply.code(200).send(fail(40001, 'command is required for stdio transport'))
    }

    try {
      const entry = createServer({ ...req.body, enabled: req.body.enabled ?? true, isBuiltIn: req.body.isBuiltIn ?? false, description: req.body.description ?? '' })
      return reply.code(200).send(success(entry))
    } catch (err: any) {
      return reply.code(200).send(fail(40900, err instanceof Error ? err.message : 'Conflict'))
    }
  })

  // ── Get one ─────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/mcp/servers/:id', async (req, reply) => {
    const server = getServer(req.params.id)
    if (!server) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(server))
  })

  // ── Full update ─────────────────────────────────────────────────────────────
  fastify.put<{ Params: { id: string }; Body: UpdateMcpServerInput }>('/mcp/servers/:id', async (req, reply) => {
    const updated = updateServer(req.params.id, req.body)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Partial update ──────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string }; Body: UpdateMcpServerInput }>('/mcp/servers/:id', async (req, reply) => {
    const updated = updateServer(req.params.id, req.body)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Delete ───────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/mcp/servers/:id', async (req, reply) => {
    const ok = deleteServer(req.params.id)
    if (!ok) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success({ deleted: true }))
  })

  // ── Enable ───────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/mcp/servers/:id/enable', async (req, reply) => {
    const updated = toggleServer(req.params.id, true)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Disable ──────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/mcp/servers/:id/disable', async (req, reply) => {
    const updated = toggleServer(req.params.id, false)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Test connection ───────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/mcp/servers/:id/test', async (req, reply) => {
    const server = getServer(req.params.id)
    if (!server) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }

    try {
      if (!server.url) {
        return reply.code(200).send(fail(40001, 'Server has no URL configured'))
      }
      const client = new HTTPMCPClient({ name: server.id, url: server.url, headers: server.headers })
      const tools = await client.toTools()
      return reply.code(200).send(success({
        success: true,
        toolCount: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      }))
    } catch (err) {
      logger.warn({ id: server.id, err }, 'MCP server test failed')
      return reply.code(200).send(fail(50000, err instanceof Error ? err.message : 'Connection failed'))
    }
  })
}

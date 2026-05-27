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

import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  toggleServer,
} from '../../../storage/mcp/mcp-config.js'
import { HTTPMCPClient } from '../../../tools/mcp/client.js'
import { logger } from '../../../observability/index.js'
import { success, fail, paginateArray } from '../response.js'
import { z } from 'zod'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

// ── Validation Schemas ──────────────────────────────────────────────────────
const McpBaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/, 'id 必须是小写字母、数字、连字符或下划线'),
  name: z.string().min(1, 'name 不能为空'),
  description: z.string().optional().default(''),
  transportType: z.enum(['stdio', 'sse', 'http', 'streamableHttp']),
  url: z.string().url('无效的 URL 格式').optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().optional().default(true),
  isBuiltIn: z.boolean().optional().default(false),
})

const CreateMcpSchema = McpBaseSchema.refine(data => {
  if (data.transportType !== 'stdio' && !data.url) return false
  if (data.transportType === 'stdio' && !data.command) return false
  return true
}, {
  message: '非 stdio 传输必须提供 url，stdio 传输必须提供 command',
})

const UpdateMcpSchema = McpBaseSchema.partial()

export async function mcpRoutes(fastify: FastifyInstance) {
  // ── List ────────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/mcp/servers', async (req, reply) => {
    const { current, pageSize } = req.query
    return reply.code(200).send(paginateArray(listServers(), current, pageSize))
  })

  // ── Create ──────────────────────────────────────────────────────────────────
  fastify.post('/mcp/servers', async (req, reply) => {
    const result = CreateMcpSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    try {
      const entry = createServer(result.data)
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
  fastify.put<{ Params: { id: string } }>('/mcp/servers/:id', async (req, reply) => {
    const result = UpdateMcpSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const updated = updateServer(req.params.id, result.data)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Partial update ──────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/mcp/servers/:id', async (req, reply) => {
    const result = UpdateMcpSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const updated = updateServer(req.params.id, result.data)
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
      const client = new HTTPMCPClient({ name: server.name || server.id, url: server.url, headers: server.headers })
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

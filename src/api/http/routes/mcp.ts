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
  importConfigDocument,
  exportConfigDocument,
} from '../../../storage/mcp/mcp-config.js'
import { HTTPMCPClient } from '../../../tools/mcp/client.js'
import { logger } from '../../../observability/index.js'
import { success, fail, paginateArray } from '../response.js'
import { z } from 'zod'
import { MAX_OPERATION_TIMEOUT_MS } from '../../../core/utils/operation-timeout.js'

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
  timeoutMs: z.number().int().min(0).max(MAX_OPERATION_TIMEOUT_MS).nullable().optional().transform(value => value ?? undefined),
  disabledTools: z.array(z.string().min(1)).optional().default([]),
  enabled: z.boolean().optional().default(true),
  isBuiltIn: z.boolean().optional().default(false),
  /** 保存层级：project（默认）| global（~/.aether/mcp.json，多项目共享） */
  scope: z.enum(['project', 'global']).optional(),
})

const CreateMcpSchema = McpBaseSchema.refine(data => {
  if (data.transportType !== 'stdio' && !data.url) return false
  if (data.transportType === 'stdio' && !data.command) return false
  return true
}, {
  message: '非 stdio 传输必须提供 url，stdio 传输必须提供 command',
})

const UpdateMcpSchema = McpBaseSchema.omit({ id: true, isBuiltIn: true, scope: true }).partial()

export async function mcpRoutes(fastify: FastifyInstance) {
  // ── List ────────────────────────────────────────────────────────────────────
  type ProjectQuery = { path?: string; scope?: 'project' | 'global' }
  const projectPath = (req: FastifyRequest<{ Querystring: ProjectQuery }>): string | undefined => {
    const value = req.query?.path
    return typeof value === 'string' && value.trim() ? value : undefined
  }

  fastify.get<{ Querystring: ProjectQuery & { current?: number; pageSize?: number } }>('/mcp/servers', async (req, reply) => {
    const { current, pageSize } = req.query
    return reply.code(200).send(paginateArray(listServers(projectPath(req), req.query.scope), current, pageSize))
  })

  // JSON-first import/export. Import validates the entire document before the
  // single atomic rename performed by the storage layer.
  fastify.get<{ Querystring: ProjectQuery }>('/mcp/config/export', async (req, reply) => {
    const scope = req.query.scope
    return reply.code(200).send(success(exportConfigDocument(projectPath(req), scope)))
  })

  fastify.post<{ Querystring: ProjectQuery; Body: { scope?: 'project' | 'global'; config?: unknown } }>('/mcp/config/import', async (req, reply) => {
    const body = req.body ?? {}
    const scope = body.scope ?? req.query.scope ?? 'project'
    if (scope !== 'project' && scope !== 'global') return reply.code(200).send(fail(40001, 'scope 必须是 project 或 global'))
    try {
      const config = body.config ?? body
      const servers = importConfigDocument(config, scope, projectPath(req))
      return reply.code(200).send(success({ servers }, 'MCP 配置已原子导入'))
    } catch (err) {
      return reply.code(200).send(fail(40001, err instanceof Error ? err.message : 'MCP 配置无效'))
    }
  })

  // ── Create ──────────────────────────────────────────────────────────────────
  fastify.post<{ Querystring: ProjectQuery }>('/mcp/servers', async (req, reply) => {
    const result = CreateMcpSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    try {
      const entry = createServer(result.data, projectPath(req))
      return reply.code(200).send(success(entry))
    } catch (err: any) {
      return reply.code(200).send(fail(40900, err instanceof Error ? err.message : 'Conflict'))
    }
  })

  // ── Get one ─────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string }; Querystring: ProjectQuery }>('/mcp/servers/:id', async (req, reply) => {
    const server = getServer(req.params.id, projectPath(req), req.query.scope)
    if (!server) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(server))
  })

  // ── Full update ─────────────────────────────────────────────────────────────
  fastify.put<{ Params: { id: string }; Querystring: ProjectQuery }>('/mcp/servers/:id', async (req, reply) => {
    const result = UpdateMcpSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const existing = getServer(req.params.id, projectPath(req), req.query.scope)
    if (!existing) return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    const merged = existing ? { ...existing, ...result.data } : null
    const valid = merged ? CreateMcpSchema.safeParse(merged) : null
    if (!valid?.success) return reply.code(200).send(fail(40001, valid?.error.errors[0]?.message ?? 'MCP server not found'))
    const updated = updateServer(req.params.id, result.data, projectPath(req), req.query.scope)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Partial update ──────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string }; Querystring: ProjectQuery }>('/mcp/servers/:id', async (req, reply) => {
    const result = UpdateMcpSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const existing = getServer(req.params.id, projectPath(req), req.query.scope)
    if (!existing) return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    const merged = existing ? { ...existing, ...result.data } : null
    const valid = merged ? CreateMcpSchema.safeParse(merged) : null
    if (!valid?.success) return reply.code(200).send(fail(40001, valid?.error.errors[0]?.message ?? 'MCP server not found'))
    const updated = updateServer(req.params.id, result.data, projectPath(req), req.query.scope)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Delete ───────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string }; Querystring: ProjectQuery }>('/mcp/servers/:id', async (req, reply) => {
    // ?scope=global 删除全局层定义；默认删项目层（项目层删除后同名全局定义重新生效）
    const ok = deleteServer(req.params.id, req.query.scope === 'global' ? 'global' : 'project', projectPath(req))
    if (!ok) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(true, '删除成功'))
  })

  // ── Enable ───────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string }; Querystring: ProjectQuery }>('/mcp/servers/:id/enable', async (req, reply) => {
    const updated = toggleServer(req.params.id, true, projectPath(req), req.query.scope)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Disable ──────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string }; Querystring: ProjectQuery }>('/mcp/servers/:id/disable', async (req, reply) => {
    const updated = toggleServer(req.params.id, false, projectPath(req), req.query.scope)
    if (!updated) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }
    return reply.code(200).send(success(updated))
  })

  // ── Test connection ───────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string }; Querystring: ProjectQuery }>('/mcp/servers/:id/test', async (req, reply) => {
    const server = getServer(req.params.id, projectPath(req), req.query.scope)
    if (!server) {
      return reply.code(200).send(fail(40400, `MCP server "${req.params.id}" not found`))
    }

    const controller = new AbortController()
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(new DOMException('MCP connection test cancelled', 'AbortError')) }
    req.raw.once('aborted', disconnected)
    reply.raw.once('close', disconnected)
    let client: HTTPMCPClient | undefined
    try {
      if (server.transportType !== 'stdio' && !server.url) {
        return reply.code(200).send(fail(40001, 'Server has no URL configured'))
      }
      client = new HTTPMCPClient({ id: server.id, name: server.name || server.id, url: server.url, command: server.command, args: server.args, env: server.env, transportType: server.transportType, headers: server.headers, timeoutMs: server.timeoutMs }, { tenantId: getTenantId(req), sessionId: '' })
      const tools = await client.toTools(controller.signal)
      return reply.code(200).send(success({
        success: true,
        toolCount: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      }))
    } catch (err) {
      logger.warn({ id: server.id, err }, 'MCP server test failed')
      return reply.code(200).send(fail(50000, err instanceof Error ? err.message : 'Connection failed'))
    } finally {
      req.raw.removeListener('aborted', disconnected)
      reply.raw.removeListener('close', disconnected)
      await client?.disconnect()
    }
  })
}

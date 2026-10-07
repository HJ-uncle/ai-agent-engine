import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SQLiteMemoryManager } from '../../../storage/memory/memory-manager.js'
import type { MemoryContext, MemoryEdgeType, MemoryNodeType, MemoryScope } from '../../../storage/memory/types.js'
import { success, fail, paginateArray } from '../response.js'
import { getRequestToolProfile } from '../tool-profile.js'
import { getSessionMemorySettings, setSessionMemoryScope } from '../../../storage/memory/settings.js'

const manager = new SQLiteMemoryManager()

type ScopeInput = { scope?: string; sessionId?: string }
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

/** Resolve one explicit visibility boundary at the HTTP edge. */
function resolveContext(req: FastifyRequest, input: ScopeInput = {}):
  | { context: MemoryContext; scope: MemoryScope; sessionId: string }
  | { error: string } {
  const rawScope = input.scope ?? 'global'
  if (rawScope !== 'global' && rawScope !== 'session') return { error: 'scope must be global or session' }
  const scope = rawScope as MemoryScope
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  if (scope === 'session' && !sessionId) return { error: 'sessionId is required when scope=session' }
  return {
    scope,
    sessionId,
    context: { tenantId: getTenantId(req), sessionId: scope === 'session' ? sessionId : '', scope },
  }
}

function badScope(reply: any, message: string) {
  return reply.code(400).send(fail(40000, message))
}

function nodeResponse(node: any) {
  return {
    ...node,
    // Keep the old key/value shape available to existing Aether clients.
    key: node.type,
    value: node.summary,
    updated_at: node.updatedAt,
    scope: node.scope ?? 'global',
  }
}

function edgeResponse(edge: any) {
  return { ...edge, source: edge.sourceNodeId, target: edge.targetNodeId, scope: edge.scope ?? 'global' }
}

async function scopedNode(id: string, ctx: MemoryContext) {
  return manager.getNode(id, ctx)
}

export async function memoryRoutes(fastify: FastifyInstance) {
  // Per-session setting is a capability switch; CRUD scope remains explicit.
  fastify.get<{ Querystring: { sessionId?: string } }>('/memory/settings', async (request, reply) => {
    const sessionId = String(request.query.sessionId ?? '').trim()
    if (!sessionId) return badScope(reply, 'sessionId is required')
    const settings = await getSessionMemorySettings(getTenantId(request), sessionId, getRequestToolProfile(request))
    return reply.code(200).send(success({ sessionId, ...settings }))
  })

  fastify.put<{ Body: { sessionId?: string; memoryScope?: string } }>('/memory/settings', async (request, reply) => {
    const sessionId = String(request.body?.sessionId ?? '').trim()
    const memoryScope = request.body?.memoryScope
    if (!sessionId) return badScope(reply, 'sessionId is required')
    if (memoryScope !== 'off' && memoryScope !== 'global' && memoryScope !== 'session') {
      return badScope(reply, 'memoryScope must be off, global, or session')
    }
    if (process.env.ENABLE_LONG_TERM_MEMORY === 'false' && memoryScope !== 'off') {
      return reply.code(409).send(fail(40900, 'Long-term memory is disabled by server configuration; choose memoryScope=off or enable ENABLE_LONG_TERM_MEMORY'))
    }
    try {
      await setSessionMemoryScope(getTenantId(request), sessionId, memoryScope)
    } catch (err: any) {
      const status = Number(err?.statusCode ?? 40900)
      return reply.code(status >= 400 && status < 600 ? status : 409).send(fail(status, err?.message ?? 'Unable to update memory settings'))
    }
    const settings = await getSessionMemorySettings(getTenantId(request), sessionId, getRequestToolProfile(request))
    return reply.code(200).send(success({ sessionId, ...settings }))
  })

  fastify.post<{ Querystring: ScopeInput; Body: { key: string; value: string; sessionId?: string; scope?: string } }>('/memory/remember', async (request, reply) => {
    const { key, value, scope, sessionId } = request.body ?? ({} as any)
    if (!key || typeof value !== 'string') return badScope(reply, 'key and value are required')
    const resolved = resolveContext(request, { scope: scope ?? request.query.scope, sessionId: sessionId ?? request.query.sessionId })
    if ('error' in resolved) return badScope(reply, resolved.error)
    const node = await manager.createNode(
      {
        type: 'fact',
        summary: `${key}: ${value}`,
        importance: 0.7,
        sourceSessionId: sessionId ?? null,
        tags: ['memory_remember', key],
      },
      resolved.context,
    )
    return reply.code(200).send(success({ success: true, id: node.id, scope: resolved.scope, sessionId: resolved.sessionId }))
  })

  fastify.get<{ Params: { key: string }; Querystring: { sessionId?: string; scope?: string } }>(
    '/memory/recall/:key',
    async (request, reply) => {
      const resolved = resolveContext(request, request.query)
      if ('error' in resolved) return badScope(reply, resolved.error)
      const nodes = await manager.recallByTags([request.params.key], resolved.context)
      const value = nodes.length > 0 ? nodes[0].summary.replace(`${request.params.key}: `, '') : null
      return reply.code(200).send(success({ key: request.params.key, value, scope: resolved.scope, sessionId: resolved.sessionId }))
    },
  )

  fastify.get<{ Querystring: { sessionId?: string; scope?: string; current?: number; pageSize?: number } }>('/memory/list', async (request, reply) => {
    const resolved = resolveContext(request, request.query)
    if ('error' in resolved) return badScope(reply, resolved.error)
    const nodes = await manager.listNodes({ orderBy: 'timestamp', orderDir: 'DESC', limit: 1000 }, resolved.context)
    return reply.code(200).send(paginateArray(nodes.map(nodeResponse), request.query.current, request.query.pageSize))
  })

  fastify.get<{ Querystring: { sessionId?: string; scope?: string } }>('/memory/graph', async (request, reply) => {
    const resolved = resolveContext(request, request.query)
    if ('error' in resolved) return badScope(reply, resolved.error)
    const nodes = await manager.listNodes({ limit: 1000 }, resolved.context)
    const nodeIds = new Set(nodes.map(node => node.id))
    const edgeMap = new Map<string, any>()
    // Both endpoints must be in this scope; this also protects old databases
    // that may contain an incorrectly scoped edge.
    for (const node of nodes) {
      const edges = await manager.getEdges(node.id, resolved.context)
      for (const edge of edges) {
        if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) edgeMap.set(edge.id, edgeResponse(edge))
      }
    }
    return reply.code(200).send(success({ nodes: nodes.map(nodeResponse), edges: [...edgeMap.values()], scope: resolved.scope, sessionId: resolved.sessionId }))
  })

  fastify.delete<{ Params: { id: string }; Querystring: { sessionId?: string; scope?: string } }>('/memory/:id', async (request, reply) => {
    const resolved = resolveContext(request, request.query)
    if ('error' in resolved) return badScope(reply, resolved.error)
    if (!await scopedNode(request.params.id, resolved.context)) return reply.code(404).send(fail(40400, 'Memory not found'))
    await manager.deleteNode(request.params.id, resolved.context)
    return reply.code(200).send(success({ success: true, id: request.params.id }))
  })

  fastify.put<{
    Params: { id: string }
    Querystring: { sessionId?: string; scope?: string }
    Body: { summary?: string; type?: MemoryNodeType; importance?: number; detail?: string | null; scope?: unknown }
  }>('/memory/:id', async (request, reply) => {
    const resolved = resolveContext(request, request.query)
    if ('error' in resolved) return badScope(reply, resolved.error)
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'scope')) return badScope(reply, 'scope cannot be changed in an update; use the request scope')
    if (!await scopedNode(request.params.id, resolved.context)) return reply.code(404).send(fail(40400, 'Memory not found'))
    const { summary, type, importance, detail } = request.body ?? {}
    const updated = await manager.updateNode(request.params.id, { summary, type, importance, detail }, resolved.context)
    if (!updated) return reply.code(404).send(fail(40400, 'Memory not found'))
    return reply.code(200).send(success(nodeResponse(updated)))
  })

  fastify.post<{
    Querystring: ScopeInput
    Body: { sourceId: string; targetId: string; type: MemoryEdgeType; description?: string; strength?: number; scope?: string; sessionId?: string }
  }>('/memory/link', async (request, reply) => {
    const body = request.body ?? ({} as any)
    const resolved = resolveContext(request, { scope: body.scope ?? request.query.scope, sessionId: body.sessionId ?? request.query.sessionId })
    if ('error' in resolved) return badScope(reply, resolved.error)
    if (!body.sourceId || !body.targetId || body.sourceId === body.targetId) return badScope(reply, 'sourceId and targetId must be different')
    const [source, target] = await Promise.all([scopedNode(body.sourceId, resolved.context), scopedNode(body.targetId, resolved.context)])
    if (!source || !target) return reply.code(404).send(fail(40400, 'Both memory nodes must exist in the requested scope'))
    try {
      const edge = await manager.createEdge({ sourceNodeId: body.sourceId, targetNodeId: body.targetId, type: body.type, strength: body.strength, description: body.description ?? '用户手动关联' }, resolved.context)
      return reply.code(200).send(success({ success: true, id: edge.id, edge: edgeResponse(edge) }))
    } catch (err: any) {
      return reply.code(400).send(fail(40000, err?.message ?? 'Unable to link memories'))
    }
  })

  fastify.post<{ Querystring: ScopeInput; Body: { scope?: string; sessionId?: string } }>('/memory/consolidate', async (request, reply) => {
    const body = request.body ?? ({} as any)
    const resolved = resolveContext(request, { scope: body.scope ?? request.query.scope, sessionId: body.sessionId ?? request.query.sessionId })
    if ('error' in resolved) return badScope(reply, resolved.error)
    const decayed = await manager.decayNodes(resolved.context)
    const report = await manager.consolidate(resolved.context)
    const parsedThreshold = Number.parseFloat(process.env.MEMORY_DECAY_THRESHOLD || '0.05')
    const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 0.05
    const weakNodes = await manager.listNodes({ maxStrength: threshold, limit: 1000 }, resolved.context)
    return reply.code(200).send(success({ success: true, message: '记忆衰减与整理已完成', decayed, report, forgottenCandidates: weakNodes.filter(node => node.type !== 'preference' && node.type !== 'decision').map(node => ({ id: node.id, summary: node.summary, strength: node.strength })), scope: resolved.scope, sessionId: resolved.sessionId }))
  })
}

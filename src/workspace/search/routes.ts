import type { FastifyInstance, FastifyRequest } from 'fastify'
import path from 'node:path'
import { workspaceManager } from '../index.js'
import { success, fail } from '../../api/http/response.js'
import type { WorkspaceSearchInput } from './core.js'
import { cancelWorkspaceSearch, disposeWorkspaceSearches, runWorkspaceSearch } from './service.js'

interface SearchBody extends WorkspaceSearchInput { sessionId: string; expectedRoot: string; bindingEpoch?: string; requestId: string }
const ownerOf = (request: FastifyRequest, sessionId: string): { tenantId: string; owner: string } => {
  const tenantId = (request as FastifyRequest & { authContext?: { tenantId: string } }).authContext?.tenantId ?? 'default'
  return { tenantId, owner: JSON.stringify([tenantId, sessionId]) }
}
const identitySchema = { sessionId: { type: 'string', minLength: 1, maxLength: 256 }, requestId: { type: 'string', minLength: 1, maxLength: 160 } }
const sameRoot = (left: string, right: string): boolean => {
  const a = path.resolve(left), b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function registerWorkspaceSearchRoutes(fastify: FastifyInstance): void {
  const owners = new Set<string>()
  fastify.addHook('onClose', async () => { disposeWorkspaceSearches(owners) })
  fastify.post<{ Body: SearchBody }>('/workspace/search', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['sessionId', 'expectedRoot', 'requestId', 'query', 'options', 'excludes', 'useIgnoreFiles'],
    properties: { ...identitySchema, expectedRoot: { type: 'string', minLength: 1, maxLength: 32768 }, bindingEpoch: { type: 'string', minLength: 1, maxLength: 128 },
      query: { type: 'string', maxLength: 4096 }, useIgnoreFiles: { type: 'boolean' },
      excludes: { type: 'object', maxProperties: 256, additionalProperties: { type: 'boolean' } },
      options: { type: 'object', additionalProperties: false, required: ['caseSensitive', 'wholeWord', 'useRegex', 'include', 'exclude'], properties: {
        caseSensitive: { type: 'boolean' }, wholeWord: { type: 'boolean' }, useRegex: { type: 'boolean' },
        include: { type: 'string', maxLength: 4096 }, exclude: { type: 'string', maxLength: 4096 }
      } }
    }
  } } }, async (request, reply) => {
    const input = request.body, { tenantId, owner } = ownerOf(request, input.sessionId)
    const context = { tenantId, sessionId: input.sessionId }
    try {
      if (!path.isAbsolute(input.expectedRoot)) throw new Error('工作区目录无效')
      const binding = workspaceManager.bindingReadGuard(context)
      if (!sameRoot(binding.snapshot.root, input.expectedRoot) || input.bindingEpoch !== undefined && binding.snapshot.epoch !== input.bindingEpoch) throw new Error('工作区已变化，请重新搜索')
      const root = workspaceManager.resolveSafePathForSnapshot(context, binding.snapshot, '.')
      owners.add(owner)
      const aborted = (): void => { cancelWorkspaceSearch(owner, input.requestId) }
      const closed = (): void => { if (!reply.raw.writableEnded) aborted() }
      request.raw.once('aborted', aborted)
      reply.raw.once('close', closed)
      try {
        const result = await runWorkspaceSearch(owner, input.requestId, root, input, binding.assertCurrent)
        binding.assertCurrent()
        return reply.send(success({ root: binding.snapshot.root, bindingEpoch: binding.snapshot.epoch, ...result }))
      } finally { request.raw.off('aborted', aborted); reply.raw.off('close', closed) }
    } catch (error) { return reply.send(fail(40001, error instanceof Error ? error.message : '工作区搜索失败')) }
  })
  fastify.post<{ Body: { sessionId: string; requestId: string } }>('/workspace/search/cancel', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['sessionId', 'requestId'], properties: identitySchema
  } } }, async (request, reply) => {
    const { owner } = ownerOf(request, request.body.sessionId)
    return reply.send(success({ cancelled: cancelWorkspaceSearch(owner, request.body.requestId) }))
  })
}

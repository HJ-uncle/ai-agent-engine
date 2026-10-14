import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthContext } from '../../../auth/types.js'
import { getCollaborationRuntime } from '../../../core/collaboration/runtime.js'
import { CollaborationError, type CollaborationRootScope } from '../../../core/collaboration/types.js'
import { fail, success } from '../response.js'

type ScopeQuery = { rootAttemptId: string; rootSessionId: string; cursor?: string; limit?: string }
type RootParams = { rootRunId: string }
function scope(request: FastifyRequest<{ Params: RootParams; Querystring: ScopeQuery }>): CollaborationRootScope {
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  if (!auth || auth.method === 'none') throw new CollaborationError('forbidden', 'Authenticated controller required')
  return { tenantId: auth.tenantId, rootRunId: request.params.rootRunId, rootAttemptId: request.query.rootAttemptId, rootSessionId: request.query.rootSessionId }
}
function pageSize(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!/^[1-9]\d*$/.test(raw)) throw new CollaborationError('invalid', 'Invalid page size')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > 64) throw new CollaborationError('invalid', 'Invalid page size')
  return value
}
function failure(error: unknown): { status: number; code: number; message: string } {
  if (!(error instanceof CollaborationError)) throw error
  const status = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, closed: 409, too_large: 413, full: 429 }[error.code]
  return { status, code: status * 100 + 1, message: error.message }
}
/** Inspection only: G3a has no model mailbox consumer or user mutation bridge. */
export async function collaborationRoutes(app: FastifyInstance): Promise<void> {
  const store = getCollaborationRuntime().store
  app.get('/collaboration/capabilities', async (_request, reply) => reply.send(success({
    protocolVersion: 1, durableQueueReceipts: true, receiptPagination: true, backend: 'sqlite',
    mailboxConsumer: false, runtimeCommunication: false, asynchronousAgentTools: false,
    userControllerMutation: false, jsonlDelivery: false,
  })))
  app.get<{ Params: RootParams; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/participants', async (request, reply) => {
    try {
      const result = await store.participants(scope(request), { cursor: request.query.cursor, limit: pageSize(request.query.limit) })
      return reply.send(success(result))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.get<{ Params: RootParams & { participantId: string }; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/participants/:participantId/receipts', async (request, reply) => {
    try {
      const result = await store.receipts(scope(request), request.params.participantId, { cursor: request.query.cursor, limit: pageSize(request.query.limit) })
      return reply.send(success(result))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.get<{ Params: RootParams & { messageId: string }; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/receipts/:messageId', async (request, reply) => {
    try {
      const result = await store.findReceipt(scope(request), request.params.messageId)
      return result ? reply.send(success(result)) : reply.code(404).send(fail(40401, 'Receipt not found'))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.post<{ Params: RootParams; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/messages', async (request, reply) => {
    try {
      scope(request)
      // Root/attempt/session fields are read scopes. They never create an
      // execution sender, even when the caller knows all of their values.
      return reply.code(501).send(fail(50101, 'No trusted user-controller mutation bridge or mailbox consumer is installed'))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
}

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getCollaborationRuntime } from '../../../core/collaboration/runtime.js'
import { CollaborationError, type CollaborationRootScope } from '../../../core/collaboration/types.js'
import { fail, success } from '../response.js'
import { controllerSubjectFromRequest } from '../middleware.js'
import { getExecutionOwners } from '../../../core/collaboration/execution-owner.js'
import { CollaborationController } from '../../../core/collaboration/controller.js'
import type { ControllerSubject } from '../../../core/collaboration/controller-origin.js'

type ScopeQuery = { rootAttemptId: string; rootSessionId: string; cursor?: string; limit?: string }
type RootParams = { rootRunId: string }
function subject(request: FastifyRequest): ControllerSubject {
  const actor = controllerSubjectFromRequest(request)
  if (!actor) throw new CollaborationError('forbidden', 'Authenticated user or an owned local controller required')
  return actor
}
function scope(request: FastifyRequest<{ Params: RootParams; Querystring: ScopeQuery }>): CollaborationRootScope {
  return { tenantId: subject(request).tenantId, rootRunId: request.params.rootRunId, rootAttemptId: request.query.rootAttemptId, rootSessionId: request.query.rootSessionId }
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
type ControllerBody = { recipientParticipantId: string; recipientInvocationRunId: string; message: string; requestKey: string }
function body(value: unknown): ControllerBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollaborationError('invalid', 'Invalid controller body')
  const fields = ['recipientParticipantId', 'recipientInvocationRunId', 'message', 'requestKey']
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== fields.length || fields.some(key => typeof record[key] !== 'string')
    || Object.keys(record).some(key => !fields.includes(key))) throw new CollaborationError('invalid', 'Controller body must contain only recipientParticipantId, recipientInvocationRunId, message and requestKey')
  return record as ControllerBody
}
/** Capabilities stay gated until the complete producer, consumer and UI contract is independently accepted. */
export async function collaborationRoutes(app: FastifyInstance): Promise<void> {
  const store = getCollaborationRuntime().store
  const controller = () => new CollaborationController(getExecutionOwners())
  const inspectionScope = async (request: FastifyRequest<{ Params: RootParams; Querystring: ScopeQuery }>) => {
    const b = scope(request); await controller().authorizeInspection(b, subject(request)); return b
  }
  app.get('/collaboration/capabilities', async (_request, reply) => reply.send(success({
    protocolVersion: 1, durableQueueReceipts: true, receiptPagination: true, backend: 'sqlite',
    mailboxConsumer: false, runtimeCommunication: false, asynchronousAgentTools: false,
    userControllerMutation: false, jsonlDelivery: false,
  })))
  app.get<{ Params: RootParams; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/participants', async (request, reply) => {
    try {
      const result = await store.participants(await inspectionScope(request), { cursor: request.query.cursor, limit: pageSize(request.query.limit) })
      return reply.send(success(result))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.get<{ Params: RootParams & { participantId: string }; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/participants/:participantId/receipts', async (request, reply) => {
    try {
      const result = await store.receipts(await inspectionScope(request), request.params.participantId, { cursor: request.query.cursor, limit: pageSize(request.query.limit) })
      return reply.send(success(result))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.get<{ Params: RootParams & { messageId: string }; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/receipts/:messageId', async (request, reply) => {
    try {
      const result = await store.findReceipt(await inspectionScope(request), request.params.messageId)
      return result ? reply.send(success(result)) : reply.code(404).send(fail(40401, 'Receipt not found'))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.get<{ Params: RootParams; Querystring: { rootSessionId: string; recipientParticipantId?: string } }>('/collaboration/roots/:rootRunId/controller-context', async (request, reply) => {
    try { return reply.send(success(await controller().context(subject(request), request.params.rootRunId, request.query.rootSessionId, request.query.recipientParticipantId))) }
    catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.get<{ Params: RootParams & { requestKey: string }; Querystring: ScopeQuery }>('/collaboration/roots/:rootRunId/controller-receipts/:requestKey', async (request, reply) => {
    try {
      const receipt = await controller().findReceipt(scope(request), subject(request), request.params.requestKey)
      return receipt ? reply.send(success({ outcome: 'accepted', receipt }))
        : reply.code(404).send(success({ outcome: 'not_found', requestKey: request.params.requestKey }))
    } catch (error) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
  })
  app.post<{ Params: RootParams; Querystring: ScopeQuery; Body: unknown }>('/collaboration/roots/:rootRunId/messages', async (request, reply) => {
    let acceptedBody: ControllerBody | undefined
    try {
      const b = scope(request), actor = subject(request)
      acceptedBody = body(request.body)
      const receipt = await controller().send(b, actor, acceptedBody)
      return reply.send(success({ outcome: 'accepted', receipt }))
    } catch (error) {
      if (error instanceof CollaborationError) { const e = failure(error); return reply.code(e.status).send(fail(e.code, e.message)) }
      if (!acceptedBody) throw error
      const query = new URLSearchParams({ rootAttemptId: request.query.rootAttemptId, rootSessionId: request.query.rootSessionId })
      const queryPath = `/collaboration/roots/${encodeURIComponent(request.params.rootRunId)}/controller-receipts/${encodeURIComponent(acceptedBody.requestKey)}?${query}`
      // A failed commit ACK does not establish non-acceptance. The caller keeps
      // the same key and queries it; no automatic resend or new key is invented.
      return reply.code(503).send(fail(50301, 'Controller acceptance is unknown; query the original request key',
        { outcome: 'unknown', requestKey: acceptedBody.requestKey, queryPath }))
    }
  })
}

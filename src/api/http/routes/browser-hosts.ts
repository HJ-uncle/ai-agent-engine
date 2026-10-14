import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { browserAuthorityFromRequest } from '../middleware.js'
import { success, fail } from '../response.js'
import type { BrowserBridge } from '../../../tools/browser/browser-bridge.js'
import { BrowserHostDemandError } from '../../../tools/browser/native-host-demand.js'
import type { BrowserExecutionIdentity } from '../../../core/browser-execution.js'

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } as const
const secret = { type: 'string', minLength: 32, maxLength: 128 } as const
const executionSchema = { type: 'object', additionalProperties: false, required: ['rootSessionId', 'rootRunId', 'ownerRunId'],
  properties: { rootSessionId: id, rootRunId: id, ownerRunId: id } } as const
const credential = (request: FastifyRequest, name: string) => {
  const value = request.headers[name]
  return typeof value === 'string' && value.length <= 128 ? value : ''
}
const authority = (request: FastifyRequest) => {
  const value = browserAuthorityFromRequest(request)
  if (!value) throw new BrowserHostDemandError(403, 'BROWSER_HOST_AUTHORITY_UNAVAILABLE', 'Authenticated account or configured owned instance authority required')
  return value
}
function exactExecution(value: unknown): value is BrowserExecutionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return Object.keys(body).length === 3 && ['rootSessionId', 'rootRunId', 'ownerRunId'].every(key =>
    typeof body[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body[key] as string))
}
async function withDisconnect<T>(reply: FastifyReply, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const closed = () => { if (!reply.raw.writableEnded) controller.abort() }
  reply.raw.once('close', closed)
  try { return await action(controller.signal) } finally { reply.raw.removeListener('close', closed) }
}
interface DemandBody { demandToken: string; execution: BrowserExecutionIdentity; code?: string }
const rejectionCodes = ['BROWSER_HOST_SLOT_CAPACITY', 'BROWSER_HOST_WINDOW_CLOSED', 'BROWSER_HOST_AI_DISABLED', 'BROWSER_HOST_CONNECTION_FAILED'] as const

/** All native routing authority is extracted after the actual auth hook, never from host/body identity fields. */
export async function browserHostRoutes(fastify: FastifyInstance, bridge: BrowserBridge): Promise<void> {
  fastify.post<{ Body: { protocolVersion: 1; authorityKind: 'account' | 'instance'; hostId?: string; hostToken?: string } }>('/browser/hosts', {
    preValidation: async (request, reply) => {
      if (!request.body || request.body.protocolVersion !== 1 || !['account', 'instance'].includes(request.body.authorityKind)) return reply.code(400).send(fail(400, 'Invalid native host negotiation'))
    },
    schema: { body: { type: 'object', additionalProperties: false, required: ['protocolVersion', 'authorityKind'], properties: {
      protocolVersion: { type: 'integer', enum: [1] }, authorityKind: { type: 'string', enum: ['account', 'instance'] }, hostId: id, hostToken: secret } } },
  }, async (request, reply) => {
    const own = authority(request), { authorityKind, hostId, hostToken } = request.body
    if (own.kind !== authorityKind) return reply.code(403).send(fail(403, 'Native host authority cannot be changed or downgraded'))
    if (Boolean(hostId) !== Boolean(hostToken)) return reply.code(400).send(fail(400, 'Both host renewal credentials are required'))
    return success(bridge.hostDemands.register(own, hostId && hostToken ? { hostId, hostToken } : undefined))
  })
  const hostParams = { type: 'object', additionalProperties: false, required: ['hostId'], properties: { hostId: id } } as const
  const demandParams = { type: 'object', additionalProperties: false, required: ['hostId', 'demandId'], properties: { hostId: id, demandId: id } } as const
  fastify.get<{ Params: { hostId: string } }>('/browser/hosts/:hostId/demands', { schema: { params: hostParams } }, async (request, reply) => {
    const own = authority(request)
    return success({ demands: await withDisconnect(reply, signal => bridge.hostDemands.poll(own, request.params.hostId,
      credential(request, 'x-aether-browser-host-token'), signal)) })
  })
  fastify.get<{ Params: { hostId: string; demandId: string }; Querystring: BrowserExecutionIdentity & { wait?: boolean } }>('/browser/hosts/:hostId/demands/:demandId/state', {
    schema: { params: demandParams, querystring: { type: 'object', additionalProperties: false, required: ['rootSessionId', 'rootRunId', 'ownerRunId'], properties: {
      rootSessionId: id, rootRunId: id, ownerRunId: id, wait: { type: 'boolean', default: false } } } },
  }, async (request, reply) => {
    const own = authority(request), { rootSessionId, rootRunId, ownerRunId } = request.query
    return success(await withDisconnect(reply, signal => bridge.hostDemands.state(own, request.params.hostId, credential(request, 'x-aether-browser-host-token'),
      request.params.demandId, credential(request, 'x-aether-browser-demand-token'), { rootSessionId, rootRunId, ownerRunId }, request.query.wait === true, signal)))
  })
  for (const action of ['client', 'reject'] as const) {
    fastify.post<{ Params: { hostId: string; demandId: string }; Body: DemandBody }>(`/browser/hosts/:hostId/demands/:demandId/${action}`, {
      preValidation: async (request, reply) => {
        if (!request.body || typeof request.body.demandToken !== 'string' || !exactExecution(request.body.execution) ||
          action === 'reject' && !rejectionCodes.includes(request.body.code as typeof rejectionCodes[number])) {
          return reply.code(400).send(fail(400, 'Invalid native handshake types or rejection code'))
        }
      },
      schema: { params: demandParams, body: { type: 'object', additionalProperties: false,
        required: action === 'client' ? ['demandToken', 'execution'] : ['demandToken', 'execution', 'code'],
        properties: { demandToken: secret, execution: executionSchema, ...(action === 'reject' ? { code: { type: 'string', enum: [...rejectionCodes] } } : {}) } } },
    }, async request => {
      const own = authority(request), token = credential(request, 'x-aether-browser-host-token'), { demandToken, execution, code } = request.body
      return success(action === 'client'
        ? bridge.hostDemands.ready(own, request.params.hostId, token, request.params.demandId, demandToken, execution)
        : { accepted: bridge.hostDemands.reject(own, request.params.hostId, token, request.params.demandId, demandToken, execution, code!) })
    })
  }
  fastify.delete<{ Params: { hostId: string; rootSessionId: string; rootRunId: string } }>('/browser/hosts/:hostId/roots/:rootSessionId/runs/:rootRunId', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['hostId', 'rootSessionId', 'rootRunId'],
      properties: { hostId: id, rootSessionId: id, rootRunId: id } } },
  }, async request => {
    bridge.hostDemands.releaseOwnedRoot(authority(request), request.params.hostId, credential(request, 'x-aether-browser-host-token'), request.params.rootSessionId, request.params.rootRunId)
    return success({ released: true })
  })
  fastify.delete<{ Params: { hostId: string } }>('/browser/hosts/:hostId', { schema: { params: hostParams } }, async request => {
    bridge.hostDemands.unregister(authority(request), request.params.hostId, credential(request, 'x-aether-browser-host-token'))
    return success({ released: true })
  })
}

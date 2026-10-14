import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthContext } from '../../../auth/types.js'
import type { BrowserExecutionIdentity } from '../../../core/browser-execution.js'
import type { ToolResult } from '../../../core/agent-context/types.js'
import { BROWSER_ACTIONS, BrowserBridgeError, browserBridge, type BrowserBridge } from '../../../tools/browser/browser-bridge.js'
import { success, fail } from '../response.js'
import { browserHostRoutes } from './browser-hosts.js'

const identity = (request: FastifyRequest) => {
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  return { tenantId: auth?.tenantId ?? 'default', userId: auth?.userId }
}
const token = (request: FastifyRequest): string => {
  const value = request.headers['x-aether-browser-token']
  return typeof value === 'string' && value.length <= 128 ? value : ''
}
const idSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } as const
const executionSchema = { type: 'object', additionalProperties: false,
  required: ['rootSessionId', 'rootRunId', 'ownerRunId'],
  properties: { rootSessionId: idSchema, rootRunId: idSchema, ownerRunId: idSchema } } as const
interface NativeResultMetadata extends Record<string, unknown> { code: string; operationPerformed: boolean | 'unknown' }

/** AJV's default coercion must not convert null/1/"false" into side-effect evidence. */
function exactNativeResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  if (typeof body.success !== 'boolean' || typeof body.output !== 'string' || typeof body.requestId !== 'string') return false
  if (body.error !== undefined && typeof body.error !== 'string') return false
  if (body.execution !== undefined) {
    if (!body.execution || typeof body.execution !== 'object' || Array.isArray(body.execution)) return false
    const execution = body.execution as Record<string, unknown>
    if (['rootSessionId', 'rootRunId', 'ownerRunId'].some(key => typeof execution[key] !== 'string')) return false
  }
  if (body.metadata !== undefined) {
    if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) return false
    const metadata = body.metadata as Record<string, unknown>
    if (Object.keys(metadata).some(key => key !== 'code' && key !== 'operationPerformed') || typeof metadata.code !== 'string' ||
        typeof metadata.operationPerformed !== 'boolean' && metadata.operationPerformed !== 'unknown') return false
  }
  return true
}

export async function browserRoutes(fastify: FastifyInstance, options: { bridge?: BrowserBridge } = {}) {
  const bridge = options.bridge ?? browserBridge
  // Proxies must not cache commands or client credentials on remote engines.
  fastify.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store') })
  fastify.addHook('onClose', async () => bridge.dispose())
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof BrowserBridgeError) return reply.code(error.statusCode).send(fail(error.statusCode, error.message))
    const err = error as Error & { statusCode?: number }
    return reply.code(err.statusCode ?? 500).send(fail(err.statusCode ?? 500, err.statusCode === 400 ? err.message : 'Browser bridge request failed'))
  })

  fastify.post<{ Body: { sessionId: string; clientId?: string; clientToken?: string; protocolVersion?: 1 | 2 } }>('/browser/clients', {
    preValidation: async (request, reply) => {
      if (request.body?.protocolVersion !== undefined && request.body.protocolVersion !== 1 && request.body.protocolVersion !== 2) {
        return reply.code(400).send(fail(400, 'Unsupported browser client protocol'))
      }
    },
    schema: { body: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: {
      sessionId: idSchema, clientId: idSchema, clientToken: { type: 'string', minLength: 32, maxLength: 128 },
      protocolVersion: { type: 'integer', enum: [1, 2], default: 1 },
    } } },
  }, async (request, reply) => {
    const { sessionId, clientId, clientToken, protocolVersion } = request.body
    if (Boolean(clientId) !== Boolean(clientToken)) return reply.code(400).send(fail(400, 'clientId and clientToken must be supplied together'))
    return success(bridge.register(identity(request), sessionId, clientId && clientToken ? { clientId, clientToken } : undefined, protocolVersion))
  })

  fastify.get<{ Params: { clientId: string } }>('/browser/clients/:clientId/commands', {
    schema: { response: { 200: {
      type: 'object', required: ['code', 'message', 'data', 'timestamp'],
      properties: {
        code: { type: 'number' }, message: { type: 'string' }, timestamp: { type: 'number' },
        data: { type: 'object', required: ['commands'], properties: {
          commands: { type: 'array', items: {
            type: 'object', required: ['requestId', 'sessionId', 'action', 'args', 'expiresAt'],
            properties: {
              requestId: idSchema, sessionId: idSchema, action: { type: 'string', enum: [...BROWSER_ACTIONS] },
              args: { type: 'object', additionalProperties: true }, expiresAt: { type: ['number', 'null'] },
              execution: executionSchema,
            },
          } },
        } },
      },
    } } },
  }, async (request, reply) => {
    const controller = new AbortController()
    const closed = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once('close', closed)
    try { return success({ commands: await bridge.poll(identity(request), request.params.clientId, token(request), controller.signal) }) }
    finally { reply.raw.removeListener('close', closed) }
  })

  fastify.get<{ Params: { clientId: string; requestId: string }; Querystring: { wait?: boolean; rootSessionId?: string; rootRunId?: string; ownerRunId?: string } }>(
    '/browser/clients/:clientId/requests/:requestId/state', {
      schema: {
        params: { type: 'object', required: ['clientId', 'requestId'], properties: { clientId: idSchema, requestId: idSchema } },
        querystring: { type: 'object', additionalProperties: false, properties: { wait: { type: 'boolean', default: true },
          rootSessionId: idSchema, rootRunId: idSchema, ownerRunId: idSchema } },
      },
    }, async (request, reply) => {
      const { rootSessionId, rootRunId, ownerRunId } = request.query
      const supplied = [rootSessionId, rootRunId, ownerRunId].filter(value => value !== undefined).length
      if (supplied !== 0 && supplied !== 3) return reply.code(400).send(fail(400, 'Complete browser execution identity is required'))
      const execution = rootSessionId && rootRunId && ownerRunId ? { rootSessionId, rootRunId, ownerRunId } : undefined
      const controller = new AbortController()
      const closed = () => { if (!reply.raw.writableEnded) controller.abort() }
      reply.raw.once('close', closed)
      try {
        return success(await bridge.watchRequest(identity(request), request.params.clientId, token(request),
          request.params.requestId, request.query.wait !== false, controller.signal, execution))
      } finally { reply.raw.removeListener('close', closed) }
    })

  fastify.post<{ Params: { clientId: string }; Body: { requestId: string; success: boolean; output: string; error?: string;
    status?: ToolResult['status']; execution?: BrowserExecutionIdentity; metadata?: NativeResultMetadata } }>('/browser/clients/:clientId/results', {
    bodyLimit: 12 * 1024 * 1024,
    preValidation: async (request, reply) => {
      if (!exactNativeResult(request.body)) return reply.code(400).send(fail(400, 'Invalid native browser result types'))
    },
    schema: { body: { type: 'object', additionalProperties: false, required: ['requestId', 'success', 'output'], properties: {
      requestId: idSchema, success: { type: 'boolean' }, output: { type: 'string', maxLength: 12 * 1024 * 1024 },
      error: { type: 'string', maxLength: 4000 },
      status: { type: 'string', enum: ['succeeded', 'failed', 'cancelled', 'interrupted'] },
      execution: executionSchema,
      metadata: { type: 'object', additionalProperties: false, required: ['code', 'operationPerformed'], properties: {
        code: { type: 'string', minLength: 9, maxLength: 100, pattern: '^BROWSER_[A-Z_]+$' },
        operationPerformed: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['unknown'] }] },
      } },
    } } },
  }, async request => {
    const { requestId, execution, ...result } = request.body
    return success({ accepted: bridge.result(identity(request), request.params.clientId, token(request), requestId, result, execution) })
  })

  fastify.delete<{ Params: { clientId: string } }>('/browser/clients/:clientId', async request => {
    bridge.unregister(identity(request), request.params.clientId, token(request))
    return success({ removed: true })
  })
  await browserHostRoutes(fastify, bridge)
}

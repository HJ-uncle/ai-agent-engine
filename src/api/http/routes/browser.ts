import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthContext } from '../../../auth/types.js'
import { BROWSER_ACTIONS, BrowserBridgeError, browserBridge, type BrowserBridge } from '../../../tools/browser/browser-bridge.js'
import { success, fail } from '../response.js'

const identity = (request: FastifyRequest) => {
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  return { tenantId: auth?.tenantId ?? 'default', userId: auth?.userId }
}
const token = (request: FastifyRequest): string => {
  const value = request.headers['x-aether-browser-token']
  return typeof value === 'string' && value.length <= 128 ? value : ''
}
const idSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } as const

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

  fastify.post<{ Body: { sessionId: string; clientId?: string; clientToken?: string } }>('/browser/clients', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: {
      sessionId: idSchema, clientId: idSchema, clientToken: { type: 'string', minLength: 32, maxLength: 128 },
    } } },
  }, async (request, reply) => {
    const { sessionId, clientId, clientToken } = request.body
    if (Boolean(clientId) !== Boolean(clientToken)) return reply.code(400).send(fail(400, 'clientId and clientToken must be supplied together'))
    return success(bridge.register(identity(request), sessionId, clientId && clientToken ? { clientId, clientToken } : undefined))
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
              args: { type: 'object', additionalProperties: true }, expiresAt: { type: 'number' },
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

  fastify.get<{ Params: { clientId: string; requestId: string }; Querystring: { wait?: boolean } }>(
    '/browser/clients/:clientId/requests/:requestId/state', {
      schema: {
        params: { type: 'object', required: ['clientId', 'requestId'], properties: { clientId: idSchema, requestId: idSchema } },
        querystring: { type: 'object', additionalProperties: false, properties: { wait: { type: 'boolean', default: true } } },
      },
    }, async (request, reply) => {
      const controller = new AbortController()
      const closed = () => { if (!reply.raw.writableEnded) controller.abort() }
      reply.raw.once('close', closed)
      try {
        return success(await bridge.watchRequest(identity(request), request.params.clientId, token(request),
          request.params.requestId, request.query.wait !== false, controller.signal))
      } finally { reply.raw.removeListener('close', closed) }
    })

  fastify.post<{ Params: { clientId: string }; Body: { requestId: string; success: boolean; output: string; error?: string } }>('/browser/clients/:clientId/results', {
    bodyLimit: 12 * 1024 * 1024,
    schema: { body: { type: 'object', additionalProperties: false, required: ['requestId', 'success', 'output'], properties: {
      requestId: idSchema, success: { type: 'boolean' }, output: { type: 'string', maxLength: 12 * 1024 * 1024 },
      error: { type: 'string', maxLength: 4000 },
    } } },
  }, async request => {
    const { requestId, ...result } = request.body
    return success({ accepted: bridge.result(identity(request), request.params.clientId, token(request), requestId, result) })
  })

  fastify.delete<{ Params: { clientId: string } }>('/browser/clients/:clientId', async request => {
    bridge.unregister(identity(request), request.params.clientId, token(request))
    return success({ removed: true })
  })
}

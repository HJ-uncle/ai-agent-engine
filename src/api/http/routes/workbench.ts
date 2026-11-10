import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthContext } from '../../../auth/types.js'
import { WORKBENCH_ACTIONS, WorkbenchBridgeError, workbenchBridge, type WorkbenchBridge } from '../../../tools/workbench/bridge.js'
import { fail, success } from '../response.js'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const auth = z.object({ clientToken: z.string().min(32).max(128) })
const execution = z.object({ rootSessionId: id, rootRunId: id, ownerRunId: id }).strict()
const receipt = auth.extend({ requestId: id, execution, result: z.object({
  success: z.boolean(), output: z.string().max(6 * 1024 * 1024 + 16384),
  metadata: z.object({ code: z.string().regex(/^WORKBENCH_[A-Z_]+$/), operationPerformed: z.union([z.boolean(), z.literal('unknown')]) }).strict(),
}).strict() }).strict()
const identity = (request: FastifyRequest) => {
  const context = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  return { tenantId: context?.tenantId ?? 'default', userId: context?.userId }
}

export async function workbenchRoutes(app: FastifyInstance, options: { bridge?: WorkbenchBridge } = {}) {
  const bridge = options.bridge ?? workbenchBridge
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store') })
  app.addHook('onClose', async () => bridge.dispose())
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof WorkbenchBridgeError ? error.statusCode : error instanceof z.ZodError ? 400 : 500
    return reply.code(status).send(fail(status, status === 500 ? '工作台请求失败。' : error instanceof Error ? error.message : '无效的工作台请求。'))
  })
  app.post('/workbench/clients', async request => {
    const body = z.object({ sessionId: id, actions: z.array(z.enum(WORKBENCH_ACTIONS)).max(WORKBENCH_ACTIONS.length) }).strict().parse(request.body)
    return success(bridge.register(identity(request), body.sessionId, body.actions))
  })
  app.post<{ Params: { clientId: string } }>('/workbench/clients/:clientId/poll', async request => {
    const body = auth.strict().parse(request.body)
    return success({ commands: await bridge.poll(identity(request), id.parse(request.params.clientId), body.clientToken) })
  })
  app.post<{ Params: { clientId: string } }>('/workbench/clients/:clientId/state', async request => {
    const body = auth.extend({ requestId: id, execution }).strict().parse(request.body)
    return success({ active: bridge.active(identity(request), id.parse(request.params.clientId), body.clientToken, body.requestId, body.execution) })
  })
  app.post<{ Params: { clientId: string } }>('/workbench/clients/:clientId/results', { bodyLimit: 8 * 1024 * 1024 }, async request => {
    const body = receipt.parse(request.body)
    if (body.result.success && body.result.metadata.operationPerformed !== true) throw new WorkbenchBridgeError(400, '成功回执必须确认操作已执行。')
    return success({ accepted: bridge.result(identity(request), id.parse(request.params.clientId), body.clientToken, body.requestId, body.execution, body.result) })
  })
  app.post<{ Params: { clientId: string } }>('/workbench/clients/:clientId/disconnect', async request => {
    const body = auth.strict().parse(request.body)
    bridge.unregister(identity(request), id.parse(request.params.clientId), body.clientToken)
    return success({ removed: true })
  })
}

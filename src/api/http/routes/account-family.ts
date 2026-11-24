/** Personal endpoints; editing another principal's state never accepts a parent or tenant from the body. */
import type { FastifyInstance } from 'fastify'
import type { ChildAccount } from '../../../auth/account-family-types.js'
import { createChildAccount, listChildAccounts, setChildAccountStatus, enterChildAccount } from '../../../auth/account-family.js'
import { AccountAuthError } from '../../../auth/account-error.js'
import type { AuthContext } from '../../../auth/types.js'
import { requireAccountAuth } from '../../../auth/accounts.js'
import { success, fail } from '../response.js'
import type { FastifyReply, FastifyRequest } from 'fastify'

const options = { bodyLimit: 1024 }
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
function input(req: FastifyRequest, field?: string): Record<string, unknown> {
  const obj = req.body ?? {}
  if (typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(k => k !== field)) throw new AccountAuthError(400, '包含无效的子账号字段。')
  return obj as Record<string, unknown>
}
function idOf(req: FastifyRequest): string {
  const id = (req.params as { id?: string }).id
  if (!id || !uuid.test(id)) throw new AccountAuthError(404, '没有可管理的子账号。')
  return id
}
async function respond(req: FastifyRequest, reply: FastifyReply, work: (auth: AuthContext) => Promise<unknown>): Promise<unknown> {
  reply.header('Cache-Control', 'no-store')
  try {
    const auth = (req as FastifyRequest & { authContext?: AuthContext }).authContext
    requireAccountAuth(auth)
    return reply.send(success(await work(auth)))
  } catch (e) { if (e instanceof AccountAuthError) return reply.code(e.statusCode).send(fail(e.statusCode * 100, e.message)); throw e }
}
export async function accountFamilyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/account/children', (req, reply) => respond(req, reply, auth => listChildAccounts(auth)))
  app.post('/auth/account/children', options, (req, reply) => respond(req, reply, auth => createChildAccount(auth, input(req, 'name').name)))
  app.patch('/auth/account/children/:id', options, (req, reply) => respond(req, reply, auth => {
    const { status } = input(req, 'status')
    if (status !== 'active' && status !== 'disabled') throw new AccountAuthError(400, '子账号状态无效。')
    return setChildAccountStatus(auth, idOf(req), status satisfies ChildAccount['status'])
  }))
  app.post('/auth/account/children/:id/enter', options, (req, reply) => respond(req, reply, auth => {
    input(req); return enterChildAccount(auth, idOf(req))
  }))
}

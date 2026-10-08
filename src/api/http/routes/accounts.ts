import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthContext } from '../../../auth/types.js'
import { success, fail } from '../response.js'
import {
  AccountAuthError, checkAccountRateLimit, registerAccount, loginAccount, refreshAccountSession,
  getAccountUser, requireAccountAuth, updateAccountProfile, listAccountSessions,
  revokeAccountSession, rotateAccountRecovery, unlinkAccountIdentity,
} from '../../../auth/accounts.js'

export function isPublicAccountRoute(method: string, pathname: string): boolean {
  return method === 'POST' && ['/auth/account/register', '/auth/account/login', '/auth/account/refresh'].includes(pathname)
}
function context(request: FastifyRequest): AuthContext {
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  requireAccountAuth(auth); return auth
}
function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body) return {}
  if (typeof request.body !== 'object' || Array.isArray(request.body)) throw new AccountAuthError(400, '请求格式不正确')
  return request.body as Record<string, unknown>
}
function requiredString(request: FastifyRequest, key: string): string {
  const value = body(request)[key]
  if (typeof value !== 'string' || !value) throw new AccountAuthError(400, `缺少 ${key}`)
  return value
}
async function run(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  reply.header('Cache-Control', 'no-store')
  try { return reply.send(success(await operation())) }
  catch (error) {
    if (error instanceof AccountAuthError) return reply.code(error.statusCode).send(fail(error.statusCode * 100, error.message))
    throw error
  }
}
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // Smaller than workspace uploads: credentials and profiles never need megabytes of input.
  const options = { bodyLimit: 32 * 1024 }
  app.post('/auth/account/register', options, (request, reply) => run(reply, async () => {
    await checkAccountRateLimit(request.ip, 'register'); return registerAccount()
  }))
  app.post('/auth/account/login', options, (request, reply) => run(reply, async () => {
    await checkAccountRateLimit(request.ip, 'login'); return loginAccount(requiredString(request, 'recoveryKey'))
  }))
  app.post('/auth/account/refresh', options, (request, reply) => run(reply, async () => {
    await checkAccountRateLimit(request.ip, 'refresh')
    const requestId = body(request).requestId
    if (requestId !== undefined && typeof requestId !== 'string') throw new AccountAuthError(400, '刷新请求标识格式不正确')
    return refreshAccountSession(requiredString(request, 'refreshToken'), requestId)
  }))
  app.get('/auth/account/me', (request, reply) => run(reply, () => {
    const auth = context(request); return getAccountUser(auth.userId!, auth.sessionId)
  }))
  app.patch('/auth/account/profile', options, (request, reply) => run(reply, () => updateAccountProfile(context(request), body(request))))
  app.get('/auth/account/sessions', (request, reply) => run(reply, () => listAccountSessions(context(request))))
  app.post('/auth/account/logout', options, (request, reply) => run(reply, async () => {
    const auth = context(request); await revokeAccountSession(auth, auth.sessionId, body(request).all === true); return { loggedOut: true }
  }))
  app.delete<{ Params: { id: string } }>('/auth/account/sessions/:id', (request, reply) => run(reply, async () => {
    await revokeAccountSession(context(request), request.params.id); return { revoked: true }
  }))
  app.post('/auth/account/recovery', options, (request, reply) => run(reply, () => rotateAccountRecovery(context(request))))
  app.delete<{ Params: { providerId: string } }>('/auth/account/identities/:providerId', (request, reply) => run(reply, () => unlinkAccountIdentity(context(request), request.params.providerId)))
}

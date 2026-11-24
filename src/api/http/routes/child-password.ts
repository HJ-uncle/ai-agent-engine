import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { childLoginName } from '../../../auth/child-password-hash.js'
import type { AuthContext } from '../../../auth/types.js'
import { AccountAuthError, checkAccountRateLimit, requireAccountAuth } from '../../../auth/accounts.js'
import { changeOwnChildPassword, childLoginInfo, issueChildResetCode, loginWithChildPassword, recoverChildPassword, saveChildLogin } from '../../../auth/child-login.js'
import { fail, success } from '../response.js'

const prefix = '/auth/account/child-password'
export const isPublicChildPasswordPath = (path: string): boolean => path === prefix + '/login' || path === prefix + '/recover'
function account(request: FastifyRequest): AuthContext {
  const auth = (request as FastifyRequest & {authContext?: AuthContext}).authContext
  requireAccountAuth(auth); return auth
}
function fields(req: FastifyRequest, keys: string[], required = keys): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AccountAuthError(400, '请输入所需的账号信息。')
  const input = req.body as Record<string, unknown>
  if (Object.keys(input).some(k => !keys.includes(k) || typeof input[k] !== 'string') || required.some(k => typeof input[k] !== 'string') || !Object.keys(input).length) throw new AccountAuthError(400, '账号信息的格式不正确。')
  return input
}
async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
  reply.header('Cache-Control','no-store')
  try { return reply.send(success(await work())) }
  catch (error) { if (error instanceof AccountAuthError) return reply.code(error.statusCode).send(fail(error.statusCode*100,error.message)); throw error }
}
export async function childPasswordRoutes(app: FastifyInstance): Promise<void> {
  const options = {bodyLimit: 8192, logLevel: 'silent' as const}
  const limitName = async (name: unknown, lane: 'login'|'recover'): Promise<string> => {
    const normalized = childLoginName(name)
    // Bound durable counters for invented login names; the same name is throttled across IPs.
    const bucket = createHash('sha256').update(normalized).digest('hex').slice(0,4)
    await checkAccountRateLimit(bucket,'child-password-name-'+lane)
    return normalized
  }
  app.post(prefix+'/login', options, (req, reply) => handle(reply, async () => {
    await checkAccountRateLimit(req.ip, 'child-password-login')
    const b = fields(req, ['loginName','password']); return loginWithChildPassword(await limitName(b.loginName,'login'),b.password)
  }))
  app.post(prefix+'/recover', options, (req, reply) => handle(reply, async () => {
    await checkAccountRateLimit(req.ip, 'child-password-recover')
    const b = fields(req, ['loginName','recoveryKey','newPassword']); return recoverChildPassword(await limitName(b.loginName,'recover'),b.recoveryKey,b.newPassword)
  }))
  app.post(prefix+'/reset-code', options, (req,reply) => handle(reply, async () => {
    const a=account(req); await checkAccountRateLimit(a.userId!, 'child-password-code')
    return issueChildResetCode(a,fields(req,['currentPassword']).currentPassword)
  }))
  app.get(prefix+'/me', options, (req,reply) => handle(reply, () => childLoginInfo(account(req))))
  app.post(prefix+'/me', options, (req,reply) => handle(reply, async () => {
    const a=account(req); await checkAccountRateLimit(a.userId!, 'child-password-change')
    const b=fields(req,['newPassword','currentPassword','recoveryKey'],['newPassword'])
    if ((b.currentPassword === undefined) === (b.recoveryKey === undefined)) throw new AccountAuthError(400,'请用当前密码或恢复码验证本人。')
    return changeOwnChildPassword(a,b,b.newPassword)
  }))
  app.get<{Params:{id:string}}>(prefix+'/children/:id', options, (req,reply) => handle(reply, () => childLoginInfo(account(req),req.params.id)))
  app.put<{Params:{id:string}}>(prefix+'/children/:id', options, (req,reply) => handle(reply, async () => {
    const a=account(req); await checkAccountRateLimit(a.userId!, 'child-password-manage')
    return saveChildLogin(a,req.params.id,fields(req,['loginName','password'],[]))
  }))
}

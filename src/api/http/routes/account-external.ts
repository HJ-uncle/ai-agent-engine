import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getDb } from '../../../storage/sqlite/db.js'
import { AccountAuthError, completeExternalIdentity, requireRecentAccountAuth, revalidateAccountAuth } from '../../../auth/accounts.js'
import type { AuthContext } from '../../../auth/types.js'
import { beginAccountTransaction, executeAccountWrite } from '../../../auth/account-database.js'
import { AccountProviderRegistry, assertAccountProviderUrl, type VerifiedExternalIdentity } from '../../../auth/account-providers.js'
import { success, fail } from '../response.js'

const BASE = '/auth/account'
const FLOW_TTL = 5 * 60_000
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
type AccountRequest = FastifyRequest & { authContext?: AuthContext }
type FlowPayload = { nonce: string; codeVerifier: string; redirectUri: string; linkAuth?: AuthContext }
const startSchema = z.object({ providerId: z.string().min(1).max(64), mode: z.enum(['login', 'link']).default('login') }).strict()
const credentialSchema = startSchema.extend({ credential: z.string().min(1).max(16 * 1024) })
const pollSchema = z.object({ flowId: z.string().uuid(), pollToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()

export function isExternalAccountCallback(method: string, pathname: string): boolean {
  return method === 'GET' && pathname === `${BASE}/external/callback`
}
export function isPublicExternalAccountRoute(method: string, pathname: string): boolean {
  return (method === 'GET' && pathname === `${BASE}/providers`) || isExternalAccountCallback(method, pathname)
    || (method === 'POST' && [`${BASE}/external/start`, `${BASE}/external/poll`, `${BASE}/external/credential`].includes(pathname))
}
function encryptionKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new AccountAuthError(503, '第三方浏览器登录需要服务端配置 ENCRYPTION_KEY')
  return Buffer.from(value, 'hex')
}
function seal(value: unknown, key: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}
function unseal<T>(value: string, key: Buffer): T {
  const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')) as T
}
async function rateLimit(request: FastifyRequest, lane: string, max: number): Promise<void> {
  const now = Date.now(), scope = `${lane}:${hash(request.ip)}`
  const tx = await beginAccountTransaction()
  try {
    await tx.execute({ sql: 'DELETE FROM account_external_limits WHERE reset_at < ?', args: [now] })
    const count = await tx.execute('SELECT COUNT(*) AS total FROM account_external_limits')
    if (Number(count.rows[0].total) >= 10_000) throw new AccountAuthError(429, '登录请求繁忙，请稍后重试')
    const result = await tx.execute({
      sql: `INSERT INTO account_external_limits(scope,count,reset_at) VALUES(?,1,?)
        ON CONFLICT(scope) DO UPDATE SET count=count+1 RETURNING count`, args: [scope, now + 60_000],
    })
    await tx.commit()
    if (Number(result.rows[0].count) > max) throw new AccountAuthError(429, '登录请求过于频繁，请稍后重试')
  } finally { tx.close() }
}
async function linkContext(request: FastifyRequest, mode: 'login' | 'link'): Promise<AuthContext | undefined> {
  if (mode !== 'link') return undefined
  const auth = (request as AccountRequest).authContext
  requireRecentAccountAuth(auth)
  if (!auth || auth.method !== 'session') throw new AccountAuthError(401, '请先登录本系统，再绑定第三方账号')
  await revalidateAccountAuth(auth)
  return auth
}
function callbackUri(): string {
  const configured = process.env.AETHER_ACCOUNT_PUBLIC_URL
  if (!configured) throw new AccountAuthError(503, '第三方浏览器登录需要服务端配置 AETHER_ACCOUNT_PUBLIC_URL')
  const url = assertAccountProviderUrl(configured)
  if (url.search) throw new AccountAuthError(503, 'AETHER_ACCOUNT_PUBLIC_URL 不允许查询参数')
  return `${url.href.replace(/\/$/, '')}${BASE}/external/callback`
}
function handleError(error: unknown, reply: FastifyReply): void {
  if (error instanceof AccountAuthError) { reply.code(error.statusCode).send(fail(error.statusCode * 100, error.message)); return }
  if (error instanceof z.ZodError) { reply.code(400).send(fail(40000, '登录请求参数不合法')); return }
  // Provider responses may contain tokens/PII; never echo upstream errors or payloads.
  reply.code(400).send(fail(40000, '第三方认证未完成，请检查凭证或联系管理员确认登录配置'))
}
export async function externalAccountRoutes(app: FastifyInstance): Promise<void> {
  const registry = AccountProviderRegistry.fromEnvironment()
  // Configuration is immutable for this server lifetime. Provider IDs therefore cannot be switched mid-flow.
  const sweep = async (): Promise<void> => {
    await executeAccountWrite({ sql: 'DELETE FROM account_external_flows WHERE expires_at < ?', args: [Date.now()] })
    await executeAccountWrite({ sql: 'DELETE FROM account_external_limits WHERE reset_at < ?', args: [Date.now()] })
  }
  const cleanup = setInterval(() => { void sweep().catch(() => {}) }, 60_000)
  cleanup.unref()
  app.addHook('onClose', async () => { clearInterval(cleanup) })
  app.get(`${BASE}/providers`, async () => success({ providers: registry.listPublic(), registrationEnabled: process.env.AETHER_ACCOUNT_REGISTRATION !== 'false' }))
  app.post(`${BASE}/external/start`, { bodyLimit: 4096, logLevel: 'silent' }, async (request, reply) => {
    try {
      const body = startSchema.parse(request.body)
      await rateLimit(request, 'start', 10)
      const key = encryptionKey(), linkAuth = await linkContext(request, body.mode)
      const redirectUri = callbackUri(), flowId = randomUUID(), pollToken = randomBytes(32).toString('base64url')
      const browser = await registry.startBrowser(body.providerId, redirectUri)
      const tx = await beginAccountTransaction()
      try {
        await tx.execute({ sql: 'DELETE FROM account_external_flows WHERE expires_at < ?', args: [Date.now()] })
        const count = await tx.execute('SELECT COUNT(*) AS total FROM account_external_flows')
        if (Number(count.rows[0].total) >= 10_000) throw new AccountAuthError(429, '待完成登录过多，请稍后重试')
        const payload: FlowPayload = { nonce: browser.nonce, codeVerifier: browser.codeVerifier, redirectUri, linkAuth }
        await tx.execute({ sql: `INSERT INTO account_external_flows(id,state_hash,poll_hash,provider_id,payload,expires_at) VALUES(?,?,?,?,?,?)`,
          args: [flowId, hash(browser.state), hash(pollToken), body.providerId, seal(payload, key), Date.now() + FLOW_TTL] })
        await tx.commit()
      } finally { tx.close() }
      return reply.header('Cache-Control', 'no-store').send(success({ authorizationUrl: browser.authorizationUrl, flowId, pollToken }))
    } catch (error) { handleError(error, reply) }
  })
  app.get(`${BASE}/external/callback`, { logLevel: 'silent' }, async (request, reply) => {
    let flowId: string | undefined
    try {
      await rateLimit(request, 'callback', 60)
      const query = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().max(8192).optional(), error: z.string().max(256).optional() }).passthrough().parse(request.query)
      const key = encryptionKey()
      const claimed = await executeAccountWrite({ sql: `UPDATE account_external_flows SET status='processing'
        WHERE state_hash=? AND status='pending' AND expires_at>? RETURNING id,provider_id,payload`, args: [hash(query.state), Date.now()] })
      const row = claimed.rows[0]
      if (!row) throw new AccountAuthError(400, '登录流程无效、已使用或已过期')
      flowId = String(row.id)
      if (query.error || !query.code) throw new AccountAuthError(400, '第三方授权已取消或未完成')
      const payload = unseal<FlowPayload>(String(row.payload), key)
      if (payload.linkAuth) { requireRecentAccountAuth(payload.linkAuth); await revalidateAccountAuth(payload.linkAuth) }
      const identity = await registry.completeBrowser(String(row.provider_id), {
        ...payload, code: query.code, state: query.state, expectedState: query.state,
      })
      if (payload.linkAuth) await revalidateAccountAuth(payload.linkAuth)
      await executeAccountWrite({ sql: `UPDATE account_external_flows SET status='complete', identity=? WHERE id=? AND status='processing' AND expires_at>?`,
        args: [seal(identity, key), flowId, Date.now()] })
      return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'").type('text/plain; charset=utf-8')
        .send('授权已完成。请返回 Aether，完成登录或账号绑定。此页面可关闭。')
    } catch (error) {
      if (flowId) await executeAccountWrite({ sql: `UPDATE account_external_flows SET status='failed',payload='',identity=NULL WHERE id=?`, args: [flowId] }).catch(() => {})
      return reply.code(400).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').type('text/plain; charset=utf-8')
        .send(error instanceof AccountAuthError ? error.message : '第三方授权未完成，请返回 Aether 重新发起登录。')
    }
  })
  app.post(`${BASE}/external/poll`, { bodyLimit: 4096, logLevel: 'silent' }, async (request, reply) => {
    try {
      const body = pollSchema.parse(request.body)
      await rateLimit(request, 'poll', 240)
      const db = getDb()
      const result = await db.execute({ sql: `SELECT status FROM account_external_flows WHERE id=? AND poll_hash=? AND expires_at>?`,
        args: [body.flowId, hash(body.pollToken), Date.now()] })
      const row = result.rows[0]
      if (!row) throw new AccountAuthError(400, '登录流程无效、已领取或已过期')
      if (row.status === 'failed') throw new AccountAuthError(400, '第三方授权未完成，请重新发起登录')
      if (row.status !== 'complete') return reply.header('Cache-Control', 'no-store').send(success({ status: 'pending' }))
      // Only a holder of the separately delivered poll secret can consume a callback, exactly once.
      const consumed = await executeAccountWrite({ sql: `DELETE FROM account_external_flows WHERE id=? AND poll_hash=? AND status='complete' AND expires_at>? RETURNING payload,identity`,
        args: [body.flowId, hash(body.pollToken), Date.now()] })
      if (!consumed.rows[0]) throw new AccountAuthError(409, '该登录结果已被领取')
      const key = encryptionKey(), payload = unseal<FlowPayload>(String(consumed.rows[0].payload), key)
      const identity = unseal<VerifiedExternalIdentity>(String(consumed.rows[0].identity), key)
      if (payload.linkAuth) { requireRecentAccountAuth(payload.linkAuth); await revalidateAccountAuth(payload.linkAuth) }
      const account = await completeExternalIdentity(identity, payload.linkAuth)
      return reply.header('Cache-Control', 'no-store').send(success({ status: 'complete', result: account }))
    } catch (error) { handleError(error, reply) }
  })
  app.post(`${BASE}/external/credential`, { bodyLimit: 20 * 1024, logLevel: 'silent' }, async (request, reply) => {
    try {
      const body = credentialSchema.parse(request.body)
      await rateLimit(request, 'credential', 10)
      const auth = await linkContext(request, body.mode)
      const identity = await registry.exchangeCredential(body.providerId, body.credential)
      if (auth) await revalidateAccountAuth(auth)
      const result = await completeExternalIdentity(identity, auth)
      return reply.header('Cache-Control', 'no-store').send(success(result))
    } catch (error) { handleError(error, reply) }
  })
}

import { beginAccountTransaction, executeAccountWrite } from './account-database.js'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Client, Row, Transaction } from '@libsql/client'
import { getDb } from '../storage/sqlite/db.js'
import type { AuthContext } from './types.js'

type Database = Client | Transaction
const ACCESS_MS = 15 * 60 * 1000
const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_MS = 10 * 60 * 1000
const NEW_ROLES = ['tenant-admin']
export interface AccountIdentity {
  id: string; providerId: string; issuer: string; subject: string
  name: string | null; email: string | null; avatarUrl: string | null
  userData: Record<string, unknown>; createdAt: string
}
export interface AccountUser {
  id: string; tenantId: string; name: string; email: string | null; avatarUrl: string | null
  bio: string | null; userData: Record<string, unknown>; createdAt: string
  identities: AccountIdentity[]; hasRecoveryKey: boolean; sessionId?: string
}
export interface AccountLoginResult {
  user: AccountUser; accessToken: string; refreshToken: string; expiresAt: string; recoveryKey?: string
}
export interface ExternalIdentity {
  providerId: string; issuer?: string; subject: string; name?: string; email?: string
  avatarUrl?: string; userData?: Record<string, unknown>
}
export class AccountAuthError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); this.name = 'AccountAuthError' }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = (prefix: string) => prefix + randomBytes(32).toString('base64url')
const iso = (value: number) => new Date(value).toISOString()
const randomName = () => `用户 ${randomBytes(3).toString('hex')}`

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  const parsed: unknown = JSON.parse(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
function sanitizeData(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountAuthError(400, 'userData 必须是 JSON 对象')
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > 16_384) throw new AccountAuthError(400, '扩展资料不能超过 16 KB')
  // Store metadata separately from authorization; reject prototype keys at any depth.
  const visit = (node: unknown, depth: number): void => {
    if (depth > 10) throw new AccountAuthError(400, '扩展资料层级过深')
    if (!node || typeof node !== 'object') return
    for (const [key, item] of Object.entries(node)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new AccountAuthError(400, '扩展资料包含无效字段')
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
  return JSON.parse(serialized) as Record<string, unknown>
}
function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > max) throw new AccountAuthError(400, '资料字段格式或长度不正确')
  return value.trim() || null
}
function avatar(value: unknown): string | null {
  const candidate = text(value, 2048)
  if (!candidate) return null
  try { if (new URL(candidate).protocol === 'https:') return candidate } catch { /* invalid */ }
  throw new AccountAuthError(400, '头像必须使用 HTTPS 地址')
}
async function audit(db: Database, userId: string | null, event: string): Promise<void> {
  await db.execute({ sql: 'INSERT INTO account_audit(id,user_id,event,created_at) VALUES(?,?,?,?)', args: [randomUUID(), userId, event, Date.now()] })
}
export function requireAccountAuth(auth?: AuthContext): asserts auth is AuthContext & { userId: string } {
  if (!auth?.userId || auth.method !== 'session' || !auth.sessionId) throw new AccountAuthError(401, '请先使用账号会话登录')
}
export function requireRecentAccountAuth(auth?: AuthContext): void {
  requireAccountAuth(auth)
  if (auth.method !== 'session' || !auth.authenticatedAt || Date.now() - auth.authenticatedAt > RECENT_MS) {
    throw new AccountAuthError(403, '此操作需要重新验证登录，请使用恢复凭证或第三方账号重新登录')
  }
}
export async function revalidateAccountAuth(auth: AuthContext): Promise<void> {
  requireAccountAuth(auth)
  if (auth.method !== 'session' || !auth.sessionId) throw new AccountAuthError(401, '请使用账号会话登录')
  const result = await getDb().execute({
    sql: 'SELECT s.id FROM account_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND u.tenant_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.access_expires_at>?',
    args: [auth.sessionId, auth.userId, auth.tenantId, Date.now(), Date.now()],
  })
  if (!result.rows.length) throw new AccountAuthError(401, '登录已失效，请重新登录')
}
export async function getAccountUser(userId: string, sessionId?: string, db: Database = getDb()): Promise<AccountUser> {
  const result = await db.execute({ sql: 'SELECT u.*, p.recovery_hash, p.avatar_url, p.bio, p.user_data FROM users u LEFT JOIN account_profiles p ON p.user_id=u.id WHERE u.id=?', args: [userId] })
  const row = result.rows[0]
  if (!row) throw new AccountAuthError(401, '账号不存在')
  const identities = await db.execute({ sql: 'SELECT * FROM account_identities WHERE user_id=? ORDER BY created_at', args: [userId] })
  return {
    id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name ?? 'Aether 用户'),
    email: row.email ? String(row.email) : null, avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    bio: row.bio ? String(row.bio) : null, userData: readObject(row.user_data),
    createdAt: iso(Number(row.created_at) * 1000), hasRecoveryKey: Boolean(row.recovery_hash || row.api_key_hash),
    identities: identities.rows.map(identity => ({
      id: String(identity.id), providerId: String(identity.provider_id), issuer: String(identity.issuer), subject: String(identity.subject),
      name: identity.name ? String(identity.name) : null, email: identity.email ? String(identity.email) : null,
      avatarUrl: identity.avatar_url ? String(identity.avatar_url) : null,
      userData: readObject(identity.user_data), createdAt: iso(Number(identity.created_at)),
    })), ...(sessionId ? { sessionId } : {}),
  }
}
async function createUser(db: Database, profile?: ExternalIdentity): Promise<{ id: string; recoveryKey: string }> {
  const id = randomUUID(), tenantId = `account_${randomUUID()}`, now = Date.now()
  const recoveryKey = secret('aether_recovery_')
  await db.execute({ sql: 'INSERT INTO users(id,tenant_id,name,email,created_at) VALUES(?,?,?,?,?)', args: [id, tenantId, text(profile?.name, 100) ?? randomName(), text(profile?.email, 320), Math.floor(now / 1000)] })
  await db.execute({ sql: 'INSERT INTO account_profiles(user_id,recovery_hash,avatar_url,user_data,roles,updated_at) VALUES(?,?,?,?,?,?)', args: [id, hash(recoveryKey), avatar(profile?.avatarUrl), JSON.stringify(sanitizeData(profile?.userData)), JSON.stringify(NEW_ROLES), now] })
  await audit(db, id, 'account.created')
  return { id, recoveryKey }
}
async function issueSession(db: Database, userId: string): Promise<AccountLoginResult> {
  const now = Date.now(), id = randomUUID(), accessToken = secret('aether_session_'), refreshToken = secret('aether_refresh_')
  await db.execute({ sql: 'INSERT INTO account_sessions(id,user_id,access_hash,access_expires_at,created_at,authenticated_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)', args: [id, userId, hash(accessToken), now + ACCESS_MS, now, now, now + SESSION_MS, now] })
  await db.execute({ sql: 'INSERT INTO account_refresh_tokens(token_hash,session_id,created_at) VALUES(?,?,?)', args: [hash(refreshToken), id, now] })
  await audit(db, userId, 'session.created')
  return { user: await getAccountUser(userId, id, db), accessToken, refreshToken, expiresAt: iso(now + ACCESS_MS) }
}
export async function registerAccount(): Promise<AccountLoginResult> {
  if (process.env.AETHER_ACCOUNT_REGISTRATION === 'false') throw new AccountAuthError(403, '管理员已关闭一键创建账号，请使用已有账号或第三方登录')
  const tx = await beginAccountTransaction()
  try {
    const created = await createUser(tx)
    const result = await issueSession(tx, created.id)
    await tx.commit()
    return { ...result, recoveryKey: created.recoveryKey }
  } finally { tx.close() }
}
export async function loginAccount(recoveryKey: string): Promise<AccountLoginResult> {
  if (!recoveryKey || recoveryKey.length > 4096) throw new AccountAuthError(401, '恢复凭证无效')
  const tx = await beginAccountTransaction()
  try {
    const result = await tx.execute({ sql: 'SELECT u.id, p.user_id AS profile_id FROM users u LEFT JOIN account_profiles p ON p.user_id=u.id WHERE p.recovery_hash=? OR u.api_key_hash=?', args: [hash(recoveryKey), hash(recoveryKey)] })
    if (result.rows.length !== 1) throw new AccountAuthError(401, '恢复凭证无效')
    const user = result.rows[0], id = String(user.id)
    // Legacy API keys retain their existing authority and, crucially, their tenant and data.
    if (!user.profile_id) await tx.execute({ sql: 'INSERT INTO account_profiles(user_id,roles,updated_at) VALUES(?,?,?)', args: [id, '["admin"]', Date.now()] })
    const session = await issueSession(tx, id)
    await tx.commit()
    return session
  } finally { tx.close() }
}
export async function authenticateAccountSession(token: string): Promise<AuthContext> {
  const now = Date.now()
  const db = getDb(), result = await db.execute({ sql: `SELECT s.*, u.tenant_id, p.roles FROM account_sessions s JOIN users u ON u.id=s.user_id JOIN account_profiles p ON p.user_id=u.id
      WHERE s.id IN (SELECT id FROM account_sessions WHERE access_hash=? AND access_expires_at>?
        UNION ALL SELECT session_id FROM account_access_tokens WHERE token_hash=? AND expires_at>?)
      AND s.revoked_at IS NULL AND s.expires_at>?`, args: [hash(token), now, hash(token), now, now] })
  const row = result.rows[0]
  if (!row) throw new AccountAuthError(401, '登录已失效，请刷新会话或重新登录')
  if (now - Number(row.last_seen_at) > 60_000) await executeAccountWrite({ sql: 'UPDATE account_sessions SET last_seen_at=? WHERE id=?', args: [now, String(row.id)] })
  const parsed: unknown = JSON.parse(String(row.roles))
  return { tenantId: String(row.tenant_id), userId: String(row.user_id), method: 'session', sessionId: String(row.id), authenticatedAt: Number(row.authenticated_at), roles: Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [] }
}
function refreshRetryKey(token: string): Buffer {
  // The DB stores SHA256(token), so use a distinct domain that cannot be reconstructed from that hash.
  return createHash('sha256').update('aether.refresh.retry\0').update(token).digest()
}
function encryptRefreshResult(token: string, requestId: string, result: AccountLoginResult): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', refreshRetryKey(token), iv)
  cipher.setAAD(Buffer.from(hash(requestId)))
  const payload = Buffer.concat([cipher.update(JSON.stringify(result), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64')
}
function decryptRefreshResult(token: string, requestId: string, encrypted: string): AccountLoginResult {
  const payload = Buffer.from(encrypted, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', refreshRetryKey(token), payload.subarray(0, 12))
  decipher.setAAD(Buffer.from(hash(requestId)))
  decipher.setAuthTag(payload.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')) as AccountLoginResult
}
export async function refreshAccountSession(refreshToken: string, requestId?: string): Promise<AccountLoginResult> {
  if (!refreshToken.startsWith('aether_refresh_') || refreshToken.length > 256) throw new AccountAuthError(401, '刷新凭证无效')
  if (requestId !== undefined && !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) throw new AccountAuthError(400, '刷新请求标识格式不正确')
  const tx = await beginAccountTransaction()
  try {
    const found = await tx.execute({ sql: 'SELECT r.consumed_at, r.request_hash, r.retry_result, r.retry_expires_at, s.* FROM account_refresh_tokens r JOIN account_sessions s ON s.id=r.session_id WHERE r.token_hash=?', args: [hash(refreshToken)] })
    const row = found.rows[0], now = Date.now()
    if (!row || row.revoked_at || Number(row.expires_at) <= now) throw new AccountAuthError(401, '登录已失效，请重新登录')
    if (row.consumed_at !== null) {
      if (requestId && row.request_hash === hash(requestId) && row.retry_result && Number(row.retry_expires_at) > now) {
        const result = decryptRefreshResult(refreshToken, requestId, String(row.retry_result))
        await tx.commit()
        return result
      }
      await tx.execute({ sql: 'UPDATE account_sessions SET revoked_at=? WHERE id=?', args: [now, String(row.id)] })
      await audit(tx, String(row.user_id), 'session.refresh_replay')
      await tx.commit()
      throw new AccountAuthError(401, '刷新凭证已使用，会话已撤销，请重新登录')
    }
    const accessToken = secret('aether_session_'), nextRefreshToken = secret('aether_refresh_')
    const expiry = Math.min(now + ACCESS_MS, Number(row.expires_at))
    // In-flight HTTP/WS handshakes keep their original access lifetime; revocation still applies to the session.
    await tx.execute({ sql: 'DELETE FROM account_access_tokens WHERE session_id=? AND expires_at<=?', args: [String(row.id), now] })
    if (Number(row.access_expires_at) > now) {
      await tx.execute({ sql: 'INSERT INTO account_access_tokens(token_hash,session_id,expires_at) VALUES(?,?,?)', args: [String(row.access_hash), String(row.id), Number(row.access_expires_at)] })
    }
    await tx.execute({ sql: 'UPDATE account_sessions SET access_hash=?,access_expires_at=?,last_seen_at=? WHERE id=?', args: [hash(accessToken), expiry, now, String(row.id)] })
    await tx.execute({ sql: 'INSERT INTO account_refresh_tokens(token_hash,session_id,created_at) VALUES(?,?,?)', args: [hash(nextRefreshToken), String(row.id), now] })
    const user = await getAccountUser(String(row.user_id), String(row.id), tx)
    const result: AccountLoginResult = { user, accessToken, refreshToken: nextRefreshToken, expiresAt: iso(expiry) }
    await tx.execute({ sql: 'UPDATE account_refresh_tokens SET consumed_at=?,request_hash=?,retry_result=?,retry_expires_at=? WHERE token_hash=?', args: [now, requestId ? hash(requestId) : null, requestId ? encryptRefreshResult(refreshToken, requestId, result) : null, requestId ? now + 5 * 60_000 : null, hash(refreshToken)] })
    await tx.commit()
    return result
  } finally { tx.close() }
}
export async function updateAccountProfile(auth: AuthContext, input: Record<string, unknown>): Promise<AccountUser> {
  requireAccountAuth(auth)
  const allowed = ['name', 'email', 'avatarUrl', 'bio', 'userData']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new AccountAuthError(400, '包含不可修改的账号字段')
  const current = await getAccountUser(auth.userId)
  const tx = await beginAccountTransaction()
  try {
    await tx.execute({ sql: 'UPDATE users SET name=?,email=? WHERE id=? AND tenant_id=?', args: [input.name === undefined ? current.name : text(input.name, 100) ?? randomName(), input.email === undefined ? current.email : text(input.email, 320), auth.userId, auth.tenantId] })
    await tx.execute({ sql: 'UPDATE account_profiles SET avatar_url=?,bio=?,user_data=?,updated_at=? WHERE user_id=?', args: [input.avatarUrl === undefined ? current.avatarUrl : avatar(input.avatarUrl), input.bio === undefined ? current.bio : text(input.bio, 1000), JSON.stringify(input.userData === undefined ? current.userData : sanitizeData(input.userData)), Date.now(), auth.userId] })
    const result = await getAccountUser(auth.userId, auth.sessionId, tx)
    await tx.commit()
    return result
  } finally { tx.close() }
}
export async function listAccountSessions(auth: AuthContext): Promise<Record<string, unknown>[]> {
  requireAccountAuth(auth)
  const result = await getDb().execute({ sql: 'SELECT id,created_at,last_seen_at,expires_at FROM account_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC', args: [auth.userId, Date.now()] })
  return result.rows.map(row => ({ id: row.id, createdAt: iso(Number(row.created_at)), lastSeenAt: iso(Number(row.last_seen_at)), expiresAt: iso(Number(row.expires_at)), current: row.id === auth.sessionId }))
}
export async function revokeAccountSession(auth: AuthContext, sessionId?: string, all = false): Promise<void> {
  requireAccountAuth(auth)
  if (!all && !sessionId) throw new AccountAuthError(400, '没有可退出的账号会话')
  await executeAccountWrite({ sql: `UPDATE account_sessions SET revoked_at=? WHERE user_id=?${all ? '' : ' AND id=?'}`, args: all ? [Date.now(), auth.userId] : [Date.now(), auth.userId, sessionId!] })
  const tx = await beginAccountTransaction()
  try { await audit(tx, auth.userId, all ? 'session.revoked_all' : 'session.revoked'); await tx.commit() } finally { tx.close() }
}
export async function rotateAccountRecovery(auth: AuthContext): Promise<{ recoveryKey: string }> {
  requireAccountAuth(auth); requireRecentAccountAuth(auth)
  const recoveryKey = secret('aether_recovery_'), tx = await beginAccountTransaction()
  try {
    await tx.execute({ sql: 'UPDATE account_profiles SET recovery_hash=?,updated_at=? WHERE user_id=?', args: [hash(recoveryKey), Date.now(), auth.userId] })
    // Old API keys must stop being a second unrevoked recovery path after rotation.
    await tx.execute({ sql: 'UPDATE users SET api_key_hash=NULL WHERE id=?', args: [auth.userId] })
    await tx.execute({ sql: 'UPDATE account_sessions SET revoked_at=? WHERE user_id=? AND id<>?', args: [Date.now(), auth.userId, auth.sessionId!] })
    await audit(tx, auth.userId, 'account.recovery_rotated')
    await tx.commit(); return { recoveryKey }
  } finally { tx.close() }
}
export async function completeExternalIdentity(identity: ExternalIdentity, linkAuth?: AuthContext): Promise<AccountLoginResult | AccountUser> {
  if (!identity.providerId || !identity.subject || identity.subject.length > 2048) throw new AccountAuthError(400, '第三方身份信息不完整')
  if (linkAuth) { requireRecentAccountAuth(linkAuth); await revalidateAccountAuth(linkAuth) }
  const issuer = identity.issuer ?? identity.providerId
  const name = text(identity.name, 100), email = text(identity.email, 320), avatarUrl = avatar(identity.avatarUrl)
  const userData = JSON.stringify(sanitizeData(identity.userData)), now = Date.now(), tx = await beginAccountTransaction()
  try {
    const existing = await tx.execute({ sql: 'SELECT user_id FROM account_identities WHERE provider_id=? AND issuer=? AND subject=?', args: [identity.providerId, issuer, identity.subject] })
    let userId = existing.rows[0] ? String(existing.rows[0].user_id) : undefined
    if (linkAuth && userId && userId !== linkAuth.userId) throw new AccountAuthError(409, '此第三方账号已绑定其他账号；为保护原有数据，不能自动合并')
    let recoveryKey: string | undefined
    if (!userId) {
      if (linkAuth) { requireAccountAuth(linkAuth); userId = linkAuth.userId }
      else {
        if (process.env.AETHER_ACCOUNT_REGISTRATION === 'false') throw new AccountAuthError(403, '管理员已关闭自动注册')
        const created = await createUser(tx, identity); userId = created.id; recoveryKey = created.recoveryKey
      }
      await tx.execute({ sql: 'INSERT INTO account_identities(id,user_id,provider_id,issuer,subject,name,email,avatar_url,user_data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', args: [randomUUID(), userId, identity.providerId, issuer, identity.subject, name, email, avatarUrl, userData, now, now] })
    } else await tx.execute({ sql: `UPDATE account_identities SET name=CASE WHEN ? THEN name ELSE ? END, email=CASE WHEN ? THEN email ELSE ? END,
      avatar_url=CASE WHEN ? THEN avatar_url ELSE ? END, user_data=CASE WHEN ? THEN user_data ELSE ? END, updated_at=?
      WHERE provider_id=? AND issuer=? AND subject=?`, args: [identity.name === undefined ? 1 : 0, name, identity.email === undefined ? 1 : 0, email, identity.avatarUrl === undefined ? 1 : 0, avatarUrl, identity.userData === undefined ? 1 : 0, userData, now, identity.providerId, issuer, identity.subject] })
    await audit(tx, userId, linkAuth ? 'identity.linked' : 'identity.login')
    const result = linkAuth ? await getAccountUser(userId, linkAuth.sessionId, tx) : { ...await issueSession(tx, userId), ...(recoveryKey ? { recoveryKey } : {}) }
    await tx.commit(); return result
  } finally { tx.close() }
}
export async function unlinkAccountIdentity(auth: AuthContext, providerId: string): Promise<AccountUser> {
  requireAccountAuth(auth); requireRecentAccountAuth(auth)
  const tx = await beginAccountTransaction()
  try {
    const user = await getAccountUser(auth.userId, auth.sessionId, tx)
    if (!user.hasRecoveryKey && !user.identities.some(identity => identity.providerId !== providerId)) throw new AccountAuthError(409, '请先配置恢复凭证或绑定其他登录方式')
    await tx.execute({ sql: 'DELETE FROM account_identities WHERE user_id=? AND provider_id=?', args: [auth.userId, providerId] })
    await audit(tx, auth.userId, 'identity.unlinked')
    const result = await getAccountUser(auth.userId, auth.sessionId, tx)
    await tx.commit(); return result
  } finally { tx.close() }
}
/** Durable counters avoid clearing brute-force throttles simply by restarting the process. */
export async function checkAccountRateLimit(ip: string, operation: string): Promise<void> {
  const now = Date.now(), windowStart = now - 60_000, limit = operation === 'register' ? 10 : 60
  const result = await executeAccountWrite({
    sql: `INSERT INTO account_auth_attempts(bucket,window_start,attempts) VALUES(?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,
      window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts`,
    args: [hash(`${operation}:${ip}`), now, windowStart, windowStart],
  })
  if (Number(result.rows[0].attempts) > limit) throw new AccountAuthError(429, '操作过于频繁，请稍后重试')
}

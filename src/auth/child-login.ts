import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Client, Row, Transaction } from '@libsql/client'
import { getDb } from '../storage/sqlite/db.js'
import { beginAccountTransaction } from './account-database.js'
import { AccountAuthError, issueSession, requireAccountAuth } from './accounts.js'
import { childLoginName, matchesChildPassword, newChildPassword } from './child-password-hash.js'
import type { AuthContext } from './types.js'
import { familySessionAllowed } from './account-session-policy.js'

type Db = Client | Transaction
interface Input { loginName?: unknown; password?: unknown }
interface Proof { currentPassword?: unknown; recoveryKey?: unknown }
type Key = 'id' | 'name'
const denied = () => new AccountAuthError(404, '没有可管理的子账号。')
const stale = () => new AccountAuthError(409, '子账号凭据已变化，请重新打开后再试。')
const wrongLogin = () => new AccountAuthError(401, '子账号登录名或密码不正确。')
const wrongRecovery = () => new AccountAuthError(403, '子账号登录名或恢复码不正确。')
const nameOf = (row: Row) => ({ loginName: typeof row.login_name === 'string' ? row.login_name : null })
const passOf = (row?: Row) => typeof row?.password_hash === 'string' ? row.password_hash : undefined
const equalRevision = (before: Row, now?: Row) => now && before.child_id === now.child_id && before.login_name === now.login_name && before.password_hash === now.password_hash

async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await beginAccountTransaction()
  try { const result = await work(tx); await tx.commit(); return result } finally { tx.close() }
}
// The family relation is authoritative even for children who have a valid password hash. A disabled child cannot sign back in.
async function child(db: Db, key: Key, value: string): Promise<Row | undefined> {
  const where = key === 'id' ? 'f.child_id = ?' : 'c.login_name = ?'
  return (await db.execute({sql: 'SELECT f.child_id, f.parent_id, c.login_name, c.password_hash, k.code_hash FROM account_children f LEFT JOIN account_child_passwords c ON c.user_id=f.child_id LEFT JOIN account_child_reset_codes k ON k.user_id=f.child_id WHERE f.disabled_at IS NULL AND ' + where, args:[value]})).rows[0]
}
async function live(db: Db, auth: AuthContext, recent: boolean): Promise<string> {
  requireAccountAuth(auth)
  const now = Date.now()
  const s = (await db.execute({sql: 'SELECT s.authenticated_at FROM account_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND u.tenant_id=? AND s.revoked_at IS NULL AND s.access_expires_at>? AND s.expires_at>? AND ' + familySessionAllowed, args:[auth.sessionId!, auth.userId, auth.tenantId, now, now, now]})).rows[0]
  if (!s) throw new AccountAuthError(401, '登录已失效，请重新登录。')
  if (recent && (Number(s.authenticated_at) < now - 10 * 60_000 || Number(s.authenticated_at) > now)) throw new AccountAuthError(403, '此操作需要重新验证登录，请使用当前主账号的恢复凭证或第三方账号验证。')
  return auth.userId
}
async function managed(db: Db, auth: AuthContext, id: string, recent: boolean): Promise<Row> {
  const owner = await live(db, auth, recent), row = await child(db, 'id', id)
  if (!row || row.parent_id !== owner || row.child_id === owner) throw denied()
  const activated = await db.execute({sql:'SELECT 1 FROM account_activation_codes WHERE used_by=?',args:[owner]})
  if (!activated.rows.length) throw denied()
  return row
}
async function own(db: Db, auth: AuthContext): Promise<Row> {
  const id = await live(db, auth, false), row = await child(db, 'id', id)
  if (!row) throw denied()
  return row
}
function hasRecovery(row: Row | undefined, key: unknown): boolean {
  if (typeof key !== 'string' || !/^aether_child_reset_[A-Za-z0-9_-]{43}$/.test(key)) return false
  const expected = row?.code_hash, known = typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected)
  const match = timingSafeEqual(createHash('sha256').update(key).digest(), known ? Buffer.from(expected, 'hex') : Buffer.alloc(32))
  return known && match
}
async function invalidate(tx: Transaction, id: string, kind: string, keep: string | null = null): Promise<void> {
  const now = Date.now()
  await tx.execute({sql: 'UPDATE account_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND (? IS NULL OR id<>?)', args:[now,id,keep,keep]})
  await tx.execute({sql:'INSERT INTO account_audit(id,user_id,event,created_at) VALUES(?,?,?,?)',args:[randomUUID(),id,kind,now]})
}
export async function childLoginInfo(auth: AuthContext, id?: string) {
  return nameOf(id === undefined ? await own(getDb(), auth) : await managed(getDb(), auth, id, false))
}
export async function saveChildLogin(auth: AuthContext, id: string, input: Input) {
  const before = await managed(getDb(), auth, id, true)
  const loginName = input.loginName === undefined ? before.login_name : childLoginName(input.loginName)
  if (typeof loginName !== 'string' || (!passOf(before) && input.password === undefined)) throw new AccountAuthError(400, '首次设置请同时填写子账号登录名和密码。')
  if (loginName === before.login_name && input.password === undefined) return nameOf(before)
  const hash = input.password === undefined ? passOf(before)! : await newChildPassword(input.password)
  return transaction(async tx => {
    const now = await managed(tx, auth, id, true)
    if (!equalRevision(before, now)) throw stale()
    const collision = await tx.execute({sql:'SELECT 1 FROM account_child_passwords WHERE login_name=? AND user_id<>?',args:[loginName,id]})
    if (collision.rows.length) throw new AccountAuthError(409, '该登录名已被使用，请换一个。')
    await tx.execute({sql:'INSERT INTO account_child_passwords(user_id,login_name,password_hash) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET login_name=excluded.login_name,password_hash=excluded.password_hash',args:[id,loginName,hash]})
    // A parent replacing a password can recover control of a compromised account.
    if (input.password !== undefined) await tx.execute({sql:'DELETE FROM account_child_reset_codes WHERE user_id=?',args:[id]})
    await invalidate(tx, id, 'child_login.updated_by_parent')
    return {loginName}
  })
}
export async function loginWithChildPassword(name: unknown, password: unknown) {
  const loginName = childLoginName(name), before = await child(getDb(), 'name', loginName)
  if (!await matchesChildPassword(password, passOf(before)) || !before) throw wrongLogin()
  return transaction(async tx => {
    if (!equalRevision(before, await child(tx, 'name', loginName))) throw wrongLogin()
    return issueSession(tx, String(before.child_id))
  })
}
export async function changeOwnChildPassword(auth: AuthContext, proof: Proof, password: unknown) {
  const before = await own(getDb(), auth)
  if (!passOf(before)) throw new AccountAuthError(409, '请先由主账号设置子账号的登录名和初始密码。')
  if (proof.recoveryKey !== undefined ? !hasRecovery(before, proof.recoveryKey) : !await matchesChildPassword(proof.currentPassword, passOf(before))) throw new AccountAuthError(403, '当前密码或子账号恢复码不正确。')
  const hash = await newChildPassword(password)
  return transaction(async tx => {
    const now = await own(tx, auth)
    if (!equalRevision(before, now) || (proof.recoveryKey !== undefined && !hasRecovery(now, proof.recoveryKey))) throw stale()
    const id = String(now.child_id)
    await tx.execute({sql:'UPDATE account_child_passwords SET password_hash=? WHERE user_id=?',args:[hash,id]})
    if (proof.recoveryKey !== undefined) await tx.execute({sql:'DELETE FROM account_child_reset_codes WHERE user_id=?',args:[id]})
    await invalidate(tx, id, 'child_login.password_changed', auth.sessionId!)
    return {changed:true}
  })
}
export async function recoverChildPassword(name: unknown, recoveryKey: unknown, password: unknown) {
  const loginName = childLoginName(name), before = await child(getDb(), 'name', loginName)
  if (!hasRecovery(before, recoveryKey) || !before) throw wrongRecovery()
  const hash = await newChildPassword(password)
  return transaction(async tx => {
    const now = await child(tx, 'name', loginName)
    if (!equalRevision(before, now) || !hasRecovery(now, recoveryKey)) throw wrongRecovery()
    const id = String(before.child_id)
    await tx.execute({sql:'UPDATE account_child_passwords SET password_hash=? WHERE user_id=?',args:[hash,id]})
    await tx.execute({sql:'DELETE FROM account_child_reset_codes WHERE user_id=?',args:[id]})
    await invalidate(tx, id, 'child_login.password_recovered')
    return {changed:true}
  })
}

/** This one-use code authorizes only a password reset. It cannot log into the parent or the child. */
export async function issueChildResetCode(auth: AuthContext, currentPassword: unknown) {
  const before=await own(getDb(),auth)
  if (!await matchesChildPassword(currentPassword,passOf(before))) throw new AccountAuthError(403,'当前密码不正确。')
  return transaction(async tx=>{
    const now=await own(tx,auth); if(!equalRevision(before,now)) throw stale()
    const code='aether_child_reset_'+randomBytes(32).toString('base64url'), id=String(now.child_id)
    await tx.execute({sql:'INSERT INTO account_child_reset_codes(user_id,code_hash) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash',args:[id,createHash('sha256').update(code).digest('hex')]})
    await tx.execute({sql:'INSERT INTO account_audit(id,user_id,event,created_at) VALUES(?,?,?,?)',args:[randomUUID(),id,'child_login.reset_code_issued',Date.now()]})
    return {code}
  })
}

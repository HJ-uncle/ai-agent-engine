import { randomUUID } from 'node:crypto'
import type { Row, Transaction } from '@libsql/client'
import { getDb } from '../storage/sqlite/db.js'
import { beginAccountTransaction } from './account-database.js'
import { AccountAuthError } from './account-error.js'
import { issueSession, requireAccountAuth, type AccountLoginResult } from './accounts.js'
import { CHILD_TENANT_PREFIX } from './account-scope.js'
import { childDisplayName, type AccountFamily, type ChildAccount } from './account-family-types.js'
import type { AuthContext } from './types.js'

const unavailable = () => new AccountAuthError(404, '没有可管理的子账号。')
const summary = (r: Row): ChildAccount => ({ id: String(r.child_id), name: String(r.name),
  status: r.disabled_at === null ? 'active' : 'disabled', createdAt: new Date(Number(r.created_at)).toISOString() })
const childQuery = `SELECT c.child_id,u.name,c.disabled_at,c.created_at FROM account_children c
  JOIN users u ON u.id=c.child_id WHERE c.parent_id=?`
async function child(tx: Transaction, ownerId: string, childId: string): Promise<Row> {
  const result = await tx.execute({ sql: childQuery + ' AND c.child_id=?', args: [ownerId, childId] })
  if (!result.rows[0]) throw unavailable()
  return result.rows[0]
}
async function audit(tx: Transaction, id: string, event: string): Promise<void> {
  await tx.execute({ sql: 'INSERT INTO account_audit(id,user_id,event,created_at) VALUES(?,?,?,?)', args: [randomUUID(), id, event, Date.now()] })
}
/** Resolve the actor and quota from this transaction's snapshot. A claimed parent ID or a workload role never grants access. */
async function asPrimary<T>(auth: AuthContext, write: boolean, work: (tx: Transaction, parent: { id:string; sessionId:string; expiresAt:number; limit:number }) => Promise<T>): Promise<T> {
  requireAccountAuth(auth)
  const tx = write ? await beginAccountTransaction() : await getDb().transaction('read')
  try {
    const now = Date.now(), sessionId = auth.sessionId!
    const row = (await tx.execute({ sql: `SELECT s.expires_at, COALESCE(q.child_limit,3) AS quota,
      EXISTS(SELECT 1 FROM account_activation_codes a WHERE a.used_by=s.user_id) AS activated,
      EXISTS(SELECT 1 FROM account_children c WHERE c.child_id=s.user_id) AS child
      FROM account_sessions s JOIN users u ON u.id=s.user_id JOIN account_profiles p ON p.user_id=u.id
      LEFT JOIN account_child_quotas q ON q.parent_id=u.id
      WHERE s.id=? AND u.id=? AND u.tenant_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.access_expires_at>?`,
      args: [sessionId, auth.userId, auth.tenantId, now, now] })).rows[0]
    if (!row) throw new AccountAuthError(401, '登录已失效，请重新登录。')
    if (Number(row.child) || !Number(row.activated)) throw new AccountAuthError(403, '只有已开通的主账号可以管理子账号。')
    const result = await work(tx, { id: auth.userId, sessionId, expiresAt: Number(row.expires_at), limit: Number(row.quota) })
    await tx.commit(); return result
  } finally { tx.close() }
}
export function listChildAccounts(auth: AuthContext): Promise<AccountFamily> {
  return asPrimary(auth, false, async (tx, parent) => {
    const result = await tx.execute({ sql: childQuery + ' ORDER BY c.created_at,c.child_id', args: [parent.id] })
    return { limit: parent.limit, used: result.rows.length, children: result.rows.map(summary) }
  })
}
export function createChildAccount(auth: AuthContext, name: unknown): Promise<ChildAccount> {
  return asPrimary(auth, true, async (tx, parent) => {
    const label = childDisplayName(name), now = Date.now(), id = randomUUID()
    const used = await tx.execute({ sql: 'SELECT count(*) AS n FROM account_children WHERE parent_id=?', args: [parent.id] })
    if (Number(used.rows[0].n) >= parent.limit) throw new AccountAuthError(409, '子账号名额已用完，请联系管理员扩容。')
    await tx.execute({ sql: 'INSERT INTO users(id,tenant_id,name,created_at) VALUES(?,?,?,?)', args: [id, CHILD_TENANT_PREFIX + randomUUID(), label, Math.floor(now / 1000)] })
    await tx.execute({ sql: `INSERT INTO account_profiles(user_id,roles,updated_at) VALUES(?,'[]',?)`, args: [id, now] })
    await tx.execute({ sql: 'INSERT INTO account_children(child_id,parent_id,created_at) VALUES(?,?,?)', args: [id, parent.id, now] })
    await audit(tx, id, 'child.created_by_parent')
    return { id, name: label, status: 'active', createdAt: new Date(now).toISOString() }
  })
}
export function setChildAccountStatus(auth: AuthContext, id: string, status: ChildAccount['status']): Promise<ChildAccount> {
  return asPrimary(auth, true, async (tx, parent) => {
    if (status !== 'active' && status !== 'disabled') throw new AccountAuthError(400, '子账号状态无效。')
    const current = summary(await child(tx, parent.id, id))
    if (current.status === status) return current
    await tx.execute({ sql: 'UPDATE account_children SET disabled_at=? WHERE child_id=? AND parent_id=?', args: [status === 'disabled' ? Date.now() : null, id, parent.id] })
    // The storage trigger revokes every delegated and password session with the same commit.
    await audit(tx, id, status === 'disabled' ? 'child.disabled_by_parent' : 'child.enabled_by_parent')
    return { ...current, status }
  })
}
export function enterChildAccount(auth: AuthContext, id: string): Promise<AccountLoginResult> {
  return asPrimary(auth, true, async (tx, parent) => {
    const row = await child(tx, parent.id, id)
    if (row.disabled_at !== null) throw new AccountAuthError(409, '该子账号已停用。')
    const login = await issueSession(tx, id, parent.expiresAt)
    await tx.execute({ sql: 'INSERT INTO account_child_sessions(session_id,parent_session_id) VALUES(?,?)', args: [login.user.sessionId!, parent.sessionId] })
    await audit(tx, id, 'child.entered_by_parent')
    return login
  })
}

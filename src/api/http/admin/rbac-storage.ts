import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Transaction } from '@libsql/client'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { ADMIN_KEY_PREFIX, ADMIN_PERMISSIONS, ALL_ADMIN_PERMISSIONS, AUDITOR_ROLE, OWNER_ROLE, VIEWER_ROLE, type AdminMe, type AdminPermission } from './rbac-contract.js'

export class AdminHttpError extends Error {
  constructor(readonly status: number, message: string, readonly reason: string = 'invalid_request') { super(message) }
}
export type AdminProof = { kind: 'recovery'; id: string } | { kind: 'key'; digest: string }
export interface AdminActor extends AdminMe { credentialId: string | null }
export interface AuditState { roleId?: string; enabled?: boolean; permissions?: AdminPermission[] }
export interface AuditChange { memberId?: string; fields?: string[]; before?: AuditState; after?: AuditState }
export interface AdminOperation { permission?: AdminPermission; action: string; targetId: string | null; requestId: string }
export type AdminTask<T> = (tx: Transaction, actor: AdminActor, record: (change: AuditChange) => void) => T | Promise<T>
export const digestAdminKey = (value: string) => createHash('sha256').update(value).digest('hex')
export const nowIso = () => new Date().toISOString()
export const newAdminKey = () => ADMIN_KEY_PREFIX + randomBytes(32).toString('base64url')
export function managementDatabasePath(primaryPath: string): string {
  const main = fs.realpathSync(path.resolve(primaryPath))
  if (!fs.statSync(main).isFile()) throw new Error('主数据库不是文件')
  return main + '.admin.sqlite'
}
export function publicActor({ id, name, roleId, roleName, permissions, recovery }: AdminActor): AdminMe { return { id, name, roleId, roleName, permissions, recovery } }
export function recoveryActor(id: string): AdminActor { return { id, name: '默认租户恢复管理员', roleId: OWNER_ROLE, roleName: '主管理员', permissions: [...ALL_ADMIN_PERMISSIONS], recovery: true, credentialId: null } }
export function readPermissions(value: unknown): AdminPermission[] {
  const parsed: unknown = JSON.parse(String(value))
  if (!Array.isArray(parsed) || !parsed.every(k => typeof k === 'string' && Object.hasOwn(ADMIN_PERMISSIONS, k))) throw new Error('Invalid stored management role')
  return parsed as AdminPermission[]
}
export function memberName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || value.toLowerCase().includes(ADMIN_KEY_PREFIX)) throw new AdminHttpError(400, '名称须为 1 至 80 个可显示字符。')
  return value.trim()
}
export const managementId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value) && !value.toLowerCase().includes(ADMIN_KEY_PREFIX)
const coreSchema = [
  `CREATE TABLE IF NOT EXISTS admin_schema(id TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS admin_roles(id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, permissions TEXT NOT NULL, builtin INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_members(id TEXT PRIMARY KEY, name TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE RESTRICT, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS admin_members_role ON admin_members(role_id,enabled)`,
  `CREATE TABLE IF NOT EXISTS admin_credentials(id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES admin_members(id) ON DELETE CASCADE, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS admin_keys_member ON admin_credentials(member_id, revoked_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, role_id TEXT NOT NULL, action TEXT NOT NULL,target_id TEXT,outcome TEXT NOT NULL,reason TEXT,request_id TEXT NOT NULL,changes TEXT)`,
  `CREATE INDEX IF NOT EXISTS admin_audit_outcomes ON admin_audit(outcome,id)`,
  `CREATE TRIGGER IF NOT EXISTS admin_audit_retention AFTER INSERT ON admin_audit WHEN NEW.id % 256=0 BEGIN DELETE FROM admin_audit WHERE id <= NEW.id-100000; END`,
]
async function insertAudit(tx: Transaction, actor: AdminActor | null, op: AdminOperation, outcome: 'success' | 'denied' | 'failed', reason: string | null, change?: AuditChange) {
  // Never serialize requests, headers, key digests or arbitrary rule/member payloads. Values below are internal identifiers and allowlisted state only.
  const state = (s?: AuditState) => s ? { ...(managementId(s.roleId) ? { roleId: s.roleId } : {}), ...(typeof s.enabled === 'boolean' ? { enabled: s.enabled } : {}), ...(Array.isArray(s.permissions) ? { permissions: ALL_ADMIN_PERMISSIONS.filter(p => s.permissions!.includes(p)) } : {}) } : undefined
  const changes = change ? JSON.stringify({ memberId: managementId(change.memberId) ? change.memberId : undefined, fields: change.fields?.filter(f => ['name','roleId','enabled','permissions','credential'].includes(f)), before: state(change.before), after: state(change.after) }) : null
  const publicId = (v: string | null) => managementId(v) ? (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v) || [OWNER_ROLE,VIEWER_ROLE,AUDITOR_ROLE].includes(v) ? v : 'ref:' + digestAdminKey(v).slice(0,24)) : null
  await tx.execute({ sql: 'INSERT INTO admin_audit(at,actor_id,actor_name,role_id,action,target_id,outcome,reason,request_id,changes) VALUES(?,?,?,?,?,?,?,?,?,?)', args: [nowIso(), actor?.id ?? 'unverified', actor?.name ?? '未验证', actor?.roleId ?? '', op.action, publicId(op.targetId), outcome, reason, /^(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|req-[0-9a-z]{1,12})$/i.test(op.requestId) ? op.requestId : '', changes] })
}
const activeOwner = async (tx: Transaction) => (await tx.execute({ sql: `SELECT 1 FROM admin_members m WHERE m.role_id=? AND m.enabled=1 AND EXISTS(SELECT 1 FROM admin_credentials c WHERE c.member_id=m.id AND c.revoked_at IS NULL) LIMIT 1`, args: [OWNER_ROLE] })).rows.length > 0
export class AdminRbacStore {
  private readonly db: LocalSqliteProcessClient
  private initialization?: Promise<void>
  private readonly recentAnonymous = new Map<string, number>()
  private readonly recentLogins = new Map<string, number>()
  private readonly auditCooldown = new Map<string, number>()
  constructor(readonly filename: string, private readonly migrations: ReadonlyMap<string, readonly string[]> = new Map()) {
    // Do not create or follow a management-file symlink; SQLite's journal inherits its private file mode.
    try { fs.closeSync(fs.openSync(filename, 'wx', 0o600)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.lstatSync(filename).isFile()) throw error }
    this.db = new LocalSqliteProcessClient({ url: 'file:' + encodeURIComponent(filename) }, { cacheKb: 1024, mmapBytes: 0 })
  }
  async close(): Promise<void> { const receipt = await this.db.closeWithReceipt(); if (!receipt.healthy) throw new Error('后台数据库未确认关闭') }
  private async transaction<T>(mode: 'read'|'write', fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.db.transaction(mode)
    try { const value = await fn(tx); await tx.commit(); return value }
    catch (error) { if (!tx.closed) await tx.rollback(); throw error }
    finally { tx.close() }
  }
  ready(): Promise<void> {
    return this.initialization ??= this.transaction('write', async tx => {
      await tx.batch(coreSchema); const now = nowIso()
      const basic: AdminPermission[] = ['status.read','metrics.read','rules.read']
      for (const [id, name, list] of [[OWNER_ROLE,'主管理员',ALL_ADMIN_PERMISSIONS],[VIEWER_ROLE,'只读管理员',basic],[AUDITOR_ROLE,'审计管理员',[...basic,'members.read','roles.read','audit.read']]] as const) {
        await tx.execute({ sql: `INSERT INTO admin_roles(id,name,permissions,builtin,created_at,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions,builtin=1,updated_at=excluded.updated_at WHERE admin_roles.name<>excluded.name OR admin_roles.permissions<>excluded.permissions OR admin_roles.builtin<>1`, args: [id,name,JSON.stringify(list),now,now] })
      }
      for (const [id, statements] of this.migrations) {
        if ((await tx.execute({ sql: 'SELECT 1 FROM admin_schema WHERE id=?', args: [id] })).rows.length) continue
        await tx.batch([...statements]); await tx.execute({ sql: 'INSERT INTO admin_schema(id) VALUES(?)', args: [id] })
      }
    }).catch(err => { this.initialization = undefined; throw err })
  }
  private async actor(tx: Pick<Transaction,'execute'>, proof: AdminProof): Promise<AdminActor> {
    if (proof.kind === 'recovery') return recoveryActor(proof.id)
    const row = (await tx.execute({ sql: `SELECT c.id AS credential_id,m.id,m.name,m.role_id,r.name AS role_name,r.permissions FROM admin_credentials c JOIN admin_members m ON m.id=c.member_id JOIN admin_roles r ON r.id=m.role_id WHERE c.key_hash=? AND c.revoked_at IS NULL AND m.enabled=1`, args: [proof.digest] })).rows[0]
    if (!row) throw new AdminHttpError(401, '后台密钥无效或已撤销。', 'invalid_credential')
    return { id: String(row.id), name: String(row.name), roleId: String(row.role_id), roleName: String(row.role_name), permissions: readPermissions(row.permissions), recovery: false, credentialId: String(row.credential_id) }
  }
  private async failed(actor: AdminActor | null, op: AdminOperation, error: unknown, mutation: boolean) {
    const now = Date.now(), logical = error instanceof AdminHttpError
    if (!actor) {
      const type = logical ? error.status + ':' + error.reason : 'internal'
      if (now - (this.recentAnonymous.get(type) ?? 0) < 60000) return
      if (this.recentAnonymous.size >= 16) this.recentAnonymous.delete(this.recentAnonymous.keys().next().value!)
      this.recentAnonymous.set(type,now)
    }
    if (!mutation && actor && logical && error.status === 403) {
      const key = actor.id + ':' + op.action, last = this.auditCooldown.get(key) ?? 0
      if (now - last < 1000) return
      if (this.auditCooldown.size >= 1024) this.auditCooldown.delete(this.auditCooldown.keys().next().value!)
      this.auditCooldown.set(key, now)
    }
    const reason = logical && /^[a-z_]{1,50}$/.test(error.reason) ? error.reason : 'operation_failed'
    await this.transaction('write', tx => insertAudit(tx, actor, op, logical && [401,403].includes(error.status) ? 'denied' : 'failed', reason))
  }
  /** Called only for an already-open management service. Never create it just to log unsolicited traffic. */
  async deniedAtGate(op: AdminOperation, reason: string, businessId?: string, mutation = false): Promise<void> {
    const actor: AdminActor | null = businessId ? { id: businessId, name:'无后台权限的业务账号', roleId:'business-account', roleName:'业务账号', permissions:[], recovery:false, credentialId:null } : null
    await this.failed(actor, op, new AdminHttpError(actor ? 403 : 401, '', reason), mutation)
  }
  private checkGrant(actor: AdminActor, permission?: AdminPermission): void {
    if (permission && !actor.permissions.includes(permission)) throw new AdminHttpError(403, '当前后台角色没有此操作权限。', 'permission_denied')
  }
  /** A single joined SELECT is already an atomic snapshot; status/metrics need no BEGIN/COMMIT round trips. */
  async authorize(proof: AdminProof, op: AdminOperation): Promise<AdminMe> {
    await this.ready(); let actor: AdminActor | null = null
    try {
      actor = await this.actor(this.db, proof); this.checkGrant(actor, op.permission)
      return publicActor(actor)
    } catch (error) { await this.failed(actor, op, error, false); throw error }
  }
  async identify(proof: AdminProof, requestId: string): Promise<AdminMe> {
    const key = proof.kind === 'key' ? proof.digest : proof.id, now = Date.now()
    const op = { action:'admin.login', targetId:null, requestId }
    if (now - (this.recentLogins.get(key) ?? 0) < 60000) return this.authorize(proof,op)
    // Reserve only the audit interval; every concurrent caller still authenticates its live credential.
    if (this.recentLogins.size >= 1024) this.recentLogins.delete(this.recentLogins.keys().next().value!)
    this.recentLogins.set(key,now)
    try { return await this.run(proof,op,true,(_tx,actor) => publicActor(actor)) }
    catch(error) { if(this.recentLogins.get(key) === now) this.recentLogins.delete(key); throw error }
  }
  async run<T>(proof: AdminProof, op: AdminOperation, write: boolean, work: AdminTask<T>): Promise<T> {
    await this.ready(); let actor: AdminActor | null = null
    try {
      return await this.transaction(write ? 'write' : 'read', async tx => {
        const current = await this.actor(tx, proof); actor = current
        this.checkGrant(current,op.permission)
        const guardOwner = write && ['member.update','member.delete','credential.revoke'].includes(op.action) && await activeOwner(tx)
        let change: AuditChange | undefined
        const value = await work(tx, current, value => { change = value })
        if (guardOwner && !await activeOwner(tx)) throw new AdminHttpError(409, '必须保留至少一位已启用且拥有有效后台密钥的主管理员。', 'last_owner')
        if (write) await insertAudit(tx, current, op, 'success', null, change)
        return value
      })
    } catch (error) { await this.failed(actor, op, error, write); throw error }
  }
}
/** Confirm this is an initialized engine database using schema metadata only. The management CLI never writes to it. */
async function inspectOfflinePrimary(primary: string): Promise<void> {
  const reader = new LocalSqliteProcessClient({url: 'file:' + encodeURIComponent(primary)}, {inspectOnly:true})
  try {
    const columns = async (table: 'users' | 'conversations') => new Set((await reader.execute(`PRAGMA table_info(${table})`)).rows.map(row => row.name))
    const users = await columns('users'), conversations = await columns('conversations')
    if (!['id','tenant_id','api_key_hash'].every(k => users.has(k)) || !['tenant_id','session_id','role'].every(k => conversations.has(k))) throw new Error('请选择已初始化的引擎主数据库。')
  } finally {
    if (!(await reader.closeWithReceipt()).healthy) throw new Error('未确认关闭主数据库读取连接。')
  }
}
/** Offline recovery. Deliver to an exclusive private file; the caller removes its own file if the DB commit fails. */
export async function provisionOfflineAdmin(primaryDatabasePath: string, name: string, deliverKey: (key: string) => void | Promise<void>): Promise<{ memberId: string; credentialId: string }> {
  const displayName = memberName(name), primary = fs.realpathSync(path.resolve(primaryDatabasePath))
  const filename = managementDatabasePath(primary)
  await inspectOfflinePrimary(primary)
  const store = new AdminRbacStore(filename), memberId = randomUUID(), credentialId = randomUUID()
  let committed = false
  try {
    const result = await store.run({ kind: 'recovery', id: 'offline-recovery' }, { action: 'offline.recovery.create', targetId: memberId, requestId: randomUUID() }, true, async (tx, _actor, record) => {
      const key = newAdminKey(), now = nowIso()
      await tx.execute({ sql: 'INSERT INTO admin_members(id,name,role_id,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)', args: [memberId, displayName, OWNER_ROLE, now, now] })
      await tx.execute({ sql: 'INSERT INTO admin_credentials(id,member_id,key_hash,created_at) VALUES(?,?,?,?)', args: [credentialId,memberId,digestAdminKey(key),now] })
      await deliverKey(key); record({ after: { roleId: OWNER_ROLE, enabled: true } }); return { memberId, credentialId }
    })
    committed = true
    return result
  } finally {
    // Once SQLite acknowledged COMMIT, a process-close failure must never invalidate the delivered key.
    try { await store.close() } catch (error) { if (!committed) throw error }
  }
}

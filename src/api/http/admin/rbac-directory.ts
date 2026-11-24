import type { Row, Transaction } from '@libsql/client'
import { ADMIN_PERMISSIONS, ALL_ADMIN_PERMISSIONS, OWNER_ROLE, type AdminAuditEntry, type AdminCredential, type AdminMember, type AdminPage, type AdminPermission, type AdminRole } from './rbac-contract.js'
import { AdminHttpError, digestAdminKey, managementId, memberName, newAdminKey, nowIso, readPermissions, type AdminActor, type AuditChange } from './rbac-storage.js'

export function fields(input: unknown, keys: readonly string[], partial = false): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) || (partial && !Object.keys(input).length)) throw new AdminHttpError(400, '请求字段不合法。')
  return input as Record<string, unknown>
}
function permissionSet(value: unknown): AdminPermission[] {
  if (!Array.isArray(value) || value.length > ALL_ADMIN_PERMISSIONS.length || new Set(value).size !== value.length || !value.every(v => typeof v === 'string' && Object.hasOwn(ADMIN_PERMISSIONS, v))) throw new AdminHttpError(400, '角色包含不支持或重复的权限。')
  return ALL_ADMIN_PERMISSIONS.filter(v => value.includes(v))
}
function enabledValue(value: unknown): boolean { if (typeof value !== 'boolean') throw new AdminHttpError(400,'启用状态必须是布尔值。'); return value }
function validId(id: unknown): string { if (!managementId(id)) throw new AdminHttpError(400,'标识无效。'); return id }
const roleRow = (r: Row): AdminRole => ({ id: String(r.id), name: String(r.name), permissions: readPermissions(r.permissions), builtIn: r.builtin === 1, createdAt: String(r.created_at), updatedAt: String(r.updated_at) })
const memberRow = (r: Row): AdminMember => ({ id: String(r.id), name: String(r.name), roleId: String(r.role_id), enabled: r.enabled === 1, createdAt: String(r.created_at), updatedAt: String(r.updated_at) })
async function role(tx: Transaction, id: unknown): Promise<AdminRole> { const r = (await tx.execute({ sql:'SELECT * FROM admin_roles WHERE id=?',args:[validId(id)] })).rows[0]; if(!r)throw new AdminHttpError(404,'角色不存在。','not_found'); return roleRow(r) }
async function member(tx: Transaction, id: unknown): Promise<AdminMember> { const r = (await tx.execute({ sql:'SELECT * FROM admin_members WHERE id=?',args:[validId(id)] })).rows[0]; if(!r)throw new AdminHttpError(404,'成员不存在。','not_found'); return memberRow(r) }
export { role as getAdminRole, member as getAdminMember }
function mayDelegate(actor: AdminActor, target: {id?: string; permissions: AdminPermission[]}) {
  if (actor.recovery || actor.roleId === OWNER_ROLE) return
  if (target.id === OWNER_ROLE || !target.permissions.every(p => actor.permissions.includes(p))) throw new AdminHttpError(403,'不能管理超出本人权限范围的成员或角色。','delegation_denied')
}
function protectBuiltin(role: AdminRole) { if (role.builtIn) throw new AdminHttpError(409, '内置角色不能修改或删除。','builtin_role') }
async function uniqueRoleName(tx: Transaction, name: string, except: string) {
  if ((await tx.execute({sql:'SELECT 1 FROM admin_roles WHERE name=? AND id<>?',args:[name,except]})).rows.length) throw new AdminHttpError(409,'角色名称已存在。','duplicate_role')
}
interface PageQuery { limit: number; cursor: string | null; q?: string; enabled?: boolean; builtIn?: boolean; outcome?: string }
type Directory = 'roles' | 'members' | 'audit' | 'families'
export function pageQuery(value: unknown, directory: Directory): PageQuery {
  const extras = directory === 'members' ? ['enabled'] : directory === 'audit' ? ['outcome'] : directory === 'roles' ? ['builtIn'] : []
  const raw = fields(value ?? {}, ['limit', 'cursor', 'q', ...extras])
  const limit = raw.limit === undefined ? 50 : typeof raw.limit === 'string' && /^\d{1,3}$/.test(raw.limit) ? Number(raw.limit) : NaN
  const cursor = raw.cursor ?? null
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && (typeof cursor !== 'string' || (directory === 'audit' ? !/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) : !managementId(cursor))))) throw new AdminHttpError(400, '分页参数无效。')
  if (raw.q !== undefined && (typeof raw.q !== 'string' || raw.q.length > 80 || /aether_(?:admin|activate)_/i.test(raw.q) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw.q))) throw new AdminHttpError(400, '搜索词最多 80 个可显示字符。')
  for (const flag of [raw.enabled,raw.builtIn]) if (flag !== undefined && flag !== 'true' && flag !== 'false') throw new AdminHttpError(400, '状态或类型筛选须为 true 或 false。')
  if (raw.outcome !== undefined && (typeof raw.outcome !== 'string' || !['success','denied','failed'].includes(raw.outcome))) throw new AdminHttpError(400, '审计结果筛选无效。')
  return {limit, cursor: cursor as string | null, q: (raw.q as string | undefined)?.trim(),
    enabled: raw.enabled === undefined ? undefined : raw.enabled === 'true', builtIn: raw.builtIn === undefined ? undefined : raw.builtIn === 'true', outcome: raw.outcome as string | undefined}
}
const actionLabels: Record<string,string> = {
  'admin.login':'后台登录','offline.recovery.create':'离线恢复主管理员','member.create':'创建成员','member.update':'修改成员','member.delete':'删除成员',
  'activation.issue':'签发主账号开通码','activation.revoke':'撤销主账号开通码','account.quota.update':'调整子账号配额', 'role.create':'创建角色','role.update':'修改角色','role.delete':'删除角色','credential.issue':'签发密钥','credential.revoke':'撤销密钥',
  'rule.create':'创建规则','rule.update':'更新规则','rule.delete':'删除规则','rule.restore':'恢复规则',
}
const listings = {
  roles: {table: 'admin_roles', search: ['name','id']},
  members: {table: 'admin_members', search: ['name','id','role_id']},
  audit: {table: 'admin_audit', search: ['action','actor_name','actor_id','role_id','target_id','request_id','reason']},
} as const
async function listPage<T extends {id: string | number}>(tx: Transaction, directory: Exclude<Directory,'families'>, value: unknown, map: (row: Row) => T): Promise<AdminPage<T>> {
  const {limit,cursor,q,enabled,builtIn,outcome} = pageQuery(value,directory)
  const filters: string[] = [], args: (string|number)[] = []
  const {table,search} = listings[directory], newest = directory === 'audit'
  if (cursor) { filters.push(newest ? 'id < ?' : 'id > ?'); args.push(newest ? Number(cursor) : cursor) }
  if (enabled !== undefined) { filters.push('enabled = ?'); args.push(Number(enabled)) }
  if (builtIn !== undefined) { filters.push('builtin = ?'); args.push(Number(builtIn)) }
  if (outcome !== undefined) { filters.push('outcome = ?'); args.push(outcome) }
  if (q) {
    // instr treats %, _ and backslashes literally. The only interpolated names are hard-coded above.
    const matches = search.map(column => `instr(lower(${column}), lower(?)) > 0`)
    args.push(...search.map(() => q))
    if (directory === 'audit') {
      const actions = Object.entries(actionLabels).filter(([,label]) => label.includes(q)).map(([id])=>id)
      if (actions.length) { matches.push(`action IN (${actions.map(() => '?').join(',')})`); args.push(...actions) }
    }
    filters.push(`(${matches.join(' OR ')})`)
  }
  const where = filters.length ? ' WHERE ' + filters.join(' AND ') : ''
  const rows = (await tx.execute({sql: `SELECT * FROM ${table}${where} ORDER BY id ${newest ? 'DESC' : 'ASC'} LIMIT ?`, args: [...args,limit+1]})).rows
  return { items: rows.slice(0,limit).map(map), nextCursor: rows.length > limit ? String(rows[limit-1].id) : null }
}
export const listRoles = (tx: Transaction, q: unknown) => listPage(tx,'roles',q,roleRow)
export const listMembers = (tx: Transaction, q: unknown) => listPage(tx,'members',q,memberRow)
export const listAudit = (tx: Transaction, q: unknown): Promise<AdminPage<AdminAuditEntry>> => listPage(tx,'audit',q, r => ({
  id: Number(r.id), at: String(r.at), actorId: String(r.actor_id), actorName: String(r.actor_name), roleId: String(r.role_id), action: String(r.action),
  targetId: r.target_id === null ? null : String(r.target_id), outcome: r.outcome as AdminAuditEntry['outcome'], reason: r.reason === null ? null : String(r.reason),
  requestId: String(r.request_id), changes: r.changes === null ? null : JSON.parse(String(r.changes)),
}))
type RecordAudit = (change: AuditChange) => void
export async function saveMember(tx: Transaction, actor: AdminActor, id: string, create: boolean, input: unknown, audit: RecordAudit) {
  const data = fields(input,['name','roleId','enabled'],!create), previous = create ? null : await member(tx,id)
  if (previous) {
    await role(tx,previous.roleId).then(r => mayDelegate(actor,r))
    if (actor.id===id && (('roleId' in data && data.roleId!==previous.roleId) || ('enabled' in data && data.enabled!==previous.enabled))) throw new AdminHttpError(409,'不能修改自己的角色或启用状态。','self_protection')
  }
  const name = 'name' in data || !previous ? memberName(data.name) : previous.name
  const roleId = 'roleId' in data || !previous ? validId(data.roleId) : previous.roleId
  const enabled = 'enabled' in data ? enabledValue(data.enabled) : previous?.enabled ?? true
  mayDelegate(actor,await role(tx,roleId)); const now=nowIso()
  if (create) await tx.execute({sql:'INSERT INTO admin_members(id,name,role_id,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)',args:[id,name,roleId,Number(enabled),now,now]})
  else await tx.execute({sql:'UPDATE admin_members SET name=?,role_id=?,enabled=?,updated_at=? WHERE id=?',args:[name,roleId,Number(enabled),now,id]})
  audit({ fields:Object.keys(data), before:previous ? {roleId:previous.roleId,enabled:previous.enabled}:undefined, after:{roleId,enabled} }); return member(tx,id)
}
export async function deleteMember(tx:Transaction,actor:AdminActor,id:string,audit:RecordAudit) {
  const current = await member(tx,id); mayDelegate(actor,await role(tx,current.roleId))
  if (actor.id===id) throw new AdminHttpError(409,'不能删除自己的后台成员。','self_protection')
  await tx.execute({sql:'DELETE FROM admin_members WHERE id=?',args:[id]}); audit({before:{roleId:current.roleId,enabled:current.enabled}}); return {deleted:true}
}
export async function saveRole(tx:Transaction,actor:AdminActor,id:string,create:boolean,input:unknown,audit:RecordAudit) {
  const data=fields(input,['name','permissions'],!create), previous=create?null:await role(tx,id)
  if (previous) { protectBuiltin(previous); mayDelegate(actor,previous); if(actor.roleId===id)throw new AdminHttpError(409,'不能修改自己当前使用的角色。','self_protection') }
  const name='name' in data || !previous ? memberName(data.name):previous.name, permissions='permissions' in data || !previous ? permissionSet(data.permissions):previous.permissions
  mayDelegate(actor,{permissions}); await uniqueRoleName(tx,name,id); const now=nowIso()
  if(create)await tx.execute({sql:'INSERT INTO admin_roles(id,name,permissions,builtin,created_at,updated_at) VALUES(?,?,?,0,?,?)',args:[id,name,JSON.stringify(permissions),now,now]})
  else await tx.execute({sql:'UPDATE admin_roles SET name=?,permissions=?,updated_at=? WHERE id=?',args:[name,JSON.stringify(permissions),now,id]})
  audit({fields:Object.keys(data),before:previous?{permissions:previous.permissions}:undefined,after:{permissions}}); return role(tx,id)
}
export async function deleteRole(tx:Transaction,actor:AdminActor,id:string,audit:RecordAudit) {
  const current=await role(tx,id); protectBuiltin(current); mayDelegate(actor,current)
  if ((await tx.execute({sql:'SELECT 1 FROM admin_members WHERE role_id=? LIMIT 1',args:[id]})).rows.length) throw new AdminHttpError(409,'先为使用此角色的成员分配其他角色。','role_in_use')
  await tx.execute({sql:'DELETE FROM admin_roles WHERE id=?',args:[id]}); audit({before:{permissions:current.permissions}}); return {deleted:true}
}
export async function listCredentials(tx:Transaction,memberId:string): Promise<{items:AdminCredential[]}> {
  await member(tx,memberId)
  const rows=(await tx.execute({sql:'SELECT id,created_at,revoked_at FROM admin_credentials WHERE member_id=? ORDER BY (revoked_at IS NULL) DESC,created_at DESC,id DESC LIMIT 100',args:[memberId]})).rows
  return {items: rows.map(r=>({id:String(r.id),createdAt:String(r.created_at),revokedAt:r.revoked_at===null?null:String(r.revoked_at)}))}
}
export async function issueCredential(tx:Transaction,actor:AdminActor,memberId:string,keyId:string,body:unknown,audit:RecordAudit) {
  fields(body ?? {},[]); const target=await member(tx,memberId); mayDelegate(actor,await role(tx,target.roleId))
  if(!target.enabled)throw new AdminHttpError(409,'请先启用此成员，再签发后台密钥。','member_disabled')
  const count=(await tx.execute({sql:'SELECT COUNT(*) AS n FROM admin_credentials WHERE member_id=? AND revoked_at IS NULL',args:[memberId]})).rows[0]
  if(Number(count.n)>=8)throw new AdminHttpError(409,'每位成员最多保留 8 把有效密钥，请先撤销不用的密钥。','credential_limit')
  const key=newAdminKey(); await tx.execute({sql:'INSERT INTO admin_credentials(id,member_id,key_hash,created_at) VALUES(?,?,?,?)',args:[keyId,memberId,digestAdminKey(key),nowIso()]})
  audit({fields:['credential'],memberId}); return {id:keyId,key}
}
export async function revokeCredential(tx:Transaction,actor:AdminActor,memberId:string,keyId:string,audit:RecordAudit) {
  const target=await member(tx,memberId); validId(keyId); mayDelegate(actor,await role(tx,target.roleId))
  if(actor.credentialId===keyId)throw new AdminHttpError(409,'请先用另一把有效密钥连接，再撤销当前密钥。','self_protection')
  const result=await tx.execute({sql:'UPDATE admin_credentials SET revoked_at=? WHERE member_id=? AND id=? AND revoked_at IS NULL',args:[nowIso(),memberId,keyId]})
  if(!result.rowsAffected) throw new AdminHttpError(404,'未找到该成员的有效后台密钥。','not_found')
  audit({fields:['credential'],memberId}); return {revoked:true}
}

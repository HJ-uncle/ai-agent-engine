/** Management-only HTTP contract. These are console permissions, never agent/tool capabilities. */
export { ADMIN_HEADER, ADMIN_KEY_PREFIX } from '../../../auth/admin-key-format.js'
export const ADMIN_PERMISSIONS = {
  'status.read': '查看实例概览', 'metrics.read': '查看运行指标', 'rules.read': '查看运维规则', 'rules.manage': '管理运维规则',
  'members.read': '查看后台成员', 'members.write': '管理后台成员', 'credentials.write': '签发和撤销后台密钥',
  'roles.read': '查看后台角色', 'roles.write': '管理自定义角色', 'audit.read': '查看管理审计',
} as const
export type AdminPermission = keyof typeof ADMIN_PERMISSIONS
export const ALL_ADMIN_PERMISSIONS = Object.keys(ADMIN_PERMISSIONS) as AdminPermission[]
export const OWNER_ROLE = 'super-admin', VIEWER_ROLE = 'viewer', AUDITOR_ROLE = 'auditor'
export interface AdminMe { id: string; name: string; roleId: string; roleName: string; permissions: AdminPermission[]; recovery: boolean }
export interface AdminMember { id: string; name: string; roleId: string; enabled: boolean; createdAt: string; updatedAt: string }
export interface AdminRole { id: string; name: string; permissions: AdminPermission[]; builtIn: boolean; createdAt: string; updatedAt: string }
export interface AdminCredential { id: string; createdAt: string; revokedAt: string | null }
export interface AdminAuditEntry { id: number; at: string; actorId: string; actorName: string; roleId: string; action: string; targetId: string | null; outcome: 'success' | 'denied' | 'failed'; reason: string | null; requestId: string; changes: { memberId?: string; fields?: string[]; before?: object; after?: object } | null }
export interface AdminPage<T> { items: T[]; nextCursor: string | null }
/** All data uses the normal {code,message,data,timestamp} envelope. Pagination: ?limit=1..100&cursor=... . Directory search: q (literal, 80 chars), members enabled=true|false, roles builtIn=true|false, audit outcome=success|denied|failed; these filters run before pagination.
 * GET /admin/me -> AdminMe. GET /admin/permissions -> {items:[{id,label}]}.
 * GET /admin/members -> AdminPage<AdminMember>; GET /admin/members/:id -> AdminMember.
 * POST /admin/members {name,roleId,enabled?}; PATCH /admin/members/:id {name?,roleId?,enabled?} -> AdminMember.
 * GET /admin/members/:id/credentials -> {items:AdminCredential[]}; POST .../credentials {} -> {id,key} (returned once).
 * DELETE .../credentials/:keyId -> {revoked:true}; DELETE /admin/members/:id -> {deleted:true}.
 * GET /admin/roles -> AdminPage<AdminRole>; GET /admin/roles/:id -> AdminRole.
 * POST /admin/roles {name,permissions}; PATCH /admin/roles/:id {name?,permissions?} -> AdminRole; DELETE -> {deleted:true}.
 * GET /admin/audit -> AdminPage<AdminAuditEntry> (newest first). All IDs are opaque.
 */

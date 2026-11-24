import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isAdminKey } from '../../../auth/admin-key-format.js'
import { canAdministerTenant } from '../../../auth/guards.js'
import type { AuthContext } from '../../../auth/types.js'
import { getDb } from '../../../storage/sqlite/db.js'
import { fail, success } from '../response.js'
import { desktopWindowGrant } from './desktop-session.js'
import { isOwnedDesktopRequest } from '../desktop-ownership.js'
import { isAdminPath } from './surface.js'
import { ADMIN_HEADER, type AdminMe, type AdminPermission } from './rbac-contract.js'
import { AdminHttpError, AdminRbacStore, digestAdminKey, managementDatabasePath, publicActor, recoveryActor, desktopActor, type AdminOperation, type AdminProof, type AdminTask } from './rbac-storage.js'
export { AdminHttpError } from './rbac-storage.js'

interface Entry { migrations: Map<string, readonly string[]>; store?: Promise<AdminRbacStore>; lifecycle: boolean }
const registries = new WeakMap<object, Entry>()
function registry(app: FastifyInstance): Entry {
  let entry = registries.get(app.server)
  if (!entry) { entry = { migrations: new Map(), lifecycle: false }; registries.set(app.server, entry) }
  return entry
}
/** Register at boot, without creating a SQLite file/process for an idle desktop engine. */
export function registerAdminSchema(app: FastifyInstance, migrationId: string, statements: readonly string[]): void {
  const entry = registry(app)
  if (!/^[a-z0-9_.-]{1,96}$/.test(migrationId) || entry.migrations.has(migrationId) || entry.store) throw new Error('Invalid, duplicate, or late administration schema registration')
  entry.migrations.set(migrationId, [...statements])
}
export function registerAdminRbacLifecycle(app: FastifyInstance): void {
  const entry = registry(app); if (entry.lifecycle) return
  entry.lifecycle = true
  // Fastify parses the body before reaching a route. Never pass its raw parse diagnostic to the general logger.
  app.setErrorHandler((error, req, reply) => {
    if (isAdminPath(req.routeOptions?.url ?? '') || isAdminPath(req.url.split('?',1)[0])) return adminErrorReply(reply,error)
    throw error
  })
  app.addHook('onClose', async () => { try { if (entry.store) await (await entry.store).close() } finally { registries.delete(app.server) } })
}
function storeFor(app: FastifyInstance): Promise<AdminRbacStore> {
  const entry = registry(app)
  return entry.store ??= (async () => {
    // Bind authorization to the actual opened database, never a later UI/DB change to process.env.DATA_DIR.
    const business = getDb()
    const primary = (await business.execute('PRAGMA database_list')).rows.find(r => r.name === 'main')?.file
    if (typeof primary !== 'string' || !primary) throw new Error('Missing primary database identity')
    const store = new AdminRbacStore(managementDatabasePath(primary), entry.migrations, business)
    try { await store.ready(); return store } catch (error) { await store.close(); throw error }
  })().catch(error => { entry.store = undefined; throw error })
}
function proofFor(req: FastifyRequest): AdminProof {
  const dedicated = req.headers[ADMIN_HEADER]
  if (dedicated !== undefined) {
    if (!isAdminKey(dedicated)) throw new AdminHttpError(401, '后台密钥无效或已撤销。', 'invalid_credential')
    const digest = digestAdminKey(dedicated), active = desktopWindowGrant(req.server, digest)
    if (active) {
      if (!isOwnedDesktopRequest(req) || req.headers.authorization !== undefined || req.headers['x-api-key'] !== undefined) throw new AdminHttpError(403, '当前身份不能使用本机管理窗口。', 'permission_denied')
      return { kind: 'desktop', id: 'desktop:local', active }
    }
    return { kind: 'key', digest }
  }
  const auth = (req as FastifyRequest & { authContext?: AuthContext }).authContext
  if (!auth || auth.method === 'none') throw new AdminHttpError(401, '需要后台管理员凭据。', 'authentication_required')
  if (!canAdministerTenant(auth, 'default')) throw new AdminHttpError(403, '此业务账号不具有默认租户恢复管理员权限。', 'permission_denied')
  const subject = auth.userId ? createHash('sha256').update(auth.userId).digest('hex').slice(0,24) : 'default'
  return { kind: 'recovery', id: `recovery:${auth.method}:${subject}` }
}
/** Keep the original denial even if audit is offline. Untrusted requests never initialize SQLite for logging. */
export async function auditAdminGateDenial(req: FastifyRequest, reason: string, action = 'admin.authentication', targetId: string | null = null): Promise<void> {
  const pending = registries.get(req.server.server)?.store
  if (!pending) return
  try {
    const auth = (req as FastifyRequest & { authContext?: AuthContext }).authContext
    const businessId = auth && auth.method !== 'none' ? 'business-ref:' + createHash('sha256').update(JSON.stringify([auth.method,auth.tenantId,auth.userId])).digest('hex').slice(0,24) : undefined
    await (await pending).deniedAtGate({ action,targetId,requestId:req.id }, reason, businessId, !['GET','HEAD'].includes(req.method))
  } catch { /* Logging failure cannot grant access or replace an authentication denial. */ }
}
async function verifiedProof(req: FastifyRequest, action: string, targetId: string | null = null): Promise<AdminProof> {
  try { return proofFor(req) }
  catch (error) { if (error instanceof AdminHttpError) await auditAdminGateDenial(req,error.reason,action,targetId); throw error }
}
export function adminErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AdminHttpError) return reply.code(error.status).send(fail(error.status * 100, error.message))
  // Framework parsing errors may embed attacker-controlled body/URL snippets in their message.
  const status = typeof error === 'object' && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined
  const clientErrors: Record<number,string> = { 400:'请求格式不正确。', 404:'后台资源不存在。', 405:'此后台接口不支持该请求方式。', 413:'请求正文过大。', 415:'不支持的请求内容类型。', 429:'请求过于频繁。' }
  if (typeof status === 'number' && Object.hasOwn(clientErrors,status)) return reply.code(status).send(fail(status * 100,clientErrors[status]))
  // Do not log/return SQL, input values, credential material or native exception text.
  return reply.code(503).send(fail(50300, '管理数据库暂不可用，操作未确认。'))
}
const requestActors = new WeakMap<FastifyRequest, AdminMe>()
export async function requireAdminPermission(req: FastifyRequest, reply: FastifyReply, permission?: AdminPermission): Promise<AdminMe | null> {
  try {
    const cached = requestActors.get(req)
    if (cached && (!permission || cached.permissions.includes(permission))) return cached
    const proof = await verifiedProof(req, permission ?? 'admin.authentication')
    if (proof.kind === 'desktop') return publicActor(desktopActor(proof))
    if (proof.kind === 'recovery') return publicActor(recoveryActor(proof.id))
    const store = await storeFor(req.server)
    const actor = await store.authorize(proof, { permission, action: permission ?? 'admin.authentication', targetId: null, requestId: req.id })
    requestActors.set(req, actor); return actor
  } catch (error) { adminErrorReply(reply, error); return null }
}
export async function adminIdentity(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try { const proof = await verifiedProof(req, 'admin.login'), store = await storeFor(req.server); return reply.send(success(await store.identify(proof, req.id))) }
  catch (error) { return adminErrorReply(reply,error) }
}
async function operation<T>(req: FastifyRequest, reply: FastifyReply, op: Omit<AdminOperation,'requestId'>, write: boolean, work: AdminTask<T>): Promise<FastifyReply> {
  try {
    const proof = await verifiedProof(req, op.action, op.targetId), store = await storeFor(req.server)
    if (op.action==='audit.read') {await store.authorize(proof,{...op,requestId:req.id}); await store.syncAccountAudit()}
    const result = await store.run(proof, { ...op, requestId: req.id }, write, work)
    return reply.send(success(result))
  } catch (error) { return adminErrorReply(reply, error) }
}
export function adminRead<T>(req: FastifyRequest, reply: FastifyReply, permission: AdminPermission, work: AdminTask<T>): Promise<FastifyReply> {
  return operation(req, reply, { permission, action: permission, targetId: null }, false, work)
}
/** Mutations repeat credential/role checks inside the same write transaction as their audit event. */
export function adminWrite<T>(req: FastifyRequest, reply: FastifyReply, permission: AdminPermission, action: string, targetId: string | null, work: AdminTask<T>): Promise<FastifyReply> {
  return operation(req, reply, { permission, action, targetId }, true, work)
}

export async function accountAdminOperation<T>(req: FastifyRequest, reply: FastifyReply, permission: AdminPermission, action: string, targetId: string|null, write: boolean, work: AdminTask<T>): Promise<FastifyReply> {
  try {
    const proof=await verifiedProof(req,action,targetId), store=await storeFor(req.server)
    return reply.send(success(await store.runAccount(proof,{permission,action,targetId,requestId:req.id},write,work)))
  } catch(error) {return adminErrorReply(reply,error)}
}

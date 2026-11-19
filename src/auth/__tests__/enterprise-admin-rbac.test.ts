import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { SignJWT, type JWTPayload } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_HEADER, type AdminAuditEntry, type AdminMember, type AdminMe, type AdminPage, type AdminRole } from '../../api/http/admin/rbac-contract.js'
import type { AuthContext } from '../types.js'

const fixtures = fileURLToPath(new URL('../../../.e2e-tmp/service-credentials/enterprise-rbac', import.meta.url))
const secret = randomBytes(48), gate = { 'x-aether-instance-token': randomBytes(32).toString('hex') }
type Headers = Record<string, string>
type Key = { id: string; key: string }
const adminKey = (key: string): Headers => ({[ADMIN_HEADER]:key})
const digest = (v: string) => createHash('sha256').update(v).digest('hex')
const jwt = async (claims: JWTPayload): Promise<Headers> => ({ authorization:'Bearer ' + await new SignJWT(claims).setProtectedHeader({alg:'HS256'}).setExpirationTime('5m').sign(new TextEncoder().encode(secret.toString('hex'))) })
let app: FastifyInstance | undefined, database: typeof import('../../storage/sqlite/db.js'), root: Headers, directory: string, primary: string
const call = (method: 'GET'|'POST'|'PATCH'|'DELETE', url: string, credential: Headers = root, payload?: Record<string, unknown>, withGate = true) => app!.inject({ method,url,headers:{...(withGate ? gate : {}),...credential},...(payload === undefined ? {} : {payload}) })
async function ok<T>(promise: ReturnType<typeof call>): Promise<T> { const response = await promise; expect(response.statusCode, response.body.replace(/aether_admin_[A-Za-z0-9_-]{43}/g,'[redacted]')).toBe(200); return response.json().data as T }
const addMember = (name: string, roleId: string, enabled = true) => ok<AdminMember>(call('POST','/admin/members',root,{name,roleId,enabled}))
const addRole = (name: string, permissions: string[]) => ok<AdminRole>(call('POST','/admin/roles',root,{name,permissions}))
const issue = (id: string) => ok<Key>(call('POST',`/admin/members/${id}/credentials`,root,{}))
const identity = (k: string) => ok<AdminMe>(call('GET','/admin/me',adminKey(k)))
const members = (suffix = '') => ok<AdminPage<AdminMember>>(call('GET','/admin/members'+suffix))
const audit = (suffix = '') => ok<AdminPage<AdminAuditEntry>>(call('GET','/admin/audit'+suffix))

async function startApp() {
  const { configureRequestAuthentication, authMiddlewareHook, loggingMiddleware } = await import('../../api/http/middleware.js')
  const { registerAdminSchema, adminRead, adminWrite, requireAdminPermission } = await import('../../api/http/admin/rbac-access.js')
  const { adminRbacRoutes } = await import('../../api/http/routes/admin-rbac.js'), {authRoutes} = await import('../../api/http/routes/auth.js')
  configureRequestAuthentication()
  const service = Fastify({ genReqId: () => randomUUID() }); service.addHook('onRequest',loggingMiddleware); service.addHook('onRequest',authMiddlewareHook)
  registerAdminSchema(service,'fixture.v1',['CREATE TABLE IF NOT EXISTS fixture_writes(n INTEGER PRIMARY KEY)'])
  await service.register(adminRbacRoutes); await service.register(authRoutes)
  service.get('/health',() => ({ok:true}))
  service.get('/fixture/business',(req: FastifyRequest & {authContext?: AuthContext}) => ({tenantId:req.authContext?.tenantId}))
  service.get('/admin/fixture/status',async (req,reply) => { const actor = await requireAdminPermission(req,reply,'status.read'); return actor ? { allowed:true } : reply })
  service.get('/admin/fixture/rows',(req,reply) => adminRead(req,reply,'rules.read',async tx => (await tx.execute('SELECT n FROM fixture_writes')).rows.length))
  service.post('/admin/fixture/fail',(req,reply) => adminWrite(req,reply,'rules.manage','fixture.rollback',null,async tx => { await tx.execute('INSERT INTO fixture_writes VALUES(1)'); throw new Error('sensitive internal diagnostic') }))
  await service.ready(); return service
}
async function close() { if(app) {await app.close(); app=undefined}; await database?.closeDb() }
beforeAll(async () => {
  fs.mkdirSync(fixtures,{recursive:true}); root = await jwt({tenantId:'default',sub:'deployment-root',roles:['admin']})
})
beforeEach(async () => {
  directory=fs.mkdtempSync(path.join(fixtures,'run-')); primary=path.join(directory,'agent.db')
  for(const [key,value] of Object.entries({DATA_DIR:primary, AETHER_GLOBAL_DIR:path.join(directory,'global'), WORKSPACE_ROOT:path.join(directory,'workspace'),QA_LOG_DIR:path.join(directory,'qa'),QA_LOG_ENABLED:'false',LOG_LEVEL:'silent',AUTH_ENABLED:'true',AETHER_INSTANCE_TOKEN:gate['x-aether-instance-token'],JWT_SECRET:secret.toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')})) vi.stubEnv(key,value)
  database = await import('../../storage/sqlite/db.js'); await database.initDb(); app=await startApp()
},30000)
afterEach(async () => {
  try { await close() } finally {
    vi.unstubAllEnvs()
    if(directory && fs.existsSync(directory)) {
      const target=fs.realpathSync(directory)
      if(path.dirname(target)!==fs.realpathSync(fixtures) || !path.basename(target).startsWith('run-') || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unexpected fixture directory')
      fs.rmSync(target,{recursive:true,force:true})
    }
  }
},30000)
afterAll(() => { vi.unstubAllEnvs() })

describe('enterprise management authorization using real HTTP and a separate SQLite database', () => {
  it('enforces the independent instance and management gates without granting workload access, including anonymous business mode',async () => {
    expect(fs.existsSync(primary+'.admin.sqlite')).toBe(false)
    expect((await call('GET','/admin/me',{})).statusCode).toBe(401)
    const foreign=await jwt({tenantId:'acme',roles:['admin']}), ordinary=await jwt({tenantId:'default',roles:['user']})
    for(const credential of [foreign,ordinary,await jwt({sub:'default',roles:['admin']})]) expect((await call('GET','/admin/me',credential)).statusCode).toBe(403)
    expect((await call('GET','/admin/me',root,undefined,false)).statusCode).toBe(401)
    expect(fs.existsSync(primary+'.admin.sqlite')).toBe(false)
    const serviceKey=randomBytes(32).toString('base64url'), businessRoot={'x-api-key':serviceKey}
    expect((await call('POST','/auth/user',root,{userId:'default',token:serviceKey})).statusCode).toBe(200)
    expect((await ok<AdminMe>(call('GET','/admin/me',businessRoot))).recovery).toBe(true)
    const person=await addMember('独立观察员','viewer'), key=await issue(person.id), headers=adminKey(key.key)
    expect(await identity(key.key)).toMatchObject({id:person.id,roleId:'viewer',recovery:false})
    expect((await call('GET','/admin/me',headers,undefined,false)).statusCode).toBe(401)
    for (const wrong of ['malformed','aether_admin_'+randomBytes(32).toString('base64url')]) expect((await call('GET','/admin/me',{...businessRoot,...adminKey(wrong)})).statusCode).toBe(401)
    expect((await call('POST','/auth/user',businessRoot,{userId:'default',token:key.key})).statusCode).toBe(400)
    expect((await database.getDb().execute('SELECT api_key_hash FROM users')).rows).toEqual([{api_key_hash:digest(serviceKey)}])
    for(const enabled of ['true','false']) {
      vi.stubEnv('AUTH_ENABLED',enabled); const {configureRequestAuthentication}=await import('../../api/http/middleware.js'); configureRequestAuthentication()
      for(const wrong of [headers,{authorization:'Bearer '+key.key},{'x-api-key':key.key},{...headers,...businessRoot},{...businessRoot,authorization:'Bearer '+key.key}]) expect((await call('GET','/fixture/business',wrong)).statusCode).toBe(401)
      expect((await call('GET','/health',{authorization:'Bearer '+key.key})).statusCode).toBe(401)
      expect((await call('GET','/fixture/business',businessRoot)).json()).toEqual({tenantId:'default'})
      expect((await call('GET','/admin/members',{})).statusCode).toBe(401)
      expect((await call('GET','/admin/fixture/status',headers)).statusCode).toBe(200)
    }
  })

  it('constrains delegation to the actor’s grants, separates member editing from key issuance, and applies role, disable and revoke changes immediately',async () => {
    const limited=await addRole('成员维护',['members.write','roles.read','roles.write']), worker=await addMember('委托管理员',limited.id), key=await issue(worker.id), h=adminKey(key.key)
    const target=await addMember('只读成员','viewer'), auditMember=await addMember('审计成员','auditor'), auditH=adminKey((await issue(auditMember.id)).key)
    expect((await call('GET','/admin/members',h)).statusCode).toBe(403)
    expect((await call('POST',`/admin/members/${worker.id}/credentials`,h,{})).statusCode).toBe(403)
    const created = await ok<AdminMember>(call('POST','/admin/members',h,{name:'另一位维护员',roleId:limited.id}))
    expect((await call('POST','/admin/members',h,{name:'不允许',roleId:'super-admin'})).statusCode).toBe(403)
    expect((await call('PATCH',`/admin/members/${target.id}`,h,{roleId:limited.id})).statusCode).toBe(403)
    expect((await call('PATCH',`/admin/members/${worker.id}`,h,{roleId:'super-admin'})).statusCode).toBe(409)
    expect((await call('PATCH',`/admin/roles/${limited.id}`,h,{name:'自改'})).statusCode).toBe(409)
    expect((await call('POST','/admin/roles',h,{name:'越权',permissions:['rules.manage']})).statusCode).toBe(403)
    expect((await call('DELETE',`/admin/roles/${limited.id}`,root)).statusCode).toBe(409)
    for(const id of ['super-admin','viewer','auditor']) expect((await call('PATCH',`/admin/roles/${id}`,root,{permissions:[]})).statusCode).toBe(409)
    expect((await call('GET','/admin/audit',auditH)).statusCode).toBe(200)
    expect((await call('POST','/admin/roles',auditH,{name:'写入',permissions:[]})).statusCode).toBe(403)
    expect((await call('PATCH',`/admin/roles/${limited.id}`,root,{permissions:['status.read','members.read']})).statusCode).toBe(200)
    expect((await call('GET','/admin/members',h)).statusCode).toBe(200)
    expect((await call('GET','/admin/roles',h)).statusCode).toBe(403)
    expect((await call('PATCH',`/admin/members/${worker.id}`,root,{enabled:false})).statusCode).toBe(200)
    expect((await call('GET','/admin/me',h)).statusCode).toBe(401)
    expect((await call('POST',`/admin/members/${worker.id}/credentials`,root,{})).statusCode).toBe(409)
    expect((await call('PATCH',`/admin/members/${worker.id}`,root,{enabled:true})).statusCode).toBe(200)
    expect((await identity(key.key)).permissions).toContain('members.read')
    expect((await call('DELETE',`/admin/members/${target.id}/credentials/${key.id}`,root)).statusCode).toBe(404)
    expect((await call('DELETE',`/admin/members/${worker.id}/credentials/${key.id}`,root)).statusCode).toBe(200)
    expect((await call('GET','/admin/me',h)).statusCode).toBe(401)
    await ok(call('DELETE',`/admin/members/${worker.id}`)); await ok(call('DELETE',`/admin/members/${created.id}`)); await ok(call('DELETE',`/admin/roles/${limited.id}`))
    expect((await call('GET',`/admin/roles/${limited.id}`)).statusCode).toBe(404)
  })

  it('atomically preserves the last usable owner and prevents self-lockout even with concurrent requests',async () => {
    const owner=await addMember('主管一','super-admin'), key=await issue(owner.id), h=adminKey(key.key)
    expect((await call('DELETE',`/admin/members/${owner.id}`,h)).statusCode).toBe(409)
    expect((await call('DELETE',`/admin/members/${owner.id}/credentials/${key.id}`,h)).statusCode).toBe(409)
    for(const op of [()=>call('DELETE',`/admin/members/${owner.id}`),()=>call('PATCH',`/admin/members/${owner.id}`,root,{roleId:'viewer'}),()=>call('PATCH',`/admin/members/${owner.id}`,root,{enabled:false}),()=>call('DELETE',`/admin/members/${owner.id}/credentials/${key.id}`)]) expect((await op()).statusCode).toBe(409)
    expect((await identity(key.key)).roleId).toBe('super-admin')
    const other=await addMember('主管二','super-admin'), otherKey=await issue(other.id)
    const removal=await Promise.all([owner,other].map(p=>call('PATCH',`/admin/members/${p.id}`,root,{enabled:false})))
    expect(removal.map(x=>x.statusCode).sort()).toEqual([200,409])
    const after=await Promise.all([key,otherKey].map(k=>call('GET','/admin/me',adminKey(k.key))))
    expect(after.map(x=>x.statusCode).sort()).toEqual([200,401])
    expect((await audit('?q=last_owner&outcome=failed')).items.length).toBeGreaterThanOrEqual(4)
  })

  it('filters full tables by literal text and status before cursor pagination, including on later audit pages',async () => {
    const role=await addRole('百分号%_',['status.read']), otherRole=await addRole('另一个角色',[])
    const candidates=await Promise.all([['Alpha%_ A',true],['alpha%_ B',true],['Alpha%_ C',false],['No match',true]].map(([name,enabled])=>addMember(String(name),role.id,Boolean(enabled))))
    const expected=candidates.slice(0,2).map(x=>x.id).sort(), query='?q='+encodeURIComponent('ALPHA%_')+'&enabled=true&limit=1'
    const page1=await members(query), page2=await members(query+'&cursor='+page1.nextCursor)
    expect([...page1.items,...page2.items].map(x=>x.id)).toEqual(expected); expect(page2.nextCursor).toBeNull()
    expect((await members('?q='+encodeURIComponent('%_')+'&enabled=false')).items.map(x=>x.id)).toEqual([candidates[2].id])
    const roles=await ok<AdminPage<AdminRole>>(call('GET','/admin/roles?builtIn=false&q='+encodeURIComponent('%_')))
    expect(roles.items.map(x=>x.id)).toEqual([role.id]); expect(roles.items.some(x=>x.id===otherRole.id)).toBe(false)
    expect((await ok<AdminPage<AdminRole>>(call('GET','/admin/roles?builtIn=true'))).items).toHaveLength(3)
    const found=await audit('?q='+encodeURIComponent('创建成员')+'&outcome=success&limit=1'), next=await audit('?q=member.create&outcome=success&limit=1&cursor='+found.nextCursor)
    expect(found.items[0].action).toBe('member.create'); expect(next.items[0].id).toBeLessThan(found.items[0].id)
    for(const url of ['/admin/roles?limit=101','/admin/members?enabled=on','/admin/audit?outcome=typo','/admin/audit?cursor=-1','/admin/roles?q='+('a'.repeat(81)),'/admin/roles?builtIn=1']) expect((await call('GET',url)).statusCode).toBe(400)
  })

  it('audits successful, denied and rolled-back changes without recording submitted values, keys or hashes',async () => {
    const person=await addMember('读者','viewer'), key=await issue(person.id), h=adminKey(key.key)
    expect((await call('POST','/admin/fixture/fail',root,{})).statusCode).toBe(503)
    expect(await ok<number>(call('GET','/admin/fixture/rows',h))).toBe(0)
    expect((await call('POST','/admin/fixture/fail',h,{})).statusCode).toBe(403)
    const before=(await audit('?q=admin.login')).items.length
    await Promise.all([identity(key.key),identity(key.key),identity(key.key)])
    expect((await audit('?q=admin.login')).items.length-before).toBe(1)
    const secretBody='test-sensitive-marker-'+randomUUID()
    expect((await call('PATCH',`/admin/members/${person.id}`,root,{unexpected:secretBody})).statusCode).toBe(400)
    await ok(call('PATCH',`/admin/members/${person.id}`,root,{enabled:false}))
    const unrelated=await jwt({sub:'unrelated-private-id',tenantId:'other-private-tenant',roles:['admin']})
    expect((await call('GET','/admin/me',unrelated)).statusCode).toBe(403)
    expect((await call('GET','/admin/me',{},undefined,false)).statusCode).toBe(401)
    const logs=(await audit()).items, okChange=logs.find(x=>x.action==='member.update' && x.outcome==='success')!
    expect(okChange).toMatchObject({targetId:person.id,roleId:'super-admin',changes:{fields:['enabled'],before:{enabled:true,roleId:'viewer'},after:{enabled:false,roleId:'viewer'}}})
    expect(logs).toContainEqual(expect.objectContaining({actorId:expect.stringMatching(/^business-ref:/),action:'admin.login',outcome:'denied',reason:'permission_denied'}))
    expect(logs).toContainEqual(expect.objectContaining({actorId:'unverified',outcome:'denied',reason:'instance_token_required'}))
    expect(okChange.requestId).toMatch(/^[a-f0-9-]{36}$/)
    expect(logs).toContainEqual(expect.objectContaining({actorId:person.id,action:'fixture.rollback',outcome:'denied',reason:'permission_denied'}))
    expect(logs).toContainEqual(expect.objectContaining({action:'fixture.rollback',outcome:'failed',reason:'operation_failed'}))
    const keys=await ok<{items:object[]}>(call('GET',`/admin/members/${person.id}/credentials`)); expect(Object.keys(keys.items[0]).sort()).toEqual(['createdAt','id','revokedAt'])
    const printable=JSON.stringify([logs,keys]); for(const item of [secretBody,key.key,digest(key.key),'sensitive internal diagnostic','unrelated-private-id','other-private-tenant']) expect(printable.includes(item)).toBe(false)
    expect((await database.getDb().execute("SELECT name FROM sqlite_master WHERE name LIKE 'admin_%'")).rows).toEqual([])
    await close()
    const files=['','-wal','-shm'].map(ext=>primary+'.admin.sqlite'+ext).filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f))
    expect(files.some(bytes=>bytes.includes(Buffer.from(key.key)))).toBe(false); expect(files.some(bytes=>bytes.includes(Buffer.from(digest(key.key))))).toBe(true)
  })

  it('logs only route templates for administrative URLs, even when an arbitrary ID contains a key or a route is unknown',async () => {
    const {logger}=await import('../../observability/index.js'), child=logger.child<string>({capture:true})
    const info=vi.spyOn(child,'info').mockImplementation(()=>{}), derive=vi.spyOn(logger,'child').mockReturnValue(child)
    const misplaced='aether_admin_'+randomBytes(32).toString('base64url')
    try {
      await call('GET','/admin/members/'+misplaced+'?q='+misplaced)
      await call('GET','/admin/unknown/'+misplaced+'?q='+misplaced)
      await call('GET','/%61dmin/unknown/'+misplaced)
      const malformed=await app!.inject({method:'POST',url:'/admin/members',headers:{...gate,...root,'content-type':'application/json'},payload:misplaced})
      expect(malformed.statusCode).toBe(400); expect(malformed.json().code).toBe(40000); expect(malformed.body.includes(misplaced)).toBe(false)
      const tooLarge=await call('POST','/admin/members',root,{name:misplaced+'x'.repeat(20*1024),roleId:'viewer'})
      expect(tooLarge.statusCode).toBe(413); expect(tooLarge.body.includes(misplaced)).toBe(false)
      const events=info.mock.calls.map(args=>args[0])
      expect(JSON.stringify(events).includes(misplaced)).toBe(false)
      expect(events).toContainEqual({method:'GET',url:'/admin/members/:id'})
      expect(events.filter(e=>typeof e==='object' && e!==null && (e as {url?:string}).url==='/admin/*')).toHaveLength(2)
    } finally { derive.mockRestore();info.mockRestore() }
  })
  it('binds management state to the open main database, persists across restarts and isolates multiple databases in one directory',async () => {
    const alternate=path.join(directory,'another.db'); vi.stubEnv('DATA_DIR',alternate)
    const first=await addMember('原实例成员','viewer'), key=await issue(first.id)
    expect(fs.existsSync(primary+'.admin.sqlite')).toBe(true); expect(fs.existsSync(alternate+'.admin.sqlite')).toBe(false)
    await close(); vi.stubEnv('DATA_DIR',primary); await database.initDb(); app=await startApp()
    expect((await identity(key.key)).id).toBe(first.id)
    await close(); vi.stubEnv('DATA_DIR',alternate); await database.initDb(); app=await startApp()
    expect((await members()).items).toHaveLength(0); expect((await call('GET','/admin/me',adminKey(key.key))).statusCode).toBe(401)
    expect(fs.existsSync(alternate+'.admin.sqlite')).toBe(true)
  })

  it('provisions a separate offline recovery identity without rotating the service key, and rolls back failed delivery',async () => {
    const {provisionOfflineAdmin}=await import('../../api/http/admin/rbac-storage.js')
    const serviceKey=randomBytes(32).toString('base64url')
    await ok(call('POST','/auth/user',root,{userId:'default',token:serviceKey})); const before=(await database.getDb().execute('SELECT id,api_key_hash FROM users')).rows
    const output=path.join(directory,'delivered.key')
    const recovery=await provisionOfflineAdmin(primary,'离线管理员',value=>fs.writeFileSync(output,value,{flag:'wx',mode:0o600})); const key=fs.readFileSync(output,'utf8')
    expect(await identity(key)).toMatchObject({id:recovery.memberId,roleId:'super-admin',recovery:false}); const count=(await members()).items.length
    let failedKey=''; await expect(provisionOfflineAdmin(primary,'不应存在的成员',value=>{failedKey=value;throw new Error('output unavailable')})).rejects.toThrow('output unavailable')
    expect((await members()).items).toHaveLength(count); expect((await call('GET','/admin/me',adminKey(failedKey))).statusCode).toBe(401)
    expect((await database.getDb().execute('SELECT id,api_key_hash FROM users')).rows).toEqual(before)
    expect((await ok<AdminMe>(call('GET','/admin/me',{'x-api-key':serviceKey}))).recovery).toBe(true)
    expect((await audit('?q=offline.recovery.create')).items.map(x=>x.outcome)).toEqual(['failed','success'])
    await expect(provisionOfflineAdmin(primary+'.admin.sqlite','错误文件',()=>{throw new Error('should not deliver')})).rejects.toThrow('引擎主数据库')
    expect(fs.existsSync(primary+'.admin.sqlite.admin.sqlite')).toBe(false)
  })
})

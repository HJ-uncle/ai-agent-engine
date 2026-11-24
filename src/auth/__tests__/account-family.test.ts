/** HTTP and durable SQLite boundaries for managed accounts. Fixtures never touch live accounts. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { issuedFixtureActivation } from './activation-fixture.js'
import type { AccountLoginResult } from '../accounts.js'
import type { AccountFamily, ChildAccount } from '../account-family-types.js'

const root = path.resolve('.e2e-tmp', 'account-family'), fixture = path.join(root, `children-${randomUUID()}`)
const gate = { 'x-aether-instance-token': 'family-test-instance-gate' }
const family = '/auth/account/children', pwd = '/auth/account/child-password', me = '/auth/account/me'
let app: FastifyInstance, db: typeof import('../../storage/sqlite/db.js'), accounts: typeof import('../accounts.js')
let address = 1
function http(method: 'GET'|'POST'|'PATCH'|'PUT', url: string, login?: AccountLoginResult, payload?: Record<string, unknown>, headers: Record<string,string> = {}) {
  return app.inject({ method, url, headers: { ...gate, ...(login ? { authorization: `Bearer ${login.accessToken}` } : {}), ...headers }, payload, remoteAddress: `192.0.2.${++address % 250}` })
}
const primary = async () => accounts.registerAccount(await issuedFixtureActivation())
async function create(p: AccountLoginResult, name: string): Promise<ChildAccount> {
  const res = await http('POST', family, p, { name }); expect(res.statusCode).toBe(200); return res.json().data
}
async function enter(p: AccountLoginResult, id: string): Promise<AccountLoginResult> {
  const res = await http('POST', `${family}/${id}/enter`, p, {}); expect(res.statusCode).toBe(200); return res.json().data
}
async function withPassword(p: AccountLoginResult, id: string) {
  const loginName = randomUUID(), password = 'correct family test passphrase'
  expect((await http('PUT', `${pwd}/children/${id}`, p, {loginName,password})).statusCode).toBe(200)
  const login = async () => http('POST', `${pwd}/login`, undefined, {loginName,password})
  const result = await login(); expect(result.statusCode).toBe(200)
  return {login, session:result.json().data as AccountLoginResult}
}
const refresh = (login: AccountLoginResult, requestId?: string) => http('POST','/auth/account/refresh',undefined,{refreshToken: login.refreshToken, ...(requestId ? {requestId} : {})})
const status = (p: AccountLoginResult,id: string,v: ChildAccount['status']) => http('PATCH',`${family}/${id}`,p,{status:v})

beforeAll(async () => {
  fs.mkdirSync(fixture, {recursive:true})
  vi.stubEnv('DATA_DIR',path.join(fixture,'engine.db')); vi.stubEnv('WORKSPACE_ROOT',path.join(fixture,'workspace'))
  vi.stubEnv('AUTH_ENABLED','true'); vi.stubEnv('AETHER_ACCOUNT_REGISTRATION','true'); vi.stubEnv('JWT_SECRET','local-family-test-issuer')
  vi.stubEnv('AETHER_INSTANCE_TOKEN',gate['x-aether-instance-token']); vi.stubEnv('AETHER_ACCOUNT_PROVIDERS_JSON','[]')
  db=await import('../../storage/sqlite/db.js'); await db.initDb(); accounts=await import('../accounts.js')
  const middleware=await import('../../api/http/middleware.js'); middleware.configureRequestAuthentication()
  app=Fastify(); app.addHook('onRequest',middleware.authMiddlewareHook)
  await app.register((await import('../../api/http/routes/accounts.js')).accountRoutes)
  await app.register((await import('../../api/http/routes/workspace.js')).workspaceRoutes)
  await app.ready()
})
afterAll(async () => {
  await app?.close(); await db?.closeDb(); vi.unstubAllEnvs()
  if (fs.existsSync(fixture) && path.dirname(fs.realpathSync(fixture)) === fs.realpathSync(root) && !fs.lstatSync(fixture).isSymbolicLink()) fs.rmSync(fixture,{recursive:true})
})

describe('managed personal accounts', () => {
  it('counts only direct children including disabled ones and commits exactly three concurrent creations',async () => {
    const p = await primary(), initial = await db.getDb().execute('SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM account_profiles) AS profiles')
    expect((await http('GET',family,p)).json().data).toEqual({limit:3,used:0,children:[]})
    for (const body of [{name:' '},{name:'a'.repeat(81)},{name:'bad\u202e'},{name:'x',parentId:p.user.id},{name:'x',roles:['admin']}]) {
      expect((await http('POST',family,p,body)).statusCode).toBe(400)
    }
    const race = await Promise.all(Array.from({length:6},(_,i)=>http('POST',family,p,{name:`账号 ${i}`})))
    expect(race.map(r=>r.statusCode).sort()).toEqual([200,200,200,409,409,409])
    const list = await http('GET',family,p), overview = list.json().data as AccountFamily
    expect(list.headers['cache-control']).toBe('no-store'); expect(overview).toMatchObject({limit:3,used:3})
    expect(new Set(overview.children.map(c=>c.id)).size).toBe(3)
    expect(overview.children.every(c=>Object.keys(c).sort().join() === 'createdAt,id,name,status' && c.id!==p.user.id && c.status==='active')).toBe(true)
    const counts=await db.getDb().execute('SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM account_profiles) AS profiles')
    expect(Number(counts.rows[0].users)-Number(initial.rows[0].users)).toBe(3)
    expect(Number(counts.rows[0].profiles)-Number(initial.rows[0].profiles)).toBe(3)
    const id=overview.children[0].id
    expect((await status(p,id,'disabled')).statusCode).toBe(200)
    expect((await status(p,id,'disabled')).statusCode).toBe(200)
    expect((await http('POST',family,p,{name:'仍无名额'})).statusCode).toBe(409)
    expect((await http('POST',`${family}/${id}/enter`,p,{})).statusCode).toBe(409)
    await db.getDb().execute({sql:'INSERT INTO account_child_quotas(parent_id,child_limit) VALUES(?,4)',args:[p.user.id]})
    await create(p,'扩容后的子账号'); expect((await http('GET',family,p)).json().data).toMatchObject({limit:4,used:4})
  })

  it('confines delegated and password logins to their own identity, tenant and workspace',async () => {
    const p=await primary(), outsider=await primary(), first=await create(p,'一号'), second=await create(p,'二号'), other=await create(outsider,'别家的')
    const direct=await withPassword(p,first.id), delegated=await enter(p,first.id), sibling=await enter(p,second.id)
    expect(new Set([p.user.tenantId,delegated.user.tenantId,sibling.user.tenantId,outsider.user.tenantId]).size).toBe(4)
    expect(p.user.accountKind).toBe('primary')
    const exportCode=await issuedFixtureActivation()
    for (const login of [direct.session,delegated]) {
      expect(login.user).toMatchObject({id:first.id,accountKind:'child',mainAccountActivated:false,roles:[],hasRecoveryKey:false,identities:[]})
      expect(Object.keys(login).sort()).toEqual(['accessToken','expiresAt','refreshToken','user'])
      expect(login.user.sessionId!==p.user.sessionId && login.refreshToken!==p.refreshToken && login.accessToken!==p.accessToken).toBe(true)
      expect((await http('GET',family,login)).statusCode).toBe(403)
      expect((await http('POST',family,login,{name:'下一级'})).statusCode).toBe(403)
      expect((await status(login,other.id,'disabled')).statusCode).toBe(403)
      expect((await http('POST',`${family}/${p.user.id}/enter`,login,{})).statusCode).toBe(403)
      expect((await http('POST','/auth/account/activation',login,{activationCode:exportCode})).statusCode).toBe(403)
      expect((await http('POST','/auth/account/recovery',login,{})).statusCode).toBe(403)
      const ctx=await accounts.authenticateAccountSession(login.accessToken)
      await expect(accounts.completeExternalIdentity({providerId:'fixture',subject:'fixture-sub'},ctx)).rejects.toMatchObject({statusCode:403})
      expect((await http('GET',`${pwd}/children/${other.id}`,login)).statusCode).toBe(404)
    }
    const state=await db.getDb().execute({sql:'SELECT u.api_key_hash, p.recovery_hash FROM users u JOIN account_profiles p ON p.user_id=u.id WHERE u.id=?',args:[first.id]})
    expect(state.rows[0]).toMatchObject({api_key_hash:null,recovery_hash:null})
    expect((await http('GET',family,outsider)).json().data.children.map((c:ChildAccount)=>c.id)).toEqual([other.id])
    expect((await status(outsider,first.id,'disabled')).statusCode).toBe(404)
    const unseen = await http('POST',`${family}/${randomUUID()}/enter`,outsider,{})
    const notOwner = await http('POST',`${family}/${first.id}/enter`,outsider,{})
    expect(notOwner.statusCode).toBe(404); expect(notOwner.json().message).toBe(unseen.json().message)
    expect((await http('POST',`${family}/${first.id}/enter`,p,{parentId:outsider.user.id})).statusCode).toBe(400)
    expect((await http('PATCH','/auth/account/profile',delegated,{name:'x'.repeat(81)})).statusCode).toBe(400)
    expect((await http('PATCH','/auth/account/profile',delegated,{name:'子空间名称'})).statusCode).toBe(200)
    expect((await http('GET',me,p)).json().data.name).toBe(p.user.name)
    const {workspaceManager}=await import('../../workspace/index.js'), sessionId='same-session', filename='private.txt'
    for (const [login,marker] of [[p,'主空间'],[delegated,'子空间'],[sibling,'同级空间']] as const) {
      const dir=workspaceManager.getPath({tenantId:login.user.tenantId,sessionId})
      if (!dir.startsWith(fixture+path.sep)) throw new Error('Unexpected live workspace')
      fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,filename),marker)
    }
    for (const [login,marker] of [[p,'主空间'],[delegated,'子空间'],[direct.session,'子空间'],[sibling,'同级空间']] as const) {
      const res=await http('GET',`/workspace/file/content?sessionId=${sessionId}&path=${filename}`,login,undefined,{'x-tenant-id':outsider.user.tenantId})
      expect(res.json().data?.content).toBe(marker)
    }
    const {SignJWT}=await import('jose'), jwt=await new SignJWT({tenantId:delegated.user.tenantId}).setProtectedHeader({alg:'HS256'}).setSubject(first.id).sign(new TextEncoder().encode(process.env.JWT_SECRET))
    expect((await http('GET',me,undefined,undefined,{authorization:`Bearer ${jwt}`})).statusCode).toBe(401)
    const key=randomUUID(); await db.getDb().execute({sql:'UPDATE users SET api_key_hash=? WHERE id=?',args:[createHash('sha256').update(key).digest('hex'),first.id]})
    expect((await http('GET','/workspace/directory',undefined,undefined,{'x-api-key':key})).statusCode).toBe(401)
    expect((await http('POST','/auth/account/login',undefined,{recoveryKey:key})).statusCode).toBe(401)
  })

  it('keeps child file access inside its workspace on an owned desktop even when its operator defaults to full access', async () => {
    const p=await primary(), c=await create(p,'桌面子账号'), d=await enter(p,c.id), sessionId='desktop-isolation'
    const env={AUTH_ENABLED:process.env.AUTH_ENABLED,AETHER_DESKTOP_OWNED:process.env.AETHER_DESKTOP_OWNED,DEFAULT_SECURITY_MODE:process.env.DEFAULT_SECURITY_MODE}
    const middleware=await import('../../api/http/middleware.js'), {workspaceManager}=await import('../../workspace/index.js')
    const {getSecurityMode}=await import('../../security/policy-engine.js')
    try {
      Object.assign(process.env,{AUTH_ENABLED:'false',AETHER_DESKTOP_OWNED:'1',DEFAULT_SECURITY_MODE:'full-access'})
      middleware.configureRequestAuthentication({desktopOwned:true,listenHost:'127.0.0.1'})
      const parentCtx={tenantId:p.user.tenantId,sessionId}, childCtx={tenantId:d.user.tenantId,sessionId}
      const parentDir=workspaceManager.getPath(parentCtx), childDir=workspaceManager.getPath(childCtx)
      for (const [dir,content] of [[parentDir,'父'],[childDir,'子']]) {
        if(!dir.startsWith(fixture+path.sep)) throw new Error('Unexpected live workspace')
        fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'marker.txt'),content)
      }
      expect(getSecurityMode(parentCtx.tenantId,sessionId)).toBe('full-access'); expect(getSecurityMode(childCtx.tenantId,sessionId)).toBe('safe')
      expect(workspaceManager.getPaths({...childCtx,projectRoot:parentDir,scratchDir:parentDir,workspacePaths:[parentDir]})).toEqual([childDir])
      for (const [login,foreign] of [[d,parentDir],[p,childDir]] as const) {
        const query=new URLSearchParams({sessionId,path:path.join(foreign,'marker.txt')})
        expect((await http('GET','/workspace/file/content?'+query,login)).json().data).toBeNull()
        expect((await http('POST','/workspace/bind',login,{sessionId,workspaceRoot:foreign})).json().code).toBe(40300)
      }
      expect((await http('POST','/workspace/bind',d,{sessionId,workspaceRoot:childDir})).json().code).toBe(200)
      expect((await http('GET','/workspace/file/content?sessionId='+sessionId+'&path=marker.txt',d)).json().data.content).toBe('子')
    } finally {
      for (const [key,value] of Object.entries(env)) { if(value===undefined) delete process.env[key]; else process.env[key]=value }
      middleware.configureRequestAuthentication()
    }
  })

  it('revokes only the matching delegation at parent logout, but all generations and both login types at disable',async () => {
    const p1=await primary(), p2=await accounts.loginAccount(p1.recoveryKey!), c=await create(p1,'可恢复')
    const direct=await withPassword(p1,c.id), d1=await enter(p1,c.id), d2=await enter(p2,c.id)
    const childCtx=await accounts.authenticateAccountSession(d1.accessToken), requestId=randomUUID()
    const rotated=(await refresh(d1,requestId)).json().data as AccountLoginResult
    expect((await refresh(p1,randomUUID())).statusCode).toBe(200)
    expect((await http('GET',me,d1)).statusCode).toBe(200); expect((await refresh(d1,requestId)).statusCode).toBe(200)
    expect((await http('POST','/auth/account/logout',p1,{})).statusCode).toBe(200)
    for (const login of [rotated,d1]) expect((await http('GET',me,login)).statusCode).toBe(401)
    await expect(accounts.revalidateAccountAuth(childCtx)).rejects.toMatchObject({statusCode:401})
    expect((await refresh(d1,requestId)).statusCode).toBe(401); expect((await refresh(rotated)).statusCode).toBe(401)
    expect((await http('GET',me,d2)).statusCode).toBe(200); expect((await http('GET',me,direct.session)).statusCode).toBe(200)
    const directRetry=randomUUID(), nextDirect=(await refresh(direct.session,directRetry)).json().data as AccountLoginResult
    expect((await http('PATCH','/auth/account/profile',d2,{bio:'停用后保留的内容'})).statusCode).toBe(200)
    expect((await status(p2,c.id,'disabled')).statusCode).toBe(200)
    await db.closeDb(); await db.initDb()
    expect((await http('GET',family,p2)).json().data).toMatchObject({used:1,children:[{id:c.id,status:'disabled'}]})
    expect((await direct.login()).statusCode).toBe(401); expect((await refresh(direct.session,directRetry)).statusCode).toBe(401)
    expect((await status(p2,c.id,'active')).statusCode).toBe(200)
    for (const login of [d1,rotated,d2,direct.session,nextDirect]) {
      expect((await http('GET',me,login)).statusCode).toBe(401); expect((await refresh(login)).statusCode).toBe(401)
    }
    const live=await enter(p2,c.id); expect(live.user.bio).toBe('停用后保留的内容')
    expect((await direct.login()).statusCode).toBe(200)
  })

  it('bounds delegation by the absolute parent lifetime and rejects stale resumptions or replays',async () => {
    const p=await primary(), c=await create(p,'时限'), absolute=Date.now()+120_000
    await db.getDb().execute({sql:'UPDATE account_sessions SET expires_at=? WHERE id=?',args:[absolute,p.user.sessionId!]})
    const d=await enter(p,c.id), ctx=await accounts.authenticateAccountSession(d.accessToken)
    expect(Date.parse(d.expiresAt)).toBe(absolute)
    await db.getDb().execute({sql:'UPDATE account_sessions SET access_expires_at=? WHERE id=?',args:[Date.now()-1,p.user.sessionId!]})
    expect((await http('GET',me,d)).statusCode).toBe(200)
    const attempt=randomUUID(); expect((await refresh(d,attempt)).statusCode).toBe(200)
    await db.getDb().execute({sql:'UPDATE account_sessions SET expires_at=? WHERE id=?',args:[Date.now()-1,p.user.sessionId!]})
    expect((await http('GET',me,d)).statusCode).toBe(401); expect((await refresh(d,attempt)).statusCode).toBe(401)
    await expect(accounts.revalidateAccountAuth(ctx)).rejects.toMatchObject({statusCode:401})
    const {mintInternalContinuation,revokeInternalContinuation,INTERNAL_CONTINUATION_HEADER}=await import('../../api/http/internal-continuation.js')
    const ticket=mintInternalContinuation(ctx)
    try { expect((await http('GET','/workspace/directory',undefined,undefined,{[INTERNAL_CONTINUATION_HEADER]:ticket})).statusCode).toBe(401) }
    finally { revokeInternalContinuation(ticket) }
    const p2=await accounts.loginAccount(p.recoveryKey!), d2=await enter(p2,c.id)
    expect((await refresh(p2,randomUUID())).statusCode).toBe(200); expect((await refresh(p2,randomUUID())).statusCode).toBe(401)
    expect((await http('GET',me,d2)).statusCode).toBe(401); expect((await refresh(d2)).statusCode).toBe(401)
  })
})

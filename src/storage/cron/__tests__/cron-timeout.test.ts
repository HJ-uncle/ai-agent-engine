import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
let fixture: string
let store: import('../index.js').CronStore
let closeDb: () => void
let db: import('@libsql/client').Client
const app=Fastify()
const input={name:'Timeout contract',cronExpr:'* * * * *',message:'Develop',sessionId:'fixture',enabled:false}
beforeAll(async()=>{
 fixture=fs.mkdtempSync(path.join(os.tmpdir(),'aether-cron-timeout-'))
 vi.stubEnv('DATA_DIR',path.join(fixture,'agent.db'))
 const database=await import('../../sqlite/db.js')
 await database.initDb(); closeDb=database.closeDb; db=database.getDb()
 store=new (await import('../index.js')).CronStore()
 await (await import('../../../api/http/routes/cron.js')).cronRoutes(app)
 await app.ready()
})
afterAll(async()=>{await app.close();closeDb?.();vi.unstubAllEnvs();if(fixture && path.dirname(fixture)===path.resolve(os.tmpdir()) && path.basename(fixture).startsWith('aether-cron-timeout-'))await fs.promises.rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:100})})
describe('per-job timeout persistence and HTTP contract',()=>{
 it('creates, preserves on unrelated edit, persists through reopen and resets explicitly',async()=>{
  const job=await store.create('default',{...input,timeoutSeconds:600})
  expect(job.timeoutSeconds).toBe(600)
  expect((await store.update(job.id,'default',{name:'Renamed'}))?.timeoutSeconds).toBe(600)
  const database=await import('../../sqlite/db.js'); database.closeDb();await database.initDb();db=database.getDb()
  expect((await store.getById(job.id,'default'))?.timeoutSeconds).toBe(600)
  expect((await store.update(job.id,'default',{timeoutSeconds:null}))?.timeoutSeconds).toBeNull()
  expect((await store.create('default',input)).timeoutSeconds).toBeNull()
  expect(await store.getById(job.id,'other-tenant')).toBeNull()
 })
 it('validates the HTTP create/update and returns persisted values',async()=>{
  const created=await app.inject({method:'POST',url:'/cron',payload:{...input,timeoutSeconds:86400}})
  const job=created.json().data;expect(job.timeoutSeconds).toBe(86400)
  const edited=await app.inject({method:'PUT',url:'/cron/'+job.id,payload:{name:'Kept'}})
  expect(edited.json().data.timeoutSeconds).toBe(86400)
  const reset=await app.inject({method:'PUT',url:'/cron/'+job.id,payload:{timeoutSeconds:null}})
  expect(reset.json().data.timeoutSeconds).toBeNull()
 })
 it.each([0,-1,86401,1.5,'600',true,{},[]])('rejects invalid timeout %j in create and update',async value=>{
  for(const method of ['POST','PUT'] as const){
   const result=await app.inject({method,url:method==='POST'?'/cron':'/cron/missing',payload:{...input,timeoutSeconds:value}})
   expect(result.json().code).toBe(40001)
  }
  await expect(store.create('default',{...input,timeoutSeconds:value as number})).rejects.toThrow('Invalid timeoutSeconds')
 })
 it('migration is idempotent and enforces database bounds',async()=>{
  const {up}=await import('../../sqlite/migrations/027_cron_timeout.js');await up(db);await up(db)
  const job=await store.create('default',{...input,timeoutSeconds:1});expect(job.timeoutSeconds).toBe(1)
  await expect(db.execute({sql:'UPDATE cron_jobs SET timeout_seconds=0 WHERE id=?',args:[job.id]})).rejects.toThrow()
 })
})

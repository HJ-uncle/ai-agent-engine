// SQLite schema upgrade, revision/persistence, shared HTTP/tool validation and exact IDs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyRequest } from 'fastify'
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest'
import * as database from '../../sqlite/db.js'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { up as up1 } from '../../sqlite/migrations/001_initial.js'
import { up as up6 } from '../../sqlite/migrations/006_add_todos_cron.js'
import { up as up26 } from '../../sqlite/migrations/026_cron_thinking_mode.js'
import { up as up27 } from '../../sqlite/migrations/027_cron_timeout.js'
import { up as up29 } from '../../sqlite/migrations/029_cron_automation.js'
import { up as up4 } from '../../sqlite/migrations/004_add_agents.js'
import { up as up8 } from '../../sqlite/migrations/008_add_agent_allowed_tools.js'
import { up as up9 } from '../../sqlite/migrations/009_add_sessions.js'
import { CronStore } from '../index.js'
import { CronService,cronCapabilities } from '../../../scheduler/cron-service.js'
import { configureRequestAuthentication } from '../../../api/http/middleware.js'
import { cronRoutes } from '../../../api/http/routes/cron.js'
import { cronTools } from '../../../tools/cron/cron-tool.js'
import { workspaceManager } from '../../../workspace/manager.js'
import { SQLiteAgentStore } from '../../agent/index.js'
import { SessionStore } from '../../session/index.js'
import { CronRunStore } from '../runs.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
let fixture:string,db:LocalSqliteProcessClient,store:CronStore,service:CronService
let app:ReturnType<typeof Fastify>
const legacy={name:'Legacy automation',cronExpr:'* * * * *',message:'Synthetic task',sessionId:'session',enabled:false}
const configuration={version:2 as const,schedule:{kind:'interval' as const,everyMinutes:90,anchorAt:Date.parse('2026-10-13T09:00:00Z')},target:{kind:'standalone' as const},notificationPolicy:'all_runs' as const,toolProfile:'general' as const}
beforeEach(async()=>{
  fixture=fs.mkdtempSync(path.join(os.tmpdir(),'aether-cron-configuration-'))
  app=Fastify()
  vi.stubEnv('AUTH_ENABLED','false');vi.stubEnv('DATA_DIR',path.join(fixture,'agent.db'));configureRequestAuthentication()
  db=new LocalSqliteProcessClient({url:'file:'+path.join(fixture,'agent.db')});vi.spyOn(database,'getDb').mockImplementation(()=>db)
  await up1(db);await up6(db);await up26(db);await up27(db);await up4(db);await up8(db);await up9(db)
  await db.execute('ALTER TABLE sessions ADD COLUMN metadata TEXT')
  store=new CronStore();service=new CronService(store);await cronRoutes(app);await app.ready()
})
afterEach(async()=>{
  await app.close();db.close();await db.whenClosed();vi.restoreAllMocks();vi.unstubAllEnvs();configureRequestAuthentication()
  if(path.dirname(fixture)!==path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-cron-configuration-'))throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture,{recursive:true,force:true,maxRetries:3,retryDelay:50})
})
describe('Cron schema v2 and storage',()=>{
  it('atomically preserves legacy columns, custom indexes, false/null/zero and disabled state',async()=>{
    await db.execute("ALTER TABLE cron_jobs ADD COLUMN custom_value TEXT DEFAULT 'retained'")
    await db.execute('CREATE INDEX cron_custom_index ON cron_jobs(custom_value)')
    for(const [id,thinking,timeout] of [['zero','false',0],['null','false',null]] as const)await db.execute({sql:'INSERT INTO cron_jobs(id,tenant_id,name,cron_expr,message,session_id,enabled,created_at,updated_at,thinking_mode,timeout_seconds) VALUES(?,?,?,?,?,?,0,1,2,?,?)',args:[id,'default',id,'* * * * *','Synthetic','session',thinking,timeout]})
    await up29(db);await up29(db)
    const rows=(await db.execute('SELECT * FROM cron_jobs ORDER BY id')).rows
    expect(rows).toHaveLength(2);expect(rows.map(row=>row.custom_value)).toEqual(['retained','retained'])
    expect(rows.map(row=>row.thinking_mode)).toEqual(['false','false']);expect(rows.map(row=>row.timeout_seconds)).toEqual([null,0])
    expect(rows.every(row=>row.enabled===0 && row.created_at===1 && row.updated_at===2 && row.next_run_at===null)).toBe(true)
    expect((await db.execute("SELECT name FROM sqlite_schema WHERE name='cron_custom_index'")).rows).toHaveLength(1)
    expect((await db.execute('PRAGMA table_info(cron_jobs)')).rows.filter(row=>['cron_expr','session_id'].includes(String(row.name))).map(row=>row.notnull)).toEqual([0,0])
    expect(await store.getById('zero','default')).toMatchObject({thinkingMode:false,timeoutSeconds:0,revision:1,scheduleRevision:1,configuration:{schedule:{kind:'legacy'},target:{kind:'session',sessionId:'session'}}})
  })
  it('rolls back the whole table replacement if a legacy target cannot be backfilled',async()=>{
    await db.execute("INSERT INTO cron_jobs(id,tenant_id,name,cron_expr,message,session_id,created_at,updated_at) VALUES('bad','default','bad','* * * * *','x','',1,2)")
    await expect(up29(db)).rejects.toThrow('target.sessionId')
    expect((await db.execute('SELECT * FROM cron_jobs')).rows).toHaveLength(1)
    expect((await db.execute('PRAGMA table_info(cron_jobs)')).rows.some(row=>row.name==='configuration_json')).toBe(false)
    expect((await db.execute("SELECT name FROM sqlite_schema WHERE name='cron_jobs_automation_v2'")).rows).toHaveLength(0)
  })
  it('backfills partially upgraded nullable rows on repeated migration without rewriting existing configs',async()=>{
    await up29(db)
    await db.execute("INSERT INTO cron_jobs(id,tenant_id,name,cron_expr,message,session_id,enabled,created_at,updated_at) VALUES('partial','default','partial','* * * * *','x','session',0,1,2)")
    const before=await store.create('default',{name:'Modern',message:'Synthetic',configuration})
    await up29(db)
    expect((await store.getById('partial','default'))?.configuration.schedule.kind).toBe('legacy')
    expect((await db.execute("SELECT configuration_json FROM cron_jobs WHERE id='partial'")).rows[0].configuration_json).not.toBeNull()
    expect(await store.getById(before.id,'default')).toEqual(before)
  })
  it('stores honest nullable legacy values for interval/new targets, and persists through process reopen',async()=>{
    await up29(db)
    const job=await store.create('default',{name:'Interval',message:'Synthetic',configuration,thinkingMode:false,timeoutSeconds:0})
    expect(job).toMatchObject({cronExpr:null,sessionId:null,thinkingMode:false,timeoutSeconds:0,configuration,revision:1})
    db.close();await db.whenClosed();db=new LocalSqliteProcessClient({url:'file:'+path.join(fixture,'agent.db')})
    expect(await store.getById(job.id,'default')).toMatchObject({cronExpr:null,sessionId:null,thinkingMode:false,timeoutSeconds:0,configuration})
  })
  it('uses config revisions and optimistic conflicts while runtime writes leave them unchanged',async()=>{
    await up29(db)
    const job=await store.create('default',{name:'Interval',message:'Synthetic',configuration})
    const renamed=(await store.update(job.id,'default',{name:'Renamed',expectedRevision:1}))!
    expect(renamed).toMatchObject({revision:2,scheduleRevision:1,nextRunAt:job.nextRunAt})
    await expect(store.update(job.id,'default',{name:'Stale',expectedRevision:1})).rejects.toThrow('modified')
    expect((await store.getById(job.id,'default'))?.name).toBe('Renamed')
    await store.updateRuntime(job.id,100,200)
    expect(await store.getById(job.id,'default')).toMatchObject({revision:2,scheduleRevision:1,lastRunAt:100,nextRunAt:200})
    const changed=await store.update(job.id,'default',{configuration:{...configuration,schedule:{...configuration.schedule,everyMinutes:30}}})
    expect(changed).toMatchObject({revision:3,scheduleRevision:2})
    const paused=await store.update(job.id,'default',{enabled:false});expect(paused?.nextRunAt).toBeUndefined();expect(paused?.scheduleRevision).toBe(3)
  })
  it('keeps unrelated legacy edits and rejects v1 downgrades of v2 targets',async()=>{
    await up29(db)
    const old=await store.create('default',{...legacy,thinkingMode:false,timeoutSeconds:null})
    expect(await store.update(old.id,'default',{name:'Old renamed'})).toMatchObject({cronExpr:old.cronExpr,sessionId:old.sessionId,thinkingMode:false,timeoutSeconds:null,configuration:old.configuration,scheduleRevision:old.scheduleRevision})
    const modern=await store.create('default',{name:'Modern',message:'Synthetic',configuration})
    await expect(store.update(modern.id,'default',{cronExpr:'* * * * *'})).rejects.toThrow('version 2')
    expect((await store.getById(modern.id,'default'))?.configuration).toEqual(configuration)
  })
})
describe('Shared Cron service, HTTP and AI tool contract',()=>{
  it('offers truthful capabilities tied to the startup auth boundary and refuses unsupported dispatch',async()=>{
    await up29(db);expect(cronCapabilities()).toMatchObject({executionSupported:true,manualRun:false,authEnabledDispatch:false,overlapPolicy:'skip',missedRunPolicy:'skip'})
    vi.stubEnv('AUTH_ENABLED','true');configureRequestAuthentication();vi.stubEnv('AUTH_ENABLED','false')
    expect(cronCapabilities()).toMatchObject({executionSupported:false,reason:'authenticated_dispatch_not_supported'})
    await expect(service.create('default',{name:'Denied',message:'Synthetic',configuration})).rejects.toThrow('not supported')
    expect((await db.execute('SELECT * FROM cron_jobs')).rows).toHaveLength(0)
  })
  it('saves and reopens a paused plan under unsupported authentication without scheduling it',async()=>{
    await up29(db);vi.stubEnv('AUTH_ENABLED','true');configureRequestAuthentication()
    const created=await service.create('default',{name:'Paused draft',message:'Synthetic',configuration,enabled:false,thinkingMode:false,timeoutSeconds:0})
    expect(created).toMatchObject({enabled:false,revision:1,thinkingMode:false,timeoutSeconds:0})
    expect(created.nextRunAt).toBeUndefined();expect(await store.listEnabled()).toEqual([])
    db.close();await db.whenClosed();db=new LocalSqliteProcessClient({url:'file:'+path.join(fixture,'agent.db')})
    const edited=await service.update('default',created.id,{name:'Edited paused draft',configuration:{...configuration,schedule:{...configuration.schedule,everyMinutes:30}},expectedRevision:1})
    expect(edited).toMatchObject({name:'Edited paused draft',enabled:false,revision:2,thinkingMode:false,timeoutSeconds:0,configuration:{schedule:{everyMinutes:30}}})
    expect(edited?.nextRunAt).toBeUndefined();expect(await store.listEnabled()).toEqual([])
    expect(await service.update('another-tenant',created.id,{name:'Wrong owner'})).toBeNull()
    expect((await store.getById(created.id,'default'))?.name).toBe('Edited paused draft')
    expect((await db.execute('SELECT * FROM cron_runs')).rows).toHaveLength(0)
  })
  it('permits authenticated HTTP and AI paused saves but rejects activation and stale revisions',async()=>{
    await up29(db);vi.stubEnv('AUTH_ENABLED','true');configureRequestAuthentication()
    await app.close();app=Fastify()
    // Substitute only the trusted request actor; execute the actual route,
    // validation, native SQLite transaction and public response unchanged.
    app.addHook('onRequest',async (request:FastifyRequest)=>{Object.assign(request,{authContext:{tenantId:'default',method:'session'}})})
    await cronRoutes(app);await app.ready()
    const created=await app.inject({method:'POST',url:'/cron',payload:{name:'HTTP paused',message:'Synthetic',configuration,enabled:false}})
    expect(created.json().code).toBe(200)
    const job=created.json().data
    const edited=await app.inject({method:'PUT',url:'/cron/'+job.id,payload:{configuration:{...configuration,notificationPolicy:'silent'},expectedRevision:job.revision}})
    expect(edited.json()).toMatchObject({code:200,data:{enabled:false,revision:2,configuration:{notificationPolicy:'silent'}}})
    const stale=await app.inject({method:'PUT',url:'/cron/'+job.id,payload:{name:'Stale writer',expectedRevision:1}})
    expect(stale.json().code).toBe(40900)
    const denied=await app.inject({method:'POST',url:'/cron/'+job.id+'/enable'})
    expect(denied.json().code).toBe(40900)
    expect((await store.getById(job.id,'default'))?.revision).toBe(2)
    const ctx={tenantId:'default',sessionId:'current-session'} as AgentContext
    const tool=await cronTools.find(tool=>tool.name==='cron_create')!.execute({name:'AI paused',message:'Synthetic',configuration,enabled:false},ctx)
    expect(tool.success).toBe(true);expect(JSON.parse(String(tool.output)).job.enabled).toBe(false)
    expect(await store.listEnabled()).toEqual([])
    expect((await db.execute('SELECT * FROM cron_runs')).rows).toHaveLength(0)
  })
  it('accepts an atomic pause and schedule edit while refusing a live edit or activation',async()=>{
    await up29(db)
    const existing=await service.create('default',{name:'Previously enabled',message:'Synthetic',configuration})
    vi.stubEnv('AUTH_ENABLED','true');configureRequestAuthentication()
    const newConfiguration={...configuration,schedule:{...configuration.schedule,everyMinutes:45}}
    await expect(service.update('default',existing.id,{configuration:newConfiguration})).rejects.toThrow('not supported')
    expect(await store.getById(existing.id,'default')).toMatchObject({enabled:true,revision:1,configuration})
    const paused=await service.update('default',existing.id,{enabled:false,configuration:newConfiguration,expectedRevision:1})
    expect(paused).toMatchObject({enabled:false,revision:2,configuration:newConfiguration})
    expect(paused?.nextRunAt).toBeUndefined()
    await expect(service.update('default',existing.id,{enabled:true,expectedRevision:2})).rejects.toThrow('not supported')
    expect((await store.getById(existing.id,'default'))?.revision).toBe(2)
  })
  it('still validates paused targets and rejects unsupported fields before any stored mutation',async()=>{
    await up29(db);vi.stubEnv('AUTH_ENABLED','true');configureRequestAuthentication()
    vi.spyOn(workspaceManager,'getBoundDirectory').mockReturnValue(null)
    await expect(service.create('default',{name:'Missing project',message:'Synthetic',configuration:{...configuration,target:{kind:'workspace',sourceSessionId:'missing'}},enabled:false})).rejects.toThrow('workspace')
    await expect(service.create('default',{name:'Missing Agent',message:'Synthetic',configuration,agentId:'missing-agent',enabled:false})).rejects.toThrow('Agent')
    await expect(service.create('default',{name:'Untrusted',message:'Synthetic',configuration,enabled:false,tenantId:'different'})).rejects.toThrow('Unsupported cron field')
    expect((await db.execute('SELECT * FROM cron_jobs')).rows).toHaveLength(0)
  })
  it('rejects missing workspace bindings in both HTTP and AI tools with zero saved jobs',async()=>{
    await up29(db);vi.spyOn(workspaceManager,'getBoundDirectory').mockReturnValue(null)
    const payload={name:'Project',message:'Synthetic',configuration:{...configuration,target:{kind:'workspace',sourceSessionId:'source'}}}
    const http=await app.inject({method:'POST',url:'/cron',payload});expect(http.json().code).toBe(40001)
    const ctx={tenantId:'default',sessionId:'source'} as AgentContext
    const tool=await cronTools.find(tool=>tool.name==='cron_create')!.execute(payload,ctx)
    expect(tool.success).toBe(false);expect(tool.output).toContain('workspace')
    expect((await db.execute('SELECT * FROM cron_jobs')).rows).toHaveLength(0)
  })
  it('uses the same create/preview/update validation, exact IDs and typed receipt body',async()=>{
    await up29(db)
    const ctx={tenantId:'default',sessionId:'current-session'} as AgentContext
    const created=await cronTools.find(tool=>tool.name==='cron_create')!.execute({name:'Created by AI',message:'Synthetic',configuration},ctx)
    expect(created.success).toBe(true)
    const body=JSON.parse(String(created.output));expect(body.automationReceipt).toMatchObject({kind:'automation',schemaVersion:2,operation:'created',jobId:body.job.id})
    const current=await app.inject('/cron/'+body.job.id);expect(current.json().data.configuration).toEqual(configuration)
    const prefix=await cronTools.find(tool=>tool.name==='cron_update')!.execute({id:body.job.id.slice(0,8),name:'Wrong'},ctx)
    expect(prefix.success).toBe(false);expect((await store.getById(body.job.id,'default'))?.name).toBe('Created by AI')
    const pause=await cronTools.find(tool=>tool.name==='cron_update')!.execute({id:body.job.id,enabled:false},ctx)
    expect(JSON.parse(String(pause.output)).automationReceipt.operation).toBe('disabled')
    const preview=await app.inject({method:'POST',url:'/cron/preview',payload:{schedule:configuration.schedule,after:configuration.schedule.anchorAt,count:3}})
    expect(preview.json().data.occurrences).toEqual([1,2,3].map(index=>configuration.schedule.anchorAt+index*90*60000))
    expect((await db.execute('SELECT * FROM cron_runs')).rows).toHaveLength(0)
  })
  it('clears an optional new-session Agent but keeps a reuse binding fixed',async()=>{
    await up29(db)
    const agent=await new SQLiteAgentStore().create('default',{name:'Agent',skills:[],mcpServers:[],knowledgeBases:[],allowedTools:[]})
    const job=await service.create('default',{name:'Agent task',message:'Synthetic',configuration,agentId:agent.id})
    expect((await service.update('default',job.id,{agentId:null}))?.agentId).toBeUndefined()
    await new SessionStore().bindAgent('reuse','default',agent.id)
    const reuse=await service.create('default',{name:'Reuse',message:'Synthetic',configuration:{...configuration,target:{kind:'session',sessionId:'reuse'}},agentId:agent.id})
    await expect(service.update('default',reuse.id,{agentId:null})).rejects.toThrow('fixed Agent')
    expect((await store.getById(reuse.id,'default'))?.agentId).toBe(agent.id)
  })
  it('rejects a concurrent target edit between validation and save instead of enabling a different job revision',async()=>{
    await up29(db)
    const job=await store.create('default',{name:'Concurrent',message:'Synthetic',configuration,enabled:false})
    const original=store.getById.bind(store)
    let changed=false
    vi.spyOn(store,'getById').mockImplementation(async(id,tenant)=>{
      const current=await original(id,tenant)
      if(!changed&&id===job.id){changed=true;await store.update(job.id,'default',{name:'Edited by another owner'})}
      return current
    })
    await expect(service.update('default',job.id,{enabled:true})).rejects.toThrow('modified')
    expect(await original(job.id,'default')).toMatchObject({name:'Edited by another owner',enabled:false,revision:2})
  })
  it('rejects a caller guessed future revision after a concurrent paused-to-live transition',async()=>{
    await up29(db)
    const job=await store.create('default',{name:'Paused before race',message:'Synthetic',configuration,enabled:false})
    const original=store.getById.bind(store);let activated=false
    vi.spyOn(store,'getById').mockImplementation(async(id,tenant)=>{
      const row=await original(id,tenant)
      if(!activated && id===job.id){activated=true;await store.update(id,tenant,{enabled:true,expectedRevision:row!.revision})}
      return row
    })
    vi.stubEnv('AUTH_ENABLED','true');configureRequestAuthentication()
    const editedConfiguration={...configuration,schedule:{...configuration.schedule,everyMinutes:17}}
    await expect(service.update('default',job.id,{configuration:editedConfiguration,expectedRevision:2})).rejects.toThrow('modified')
    expect(await original(job.id,'default')).toMatchObject({revision:2,enabled:true,configuration})
    expect((await original(job.id,'default'))?.configuration.schedule).toEqual(configuration.schedule)
  })
  it.each([{timeoutSeconds:-1},{timeoutSeconds:'60'},{thinkingMode:'off'},{enabled:1},{runOnce:true},{configuration:{...configuration,overlapPolicy:'queue_latest'}}])('rejects unsupported or malformed input %j before missing-job lookup',async value=>{
    await up29(db)
    const response=await app.inject({method:'PUT',url:'/cron/missing',payload:value});expect(response.json().code).toBe(40001)
    expect((await db.execute('SELECT * FROM cron_jobs')).rows).toHaveLength(0)
  })
  it('serves durable run history, notifications and read state after job deletion',async()=>{
    await up29(db)
    const job=await service.create('default',{name:'Run',message:'Synthetic',configuration})
    const scheduledAt=Math.floor(Date.now()/60000)*60000
    await db.execute({sql:'UPDATE cron_jobs SET next_run_at=? WHERE id=?',args:[scheduledAt,job.id]})
    const runs=new CronRunStore(),run=(await runs.claimDue((await store.getById(job.id,'default'))!,scheduledAt,scheduledAt+60000,scheduledAt+1))!
    await runs.finishUnadmitted('default',run.id,'failed','Synthetic unavailable target');await service.delete('default',job.id)
    expect((await app.inject('/cron/'+job.id+'/runs')).json().data.items).toMatchObject([{id:run.id,status:'failed',jobDeleted:true}])
    const feed=(await app.inject('/cron/notifications?unreadOnly=true&limit=10')).json().data
    expect(feed.unreadCount).toBe(1);expect(feed.items).toHaveLength(1)
    const read=(await app.inject({method:'POST',url:'/cron/notifications/'+feed.items[0].id+'/read'})).json().data
    expect(read.readAt).toBeGreaterThan(0);expect((await app.inject('/cron/notifications?unreadOnly=true')).json().data.unreadCount).toBe(0)
    expect((await app.inject({method:'POST',url:'/cron/runs/'+run.id+'/cancel'})).json().data.status).toBe('failed')
  })
  it.each(['/cron/notifications?limit=0','/cron/notifications?limit=101','/cron/notifications?unreadOnly=1','/cron/missing/runs?cursor=bad'])('rejects invalid pagination %s',async url=>{
    await up29(db);expect((await app.inject(url)).json().code).toBe(40001)
  })
})

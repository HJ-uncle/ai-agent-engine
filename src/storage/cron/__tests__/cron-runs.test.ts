// SQLite claim, admission, ownership and persistent inbox invariants. No model or Electron process.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import {LocalSqliteProcessClient} from '../../sqlite/local-process-client.js'
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import * as database from '../../sqlite/db.js'
import {CronStore,type CronJob} from '../index.js'
import {CronRunStore,ensureCronRunSchema,validateAutomationAdmission,type CronAutomationRun} from '../runs.js'
import {RootRunStore,rootRunStore} from '../../root-runs/index.js'
import {dispatchCronRun,cancelCronRun,reconcileCronRuns,stopCronDeadlineTimers,cronDispatchHeaders} from '../../../scheduler/cron-dispatch.js'
import {configureRequestAuthentication} from '../../../api/http/middleware.js'

let db:LocalSqliteProcessClient;let fixture:string;let jobs:CronStore;let runs:CronRunStore;let roots:RootRunStore
let scheduledAt:number
beforeEach(async()=>{
  fixture=fs.mkdtempSync(path.join(os.tmpdir(),'aether-cron-v2-'))
  vi.stubEnv('DATA_DIR',path.join(fixture,'agent.db'));vi.stubEnv('AUTH_ENABLED','false')
  configureRequestAuthentication()
  db=new LocalSqliteProcessClient({url:`file:${path.join(fixture,'agent.db')}`});vi.spyOn(database,'getDb').mockImplementation(()=>db)
  await db.execute(`CREATE TABLE cron_jobs(id TEXT PRIMARY KEY,tenant_id TEXT,name TEXT,description TEXT,cron_expr TEXT,message TEXT,session_id TEXT,agent_id TEXT,thinking_mode TEXT,timeout_seconds INTEGER,enabled INTEGER,last_run_at INTEGER,next_run_at INTEGER,created_at INTEGER,updated_at INTEGER,configuration_json TEXT,revision INTEGER,schedule_revision INTEGER)`)
  await db.execute('CREATE TABLE sessions(session_id TEXT,tenant_id TEXT,agent_id TEXT,metadata TEXT,PRIMARY KEY(session_id,tenant_id))')
  await db.execute('CREATE TABLE agents(id TEXT PRIMARY KEY,tenant_id TEXT)')
  await ensureCronRunSchema(db);jobs=new CronStore();runs=new CronRunStore(db);roots=new RootRunStore();await roots.initialize()
  scheduledAt=Math.floor(Date.now()/60000)*60000
})
afterEach(async()=>{
  stopCronDeadlineTimers();db.close();await db.whenClosed();vi.restoreAllMocks();vi.unstubAllEnvs();configureRequestAuthentication()
  if(path.dirname(fixture)!==path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-cron-v2-'))throw new Error('Unsafe test cleanup')
  fs.rmSync(fixture,{recursive:true,force:true,maxRetries:3,retryDelay:50})
})
async function job(overrides:Partial<Parameters<CronStore['create']>[1]>={}):Promise<CronJob>{
  const created=await jobs.create('default',{name:'Synthetic automation',message:'Write a synthetic report',thinkingMode:false,timeoutSeconds:null,
    configuration:{version:2,schedule:{kind:'interval',everyMinutes:1,anchorAt:scheduledAt},target:{kind:'standalone'},notificationPolicy:'all_runs',toolProfile:'general'},...overrides})
  await db.execute({sql:'UPDATE cron_jobs SET next_run_at=? WHERE id=?',args:[scheduledAt,created.id]})
  return (await jobs.getById(created.id,'default'))!
}
async function claim(value:CronJob,at=scheduledAt):Promise<CronAutomationRun>{return (await runs.claimDue(value,at,at+60000,at+1))!}
function body(run:CronAutomationRun):Record<string,unknown>{return {message:run.snapshot.message,sessionId:run.sessionId,cronJobId:run.jobId,automationRunId:run.id,cronTimeoutSeconds:run.snapshot.timeoutSeconds,thinkingMode:run.snapshot.thinkingMode,toolProfile:run.snapshot.configuration.toolProfile,...(run.snapshot.agentId?{agentId:run.snapshot.agentId}:{})}}
async function admit(run:CronAutomationRun){const request=body(run);return roots.create(run.tenantId,run.sessionId,'stored-model',[],request,{runId:run.id,effectiveAgentId:'resolved-agent',effectiveAgentName:'Synthetic Agent',dispatchRequest:request})}

describe('Cron durable claim and root admission',()=>{
  it('claims one occurrence once despite competing ticks and a schedule revision replay',async()=>{
    const value=await job();const claimed=await Promise.all(Array.from({length:8},()=>runs.claimDue(value,scheduledAt,scheduledAt+60000,scheduledAt+1)))
    expect(claimed.filter(Boolean)).toHaveLength(1)
    await db.execute({sql:'UPDATE cron_jobs SET next_run_at=?,schedule_revision=schedule_revision+1 WHERE id=?',args:[scheduledAt,value.id]})
    expect(await runs.claimDue((await jobs.getById(value.id,'default'))!,scheduledAt,scheduledAt+60000,scheduledAt+1)).toBeNull()
    expect((await db.execute('SELECT * FROM cron_runs')).rows).toHaveLength(1)
  })
  it.each(['pause','delete'])('rejects %s committed before admission without creating a root',async operation=>{
    const value=await job();const run=await claim(value)
    if(operation==='pause')await jobs.update(value.id,'default',{enabled:false});else await jobs.delete(value.id,'default')
    await expect(admit(run)).rejects.toThrow('configuration changed')
    expect((await db.execute('SELECT * FROM root_runs')).rows).toHaveLength(0)
    expect((await runs.get('default',run.id))?.rootRunId).toBeUndefined()
  })
  it('keeps a root admitted before pause, projects the actual Agent/model, and rejects duplicate admission',async()=>{
    const value=await job();const run=await claim(value);const root=await admit(run)
    await jobs.update(value.id,'default',{enabled:false})
    expect(await runs.get('default',run.id)).toMatchObject({status:'running',rootRunId:root.runId,snapshot:{effectiveAgentId:'resolved-agent',effectiveAgentName:'Synthetic Agent',effectiveModelId:'stored-model'}})
    await expect(admit(run)).rejects.toThrow('already admitted')
    expect((await roots.list('default',run.sessionId))).toHaveLength(1)
  })
  it('skips a busy reuse session without changing the manual root or emitting notification',async()=>{
    const manual=await roots.create('default','reuse-session','m',[],{})
    const value=await job({configuration:{version:2,schedule:{kind:'interval',everyMinutes:1,anchorAt:scheduledAt},target:{kind:'session',sessionId:'reuse-session'},notificationPolicy:'all_runs',toolProfile:'code'}})
    expect(await claim(value)).toMatchObject({status:'skipped',reason:'overlap_skipped'})
    expect(await roots.get('default',manual.runId)).toMatchObject({status:'running',version:1})
    expect((await runs.listNotifications('default')).unreadCount).toBe(0)
  })
  it('skips missed occurrences and advances next without replaying the task',async()=>{
    const value=await job();const run=await runs.claimDue(value,scheduledAt,scheduledAt+120000,scheduledAt+60001)
    expect(run).toMatchObject({status:'skipped',reason:'missed_occurrence'})
    expect((await jobs.getById(value.id,'default'))?.nextRunAt).toBe(scheduledAt+120000)
    expect((await db.execute('SELECT * FROM root_runs')).rows).toHaveLength(0)
  })
  it('preserves off/null, waiting identity and deadline across an answer, with one inbox event per pending/terminal',async()=>{
    const value=await job({timeoutSeconds:60});const run=await claim(value);const root=await admit(run)
    const deadline=(await runs.get('default',run.id))!.deadlineAt
    const pending={requestId:'r1',kind:'ask' as const,toolCallId:'t1',toolName:'ask_user',args:{}}
    await roots.pending('default',root.runId,pending);await roots.pending('default',root.runId,pending)
    expect(await runs.get('default',run.id)).toMatchObject({status:'waiting',rootRunId:root.runId,deadlineAt:deadline,snapshot:{thinkingMode:false}})
    expect((await runs.listNotifications('default')).items.map(item=>item.eventKey)).toEqual(['pending:r1'])
    await roots.answer('default',run.sessionId,root.runId,'r1','t1','ask_user','continue')
    expect((await runs.get('default',run.id))!.deadlineAt).toBe(deadline)
    await roots.update('default',root.runId,{status:'succeeded'});await roots.update('default',root.runId,{status:'succeeded'})
    expect((await runs.listNotifications('default')).items.map(item=>item.eventKey).sort()).toEqual(['pending:r1','terminal'])
  })
  it('persists silent policy without inbox entries and isolates notification read/cursors by tenant',async()=>{
    const value=await job({configuration:{version:2,schedule:{kind:'interval',everyMinutes:1,anchorAt:scheduledAt},target:{kind:'standalone'},notificationPolicy:'silent',toolProfile:'general'}})
    const root=await admit(await claim(value));await roots.update('default',root.runId,{status:'succeeded'})
    expect((await runs.listNotifications('default')).items).toEqual([])
    const visible=await job();const second=await admit(await claim(visible));await roots.pending('default',second.runId,{requestId:'p',kind:'ask',toolCallId:'p',toolName:'ask_user',args:{}});await roots.update('default',second.runId,{status:'succeeded'})
    const first=await runs.listNotifications('default',{limit:1});expect(first.nextCursor).toBeTypeOf('string')
    await expect(runs.listNotifications('foreign',{cursor:first.nextCursor!})).rejects.toThrow('scope mismatch')
    expect(await runs.readNotification('foreign',first.items[0].id)).toBeNull()
    await runs.readNotification('default',first.items[0].id)
    expect((await runs.listNotifications('default')).unreadCount).toBe(1)
    expect((await runs.listNotifications('default',{cursor:first.nextCursor!,limit:1})).items).toHaveLength(1)
  })
  it('rejects forged tenant/session/body/resource overrides before root creation',async()=>{
    const run=await claim(await job());const request=body(run)
    await expect(validateAutomationAdmission(db,'foreign',run.sessionId,request,{runId:run.id})).rejects.toThrow('unavailable')
    await expect(validateAutomationAdmission(db,'default','wrong',request,{runId:run.id})).rejects.toThrow('does not match')
    for(const extra of [{message:'changed'},{thinkingMode:true},{mcpServers:[]},{memoryScope:'off'},{securityMode:'full-access'}])await expect(validateAutomationAdmission(db,'default',run.sessionId,{...request,...extra},{runId:run.id})).rejects.toThrow()
    expect((await db.execute('SELECT * FROM root_runs')).rows).toHaveLength(0)
  })
  it('makes standalone sessions distinct for successive occurrences and keeps true null legacy columns',async()=>{
    const value=await job();expect(value.cronExpr).toBeNull();expect(value.sessionId).toBeNull()
    const first=await claim(value);const root=await admit(first);await roots.update('default',root.runId,{status:'succeeded'})
    const second=await claim((await jobs.getById(value.id,'default'))!,scheduledAt+60000)
    expect(first.sessionId).not.toBe(second.sessionId);expect(second.snapshot.timeoutSeconds).toBeNull()
  })
  it('recovers running as interrupted on database reopen while preserving waiting and inbox read state',async()=>{
    const running=await claim(await job());const root=await admit(running)
    const waiting=await claim(await job());const waitingRoot=await admit(waiting)
    await roots.pending('default',waitingRoot.runId,{requestId:'keep',kind:'ask',toolCallId:'keep',toolName:'ask_user',args:{}})
    const notification=(await runs.listNotifications('default')).items[0];await runs.readNotification('default',notification.id)
    db.close();await db.whenClosed();db=new LocalSqliteProcessClient({url:`file:${path.join(fixture,'agent.db')}`});roots=new RootRunStore();runs=new CronRunStore(db);await roots.initialize()
    expect(await roots.get('default',root.runId)).toMatchObject({status:'interrupted'})
    expect(await runs.get('default',running.id)).toMatchObject({status:'interrupted',rootRunId:root.runId})
    expect(await runs.get('default',waiting.id)).toMatchObject({status:'waiting',rootRunId:waitingRoot.runId})
    expect((await runs.listNotifications('default')).items.find(item=>item.id===notification.id)?.readAt).toBeTypeOf('number')
  })
})

describe('Cron transport follows durable ownership',()=>{
  it('enforces a persistent one-second deadline after waiting SSE ends using real loopback HTTP',async()=>{
    const run=await claim(await job({timeoutSeconds:1}));const app=Fastify({forceCloseConnections:true});let rootId='';let cancelled:unknown
    let notifyCancelled!:()=>void;const cancelledSignal=new Promise<void>(resolve=>{notifyCancelled=resolve})
    app.post('/api/v1/chat',async(request,reply)=>{
      const raw={...request.body as Record<string,unknown>,toolProfile:'general'}
      rootId=(await rootRunStore.create('default',run.sessionId,'m',[],raw,{runId:run.id,dispatchRequest:raw})).runId
      await rootRunStore.pending('default',rootId,{requestId:'later',kind:'ask',toolCallId:'later',toolName:'ask_user',args:{}})
      return reply.type('text/event-stream').send('data: '+JSON.stringify({run:{runId:rootId,sessionId:run.sessionId,status:'waiting'}})+'\n\n')
    })
    app.post('/api/v1/chat/cancel',async(request)=>{
      cancelled=request.body;await rootRunStore.update('default',rootId,{status:'cancelled'});notifyCancelled();return {code:200}
    })
    const url=await app.listen({host:'127.0.0.1',port:0});let timer:ReturnType<typeof setTimeout>|undefined
    try{
      expect(await dispatchCronRun(run,{baseUrl:url})).toMatchObject({status:'waiting',rootRunId:rootId})
      await Promise.race([cancelledSignal,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Deadline did not cancel waiting root')),3500)})])
      expect(cancelled).toEqual({sessionId:run.sessionId,runId:rootId})
      expect(await runs.get('default',run.id)).toMatchObject({status:'cancelled',rootRunId:rootId})
    }finally{clearTimeout(timer);stopCronDeadlineTimers();await app.close()}
  },7000)
  it('accepts waiting SSE without cancellation and follows the same root after answer',async()=>{
    const run=await claim(await job());let rootId='';const calls:string[]=[]
    vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
      calls.push(String(url));const request={...JSON.parse(String(init?.body)),toolProfile:'general'} as Record<string,unknown>
      const root=await rootRunStore.create('default',run.sessionId,'m',[],request,{runId:run.id,dispatchRequest:request});rootId=root.runId
      await rootRunStore.pending('default',rootId,{requestId:'ask',kind:'ask',toolCallId:'ask',toolName:'ask_user',args:{}})
      return new Response('data: '+JSON.stringify({run:{runId:rootId,sessionId:run.sessionId,status:'waiting'}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
    })
    expect(await dispatchCronRun(run)).toMatchObject({status:'waiting',rootRunId:rootId})
    expect(calls).toHaveLength(1)
    await rootRunStore.answer('default',run.sessionId,rootId,'ask','ask','ask_user','yes');await rootRunStore.update('default',rootId,{status:'succeeded'})
    expect(await runs.get('default',run.id)).toMatchObject({status:'succeeded',rootRunId:rootId})
  })
  it('recovers identity when admission succeeded but the first stream frame was lost',async()=>{
    const run=await claim(await job());let rootId=''
    const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      const request={...JSON.parse(String(init?.body)),toolProfile:'general'} as Record<string,unknown>
      rootId=(await rootRunStore.create('default',run.sessionId,'m',[],request,{runId:run.id,dispatchRequest:request})).runId
      throw new Error('connection lost before first frame')
    })
    expect(await dispatchCronRun(run)).toMatchObject({status:'running',rootRunId:rootId});expect(send).toHaveBeenCalledTimes(1)
    expect((await roots.list('default',run.sessionId))).toHaveLength(1)
    await expect(admit(run)).rejects.toThrow('already admitted')
  })
  it('fails a closed successful-looking stream with no persisted admission instead of keeping a permanent claim',async()=>{
    const run=await claim(await job())
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('data: '+JSON.stringify({run:{runId:'unpersisted',sessionId:run.sessionId,status:'succeeded'}})+'\n\n',{headers:{'content-type':'text/event-stream'}}))
    expect(await dispatchCronRun(run)).toMatchObject({status:'failed',reason:'Automation chat ended without a persisted root identity'})
    expect(await runs.active()).toEqual([])
    expect((await roots.list('default',run.sessionId))).toEqual([])
  })
  it('rejects a removed or foreign Agent before dispatch instead of falling back to an unconfigured assistant',async()=>{
    const send=vi.spyOn(globalThis,'fetch')
    const removed=await claim(await job({agentId:'removed-agent'}))
    expect(await dispatchCronRun(removed)).toMatchObject({status:'failed',reason:'Automation Agent is no longer available in this tenant'})
    await db.execute("INSERT INTO agents(id,tenant_id) VALUES('foreign-agent','foreign')")
    const foreign=await claim(await job({agentId:'foreign-agent'}))
    expect(await dispatchCronRun(foreign)).toMatchObject({status:'failed',reason:'Automation Agent is no longer available in this tenant'})
    expect(send).not.toHaveBeenCalled();expect((await db.execute('SELECT * FROM root_runs')).rows).toHaveLength(0)
  })
  it('allows owned stop after job deletion and never stops a later manual root',async()=>{
    const value=await job();const run=await claim(value);const root=await admit(run);await jobs.delete(value.id,'default')
    const cancel=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
      expect(String(url)).toContain('/chat/cancel');expect(JSON.parse(String(init?.body))).toEqual({sessionId:run.sessionId,runId:root.runId})
      await rootRunStore.update('default',root.runId,{status:'cancelled'});return new Response(JSON.stringify({code:200}))
    })
    expect(await cancelCronRun('foreign',run.id)).toBeNull();expect(cancel).not.toHaveBeenCalled()
    expect(await cancelCronRun('default',run.id)).toMatchObject({status:'cancelled',jobDeleted:true})
    const manual=await roots.create('default',run.sessionId,'m',[],{})
    await cancelCronRun('default',run.id);expect(cancel).toHaveBeenCalledTimes(1)
    expect(await roots.get('default',manual.runId)).toMatchObject({status:'running'})
  })
  it('retains unclaimed interrupted records on startup without sending or replaying them',async()=>{
    const run=await claim(await job());const send=vi.spyOn(globalThis,'fetch')
    await reconcileCronRuns({interruptClaims:true})
    expect(await runs.get('default',run.id)).toMatchObject({status:'interrupted'})
    expect(send).not.toHaveBeenCalled()
  })
  it('fails a missing workspace source explicitly instead of falling back to scratch',async()=>{
    const value=await job({configuration:{version:2,schedule:{kind:'interval',everyMinutes:1,anchorAt:scheduledAt},target:{kind:'workspace',sourceSessionId:'unbound'},notificationPolicy:'all_runs',toolProfile:'code'}})
    const send=vi.spyOn(globalThis,'fetch');const run=await claim(value)
    expect(await dispatchCronRun(run)).toMatchObject({status:'failed',reason:'Automation source session has no selected workspace'})
    expect(send).not.toHaveBeenCalled()
  })
  it('requires loopback local dispatch, preserving instance token and profile/protocol/lifetime headers',async()=>{
    const run=await claim(await job());vi.stubEnv('AETHER_INSTANCE_TOKEN','synthetic-token')
    const headers=cronDispatchHeaders('http://127.0.0.1:12345',run)
    expect(new Headers(headers).get('X-Aether-Instance-Token')).toBe('synthetic-token')
    expect(headers).toMatchObject({'X-Aether-Tool-Profile':'general','X-Aether-Run-Lifetime':'durable','X-Aether-Subagent-Protocol':'2'})
    expect(()=>cronDispatchHeaders('https://example.invalid',run)).toThrow('loopback')
    vi.stubEnv('AUTH_ENABLED','true');configureRequestAuthentication();expect(()=>cronDispatchHeaders('http://127.0.0.1',run)).toThrow('Authenticated')
    vi.stubEnv('AUTH_ENABLED','false');expect(()=>cronDispatchHeaders('http://127.0.0.1',run)).toThrow('Authenticated')
  })
})

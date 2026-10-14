import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {LocalSqliteProcessClient} from '../../storage/sqlite/local-process-client.js'
import {beforeEach,afterEach,vi} from 'vitest'
import * as database from '../../storage/sqlite/db.js'
import {CronStore,type CreateCronJobInput} from '../../storage/cron/index.js'
import {CronRunStore,ensureCronRunSchema,type CronAutomationRun} from '../../storage/cron/runs.js'
import {RootRunStore,rootRunStore} from '../../storage/root-runs/index.js'
import {stopCronDeadlineTimers} from '../cron-dispatch.js'
import {configureRequestAuthentication} from '../../api/http/middleware.js'

export function cronFixture(){
  let db:LocalSqliteProcessClient;let fixture:string;let roots:RootRunStore;let runs:CronRunStore;let jobs:CronStore
  beforeEach(async()=>{
    fixture=fs.mkdtempSync(path.join(os.tmpdir(),'aether-cron-transport-'))
    vi.stubEnv('DATA_DIR',path.join(fixture,'agent.db'));vi.stubEnv('AUTH_ENABLED','false')
    configureRequestAuthentication()
    db=new LocalSqliteProcessClient({url:`file:${path.join(fixture,'agent.db')}`});vi.spyOn(database,'getDb').mockImplementation(()=>db)
    await db.execute(`CREATE TABLE cron_jobs(id TEXT PRIMARY KEY,tenant_id TEXT,name TEXT,description TEXT,cron_expr TEXT,message TEXT,session_id TEXT,agent_id TEXT,thinking_mode TEXT,timeout_seconds INTEGER,enabled INTEGER,last_run_at INTEGER,next_run_at INTEGER,created_at INTEGER,updated_at INTEGER,configuration_json TEXT,revision INTEGER,schedule_revision INTEGER)`)
    await db.execute('CREATE TABLE sessions(session_id TEXT,tenant_id TEXT,agent_id TEXT,metadata TEXT,PRIMARY KEY(session_id,tenant_id))')
    await db.execute('CREATE TABLE agents(id TEXT PRIMARY KEY,tenant_id TEXT)')
    await ensureCronRunSchema(db);roots=new RootRunStore();await roots.initialize();runs=new CronRunStore(db);jobs=new CronStore()
  })
  afterEach(async()=>{
    stopCronDeadlineTimers();db.close();await db.whenClosed();vi.restoreAllMocks();vi.unstubAllEnvs();configureRequestAuthentication()
    if(path.dirname(fixture)!==path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-cron-transport-'))throw new Error('Unsafe fixture cleanup')
    fs.rmSync(fixture,{recursive:true,force:true,maxRetries:3,retryDelay:50})
  })
  return {
    get db(){return db},get roots(){return roots},get runs(){return runs},get jobs(){return jobs},
    async claim(overrides:Partial<CreateCronJobInput>={}):Promise<CronAutomationRun>{
      const now=Math.floor(Date.now()/60000)*60000
      const value=await jobs.create('default',{name:'Transport fixture',message:'Develop synthetic project',thinkingMode:false,
        configuration:{version:2,schedule:{kind:'interval',everyMinutes:1,anchorAt:now},target:{kind:'standalone'},notificationPolicy:'silent',toolProfile:'general'},...overrides})
      await db.execute({sql:'UPDATE cron_jobs SET next_run_at=? WHERE id=?',args:[now,value.id]})
      return (await runs.claimDue((await jobs.getById(value.id,'default'))!,now,now+60000,now+1))!
    },
    async admit(run:CronAutomationRun,request:Record<string,unknown>){
      const raw={...request,toolProfile:run.snapshot.configuration.toolProfile}
      return rootRunStore.create('default',run.sessionId,'fixture-model',[],raw,{runId:run.id,dispatchRequest:raw})
    }
  }
}

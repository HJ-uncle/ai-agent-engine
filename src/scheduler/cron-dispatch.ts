import { CronRunStore, ensureCronRunSchema, validateAutomationAdmission, type CronAutomationRun } from '../storage/cron/runs.js'
import { getDb } from '../storage/sqlite/db.js'
import { rootRunStore } from '../storage/root-runs/index.js'
import { SessionStore } from '../storage/session/index.js'
import { workspaceManager } from '../workspace/manager.js'
import { INSTANCE_TOKEN_HEADER } from '../auth/instance-token.js'
import { readEngineListenAddress } from '../server-listen.js'
import { consumeCronStream } from './cron-stream.js'
import { isRequestAuthenticationRequired } from '../api/http/middleware.js'
import { stopOwnedRoot } from '../api/http/routes/chat.js'

const runs = new CronRunStore()
const deadlines=new Map<string,{deadlineAt:number;timer:ReturnType<typeof setTimeout>}>()
let deadlineGeneration=0
function clearDeadline(id:string):void {const entry=deadlines.get(id);if(entry)clearTimeout(entry.timer);deadlines.delete(id)}
export function stopCronDeadlineTimers():void {deadlineGeneration++;for(const id of deadlines.keys())clearDeadline(id)}
function armDeadline(run:CronAutomationRun,baseUrl:string):void {
  if(run.deadlineAt==null || !['running','waiting'].includes(run.status)){clearDeadline(run.id);return}
  if(deadlines.get(run.id)?.deadlineAt===run.deadlineAt)return
  clearDeadline(run.id)
  const deadlineAt=run.deadlineAt
  const generation=deadlineGeneration
  const arm=(retryDelay=0)=>{
    const timer=setTimeout(async()=>{
      deadlines.delete(run.id)
      if(generation!==deadlineGeneration)return
      if(Date.now()<deadlineAt){arm();return}
      try{const current=await cancelCronRun(run.tenantId,run.id,baseUrl);if(generation===deadlineGeneration && current && ['running','waiting'].includes(current.status))arm(1000)}
      catch(error){if(generation!==deadlineGeneration)return;console.error('[CronScheduler] deadline cancellation failed:',error);const retry=setTimeout(()=>arm(),1000);retry.unref?.();deadlines.set(run.id,{deadlineAt,timer:retry})}
    },Math.max(retryDelay,Math.max(0,Math.min(deadlineAt-Date.now(),2_147_483_647))))
    timer.unref?.();deadlines.set(run.id,{deadlineAt,timer})
  }
  arm()
}
export const cronBaseUrl = () => `http://127.0.0.1:${readEngineListenAddress().port}`
export function cronDispatchHeaders(baseUrl:string,run:CronAutomationRun):Record<string,string> {
  const target=new URL(baseUrl)
  if (!['http:','https:'].includes(target.protocol) || !['127.0.0.1','[::1]','localhost'].includes(target.hostname) || target.username || target.password) throw new Error('Internal cron dispatch requires a loopback target')
  if (isRequestAuthenticationRequired()) throw new Error('Authenticated automation dispatch is not supported')
  if (run.tenantId !== 'default') throw new Error('Local automation dispatch cannot impersonate another tenant')
  const headers:Record<string,string>={'Content-Type':'application/json','X-Request-ID':`cron-${run.id}`,'X-Aether-Tool-Profile':run.snapshot.configuration.toolProfile,'X-Aether-Run-Lifetime':'durable','X-Aether-Subagent-Protocol':'2'}
  if (process.env.AETHER_INSTANCE_TOKEN) headers[INSTANCE_TOKEN_HEADER]=process.env.AETHER_INSTANCE_TOKEN
  return headers
}

/** No inline resources or credentials: Agent resolution stays in the existing chat route. */
export async function cronDispatchBody(run:CronAutomationRun):Promise<Record<string,unknown>> {
  const target=run.snapshot.configuration.target
  const body:Record<string,unknown>={message:run.snapshot.message,sessionId:run.sessionId,cronJobId:run.jobId,automationRunId:run.id}
  const binding=target.kind === 'session' ? await new SessionStore().getBinding(run.sessionId,run.tenantId) : undefined
  const agentId=binding ? binding.agentId : run.snapshot.agentId
  if (agentId) body.agentId=agentId
  if (run.snapshot.thinkingMode != null) body.thinkingMode=run.snapshot.thinkingMode
  if (run.snapshot.timeoutSeconds !== undefined) body.cronTimeoutSeconds=run.snapshot.timeoutSeconds
  return body
}

export async function reconcileCronRun(run:CronAutomationRun):Promise<CronAutomationRun|null> {
  const current=await runs.get(run.tenantId,run.id)
  if (!current || !current.rootRunId) return current
  const root=await rootRunStore.get(current.tenantId,current.rootRunId)
  if (!root || root.sessionId !== current.sessionId) return runs.interruptMissingRoot(current.tenantId,current.id)
  return runs.project(current.tenantId,rootRunStore.public(root))
}

/** Stopping an old automation must never stop a later manual turn in its session. */
export async function cancelCronRun(tenantId:string,id:string,baseUrl=cronBaseUrl()):Promise<CronAutomationRun|null> {
  let run=await runs.get(tenantId,id)
  if (!run || !['claimed','running','waiting'].includes(run.status)) return run
  if (!run.rootRunId) {
    run=await runs.finishUnadmitted(tenantId,id,'cancelled','Cancelled before admission')
    if (!run?.rootRunId || !['running','waiting'].includes(run.status)) return run
  }
  run=await reconcileCronRun(run)
  if (!run || !['running','waiting'].includes(run.status) || !run.rootRunId) return run
  const headers=cronDispatchHeaders(baseUrl,run)
  const response=await fetch(baseUrl+'/api/v1/chat/cancel',{method:'POST',headers,redirect:'error',body:JSON.stringify({sessionId:run.sessionId,runId:run.rootRunId}),signal:AbortSignal.timeout(10000)})
  if (!response.ok) throw new Error('Automation cancellation failed: '+response.status)
  const envelope=await response.json() as {code?:number}
  if (envelope.code !== 200) throw new Error('Automation cancellation was rejected')
  const result=await reconcileCronRun(run)
  if(result && !['running','waiting'].includes(result.status))clearDeadline(result.id)
  return result
}

/** Server shutdown owns the durable root directly, while HTTP is already closing. */
export async function stopCronOwnedRun(tenantId: string, id: string): Promise<CronAutomationRun | null> {
  let run = await runs.get(tenantId, id)
  if (!run || !['claimed','running','waiting'].includes(run.status)) return run
  if (!run.rootRunId) run = await runs.finishUnadmitted(tenantId, id, 'cancelled', 'Scheduler stopped before admission')
  if (!run?.rootRunId || !['running','waiting'].includes(run.status)) return run
  await stopOwnedRoot(tenantId, run.sessionId, run.rootRunId, 'Cron scheduler stopped')
  const current = await reconcileCronRun(run)
  if (!current || ['claimed','running','waiting'].includes(current.status)) throw new Error('CRON_OWNED_STOP_NOT_JOINED')
  clearDeadline(id)
  return current
}

export async function reconcileCronRuns(options:{baseUrl?:string;interruptClaims?:boolean;excludeClaims?:ReadonlySet<string>}={}):Promise<void> {
  const generation=deadlineGeneration
  await rootRunStore.initialize()
  const active=await runs.active();const activeIds=new Set(active.map(run=>run.id))
  for(const id of deadlines.keys())if(!activeIds.has(id))clearDeadline(id)
  for (const run of active) {
    if (!run.rootRunId) {
      if (options.interruptClaims && !options.excludeClaims?.has(run.id)) await runs.finishUnadmitted(run.tenantId,run.id,'interrupted','Engine restarted before admission; occurrence was not replayed')
      continue
    }
    const current=await reconcileCronRun(run)
    if (current && generation===deadlineGeneration) armDeadline(current,options.baseUrl ?? cronBaseUrl())
  }
}

/** Detaching the HTTP reader does not cancel a durable root. The database owns the outcome. */
export async function dispatchCronRun(run:CronAutomationRun,options:{baseUrl?:string;signal?:AbortSignal}={}):Promise<CronAutomationRun|null> {
  const baseUrl=options.baseUrl ?? cronBaseUrl()
  const generation=deadlineGeneration
  try {
    const headers=cronDispatchHeaders(baseUrl,run)
    const body=await cronDispatchBody(run)
    await ensureCronRunSchema(getDb())
    await validateAutomationAdmission(getDb(),run.tenantId,run.sessionId,{...body,toolProfile:run.snapshot.configuration.toolProfile},{runId:run.id})
    if (options.signal?.aborted) throw options.signal.reason
    if (run.snapshot.configuration.target.kind === 'workspace') {
      const source=workspaceManager.getBoundDirectory({tenantId:run.tenantId,sessionId:run.snapshot.configuration.target.sourceSessionId})
      if (!source) throw new Error('Automation source session has no selected workspace')
      workspaceManager.bind({tenantId:run.tenantId,sessionId:run.sessionId},source)
    }
    const response=await fetch(baseUrl+'/api/v1/chat',{method:'POST',headers,redirect:'error',body:JSON.stringify(body),signal:options.signal})
    if (!response.ok) throw new Error('Automation chat request failed: '+response.status)
    const admitted=await runs.get(run.tenantId,run.id)
    if(admitted && generation===deadlineGeneration && !options.signal?.aborted)armDeadline(admitted,baseUrl)
    await consumeCronStream(response,run.sessionId,()=>{})
  } catch (error) {
    const current=await runs.get(run.tenantId,run.id)
    if (current && !current.rootRunId) return runs.finishUnadmitted(run.tenantId,run.id,options.signal?.aborted ? 'interrupted' : 'failed',error instanceof Error ? error.message : String(error))
    // The first frame can be lost after root admission; never POST the task again.
    if (!current) throw error
  }
  const current=await reconcileCronRun(run)
  if(current && current.status==='claimed' && !current.rootRunId)return runs.finishUnadmitted(current.tenantId,current.id,'failed','Automation chat ended without a persisted root identity')
  if(current && generation===deadlineGeneration && !options.signal?.aborted)armDeadline(current,baseUrl)
  if (current && ['running','waiting'].includes(current.status) && current.deadlineAt != null && current.deadlineAt <= Date.now()) return cancelCronRun(current.tenantId,current.id,baseUrl)
  return current
}

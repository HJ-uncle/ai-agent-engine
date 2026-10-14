import { CronStore } from '../storage/cron/index.js'
import { CronRunStore, type CronAutomationRun } from '../storage/cron/runs.js'
import { nextOccurrence } from './cron-schedule.js'
import { cronBaseUrl, dispatchCronRun, reconcileCronRuns, stopCronDeadlineTimers, stopCronOwnedRun } from './cron-dispatch.js'
import { isRequestAuthenticationRequired } from '../api/http/middleware.js'

export class CronScheduler {
  private timer:ReturnType<typeof setInterval>|null=null
  private initialTimer:ReturnType<typeof setTimeout>|null=null
  private store: Pick<CronStore, 'listEnabled'>
  private runs: Pick<CronRunStore, 'get' | 'claimDue' | 'finishUnadmitted'>
  private baseUrl:string
  private running=false
  private generation=0
  private activeJobs=new Map<string,{tenantId:string;controller:AbortController;completion:Promise<void>}>()
  private initialized=false
  private tick:Promise<void>|null=null
  private stopPromise: Promise<void> | null = null
  private stopping=false
  private failures:unknown[]=[]
  constructor(baseUrl?:string, private readonly dependencies: {
    store?: Pick<CronStore, 'listEnabled'>; runs?: Pick<CronRunStore, 'get' | 'claimDue' | 'finishUnadmitted'>;
    reconcile?: typeof reconcileCronRuns; dispatch?: typeof dispatchCronRun; stopOwned?: typeof stopCronOwnedRun
  } = {}) {
    this.baseUrl=baseUrl ?? cronBaseUrl(); this.store=dependencies.store ?? new CronStore(); this.runs=dependencies.runs ?? new CronRunStore()
  }
  start() {
    if (this.running) return
    if (this.stopPromise) throw new Error('Cron scheduler cannot restart before owned shutdown finishes')
    if (this.failures.length) throw new Error('Cron scheduler prior cleanup is unknown')
    this.stopping=false
    this.running=true
    const tick=()=>{if(this.running) this.checkAndRun().catch(error=>console.error('[CronScheduler] tick error:',error))}
    this.initialTimer=setTimeout(()=>{this.initialTimer=null;if(!this.running)return;tick();this.timer=setInterval(tick,60000)},60000-Date.now()%60000)
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping=true;this.running=false;this.generation++
    stopCronDeadlineTimers()
    if(this.initialTimer){clearTimeout(this.initialTimer);this.initialTimer=null}
    if(this.timer){clearInterval(this.timer);this.timer=null}
    if (!this.tick && this.activeJobs.size === 0 && this.failures.length===0) return Promise.resolve()
    const stopped = (async () => {
      const failures: unknown[] = [...this.failures]
      // A claim may be in progress. Its post-await generation fence must run
      // before we capture readers; otherwise a late dispatch escapes shutdown.
      try { await this.tick } catch (error) { failures.push(error) }
      const active = [...this.activeJobs.entries()]
      const results = await Promise.allSettled(active.map(async ([id, job]) => {
        let stopError: unknown
        try { await (this.dependencies.stopOwned ?? stopCronOwnedRun)(job.tenantId, id) }
        catch (error) { stopError = error }
        // Reader abort happens after durable-root cancel/join was attempted;
        // it is never the evidence that the durable task stopped.
        job.controller.abort(new Error('Cron scheduler stopped'))
        try { await job.completion } catch (error) { if (!stopError) stopError = error }
        if (stopError) throw stopError
      }))
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length) throw new AggregateError(failures, 'CRON_STOP_CLEANUP_UNKNOWN')
    })()
    this.stopPromise=stopped
    // An unknown join is sticky. A new timer generation cannot hide the old
    // owner/reader failure by overwriting its only shutdown promise.
    void stopped.then(()=>{if(this.stopPromise===stopped)this.stopPromise=null},()=>undefined)
    return stopped
  }
  async checkAndRun():Promise<void> {
    if(this.stopping)return this.stopPromise ?? Promise.resolve()
    if(this.tick)return this.tick
    const generation=this.generation
    const pending=this.check(generation).catch(error=>{this.failures.push(error);throw error}).finally(()=>{if(this.tick===pending)this.tick=null})
    this.tick=pending;return pending
  }
  private async check(generation:number) {
    await (this.dependencies.reconcile ?? reconcileCronRuns)({baseUrl:this.baseUrl,interruptClaims:!this.initialized,excludeClaims:new Set(this.activeJobs.keys())})
    this.initialized=true
    // A missing SSE end frame must not retain one reader per completed turn forever.
    for(const [id,active] of this.activeJobs) {
      const run=await this.runs.get(active.tenantId,id)
      if(!run || !['claimed','running'].includes(run.status))active.controller.abort(new Error('Cron viewer detached after persisted state changed'))
    }
    if(generation!==this.generation || isRequestAuthenticationRequired())return
    const now=Date.now()
    for(const job of await this.store.listEnabled()) {
      if(generation!==this.generation)return
      if(job.nextRunAt==null || job.nextRunAt>now)continue
      const run=await this.runs.claimDue(job,job.nextRunAt,nextOccurrence(job.configuration.schedule,now),now)
      if (generation !== this.generation) {
        if (run?.status === 'claimed') await this.runs.finishUnadmitted(run.tenantId, run.id, 'cancelled', 'Scheduler stopped during claim; occurrence was not dispatched')
        return
      }
      if(run?.status==='claimed') this.fireJob(run).catch(error=>console.error('[CronScheduler] dispatch failed:',error))
    }
  }
  private fireJob(run:CronAutomationRun):Promise<void> {
    const prior=this.activeJobs.get(run.id)
    if(prior)return prior.completion
    const controller=new AbortController()
    const completion=Promise.resolve().then(async () => {
      await (this.dependencies.dispatch ?? dispatchCronRun)(run,{baseUrl:this.baseUrl,signal:controller.signal})
      if(this.activeJobs.get(run.id)?.controller===controller)this.activeJobs.delete(run.id)
    })
    this.activeJobs.set(run.id,{tenantId:run.tenantId,controller,completion})
    return completion
  }
}
export const cronScheduler=new CronScheduler()

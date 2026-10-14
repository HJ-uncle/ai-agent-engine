/** Exact Cron claim/root/reader joins with controlled barriers and real SQLite state. No HTTP provider/model calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../cron-scheduler.js'
import { cronDispatchBody, stopCronOwnedRun } from '../cron-dispatch.js'
import { cronFixture } from './cron-v2-fixture.js'
import type { CronAutomationRun } from '../../storage/cron/runs.js'

const f = cronFixture()
const barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
const schedulers: CronScheduler[] = []
afterEach(async () => { for (const scheduler of schedulers.splice(0)) await scheduler.stop().catch(() => undefined) })
async function due() {
  const now = Math.floor(Date.now()/60000)*60000
  const job = await f.jobs.create('default', { name:'Synthetic owned Cron', message:'Synthetic task', thinkingMode:false,
    configuration:{version:2,schedule:{kind:'interval',everyMinutes:1,anchorAt:now},target:{kind:'standalone'},notificationPolicy:'silent',toolProfile:'general'} })
  await f.db.execute({sql:'UPDATE cron_jobs SET next_run_at=? WHERE id=?',args:[now,job.id]})
  return (await f.jobs.getById(job.id,'default'))!
}
function scheduler(dependencies: NonNullable<ConstructorParameters<typeof CronScheduler>[1]>) {
  const value = new CronScheduler('http://127.0.0.1:1', dependencies); schedulers.push(value); return value
}
describe('owned Cron shutdown', () => {
  it('closes the generation during a held committed claim ACK and never dispatches that occurrence', async () => {
    const job = await due(), entered = barrier(), ack = barrier(), dispatch = vi.fn()
    let claim: CronAutomationRun | null = null
    const value = scheduler({store:{listEnabled:async()=>[job]}, runs:{get:f.runs.get.bind(f.runs),finishUnadmitted:f.runs.finishUnadmitted.bind(f.runs),
      claimDue:async(...args)=>{claim=await f.runs.claimDue(...args);entered.release();await ack.promise;return claim}},reconcile:async()=>{},dispatch})
    const tick = value.checkAndRun(); await entered.promise
    expect(claim).toMatchObject({status:'claimed'})
    let stopped = false; const stopping = value.stop().then(()=>{stopped=true})
    expect(stopped).toBe(false); ack.release(); await Promise.all([tick,stopping])
    expect(dispatch).not.toHaveBeenCalled()
    expect((await f.runs.get('default',claim!.id))?.status).toBe('cancelled')
    await value.checkAndRun(); expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps the reader alive until the exact durable root stop joins, then joins reader completion', async () => {
    const job=await due(), dispatched=barrier(), rootJoin=barrier(), readerJoin=barrier(), rootEntered=barrier()
    let signal!:AbortSignal, run!:CronAutomationRun
    const value=scheduler({store:{listEnabled:async()=>[job]},runs:f.runs,reconcile:async()=>{},
      dispatch:async(current,options)=>{run=current;signal=options!.signal!;dispatched.release();await readerJoin.promise;return null},
      stopOwned:async(tenant,id)=>{expect(tenant).toBe('default');expect(id).toBe(run.id);rootEntered.release();await rootJoin.promise;return null}})
    await value.checkAndRun();await dispatched.promise
    let stopped=false;const stopping=value.stop().then(()=>{stopped=true})
    await rootEntered.promise;expect(signal.aborted).toBe(false);expect(stopped).toBe(false)
    rootJoin.release();await vi.waitFor(()=>expect(signal.aborted).toBe(true));expect(stopped).toBe(false)
    readerJoin.release();await stopping;expect(stopped).toBe(true)
  })

  it('preserves cleanup_unknown when one durable stop fails and still joins all other readers', async () => {
    const a=await due(),b=await due(),signals=new Map<string,AbortSignal>(),entered=barrier(),readers=barrier()
    const value=scheduler({store:{listEnabled:async()=>[a,b]},runs:f.runs,reconcile:async()=>{},
      dispatch:async(run,options)=>{signals.set(run.id,options!.signal!);if(signals.size===2)entered.release();await readers.promise;return null},
      stopOwned:async(_tenant,id)=>{if(id===[...signals.keys()][0])throw new Error('Synthetic exact-root join unknown');return null}})
    await value.checkAndRun();await entered.promise
    let settled=false;const stopping=value.stop().finally(()=>{settled=true});void stopping.catch(()=>undefined)
    await vi.waitFor(()=>expect([...signals.values()].every(signal=>signal.aborted)).toBe(true));expect(settled).toBe(false)
    readers.release();await expect(stopping).rejects.toThrow('CRON_STOP_CLEANUP_UNKNOWN')
    await expect(value.stop()).rejects.toThrow('CRON_STOP_CLEANUP_UNKNOWN')
    expect(()=>value.start()).toThrow('cannot restart')
  })

  it('retains a rejected dispatch for exact shutdown instead of dropping its owner entry', async () => {
    vi.spyOn(console,'error').mockImplementation(()=>undefined)
    const job=await due(),dispatchEntered=barrier(),stopOwned=vi.fn(async()=>null)
    const value=scheduler({store:{listEnabled:async()=>[job]},runs:f.runs,reconcile:async()=>{},
      dispatch:async()=>{dispatchEntered.release();throw new Error('Synthetic reader failed before join')},stopOwned})
    await value.checkAndRun();await dispatchEntered.promise
    await expect(value.stop()).rejects.toThrow('CRON_STOP_CLEANUP_UNKNOWN')
    expect(stopOwned).toHaveBeenCalledOnce();expect(()=>value.start()).toThrow('cannot restart')
  })

  it('retains a rejected tick in the shutdown result and cannot silently restart', async () => {
    const value=scheduler({reconcile:async()=>{throw new Error('Synthetic claim source failed')}})
    await expect(value.checkAndRun()).rejects.toThrow('claim source failed')
    await expect(value.stop()).rejects.toThrow('CRON_STOP_CLEANUP_UNKNOWN')
    expect(()=>value.start()).toThrow('cannot restart')
  })

  it('stopping an old terminal automation cannot cancel the later manual root in its reused session', async () => {
    const run=await f.claim(),root=await f.admit(run,await cronDispatchBody(run))
    await f.roots.update('default',root.runId,{status:'succeeded'})
    const manual=await f.roots.create('default',run.sessionId,'synthetic-no-model',[],{memoryScope:'off'})
    expect((await stopCronOwnedRun('default',run.id))?.status).toBe('succeeded')
    expect((await f.roots.get('default',manual.runId))?.status).toBe('running')
    expect(manual.runId).not.toBe(root.runId)
  })
})

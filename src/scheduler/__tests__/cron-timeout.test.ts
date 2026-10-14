// Persisted deadline configuration is measured from admission, not each HTTP attachment.
import {describe,it,expect,vi} from 'vitest'
import {dispatchCronRun,stopCronDeadlineTimers} from '../cron-dispatch.js'
import {rootRunStore} from '../../storage/root-runs/index.js'
import {cronFixture} from './cron-v2-fixture.js'
const fixture=cronFixture()
describe('Cron persistent deadline contract',()=>{
  it.each([undefined,null,0])('leaves timeout %s unlimited without synthesizing an AbortSignal deadline',async timeoutSeconds=>{
    const run=await fixture.claim({timeoutSeconds});const timeout=vi.spyOn(AbortSignal,'timeout');let delivered:Record<string,unknown>|undefined
    vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      delivered=JSON.parse(String(init?.body));const root=await fixture.admit(run,delivered!)
      await rootRunStore.update('default',root.runId,{status:'succeeded'})
      return new Response('data: '+JSON.stringify({run:{runId:root.runId,sessionId:run.sessionId,status:'succeeded'}})+'\n\n')
    })
    expect(await dispatchCronRun(run)).toMatchObject({status:'succeeded',deadlineAt:undefined})
    expect(timeout).not.toHaveBeenCalled();expect(delivered?.cronTimeoutSeconds).toBe(timeoutSeconds??null)
  })
  it('persists a deadline beyond 24 hours without overflowing Node timers into immediate cancellation',async()=>{
    const run=await fixture.claim({timeoutSeconds:2_147_484});let rootId=''
    const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      rootId=(await fixture.admit(run,JSON.parse(String(init?.body)))).runId
      await rootRunStore.pending('default',rootId,{requestId:'wait',kind:'ask',toolCallId:'wait',toolName:'ask_user',args:{}})
      return new Response('data: '+JSON.stringify({run:{runId:rootId,sessionId:run.sessionId,status:'waiting'}})+'\n\n')
    })
    const result=await dispatchCronRun(run);const root=await rootRunStore.get('default',rootId)
    expect(result).toMatchObject({status:'waiting',deadlineAt:root!.createdAt+2_147_484_000})
    await new Promise(resolve=>setImmediate(resolve));expect(send).toHaveBeenCalledTimes(1)
    stopCronDeadlineTimers()
  })
})

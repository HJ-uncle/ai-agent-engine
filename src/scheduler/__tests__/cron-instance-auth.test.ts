// Instance gate, redirects, durable disconnect and precise cancellation. Only local HTTP is used.
import Fastify from 'fastify'
import type {FastifyInstance} from 'fastify'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {authMiddlewareHook,configureRequestAuthentication} from '../../api/http/middleware.js'
import {CronScheduler} from '../cron-scheduler.js'
import {dispatchCronRun,cancelCronRun} from '../cron-dispatch.js'
import {rootRunStore} from '../../storage/root-runs/index.js'
import {cronFixture} from './cron-v2-fixture.js'
const fixture=cronFixture();const apps:FastifyInstance[]=[];const token='cron-runtime-auth-fixture-token'
afterEach(async()=>{for(const app of apps.splice(0))await app.close();configureRequestAuthentication()})
const frame=(sessionId:string,runId:string,status:string)=>'data: '+JSON.stringify({run:{runId,sessionId,status}})+'\n\n'
async function server(){const app=Fastify({forceCloseConnections:true});apps.push(app);return app}
describe('Owned instance Cron dispatch',()=>{
  it('uses the dedicated engine port, obeys instance authentication, and carries explicit off/profile/protocol',async()=>{
    vi.stubEnv('AETHER_INSTANCE_TOKEN',token);configureRequestAuthentication()
    const run=await fixture.claim();const app=await server();app.addHook('onRequest',authMiddlewareHook);let delivered:Record<string,unknown>|undefined;let count=0
    app.post('/api/v1/chat',async(request,reply)=>{
      count++;delivered=request.body as Record<string,unknown>
      expect(request.headers['x-aether-instance-token']).toBe(token)
      expect(request.headers['x-aether-subagent-protocol']).toBe('2')
      expect(request.headers['x-aether-tool-profile']).toBe('general')
      const root=await fixture.admit(run,delivered);await rootRunStore.update('default',root.runId,{status:'succeeded'})
      return reply.type('text/event-stream').send(frame(run.sessionId,root.runId,'succeeded'))
    })
    const url=await app.listen({host:'127.0.0.1',port:0});vi.stubEnv('AETHER_ENGINE_PORT',new URL(url).port);vi.stubEnv('PORT','0')
    expect((await fetch(url+'/api/v1/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401)
    expect(count).toBe(0);expect(await dispatchCronRun(run)).toMatchObject({status:'succeeded'})
    expect(count).toBe(1);expect(delivered).toMatchObject({thinkingMode:false,automationRunId:run.id,cronJobId:run.jobId,sessionId:run.sessionId})
    expect(process.env.PORT).toBe('0')
  })
  it('rejects remote credentials and refuses redirects without leaking to the destination',async()=>{
    vi.stubEnv('AETHER_INSTANCE_TOKEN',token)
    const remote=await fixture.claim();expect(await dispatchCronRun(remote,{baseUrl:'https://example.invalid'})).toMatchObject({status:'failed',reason:expect.stringContaining('loopback')})
    const destination=await server();const redirect=await server();let leaked=0
    destination.post('/sink',async()=>{leaked++;return 'unexpected'})
    const destinationUrl=await destination.listen({host:'127.0.0.1',port:0})
    redirect.post('/api/v1/chat',async(_request,reply)=>reply.code(307).header('Location',destinationUrl+'/sink').send())
    const url=await redirect.listen({host:'127.0.0.1',port:0});const run=await fixture.claim()
    expect(await dispatchCronRun(run,{baseUrl:url})).toMatchObject({status:'failed'});expect(leaked).toBe(0)
  })
  it('scheduler shutdown joins the exact admitted durable root before detaching its reader',async()=>{
    const run=await fixture.claim();let signal:AbortSignal|undefined;let admitted!:()=>void;const ready=new Promise<void>(resolve=>{admitted=resolve})
    const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      signal=init!.signal!;await fixture.admit(run,JSON.parse(String(init?.body)));admitted()
      return new Promise<Response>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true})})
    })
    const scheduler=new CronScheduler('http://127.0.0.1:12519')
    const fire=(scheduler as unknown as {fireJob(input:typeof run):Promise<void>}).fireJob.bind(scheduler)
    const running=fire(run);await ready;const duplicate=fire(run);expect(send).toHaveBeenCalledTimes(1)
    await scheduler.stop();await Promise.all([running,duplicate]);expect(signal?.aborted).toBe(true)
    expect(await fixture.runs.get('default',run.id)).toMatchObject({status:'cancelled'})
    expect(send).toHaveBeenCalledTimes(1)
  })
  it.each(['malformed','oversized'])('retains root ownership after %s SSE without issuing broad cancellation',async kind=>{
    const run=await fixture.claim();let rootId=''
    const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      rootId=(await fixture.admit(run,JSON.parse(String(init?.body)))).runId
      return new Response(frame(run.sessionId,rootId,'running')+(kind==='malformed'?'data: invalid-json\n\n':'data: '+'x'.repeat(1024*1024+1)),{headers:{'content-type':'text/event-stream'}})
    })
    expect(await dispatchCronRun(run)).toMatchObject({status:'running',rootRunId:rootId});expect(send).toHaveBeenCalledTimes(1)
  })
  it.each(['succeeded','waiting'])('releases an unclosed SSE reader after the persisted root becomes %s',async status=>{
    const run=await fixture.claim();let rootId='';let signal:AbortSignal|undefined;let ready!:()=>void
    const observed=new Promise<void>(resolve=>{ready=resolve})
    const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      rootId=(await fixture.admit(run,JSON.parse(String(init?.body)))).runId;signal=init!.signal!
      const stream=new ReadableStream<Uint8Array>({start(controller){
        controller.enqueue(new TextEncoder().encode(frame(run.sessionId,rootId,'running')))
        signal!.addEventListener('abort',()=>controller.error(signal!.reason),{once:true});ready()
      }})
      return new Response(stream,{headers:{'content-type':'text/event-stream'}})
    })
    const scheduler=new CronScheduler('http://127.0.0.1:12519')
    const fire=(scheduler as unknown as {fireJob(input:typeof run):Promise<void>}).fireJob.bind(scheduler)
    try{
      const watching=fire(run);await observed
      if(status==='waiting')await rootRunStore.pending('default',rootId,{requestId:'pending',kind:'ask',toolCallId:'pending',toolName:'ask_user',args:{}})
      else await rootRunStore.update('default',rootId,{status:'succeeded'})
      await scheduler.checkAndRun();await watching
      expect(signal?.aborted).toBe(true);expect(send).toHaveBeenCalledTimes(1)
      expect(await fixture.runs.get('default',run.id)).toMatchObject({status,rootRunId:rootId})
      expect(await rootRunStore.get('default',rootId)).toMatchObject({status})
    }finally{scheduler.stop()}
  })
  it('checks cancellation response body and retains the true running state when cancellation is rejected',async()=>{
    const run=await fixture.claim();const root=await fixture.admit(run,{message:run.snapshot.message,sessionId:run.sessionId,automationRunId:run.id,cronJobId:run.jobId,thinkingMode:false,cronTimeoutSeconds:null})
    let cancellation:unknown;vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{cancellation=JSON.parse(String(init?.body));return Response.json({code:40001})})
    await expect(cancelCronRun('default',run.id)).rejects.toThrow('rejected')
    expect(cancellation).toEqual({sessionId:run.sessionId,runId:root.runId});expect(await fixture.runs.get('default',run.id)).toMatchObject({status:'running'})
  })
})

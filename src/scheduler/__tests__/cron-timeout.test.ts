import Fastify from 'fastify'
import {describe,expect,it,vi} from 'vitest'
import {CronScheduler} from '../cron-scheduler.js'
const job={id:'deadline-job',message:'Develop',sessionId:'deadline-session'}
const fire=(scheduler:CronScheduler,input:typeof job & {timeoutSeconds?:number|null})=>(scheduler as unknown as {fireJob(input:typeof job & {timeoutSeconds?:number|null}):Promise<void>}).fireJob(input)
const frame=(status:string)=>'data: '+JSON.stringify({run:{runId:'owned-deadline',sessionId:job.sessionId,status}})+'\n\n'
describe('per-job scheduler deadline',()=>{
 it('actually aborts a one-second HTTP task and cancels only its observed run',async()=>{
  const app=Fastify({forceCloseConnections:true});let cancelled:unknown;let delivered:Record<string,unknown>|undefined
  app.post('/api/v1/chat',async(request,reply)=>{
   delivered=request.body as Record<string,unknown>
   reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream'});reply.raw.write(frame('running'))
   const timer=setTimeout(()=>reply.raw.end(frame('succeeded')),5000)
   reply.raw.on('close',()=>clearTimeout(timer))
  })
  app.post('/api/v1/chat/cancel',async(request)=>{cancelled=request.body;return {code:200,data:{cancelled:true}}})
  const url=await app.listen({host:'127.0.0.1',port:0});const scheduler=new CronScheduler(url);const started=Date.now()
  try {
   await expect(fire(scheduler,{...job,timeoutSeconds:1})).rejects.toThrow()
   expect(Date.now()-started).toBeLessThan(4000)
   expect(cancelled).toEqual({sessionId:job.sessionId,runId:'owned-deadline'})
   expect(delivered?.cronTimeoutSeconds).toBe(1)
  }finally{scheduler.stop();await app.close()}
 },10000)
 it.each([undefined,null,600,86400])('uses the configured deadline %s instead of fixed 120s',async timeoutSeconds=>{
  const timeout=vi.spyOn(AbortSignal,'timeout');const original=globalThis.fetch;let delivered:Record<string,unknown>|undefined
  globalThis.fetch=vi.fn(async(_url,init)=>{delivered=JSON.parse(String(init?.body));return new Response(frame('succeeded'))})
  try{
   await fire(new CronScheduler('http://127.0.0.1'),{...job,timeoutSeconds})
   expect(timeout).toHaveBeenCalledTimes(1)
   expect(timeout).toHaveBeenCalledWith((timeoutSeconds??120)*1000)
   expect(delivered?.cronTimeoutSeconds).toBe(timeoutSeconds??120)
   expect(delivered?.cronJobId).toBe(job.id)
  }finally{globalThis.fetch=original;timeout.mockRestore()}
 })
})

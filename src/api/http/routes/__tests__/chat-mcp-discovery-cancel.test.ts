import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { initDb, closeDb, getDb } from '../../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { chatRoutes } from '../chat.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { ReActStrategy } from '../../../../core/agent-loop/index.js'

const tenantId='discovery-cancel-tenant'
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
let root:string,base:string,app:FastifyInstance
let strategy:MockInstance<typeof ReActStrategy.prototype.run>
const sessionIds:string[]=[]
beforeEach(async()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-chat-mcp-discovery-'))
  vi.stubEnv('DATA_DIR',path.join(root,'agent.db'))
  vi.stubEnv('MEMORY_DB_PATH',path.join(root,'memory.db'))
  vi.stubEnv('MCP_CONFIG_PATH',path.join(root,'mcp.json'))
  vi.stubEnv('AETHER_GLOBAL_DIR',path.join(root,'global'))
  vi.stubEnv('SKILLS_ROOT',path.join(root,'skills'))
  vi.stubEnv('WORKSPACE_ROOT',root)
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY','false')
  vi.stubEnv('HISTORY_BACKEND','jsonl')
  vi.stubEnv('LLM_PRIMARY_MODEL','fixture-model')
  vi.stubEnv('OPENAI_API_KEY','fixture-key')
  vi.stubEnv('QA_LOG_ENABLED','false')
  fs.mkdirSync(path.join(root,'skills'))
  await initDb()
  strategy=vi.spyOn(ReActStrategy.prototype,'run').mockImplementation(async function*(_prompt,ctx){
    await ctx.history.append({id:ctx.assistantMessageId,role:'assistant',content:'follow-up completed',conversationId:ctx.turnId} as never,ctx)
    await ctx.runObserver?.onOutcome?.({status:'succeeded',stopReason:'completed'} as never)
    yield 'follow-up completed'
  })
  app=Fastify();app.decorateRequest('authContext',null)
  app.addHook('onRequest',async request=>{Object.assign(request,{authContext:{tenantId:request.headers['x-tenant']??tenantId}})})
  await app.register(chatRoutes)
  base=await app.listen({host:'127.0.0.1',port:0})
})
afterEach(async()=>{
  for(const sessionId of sessionIds.splice(0)) {
    await app.inject({method:'POST',url:'/chat/cancel',payload:{sessionId}})
    const bus=activeStreams.get(`${tenantId}:${sessionId}`)
    if(bus?.disconnectTimeout)clearTimeout(bus.disconnectTimeout)
    bus?.abortController.abort();bus?.end();activeStreams.delete(`${tenantId}:${sessionId}`)
  }
  await app.close()
  const db=getDb() as LocalSqliteProcessClient
  closeDb()
  await Promise.all([closeMemoryDb(),db.whenClosed()])
  vi.restoreAllMocks();vi.unstubAllEnvs()
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5})
})
function hungServer(id:string,marker:string){
  const script=path.join(root,`${id}.cjs`)
  fs.writeFileSync(script,`const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({leader:process.pid,child:child.pid})); process.stdin.resume(); setInterval(()=>{},1000)`)
  return {id,name:id,transportType:'stdio',command:process.execPath,args:[script],timeoutMs:0}
}
async function waitOwned(marker:string){
  for(let attempt=0;attempt<240&&!fs.existsSync(marker);attempt++)await pause(25)
  return JSON.parse(fs.readFileSync(marker,'utf8')) as {leader:number;child:number}
}
async function reclaimed(owned:{leader:number;child:number}){
  for(let attempt=0;attempt<400&&(alive(owned.leader)||alive(owned.child));attempt++)await pause(25)
  expect(alive(owned.leader)).toBe(false);expect(alive(owned.child)).toBe(false)
  expect(alive(process.pid)).toBe(true)
}
function sendChat(sessionId:string,inlineMcpServers:unknown[],headers:Record<string,string>={}){
  return app.inject({method:'POST',url:'/chat',headers:{'x-aether-tool-profile':'code',...headers},payload:{message:'begin development',sessionId,model:'fixture-model',memoryScope:'off',workspacePaths:[root],inlineMcpServers}})
}
async function assertReusable(sessionId:string){
  expect(await rootRunStore.list(tenantId,sessionId)).toEqual([])
  expect(activeStreams.has(`${tenantId}:${sessionId}`)).toBe(false)
  const status=(await app.inject(`/chat/status?sessionId=${sessionId}`)).json()
  expect(status).toMatchObject({code:200,data:{running:false}})
  // Use a real socket for SSE: light-my-request does not implement the native
  // ServerResponse.setTimeout(0) behavior used by the streaming response.
  const next=await fetch(base+'/chat',{
    method:'POST',headers:{'content-type':'application/json','x-aether-tool-profile':'code'},
    body:JSON.stringify({message:'continue development',sessionId,model:'fixture-model',memoryScope:'off',workspacePaths:[root],inlineMcpServers:[]}),
  })
  const body=await next.text()
  expect(next.status,body).toBe(200)
  expect(body).toContain('follow-up completed')
  expect((await rootRunStore.list(tenantId,sessionId)).at(-1)?.status).toBe('succeeded')
}

describe('formal chat MCP registration cancellation',()=>{
  it('cancels never-ending inline discovery through /chat/cancel and permits a new turn in the same session',async()=>{
    const sessionId='cancel-inline';sessionIds.push(sessionId)
    const marker=path.join(root,'inline-owned.json')
    const pending=sendChat(sessionId,[hungServer('inline-hung',marker)])
    const owned=await waitOwned(marker)
    const cancel=await app.inject({method:'POST',url:'/chat/cancel',payload:{sessionId}})
    expect(cancel.json()).toMatchObject({code:200,data:{cancelled:true}})
    const response=await pending
    expect(response.statusCode).toBe(499)
    expect(response.json()).toMatchObject({code:49900,message:'Chat preparation cancelled'})
    await reclaimed(owned)
    expect(strategy).not.toHaveBeenCalled()
    await assertReusable(sessionId)
    expect(strategy).toHaveBeenCalledOnce()
  },30_000)

  it('cancels locally configured discovery as well, without skipping the cancellation into model execution',async()=>{
    const sessionId='cancel-local';sessionIds.push(sessionId)
    const marker=path.join(root,'local-owned.json'),config=hungServer('local-hung',marker)
    fs.writeFileSync(path.join(root,'mcp.json'),JSON.stringify({mcpServers:{[config.id]:{...config,enabled:true}}}))
    const pending=sendChat(sessionId,[]),owned=await waitOwned(marker)
    expect((await app.inject({method:'POST',url:'/chat/cancel',payload:{sessionId}})).json().data.cancelled).toBe(true)
    expect((await pending).statusCode).toBe(499)
    await reclaimed(owned);expect(strategy).not.toHaveBeenCalled()
    fs.writeFileSync(path.join(root,'mcp.json'),JSON.stringify({mcpServers:{}}))
    await assertReusable(sessionId)
  },30_000)

  it('a real HTTP disconnect during Code discovery reclaims the owned tree before any root/model starts',async()=>{
    const sessionId='disconnected-preparation';sessionIds.push(sessionId)
    const marker=path.join(root,'disconnected-owned.json')
    const request=http.request(base+'/chat',{method:'POST',headers:{'content-type':'application/json','x-aether-tool-profile':'code'}})
    request.on('error',()=>undefined)
    request.end(JSON.stringify({message:'development',sessionId,model:'fixture-model',memoryScope:'off',workspacePaths:[root],inlineMcpServers:[hungServer('disconnected-hung',marker)]}))
    const owned=await waitOwned(marker)
    request.destroy(new Error('client closed before admission'))
    await reclaimed(owned)
    expect(strategy).not.toHaveBeenCalled()
    await assertReusable(sessionId)
  },30_000)
})

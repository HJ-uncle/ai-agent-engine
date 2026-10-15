/** Real Fastify inject, admission/answer, stores and native WAL. The executor is
 * deterministic and invokes no model/provider; no HTTP listener is opened. */
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {initDb,getDb,closeDb} from '../../../../storage/sqlite/db.js'
import {closeMemoryDb} from '../../../../storage/memory/db.js'
import {rootRunStore} from '../../../../storage/root-runs/index.js'
import {SubagentStore} from '../../../../core/subagent/store.js'
import {ParentPublicationAuthority} from '../../../../core/subagent/parent-publication.js'
import {PublishedTurnBootstraps} from '../../../../core/subagent/turn-bootstrap.js'
import {StreamBus,activeStreams} from '../../../../core/stream-pipeline/stream-bus.js'
import {ReActStrategy} from '../../../../core/agent-loop/index.js'
import * as resolver from '../../../../core/llm-adapter/resolve-model.js'
import {resolveCapabilities} from '../../../../core/model-capabilities/index.js'
import {chatRoutes,stopAllOwnedExecutions} from '../chat.js'
import {collaborationRoutes} from '../collaboration.js'
import {serviceForOwner} from '../../../../core/collaboration/execution-owner.js'
import {controllerSubject} from '../../../../core/collaboration/controller-origin.js'

const tenantId='p5-inject',sessionId='p5-parent'
let directory:string,app:FastifyInstance
beforeEach(async()=>{
  directory=path.resolve('.e2e-tmp','p5-inject-'+randomUUID());fs.mkdirSync(directory,{recursive:true})
  for(const[key,value]of Object.entries({DATA_DIR:path.join(directory,'agent.db'),MEMORY_DB_PATH:path.join(directory,'memory.db'),
    AETHER_GLOBAL_DIR:path.join(directory,'global'),SKILLS_ROOT:path.join(directory,'skills'),WORKSPACE_ROOT:directory,HISTORY_BACKEND:'jsonl',
    ENABLE_LONG_TERM_MEMORY:'false',QA_LOG_ENABLED:'false',OSM_MODE:'off',LOG_LEVEL:'silent'}))vi.stubEnv(key,value)
  fs.mkdirSync(path.join(directory,'skills'));await initDb()
  vi.spyOn(resolver,'resolveModelConfig').mockResolvedValue({model:'synthetic-no-provider',provider:'fixture',capabilities:resolveCapabilities({model:'gpt-4o',provider:'openai'}),thinkingEnabled:false})
  app=Fastify({logger:false});app.decorateRequest('authContext',null)
  app.setErrorHandler((error,_request,reply)=>{
    const diagnostic=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:{message:String(error)}
    fs.writeFileSync(path.join(directory,'http-handler-error.json'),JSON.stringify(diagnostic,null,2));reply.type('application/json').code(500).send(diagnostic)
  })
  app.addHook('onRequest',async(request,reply)=>{
    Object.assign(request,{authContext:{tenantId,userId:'fixture-alice',method:'jwt'}})
    // light-my-request requires a callback although ServerResponse's real API
    // permits setTimeout(0). Normalize only this injected response adapter.
    const timeout=reply.raw.setTimeout
    reply.raw.setTimeout=function(milliseconds,callback){return timeout.call(this,milliseconds,callback??(()=>{}))}
  })
  await app.register(chatRoutes,{newStreamPublication:true,liveChildRecovery:true,durableChildRecovery:true});await app.register(collaborationRoutes);await app.ready()
})
afterEach(async()=>{
  await stopAllOwnedExecutions('P5 inject fixture cleanup');await app.close()
  for(const[key,bus]of activeStreams)if(key.startsWith(tenantId+':')){if(bus.disconnectTimeout)clearTimeout(bus.disconnectTimeout);activeStreams.delete(key)}
  for(const receipt of await Promise.all([closeDb(),closeMemoryDb()]))if(receipt)expect(receipt.healthy,JSON.stringify(receipt)).toBe(true)
  vi.restoreAllMocks();vi.unstubAllEnvs()
  // Keep contract fixtures and failure evidence; no test deletes another source.
})
async function waiting(checkpoint:boolean){
  const run=await rootRunStore.create(tenantId,sessionId,'synthetic-no-provider',[directory],{toolProfile:'code',memoryScope:'off',skills:[],mcpServers:[],knowledgeBases:[]})
  const owner=(await rootRunStore.get(tenantId,run.runId))!
  const scope={tenantId,parentSessionId:sessionId,rootSessionId:sessionId,parentTurnId:run.turnId,rootRunId:run.runId,attemptId:owner.attemptId}
  const authority=new ParentPublicationAuthority(getDb(),scope,{enabled:true,checkpointEveryEvents:1}),bus=new StreamBus(new AbortController(),{publication:authority.hooks})
  if(checkpoint){
    await bus.publish('\x00__run__'+JSON.stringify(run))
    const children=new SubagentStore();await children.initialize()
    const child=await children.createRunDelta({...scope,runId:'child-one',parentConversationId:run.turnId,parentMessageId:'dispatch',parentToolCallId:'delegate',childSessionId:'child',modelId:'synthetic-no-provider',task:'isolated fixture',description:'synthetic'})
    await bus.publish('\x00__subagent_event__'+JSON.stringify(child.event));await bus.publish('SEALED ORDINARY')
  }
  const parked=await rootRunStore.pending(tenantId,run.runId,{requestId:'approval',toolCallId:'ask',toolName:'ask_user',kind:'ask',args:{},question:'Continue?'})
  if(checkpoint){await bus.publish('\x00__run__'+JSON.stringify(parked));await bus.endOrdered()}
  return{run,scope,bus}
}
const response=()=>app.inject({method:'POST',url:'/chat',headers:{'x-aether-tool-profile':'code','x-aether-run-lifetime':'durable','x-aether-subagent-protocol':'2'},
  payload:{sessionId,message:'',toolResponse:{runId:responseRunId,requestId:'approval',toolCallId:'ask',name:'ask_user',output:'continue'}}})
let responseRunId:string
it('POST answer imports the exact persisted prefix and publishes a new attempt without legacy inventory or duplicate execution',async()=>{
  const f=await waiting(true);responseRunId=f.run.runId
  const before=await new PublishedTurnBootstraps(getDb()).latestForRun(f.scope)
  vi.spyOn(SubagentStore.prototype,'listRunViewsForParent').mockRejectedValue(new Error('FORBIDDEN latest inventory'))
  const execute=vi.spyOn(ReActStrategy.prototype,'run').mockImplementation(async function*(_prompt,ctx){
    const current=activeStreams.get(tenantId+':'+sessionId)!
    expect(current.childSequenceSource).toBe('published-store')
    expect(current.snapshot().subagentWatermarks).toBeUndefined()
    expect(current.snapshot().projection.some(frame=>frame.content==='SEALED ORDINARY')).toBe(true)
    expect(current.snapshot().projection.find(frame=>frame.subagentEvent)?.subagentEvent).toMatchObject({kind:'published-reference',runId:'child-one'})
    yield 'RESUMED ORDINARY'
    await ctx.runObserver?.onOutcome?.({status:'succeeded',stopReason:'completed'})
  })
  const accepted=await response();expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.body).toContain('RESUMED ORDINARY')
  expect(execute).toHaveBeenCalledOnce()
  const owned=(await rootRunStore.get(tenantId,f.run.runId))!
  expect(owned.attemptId).not.toBe(f.scope.attemptId)
  const checkpoint=await new PublishedTurnBootstraps(getDb()).latestForRun({...f.scope,attemptId:owned.attemptId})
  expect(checkpoint.fence.revision).toBe(before.fence.revision)
  const snap=await app.inject('/chat/snapshot?sessionId='+sessionId+'&childRecoveryProtocol=1')
  expect(snap.statusCode,snap.body).toBe(200);expect(snap.json().data.finished).toBe(true);expect(snap.json().data.source).toBe('persisted-published')
  expect(snap.json().data.subagentRecovery.totalPublishedCount).toBe(1)
  const duplicate=await response();expect(duplicate.statusCode,duplicate.body).toBe(200);expect(execute).toHaveBeenCalledOnce()
  expect((await getDb().execute('SELECT count(*) AS n FROM parent_turn_bootstrap_handoffs')).rows[0].n).toBe(1)
},20000)
it('missing predecessor rejects before answer changes root attempt or invokes executor',async()=>{
  const f=await waiting(false);responseRunId=f.run.runId
  const execute=vi.spyOn(ReActStrategy.prototype,'run')
  const rejected=await response();expect(rejected.statusCode,rejected.body).toBe(409);expect(rejected.json().data.reason).toBe('bootstrap_unavailable')
  expect(execute).not.toHaveBeenCalled();const owned=(await rootRunStore.get(tenantId,f.run.runId))!
  expect(owned.attemptId).toBe(f.scope.attemptId);expect(owned.status).toBe('waiting');expect(owned.pending[0].status).toBe('pending')
},20000)
it('post-answer durable seed failure marks observer recovery while the accepted executor completes',async()=>{
  const f=await waiting(true);responseRunId=f.run.runId
  vi.spyOn(PublishedTurnBootstraps.prototype,'projectionSeed').mockRejectedValue(new Error('OWNED_SEED_IO_FAILURE'))
  const execute=vi.spyOn(ReActStrategy.prototype,'run').mockImplementation(async function*(_prompt,ctx){
    expect(activeStreams.get(tenantId+':'+sessionId)!.abortController.signal.aborted).toBe(false)
    yield 'REAL EXECUTOR CONTINUES'
    await ctx.runObserver?.onOutcome?.({status:'succeeded',stopReason:'completed'})
  })
  const accepted=await response();expect(accepted.statusCode,accepted.body).toBe(200)
  await vi.waitFor(async()=>expect((await rootRunStore.get(tenantId,f.run.runId))?.status).toBe('succeeded'))
  expect(execute).toHaveBeenCalledOnce()
  const bus=activeStreams.get(tenantId+':'+sessionId)!
  expect(bus.abortController.signal.aborted).toBe(false)
  expect(bus.snapshot()).toMatchObject({publicationRecovery:{reason:'evidence_unavailable',lastConfirmedEventId:bus.streamId+':0'}})
  const snapshot=await app.inject('/chat/snapshot?sessionId='+sessionId+'&childRecoveryProtocol=1')
  expect(snapshot.statusCode).toBe(409);expect(snapshot.json().data.recoveryRequired).toBe(true)
},20000)
it('actual POST chat admits the authenticated user controller and its receipt stays readable after completion',async()=>{
  let frozen:{rootRunId:string;rootAttemptId:string;rootSessionId:string}|undefined
  const requestKey='actual-chat-controller'
  vi.spyOn(ReActStrategy.prototype,'run').mockImplementation(async function*(_prompt,ctx){
    const b=serviceForOwner(ctx.executionOwner!).controllerBinding(ctx.executionOwner!)
    frozen={rootRunId:b.rootRunId,rootAttemptId:b.rootAttemptId,rootSessionId:b.rootSessionId}
    const source=(await getDb().execute({sql:'SELECT subject_key,subject_kind,auth_method FROM collaboration_controller_roots WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?',args:[tenantId,b.rootRunId,b.rootAttemptId]})).rows[0]
    expect(source).toMatchObject({subject_key:controllerSubject({kind:'account',tenantId,userId:'fixture-alice'},'jwt').key,subject_kind:'account',auth_method:'jwt'})
    const query=new URLSearchParams({rootAttemptId:b.rootAttemptId,rootSessionId:b.rootSessionId})
    const context=await app.inject({url:`/collaboration/roots/${b.rootRunId}/controller-context?rootSessionId=${b.rootSessionId}&recipientParticipantId=${encodeURIComponent(b.participantId)}`})
    expect(context.statusCode,context.body).toBe(200);expect(context.json().data.scope).toEqual(frozen)
    const accepted=await app.inject({method:'POST',url:`/collaboration/roots/${b.rootRunId}/messages?${query}`,payload:{recipientParticipantId:b.participantId,recipientInvocationRunId:b.invocationRunId,message:'User addition through actual chat-owned scope',requestKey}})
    expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().data.receipt.state).toBe('queued')
    yield 'Owned actual chat controller accepted'
    await ctx.runObserver?.onOutcome?.({status:'succeeded',stopReason:'completed'})
  })
  const response=await app.inject({method:'POST',url:'/chat',headers:{'x-aether-tool-profile':'general','x-aether-run-lifetime':'durable','x-aether-subagent-protocol':'2'},payload:{sessionId,message:'Current original human task',memoryScope:'off'}})
  expect(response.statusCode,response.body).toBe(200);expect(frozen).toBeDefined()
  await vi.waitFor(async()=>expect((await rootRunStore.get(tenantId,frozen!.rootRunId))?.status).toBe('succeeded'))
  const query=new URLSearchParams({rootAttemptId:frozen!.rootAttemptId,rootSessionId:frozen!.rootSessionId})
  const receipt=await app.inject({url:`/collaboration/roots/${frozen!.rootRunId}/controller-receipts/${requestKey}?${query}`})
  expect(receipt.statusCode,receipt.body).toBe(200);expect(receipt.json().data.receipt.state).toBe('rejected')
  const context=await app.inject({url:`/collaboration/roots/${frozen!.rootRunId}/controller-context?rootSessionId=${sessionId}`})
  expect(context.statusCode).toBe(409)
},20000)

// Actual ReAct, canonical child runner, WAL/file delivery and exact terminal projection.
// Only in-process provider output is scripted; no listener, Electron or model is started.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../../agent-loop/react.js'
import { SubagentRunner } from '../../subagent/runner.js'
import { SubagentStore } from '../../subagent/store.js'
import { closeDb, getDb, initDb } from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { jsonlHistoryIdentity } from '../../../storage/conversation/jsonl-origin.js'
import { admissionProjectingHistory, readAdmissionSeed } from '../../../storage/root-admission/projection.js'
import { ensureUserAdmissionSchema, prepareUserAdmission, readDatabaseNamespace, userAdmissionDigest } from '../../../storage/root-admission/index.js'
import { CollaborationRuntime } from '../runtime.js'
import { CollaborationStore } from '../store.js'
import { ExecutionOwners, type ExecutionOwner } from '../execution-owner.js'
import type { CollaborationProducer } from '../types.js'
import { installProductionCollaborationBoundary } from '../production-boundary.js'
import * as sqlite from '../sqlite-react-boundary.js'
import * as jsonl from '../jsonl-react-boundary.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
const scope = { tenantId: 'child-drain-tenant', sessionId: 'parent' }
const task = 'Exact original parent task'
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() })
let backend: 'jsonl' | 'sqlite' = 'jsonl', directory: string
let db: LocalSqliteProcessClient, observer: LocalSqliteProcessClient, roots: RootRunStore, agents: SubagentStore
let runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, producer: CollaborationProducer
let ctx: AgentContext, rootRunId: string, turnId: string, userId: string
function context(history: AgentContext['history'], executionOwner: ExecutionOwner = owner, sessionId = scope.sessionId): AgentContext {
  return { ...scope, sessionId, rootRunId, turnId, userMessageId: userId, executionOwner, history, logger: logger(),
    inheritContext: false, modelCaps: { contextWindow: 100_000 }, tokenBudget: 100_000,
    tools: { list: () => [], has: () => true, executionMode: () => 'serial', execute: async () => ({ success: true, output: 'Exact tool result' }) },
  } as unknown as AgentContext
}
async function bind(target: AgentContext, inputId?: string, inputContent?: string) {
  if (target.jsonlDelivery) await jsonl.bindJSONLReActBoundary(target.jsonlDelivery, target, inputId, inputContent)
  else await sqlite.bindSQLiteReActBoundary(target.sqliteDelivery!, target, inputId, inputContent)
}
async function consume(target: AgentContext) {
  return target.jsonlDelivery ? jsonl.consumeJSONLReActIteration(target.jsonlDelivery, target)
    : sqlite.consumeSQLiteReActIteration(target.sqliteDelivery!, target)
}
async function snapshot(target: AgentContext) {
  return target.jsonlDelivery ? jsonl.readJSONLReActHistory(target.jsonlDelivery, target)
    : sqlite.readSQLiteReActHistory(target.sqliteDelivery!, target)
}
async function directBind(sender: CollaborationProducer, target: AgentContext, anchorId: string, executionOwner?: ExecutionOwner) {
  if (backend === 'jsonl') {
    const consumer = await runtime.bindJSONLDelivery(sender, { origin: jsonlHistoryIdentity(target.history)!,
      tenantId: target.tenantId, sessionId: target.sessionId, anchorId, executionOwner })
    return { consume: () => runtime.consumeJSONLDelivery(consumer), snapshot: () => runtime.jsonlDeliverySnapshot(consumer, false) }
  }
  const consumer = await runtime.bindSQLiteDelivery(sender, { db, tenantId: target.tenantId, sessionId: target.sessionId, anchorId, executionOwner })
  return { consume: () => runtime.consumeSQLiteDelivery(consumer), snapshot: () => runtime.sqliteDeliverySnapshot(consumer, false) }
}
function childInput(key: string) {
  return { tenantId: scope.tenantId, rootSessionId: scope.sessionId, parentSessionId: scope.sessionId,
    parentConversationId: turnId, parentMessageId: 'dispatch-' + key, parentToolCallId: 'delegate-' + key,
    task: 'Exact child task ' + key, description: key, modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] } }
}
async function admittedChild(key: string, canonical: boolean) {
  const ticket = canonical ? owners.reserveChild(owner) : undefined
  const input = childInput(key), accepted = await runtime.admitChild(producer, input)
  const childOwner = ticket ? owners.attachChild(ticket, accepted.mutation.header.runId, accepted.producer) : undefined
  const target = context(createConversationHistory(), childOwner, accepted.mutation.header.childSessionId)
  if (!childOwner) delete target.executionOwner
  delete target.userMessageId; target.runId = accepted.mutation.header.runId
  const message = { id: 'input-' + key, role: 'user' as const, content: input.task, conversationId: turnId }
  await target.history.append(message, { tenantId: target.tenantId, sessionId: target.sessionId })
  return { ...accepted, input, target, childOwner, ticket, anchorId: message.id }
}
beforeEach(async () => {
  const prior = getDb() as LocalSqliteProcessClient; await closeDb(); await prior.whenClosed()
  directory = path.resolve('.e2e-tmp', 'child-drain-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', backend)
  db = getDb() as LocalSqliteProcessClient
  observer = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  await initDb(); await ensureUserAdmissionSchema(db)
  roots = new RootRunStore(() => db)
  const selector = { protocolVersion: 1 as const, namespace: await readDatabaseNamespace(db), owner: 'code' as const, predecessor: null }
  const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
  const body: Record<string, unknown> = { sessionId: scope.sessionId, message: task, model: 'scripted-only' }
  body.admission = { ...selector, requestKey: 'root', bodyDigest: userAdmissionDigest(body, transport, selector) }
  const accepted = await roots.createUserAdmission(scope.tenantId, 'scripted-only', [], body, prepareUserAdmission(body, transport)!)
  rootRunId = accepted.run.runId; turnId = accepted.run.turnId; userId = accepted.run.userMessageId
  agents = new SubagentStore(db); runtime = new CollaborationRuntime(new CollaborationStore(db), agents); owners = new ExecutionOwners(db, runtime)
  owner = await owners.admitRoot({ tenantId: scope.tenantId, rootRunId, rootAttemptId: accepted.receipt.attemptId, controller: new AbortController() })
  producer = owners.producer(owner)
  const seed = await readAdmissionSeed(db, scope, rootRunId)
  ctx = context(admissionProjectingHistory(createConversationHistory(), seed.anchor)); installProductionCollaborationBoundary(ctx)
  await ctx.history.append(seed.message, scope); await bind(ctx, userId)
})
afterEach(async () => {
  vi.restoreAllMocks(); await closeDb(); observer.close(); await Promise.all([db.whenClosed(), observer.whenClosed()]); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('child-drain-')) throw new Error('Unsafe cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe.each(['jsonl', 'sqlite'] as const)('%s canonical child continuation during finish', selected => {
  beforeAll(() => { backend = selected })
  it('parent finish waits while the actual child consumes new mail and reaches its second provider iteration', async () => {
    const input = { tenantId: scope.tenantId, rootSessionId: scope.sessionId, parentSessionId: scope.sessionId,
      parentConversationId: turnId, parentMessageId: 'dispatch', parentToolCallId: 'delegate',
      task: 'Exact admitted child task', description: 'Held canonical child', modelId: 'scripted-only',
      continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] } }
    const dispatch = { id: input.parentMessageId, role: 'assistant' as const, content: '',
      toolCall: { id: input.parentToolCallId, name: 'subagent', args: {} }, conversationId: turnId }
    await ctx.history.append(dispatch, scope)
    let entered!: () => void, release!: () => void, childContext!: AgentContext, childProducer!: CollaborationProducer, messageId = ''
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const model: LLMAdapter = { model: 'scripted-only', provider: 'fixture', countTokens: () => 0, complete: vi.fn(),
      stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
        calls++
        if (calls === 1) { entered(); await gate; yield { done: true, toolCalls: [{ id: 'read-step', name: 'read_file', args: '{"path":"fixture"}', index: 0 }] } }
        else yield { done: true, content: 'Exact child terminal response after drain' }
      }) }
    const pending = new SubagentRunner(agents).run(input, ctx, async execution => {
      childProducer = owners.producerForExecution(execution.executionOwner!)
      childContext = context(createConversationHistory(), execution.executionOwner!, execution.snapshot.childSessionId)
      delete childContext.userMessageId; childContext.runId = execution.snapshot.runId
      childContext.runObserver = execution.observer; childContext.signal = execution.signal
      childContext.tools.execute = async () => {
        const sent = await runtime.send(childProducer, { recipientParticipantId: 'child:' + execution.snapshot.childSessionId,
          message: 'Canonical child evidence queued during finish drain', requestKey: 'during-drain' })
        messageId = sent.messageId
        return { success: true, output: 'Exact tool result during drain' }
      }
      installProductionCollaborationBoundary(childContext)
      for await (const _frame of new ReActStrategy(model, { maxIterations: 3, maxOutputTokens: 100 }).run(input.task, childContext)) { /* actual loop */ }
    })
    let finishing: ReturnType<RootRunStore['finishOwned']> | undefined, settled = false
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('Child ended before first provider gate') })])
      expect(childProducer).not.toBe(producer)
      finishing = roots.finishOwned(owner, { status: 'succeeded' }).then(result => { settled = true; return result })
      void finishing.catch(() => undefined)
      await expect.poll(async () => (await observer.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('draining')
      expect(settled).toBe(false)
      expect(() => owners.reserveChild(owner)).toThrow('revoked')
      await expect(consume(ctx)).rejects.toThrow('revoked')
      await expect(snapshot(ctx)).rejects.toThrow('revoked')
      await expect(consume({ ...childContext, executionOwner: Object.freeze({}) as ExecutionOwner })).rejects.toThrow('private')
      await expect(runtime.admitChild(producer, childInput('late-dispatch'))).rejects.toThrow('not accepting')
      await expect(directBind(childProducer, childContext, (await childContext.history.getFullHistory({tenantId:scope.tenantId,sessionId:childContext.sessionId})).find(message=>message.role==='user')!.id!)).rejects.toThrow('not accepting')
      release(); const child = await pending
      expect(vi.mocked(model.stream).mock.calls.length, JSON.stringify(child.error)).toBe(2)
      expect(child.status).toBe('succeeded')
      const sent = vi.mocked(model.stream).mock.calls[1][0]
      expect(sent.some(message => String(message.content).includes(input.task))).toBe(true)
      expect(sent.some(message => String(message.content).includes('Canonical child evidence queued during finish drain'))).toBe(true)
      expect(sent.some(message => message.role === 'tool' && String(message.content).includes('Exact tool result during drain'))).toBe(true)
      expect((await finishing).status).toBe('succeeded')
      const deliveryTable = backend === 'jsonl' ? 'collaboration_jsonl_deliveries' : 'collaboration_deliveries'
      const receipt = (await observer.execute({ sql: `SELECT state,recipient_invocation_run_id FROM ${deliveryTable} WHERE message_id=?`, args: [messageId] })).rows[0]
      expect(receipt).toMatchObject({ state: 'integrated', recipient_invocation_run_id: child.runId })
      const projected = (await ctx.history.getFullHistory(scope)).find(message => message.id === 'subagent-result:' + child.runId)
      expect(projected).toMatchObject({ role: 'tool', toolCallId: input.parentToolCallId })
      expect(String(projected?.content)).toContain('Exact child terminal response after drain')
      await expect(consume(childContext)).rejects.toThrow('revoked')
      await expect(snapshot(childContext)).rejects.toThrow('revoked')
    } finally { release(); await pending.catch(() => undefined); await finishing?.catch(() => undefined) }
  })
  it('an ownerless producer consumer cannot acquire continuation or upgrade its original fence', async () => {
    const child = await admittedChild('ownerless', true)
    const raw = await directBind(child.producer, child.target, child.anchorId)
    await expect(raw.snapshot()).resolves.toHaveLength(1)
    await expect(directBind(child.producer, child.target, child.anchorId, child.childOwner)).rejects.toThrow('rebind')
    owners.fence(owner, 'finish'); await runtime.beginDrain(producer)
    await expect(raw.consume()).rejects.toThrow('not accepting')
    await expect(raw.snapshot()).rejects.toThrow('not accepting')
  })
  it('binding rejects copied root, wrong child and foreign runtime owners before admitting a consumer', async () => {
    const child = await admittedChild('exact', true), other = await admittedChild('other', true)
    await expect(directBind(child.producer, child.target, child.anchorId, Object.freeze({}) as ExecutionOwner)).rejects.toThrow('Forged')
    await expect(directBind(child.producer, child.target, child.anchorId, owner)).rejects.toThrow('exact canonical')
    await expect(directBind(child.producer, child.target, child.anchorId, other.childOwner)).rejects.toThrow('exact canonical')
    const foreignRuntime = new CollaborationRuntime(new CollaborationStore(db), agents)
    const foreignOwners = new ExecutionOwners(db, foreignRuntime)
    expect((await observer.execute('SELECT count(*) AS n FROM collaboration_participants')).rows[0].n).toBe(3)
    const foreignRoot = await roots.create(scope.tenantId, 'foreign-runtime-session', 'scripted-only', [], {})
    const foreignOwner = await foreignOwners.admitRoot({tenantId:scope.tenantId,rootRunId:foreignRoot.runId,rootAttemptId:(await roots.get(scope.tenantId,foreignRoot.runId))!.attemptId,controller:new AbortController()})
    await expect(directBind(child.producer, child.target, child.anchorId, foreignOwner)).rejects.toThrow('exact canonical')
  })
  it.each(['cancel', 'park'] as const)('%s revokes a previously canonical child consumer without integrating queued mail', async intent => {
    const child = await admittedChild(intent, true)
    installProductionCollaborationBoundary(child.target); await bind(child.target, child.anchorId, child.input.task)
    const accepted = await runtime.send(producer, {recipientParticipantId:'child:'+child.target.sessionId,message:'Must remain queued',requestKey:intent})
    owners.fence(owner, intent); await runtime.beginDrain(producer)
    await expect(consume(child.target)).rejects.toThrow('revoked')
    await expect(snapshot(child.target)).rejects.toThrow('revoked')
    const table=backend==='jsonl'?'collaboration_jsonl_deliveries':'collaboration_deliveries'
    expect((await observer.execute({sql:`SELECT count(*) AS n FROM ${table} WHERE message_id=?`,args:[accepted.messageId]})).rows[0].n).toBe(0)
    expect((await child.target.history.getFullHistory({tenantId:scope.tenantId,sessionId:child.target.sessionId})).some(message=>String(message.content).includes('Must remain queued'))).toBe(false)
  })
  it.each(['cancel', 'park'] as const)('%s during an awaited authority read cannot finalize a queued delivery', async intent => {
    const child = await admittedChild('held-' + intent, true)
    installProductionCollaborationBoundary(child.target); await bind(child.target, child.anchorId, child.input.task)
    const accepted = await runtime.send(producer, {recipientParticipantId:'child:'+child.target.sessionId,message:'Held delivery must stay unintegrated',requestKey:intent})
    const original = runtime.store.assertProducer.bind(runtime.store)
    let entered!:()=>void, release!:()=>void, held=false
    const ready=new Promise<void>(resolve=>{entered=resolve}), gate=new Promise<void>(resolve=>{release=resolve})
    vi.spyOn(runtime.store,'assertProducer').mockImplementation(async(query,binding,admit)=>{
      const result=await original(query,binding,admit)
      if (!held && binding.invocationRunId===child.mutation.header.runId) {held=true;entered();await gate}
      return result
    })
    const pending=consume(child.target); void pending.catch(()=>undefined)
    try {
      await ready; owners.fence(owner,intent); release()
      await expect(pending).rejects.toThrow('revoked')
      const table=backend==='jsonl'?'collaboration_jsonl_deliveries':'collaboration_deliveries'
      expect((await observer.execute({sql:`SELECT count(*) AS n FROM ${table} WHERE message_id=?`,args:[accepted.messageId]})).rows[0].n).toBe(0)
    } finally {release();await pending.catch(()=>undefined)}
  })
  it('a settled child cannot keep consuming while a real sibling keeps the parent draining', async () => {
    const runner=new SubagentRunner(agents), first=childInput('settled'), second=childInput('sibling')
    for (const input of [first,second]) {
      const dispatch={id:input.parentMessageId,role:'assistant' as const,content:'',toolCall:{id:input.parentToolCallId,name:'subagent',args:{}},conversationId:turnId}
      await ctx.history.append(dispatch,scope)
    }
    let firstContext!:AgentContext, secondContext!:AgentContext, enterFirst!:()=>void, enterSecond!:()=>void, releaseFirst!:()=>void, releaseSecond!:()=>void
    const firstReady=new Promise<void>(resolve=>{enterFirst=resolve}),secondReady=new Promise<void>(resolve=>{enterSecond=resolve})
    const firstGate=new Promise<void>(resolve=>{releaseFirst=resolve}),secondGate=new Promise<void>(resolve=>{releaseSecond=resolve})
    const start=(input:ReturnType<typeof childInput>,firstChild:boolean)=>runner.run(input,ctx,async execution=>{
      const target=context(createConversationHistory(),execution.executionOwner!,execution.snapshot.childSessionId)
      delete target.userMessageId;target.runId=execution.snapshot.runId;target.runObserver=execution.observer;target.signal=execution.signal
      if(firstChild)firstContext=target;else secondContext=target
      installProductionCollaborationBoundary(target)
      const model:LLMAdapter={model:'scripted-only',provider:'fixture',countTokens:()=>0,complete:vi.fn(),
        stream:vi.fn(async function*(){if(firstChild){enterFirst();await firstGate}else{enterSecond();await secondGate}yield{done:true,content:'Exact '+input.description+' terminal'}})}
      for await(const _frame of new ReActStrategy(model,{maxIterations:2,maxOutputTokens:100}).run(input.task,target)){/* actual loop */}
    })
    const one=start(first,true),two=start(second,false);void one.catch(()=>undefined);void two.catch(()=>undefined)
    let finishing:ReturnType<RootRunStore['finishOwned']>|undefined
    try {
      await Promise.all([firstReady,secondReady]);finishing=roots.finishOwned(owner,{status:'succeeded'});void finishing.catch(()=>undefined)
      await expect.poll(async()=>(await observer.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('draining')
      releaseFirst();const settled=await one;expect(settled.status).toBe('succeeded')
      expect((await observer.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('draining')
      await expect(consume(firstContext)).rejects.toThrow('no active admitted producer')
      await expect(snapshot(firstContext)).rejects.toThrow('no active admitted producer')
      const stillLive=await snapshot(secondContext)
      expect(stillLive.some(message=>String('content' in message?message.content:'').includes(second.task))).toBe(true)
      releaseSecond();expect((await two).status).toBe('succeeded');expect((await finishing).status).toBe('succeeded')
      const history=await ctx.history.getFullHistory(scope)
      expect(history.filter(message=>message.role==='tool'&&[first.parentToolCallId,second.parentToolCallId].includes(message.toolCallId??''))).toHaveLength(2)
    } finally {releaseFirst();releaseSecond();await Promise.allSettled([one,two]);await finishing?.catch(()=>undefined)}
  })
})

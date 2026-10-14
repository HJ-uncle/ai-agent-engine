import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { RequestBudget } from '../../subagent/budget.js'
import { ReActStrategy, type ReActOptions } from '../react.js'
import { estimateRequestInput } from '../finalization.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import * as database from '../../../storage/sqlite/db.js'
import { up as createConversations } from '../../../storage/sqlite/migrations/001_initial.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'
import { OpenAIAdapter } from '../../llm-adapter/openai.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
const PRIVATE = 'private-reasoning-never-a-public-answer'
const reasoning = (text = PRIVATE): LLMStreamChunk => ({ done: true, finishReason: 'length', reasoningContent: text, promptTokens: 20, completionTokens: 8192 })
const answer = (content = 'Public task result verified.'): LLMStreamChunk => ({ done: true, finishReason: 'stop', content, promptTokens: 40, completionTokens: 15 })
const tool = (id = 'provider-id'): LLMStreamChunk => ({ done: true, finishReason: 'tool_calls',
  toolCalls: [{ index: 0, id, name: 'read_file', args: '{"path":"evidence.txt"}' }], promptTokens: 10, completionTokens: 3 })
const body = (frames: string[]) => frames.filter(f => !f.startsWith('\x00__')).join('')
function fixture(profile: 'general' | 'code' = 'general') {
  const history: Message[] = [], appended: Message[] = [], outcomes: RunOutcome[] = []
  const ctx = { tenantId: 'reasoning-tenant', sessionId: 'session', rootRunId: 'root', turnId: 'turn',
    userMessageId: 'user', assistantMessageId: 'final-answer', workspaceDir: '.', toolProfile: profile,
    modelCaps: { contextWindow: 100_000 },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: { append: vi.fn(async (m: Message) => { appended.push(m); history.push(m); return m.id }),
      getHistory: vi.fn(async () => [...history]), getFullHistory: vi.fn(async () => [...history]),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })) },
    tools: { list: () => [], has: () => true, executionMode: () => 'serial', execute: vi.fn(async () => ({ success: true, output: 'actual file evidence' })) },
    runObserver: { onOutput: vi.fn(), onUsage: vi.fn(), onOutcome: vi.fn(async (o: RunOutcome) => { outcomes.push(o) }) },
  } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'fixture-model', provider: 'fixture', countTokens: () => 0,
    complete: vi.fn(), stream: vi.fn(async function* () { yield answer() }) }
  const run = async (options: ReActOptions = {}, onFrame?: (f: string) => void) => {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, options).run('Complete the approved task using file evidence.', ctx)) { frames.push(frame); onFrame?.(frame) }
    return frames
  }
  return { history, appended, outcomes, ctx, llm, run }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('reasoning-only terminal output recovery', () => {
  it.each(['general', 'code'] as const)('%s regenerates once without replaying private reasoning or creating an empty assistant', async profile => {
    const f = fixture(profile)
    let calls = 0
    const caps: Array<number | undefined> = []
    f.llm.stream = vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions) {
      caps.push(options?.maxTokens)
      expect(options?.requestInputTokenEstimate).toBe(estimateRequestInput(messages, options?.systemPrompt, options?.tools ?? []))
      if (++calls === 1) yield reasoning()
      else {
        expect(JSON.stringify(messages)).not.toContain(PRIVATE)
        expect(messages.filter(m => m.role === 'assistant')).toHaveLength(0)
        expect(messages.filter(m => m.role === 'user')).toHaveLength(1)
        expect(options?.systemPrompt).toContain('before producing a public answer')
        expect(options?.thinkingEnabled).toBe(true)
        yield answer()
      }
    })
    const frames = await f.run({ thinkingEnabled: true })
    expect(calls).toBe(2)
    if (profile === 'general') expect(caps).toEqual([8192, 16_384])
    else expect(caps.every(n => n !== undefined && n > 8192)).toBe(true)
    expect(body(frames)).toBe('Public task result verified.')
    expect(f.outcomes).toEqual([{ status: 'succeeded', output: body(frames), stopReason: 'completed' }])
    const segments = f.appended.filter(m => m.role === 'assistant')
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ content: '', reasoningContent: PRIVATE, metadata: { partial: true, status: 'failed', stopReason: 'output_limit', outputReasoningRecovery: true }, usage: { promptTokens: 20, completionTokens: 8192 } })
    expect(segments[0].id).not.toBe('final-answer')
    expect(segments[1]).toMatchObject({ id: 'final-answer', content: body(frames), usage: { promptTokens: 40, completionTokens: 15 } })
    expect(f.ctx.runObserver?.onUsage).toHaveBeenCalledTimes(2)
    expect(JSON.parse(frames.filter(s => s.startsWith('\x00__usage__')).at(-1)!.slice('\x00__usage__'.length))).toMatchObject({ promptTokens: 60, completionTokens: 8207, totalTokens: 8267 })
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('retains an explicit output cap and explicit Off on the one recovery request', async () => {
    const f = fixture(), caps: Array<number | undefined> = []
    f.llm.stream = vi.fn(async function* (messages, options) {
      caps.push(options?.maxTokens)
      expect(options?.thinkingEnabled).toBe(false)
      expect(JSON.stringify(messages)).not.toContain(PRIVATE)
      if (caps.length === 1) yield { ...reasoning(), completionTokens: 2048 }
      else yield answer()
    })
    await f.run({ maxOutputTokens: 2048, thinkingEnabled: false })
    expect(caps).toEqual([2048, 2048])
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
    expect(f.appended.find(message => message.metadata?.outputReasoningRecovery)?.usage?.completionTokens).toBe(2048)
  })

  it('keeps a finite cumulative budget authoritative even when it can afford more output', async () => {
    const f = fixture(), budget = new RequestBudget(100_000), caps: Array<number | undefined> = []
    f.ctx.requestBudget = budget
    f.ctx.onRequestAttempt = event => { budget.observe(event) }
    f.llm.stream = vi.fn(async function* (_messages, options) {
      caps.push(options?.maxTokens)
      const n = caps.length
      const usage = { promptTokens: n === 1 ? 20 : 40, completionTokens: n === 1 ? 8192 : 15 }
      await options?.onRequestAttempt?.({ type: 'start', requestAttemptId: 'finite-' + n,
        provider: 'fixture', model: 'fixture-model', estimatedInputTokens: options.requestInputTokenEstimate, maxOutputTokens: options.maxTokens })
      await options?.onRequestAttempt?.({ type: 'finish', requestAttemptId: 'finite-' + n,
        provider: 'fixture', model: 'fixture-model', outcome: 'succeeded', usage })
      yield n === 1 ? reasoning() : answer()
    })
    await f.run()
    expect(caps).toEqual([8192, 8192])
    expect(budget.snapshot).toMatchObject({ charged: 8267, reserved: 0, remaining: 91733 })
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
  })

  it.each([{ window: 6000, expected: [1500, 1500] }, { window: 40_000, expected: [8192, 10_000] }])(
    'keeps the recovery reservation within a $window token context', async ({ window, expected }) => {
      const f = fixture(), caps: Array<number | undefined> = []
      f.ctx.modelCaps = { contextWindow: window }
      f.llm.stream = vi.fn(async function* (messages, options) {
        caps.push(options?.maxTokens)
        expect(options?.requestInputTokenEstimate).toBe(estimateRequestInput(messages, options?.systemPrompt, options?.tools ?? []))
        expect(options!.requestInputTokenEstimate! + options!.maxTokens!).toBeLessThanOrEqual(window)
        yield caps.length === 1 ? { ...reasoning(), completionTokens: expected[0] } : answer()
      })
      await f.run()
      expect(caps).toEqual(expected)
      expect(f.outcomes.at(-1)?.status).toBe('succeeded')
    },
  )

  it('expands only the regeneration dispatch even when an unchanged completed read keeps the episode open', async () => {
    const f = fixture(), caps: Array<number | undefined> = []
    f.ctx.tools.executionMode = () => 'readonly'
    f.llm.stream = vi.fn(async function* (_messages, options) {
      caps.push(options?.maxTokens)
      const n = caps.length
      if (n === 1 || n === 3) yield tool('same-read')
      else yield n === 2 ? reasoning() : answer()
    })
    await f.run()
    expect(caps).toEqual([8192, 8192, 16_384, 8192])
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(2)
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
  })

  it('keeps the reserved finalization request after a private-only length response', async () => {
    const f = fixture(), caps: Array<number | undefined> = []
    const systemPrompt = 'Retained user system requirement. '.repeat(8800)
    const fixed = estimateRequestInput([], systemPrompt, [])
    expect(fixed + 8192).toBeLessThan(100_000)
    expect(fixed + 16_384).toBeGreaterThan(100_000)
    f.llm.stream = vi.fn(async function* (messages, options) {
      caps.push(options?.maxTokens)
      expect(options?.thinkingEnabled).toBe(false)
      expect(JSON.stringify(messages)).not.toContain(PRIVATE)
      expect(options!.requestInputTokenEstimate! + options!.maxTokens!).toBeLessThanOrEqual(100_000)
      if (caps.length === 1) yield reasoning()
      else {
        expect(options?.tools).toEqual([])
        expect(options?.systemPrompt).toContain('探索已停止')
        yield answer('Supported partial findings.')
      }
    })
    await f.run({ systemPrompt, maxIterations: 2, finalizeOnLimit: true, thinkingEnabled: false })
    expect(caps).toEqual([8192, 4096])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'max_steps' })
    expect(f.appended.filter(message => message.metadata?.outputReasoningRecovery)).toHaveLength(1)
  })

  it('uses available context for regeneration rather than rejecting a fixed system prompt that already fits', async () => {
    const f = fixture(), requests: Array<LLMAdapterOptions | undefined> = []
    const systemPrompt = 'Retained user system requirement. '.repeat(8800)
    f.llm.stream = vi.fn(async function* (messages, options) {
      requests.push(options)
      expect(JSON.stringify(messages)).not.toContain(PRIVATE)
      expect(options!.requestInputTokenEstimate! + options!.maxTokens!).toBeLessThanOrEqual(100_000)
      yield requests.length === 1 ? reasoning() : answer()
    })
    await f.run({ systemPrompt })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.maxTokens).toBe(8192)
    expect(requests[1]?.maxTokens).toBeGreaterThan(8192)
    expect(requests[1]?.maxTokens).toBeLessThan(16_384)
    expect(requests[1]!.requestInputTokenEstimate! + requests[1]!.maxTokens!).toBe(100_000)
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
  })

  it('keeps failure when even a different second private segment exhausts output', async () => {
    const f = fixture(); let calls = 0
    f.llm.stream = vi.fn(async function* () { yield reasoning(PRIVATE + ++calls) })
    const frames = await f.run()
    expect(calls).toBe(2)
    expect(body(frames)).toBe('')
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit', error: { code: 'OUTPUT_LIMIT' } })
    const segments = f.appended.filter(m => m.role === 'assistant')
    expect(segments.map(m => m.reasoningContent)).toEqual([PRIVATE + '1', PRIVATE + '2'])
    expect(new Set(segments.map(m => m.id)).size).toBe(2)
    expect(f.ctx.runObserver?.onUsage).toHaveBeenCalledTimes(2)
  })

  it.each([
    { title: 'empty', chunk: { done: true, finishReason: 'length' } },
    { title: 'blank reasoning', chunk: { done: true, finishReason: 'length', reasoningContent: ' \n ' } },
    { title: 'nonterminal length', chunk: { done: false, finishReason: 'length', reasoningContent: PRIVATE } },
    { title: 'provider error', chunk: { done: true, finishReason: 'error', reasoningContent: PRIVATE } },
    { title: 'reasoning-only stop', chunk: { done: true, finishReason: 'stop', reasoningContent: PRIVATE } },
  ] as Array<{ title: string; chunk: LLMStreamChunk }>)('does not recover $title', async ({ chunk }) => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () { yield chunk })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)?.status).toBe('failed')
    expect(f.appended.some(m => m.metadata?.outputReasoningRecovery)).toBe(false)
  })

  it('accepts blank public whitespace while keeping it out of model replay', async () => {
    const f = fixture(); let calls = 0
    f.llm.stream = vi.fn(async function* (messages: Message[]) {
      if (++calls === 1) yield { ...reasoning(), content: ' \n ' }
      else { expect(messages.filter(m => m.role === 'assistant')).toHaveLength(0); yield answer() }
    })
    await f.run()
    expect(calls).toBe(2)
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
  })

  it('reopens one recovery only after a complete tool exchange is durably settled', async () => {
    const f = fixture(); let calls = 0
    f.llm.stream = vi.fn(async function* (messages: Message[]) {
      const n = ++calls
      if (n === 1 || n === 3) yield reasoning(PRIVATE + n)
      else if (n === 2) yield tool()
      else {
        expect(messages.filter(m => m.role === 'tool')).toHaveLength(1)
        expect(JSON.stringify(messages)).not.toContain(PRIVATE)
        yield answer()
      }
    })
    await f.run()
    expect(calls).toBe(4)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.appended.filter(m => m.metadata?.outputReasoningRecovery)).toHaveLength(2)
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
  })

  it('does not reopen reasoning recovery after an interrupted tool argument batch', async () => {
    const f = fixture(); let calls = 0
    f.llm.stream = vi.fn(async function* () {
      if (++calls === 2) yield { done: true, finishReason: 'length' as const, toolCalls: [{ index: 0, id: 'partial', name: 'write_file', args: '{"path":"' }] }
      else yield reasoning(PRIVATE + calls)
    })
    await f.run()
    expect(calls).toBe(3)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it.each(['failed', 'repeated-read', 'waiting'] as const)('does not reopen quota after %s tools', async kind => {
    const f=fixture();let calls=0
    f.ctx.tools.executionMode=()=> 'readonly'
    if(kind==='failed')f.ctx.tools.execute=vi.fn(async()=>({success:false,status:'failed' as const,output:'missing file'}))
    if(kind==='waiting')f.ctx.tools.execute=vi.fn(async()=>({success:true,status:'succeeded' as const,output:'{"status":"running"}'}))
    f.llm.stream=vi.fn(async function*(){
      const n=++calls
      if(kind==='repeated-read' && n===1)yield tool('prior')
      else if(n===(kind==='repeated-read'?3:2))yield kind==='waiting'
        ? {...tool(),toolCalls:[{index:0,id:'waiting',name:'task_status',args:'{}'}]}:tool()
      else yield reasoning(PRIVATE+n)
    })
    await f.run()
    expect(calls).toBe(kind==='repeated-read'?4:3)
    expect(f.outcomes.at(-1)).toMatchObject({status:'failed',stopReason:'output_limit'})
    expect(f.appended.filter(m=>m.metadata?.outputReasoningRecovery)).toHaveLength(2)
  })

  it('excludes an exhausted private-only final failure on a later explicit turn', async()=>{
    const f=fixture();f.llm.stream=vi.fn(async function*(){yield reasoning()})
    await f.run()
    expect(f.outcomes.at(-1)?.status).toBe('failed')
    f.llm.stream=vi.fn(async function*(messages:Message[]){
      expect(JSON.stringify(messages)).not.toContain(PRIVATE)
      expect(messages.filter(m=>m.role==='assistant')).toHaveLength(0)
      yield answer()
    })
    f.ctx.assistantMessageId='later-final'
    await f.run()
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
    expect(f.appended.filter(m=>m.reasoningContent===PRIVATE)).toHaveLength(2)
  })

  it('does not omit marked records that still carry real model input or tools', async()=>{
    const f=fixture()
    const metadata={outputReasoningRecovery:true,partial:true,status:'failed',stopReason:'output_limit'}
    f.history.push({role:'assistant',content:'',modelInputContent:'actual retained public fact',reasoningContent:PRIVATE,metadata})
    f.llm.stream=vi.fn(async function*(messages:Message[]){
      expect(messages.some(m=>m.content==='actual retained public fact')).toBe(true);yield answer()
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
  })

  it('filters retained private recovery evidence before an actual compaction model request',async()=>{
    const f=fixture();let calls=0
    f.ctx.modelCaps={contextWindow:6000}
    f.ctx.history={...f.ctx.history,retainsArchive:true}
    f.ctx.history.append=vi.fn(async(m:Message)=>{
      f.appended.push(m);f.history.push(m)
      if(m.metadata?.outputReasoningRecovery)f.history.push({id:'extra-public',role:'assistant',content:'public file fact '.repeat(1800)})
      return m.id!
    })
    f.ctx.history.compress=vi.fn(async(_ctx,summarize)=>{
      const summary=await summarize([...f.history])
      f.history.splice(0,f.history.length,{role:'user',content:'approved task'},{role:'system',content:summary})
      return {preTokens:9000,postTokens:100}
    })
    f.llm.complete=vi.fn(async(messages:Message[])=>{
      expect(JSON.stringify(messages)).not.toContain(PRIVATE)
      return {content:'Public file facts preserved; complete approved task.',toolCalls:[],promptTokens:10,completionTokens:10,finishReason:'stop' as const,model:'fixture'}
    })
    f.llm.stream=vi.fn(async function*(messages:Message[]){if(++calls===1)yield reasoning();else{expect(JSON.stringify(messages)).not.toContain(PRIVATE);yield answer()}})
    await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(f.llm.complete).toHaveBeenCalled()
    expect(vi.mocked(f.llm.complete).mock.calls.some(([messages]) => JSON.stringify(messages).includes('public file fact'))).toBe(true)
    expect(f.appended.find(m=>m.metadata?.outputReasoningRecovery)?.reasoningContent).toBe(PRIVATE)
    expect(f.outcomes.at(-1)).toMatchObject({status:'succeeded'})
  })

  it('clears public-text continuation guidance before reasoning regeneration', async () => {
    const f = fixture(); let calls = 0
    f.llm.stream = vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions) {
      if (++calls === 1) yield { ...answer('public prefix; '), finishReason: 'length' as const }
      else if (calls === 2) yield reasoning()
      else {
        expect(messages.some(m => m.role === 'assistant' && m.content === 'public prefix; ')).toBe(true)
        expect(JSON.stringify(messages)).not.toContain('starting exactly where the response stopped')
        expect(options?.systemPrompt).toContain('before producing a public answer')
        yield answer()
      }
    })
    expect(body(await f.run())).toBe('public prefix; Public task result verified.')
    expect(calls).toBe(3)
  })

  it('retains history evidence and model ID isolation when provider tool IDs are reused after recovery', async () => {
    const f = fixture(); let calls = 0
    f.llm.stream = vi.fn(async function* () {
      const n=++calls
      if (n === 1 || n === 3) yield tool('same-provider-id')
      else if(n===2) yield reasoning()
      else yield answer()
    })
    await f.run()
    const announcements=f.appended.filter(m=>m.toolCall), receipts=f.appended.filter(m=>m.role==='tool')
    expect(announcements).toHaveLength(2)
    expect(receipts).toHaveLength(2)
    expect(new Set(announcements.map(m=>m.toolCallId)).size).toBe(2)
    expect(receipts.map(m=>m.toolCallId)).toEqual(announcements.map(m=>m.toolCallId))
    expect(announcements[1].metadata?.providerToolCallId).toBe('same-provider-id')
  })

  it('stops before regeneration when cancellation arrives after retained usage', async () => {
    const f = fixture(), abort = new AbortController(); f.ctx.signal=abort.signal
    f.llm.stream=vi.fn(async function*(){yield reasoning()})
    await f.run({}, frame=>{if(frame.startsWith('\x00__usage__') && f.appended.some(m=>m.metadata?.outputReasoningRecovery))abort.abort()})
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)?.status).toBe('cancelled')
    expect(f.appended.find(m=>m.metadata?.outputReasoningRecovery)?.reasoningContent).toBe(PRIVATE)
  })

  it('reports a persistence failure and sends no recovery request', async () => {
    const f=fixture()
    f.ctx.history.append=vi.fn(async m=>{if(m.metadata?.outputReasoningRecovery)throw new Error('disk write failed');f.history.push(m);return m.id!})
    f.llm.stream=vi.fn(async function*(){yield reasoning()})
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({status:'failed',error:{code:'PERSISTENCE_ERROR'}})
  })

  it('does not regenerate after a failed usage observer', async () => {
    const f=fixture()
    f.ctx.runObserver!.onUsage=vi.fn(async()=>{throw new Error('usage observer failed')})
    f.llm.stream=vi.fn(async function*(){yield reasoning()})
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({status:'failed',error:{code:'RUNTIME_ERROR',message:'usage observer failed'}})
    expect(f.appended.find(m=>m.role==='assistant')).toMatchObject({reasoningContent:PRIVATE,usage:{completionTokens:8192}})
  })

  it('keeps physical usage when a consumer closes on the terminal thinking frame', async () => {
    const f=fixture(); f.llm.stream=vi.fn(async function*(){yield reasoning()})
    const iterator=new ReActStrategy(f.llm).run('approved task',f.ctx)[Symbol.asyncIterator]()
    while(true){const next=await iterator.next();if(next.done)throw new Error('thinking frame missing');if(next.value.startsWith('\x00__thinking__'))break}
    await iterator.return?.()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)?.status).not.toBe('succeeded')
    expect(f.appended.find(m=>m.role==='assistant')).toMatchObject({reasoningContent:PRIVATE,usage:{promptTokens:20,completionTokens:8192}})
  })

  it('honors an explicit physical budget instead of bypassing it for recovery', async () => {
    const f=fixture(), budget=new RequestBudget(100_000);f.ctx.requestBudget=budget
    f.ctx.onRequestAttempt=e=>{budget.observe(e)}
    f.llm.stream=vi.fn(async function*(_messages,options){
      await options?.onRequestAttempt?.({type:'start',requestAttemptId:'one',provider:'fixture',model:'model',estimatedInputTokens:options.requestInputTokenEstimate,maxOutputTokens:options.maxTokens})
      await options?.onRequestAttempt?.({type:'finish',requestAttemptId:'one',provider:'fixture',model:'model',outcome:'succeeded',usage:{promptTokens:91808,completionTokens:8192}})
      yield {...reasoning(),promptTokens:91808}
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({status:'failed',stopReason:'budget'})
    expect(budget.snapshot).toMatchObject({charged:100000,reserved:0,remaining:0})
  })

  it('honors the configured last iteration and finalization instead of regenerating', async () => {
    const f=fixture();f.llm.stream=vi.fn(async function*(){yield reasoning()})
    await f.run({maxIterations:1})
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({status:'failed',stopReason:'output_limit'})
    const g=fixture();let calls=0;g.llm.stream=vi.fn(async function*(_messages: Message[], options?: LLMAdapterOptions){
      if(++calls===1)yield tool()
      else{expect(options?.systemPrompt).toContain('探索已停止');expect(options?.tools).toEqual([]);yield reasoning()}
    })
    await g.run({maxIterations:2,finalizeOnLimit:true})
    expect(g.llm.stream).toHaveBeenCalledTimes(2)
    expect(g.outcomes.at(-1)).toMatchObject({status:'failed',stopReason:'output_limit'})
  })
})

describe('actual SDK provider framing after reasoning recovery',()=>{
  it.each(['anthropic','openai'] as const)('%s wire has neither the private fragment nor empty assistant replay',async provider=>{
    const f=fixture(),bodies:Record<string,unknown>[]=[]
    const budget=new RequestBudget(Infinity), attempts: Array<{ type: string; maxOutputTokens?: number }> = []
    f.ctx.requestBudget=budget
    f.ctx.onRequestAttempt=event=>{attempts.push(event);budget.observe(event)}
    let requests=0
    vi.stubGlobal('fetch',vi.fn(async(_url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
      bodies.push(JSON.parse(String(init?.body)))
      const n=++requests
      if(n===2){
        expect(JSON.stringify(bodies[1])).not.toContain(PRIVATE)
        const messages=bodies[1].messages as Array<{role:string;content:unknown}>
        expect(messages.filter(m=>m.role==='assistant')).toHaveLength(0)
      }
      if(provider==='anthropic'){
        const events=[
          {type:'message_start',message:{id:'fixture-'+n,type:'message',role:'assistant',model:'qwen3.8-flash',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:n===1?20:40,output_tokens:0}}},
          {type:'content_block_start',index:0,content_block:n===1?{type:'thinking',thinking:''}:{type:'text',text:''}},
          {type:'content_block_delta',index:0,delta:n===1?{type:'thinking_delta',thinking:PRIVATE}:{type:'text_delta',text:'Public task result verified.'}},
          {type:'content_block_stop',index:0},
          {type:'message_delta',delta:{stop_reason:n===1?'max_tokens':'end_turn',stop_sequence:null},usage:{output_tokens:n===1?8192:15}},
          {type:'message_stop'},
        ]
        return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}})
      }
      const chunk={id:'fixture-'+n,object:'chat.completion.chunk',created:1,model:'qwen3.8-flash',
        choices:[{index:0,delta:n===1?{reasoning_content:PRIVATE}:{content:'Public task result verified.'},finish_reason:n===1?'length':'stop'}],
        usage:{prompt_tokens:n===1?20:40,completion_tokens:n===1?8192:15,total_tokens:n===1?8212:55}}
      return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})
    }))
    f.llm=provider==='anthropic'
      ? new AnthropicAdapter('qwen3.8-flash','fixture-key','http://model.invalid',{'X-Access-Token':'fixture-token'})
      :new OpenAIAdapter('qwen3.8-flash','fixture-key','http://model.invalid',false,{'X-Access-Token':'fixture-token'})
    const frames:string[]=[]
    for await(const frame of new ReActStrategy(f.llm,{thinkingEnabled:true}).run('approved task',f.ctx))frames.push(frame)
    expect(requests).toBe(2)
    expect(bodies[0].max_tokens).toBe(8192)
    expect(bodies[1].max_tokens).toBe(16_384)
    expect(attempts.filter(event=>event.type==='start').map(event=>event.maxOutputTokens)).toEqual([8192,16_384])
    expect(budget.snapshot).toMatchObject({charged:8267,reserved:0,remaining:Infinity})
    expect(body(frames)).toBe('Public task result verified.')
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
    expect(f.appended.find(m=>m.metadata?.outputReasoningRecovery)).toMatchObject({reasoningContent:PRIVATE,usage:{promptTokens:20,completionTokens:8192}})
  })
})

describe('reasoning recovery retained in real storage',()=>{
  it.each(['jsonl','sqlite'] as const)('%s retains distinct billing records and final assistant identity',async kind=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aether-reasoning-recovery-'))
    vi.stubEnv('DATA_DIR',path.join(dir,'agent.db'))
    const db=new LocalSqliteProcessClient({url:`file:${path.join(dir,'agent.db').replace(/\\/g,'/')}`})
    vi.spyOn(database,'getDb').mockReturnValue(db)
    try{
      await createConversations(db)
      for(const column of ['message_id','model_id','reasoning_content','metadata'])await db.execute(`ALTER TABLE conversations ADD COLUMN ${column} TEXT`)
      const history=kind==='jsonl'?new JSONLConversationHistory():new SQLiteConversationHistory()
      const f=fixture();f.ctx.history=history;let calls=0
      f.llm.stream=vi.fn(async function*(messages){if(++calls===1)yield reasoning();else{expect(JSON.stringify(messages)).not.toContain(PRIVATE);yield answer()}})
      await f.run()
      const stored=await history.getFullHistory(f.ctx)
      const assistants=stored.filter(m=>m.role==='assistant')
      expect(assistants).toHaveLength(2)
      expect(assistants[0].id).not.toBe('final-answer')
      expect(assistants[0]).toMatchObject({reasoningContent:PRIVATE,metadata:{outputReasoningRecovery:true}})
      expect(assistants[1]).toMatchObject({id:'final-answer',content:'Public task result verified.'})
      expect(await history.getSessionUsage(f.ctx)).toMatchObject({promptTokens:60,completionTokens:8207,totalTokens:8267})
      if(history instanceof JSONLConversationHistory){
        await history.compress(f.ctx,async()=> 'Original task completed with a public result.',1)
        const reopened=new JSONLConversationHistory(), archived=await reopened.getArchive(f.ctx)
        expect(archived.messages.find(m=>m.metadata?.outputReasoningRecovery)?.reasoningContent).toBe(PRIVATE)
        expect(await reopened.getSessionUsage(f.ctx)).toMatchObject({promptTokens:60,completionTokens:8207,totalTokens:8267})
      }
    }finally{db.close();await db.whenClosed();vi.restoreAllMocks();vi.unstubAllEnvs();
      if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('aether-reasoning-recovery-'))throw new Error('Unsafe recovery fixture cleanup')
      fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:20})}
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, ToolResult, ToolCall } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { RequestBudget, type RequestAttempt } from '../../subagent/budget.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'
import { ReActStrategy, pairToolHistory, type ReActOptions } from '../react.js'
import { estimateRequestInput } from '../finalization.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import * as database from '../../../storage/sqlite/db.js'
import { up as createConversations } from '../../../storage/sqlite/migrations/001_initial.js'
import { up as createSessions } from '../../../storage/sqlite/migrations/009_add_sessions.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const notice = 'None of the tool calls in that response executed'
const unfinished = '{"task":"UNTRUSTED_ARGUMENT_INJECTION'
const tc = (id: string, args = unfinished, index = 0, name = 'subagent') => ({ id, name, args, index })
function fixture(profile: 'code' | 'general' = 'code') {
  const history: Message[] = [], outcomes: RunOutcome[] = [], attempts: RequestAttempt[] = []
  const budget = new RequestBudget(1_000_000)
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', rootRunId: 'root', turnId: 'turn',
    userMessageId: 'user', assistantMessageId: 'final-assistant', workspaceDir: '.',
    modelCaps: { contextWindow: 100_000 }, toolProfile: profile,
    requestBudget: budget, onRequestAttempt: (event: RequestAttempt) => { attempts.push(event); budget.observe(event) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => { if (!history.some(m => m.id === message.id)) history.push(message); return message.id! }),
      getHistory: vi.fn(async () => [...history]), getFullHistory: vi.fn(async () => [...history]),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
    },
    tools: {
      list: () => ['subagent', 'write_file'].map(name => ({ name, description: name, parameters: { type: 'object' } })),
      has: () => true, executionMode: (name: string) => name === 'subagent' ? 'subagent' : 'serial',
      preflight: vi.fn(async () => undefined as ToolResult | undefined),
      execute: vi.fn(async () => ({ success: true, output: 'approved work completed' })),
    },
    runObserver: { onToolStart: vi.fn(), onToolEnd: vi.fn(), onUsage: vi.fn(), onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }) },
  } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'model', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, content: 'done' } }) }
  async function run(options: ReActOptions = {}, onFrame?: (frame: string) => void, adapter = llm) {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(adapter, options).run('Implement the approved project.', ctx)) {
      frames.push(frame); onFrame?.(frame)
    }
    return frames
  }
  return { ctx, llm, run, history, outcomes, attempts, budget }
}
function pairIds(history: Message[]) {
  const calls = history.filter(m => m.toolCall).map(m => m.toolCall!.id).sort()
  const results = history.filter(m => m.role === 'tool').map(m => m.toolCallId).sort()
  expect(calls).toEqual(results)
  expect(new Set(calls).size).toBe(calls.length)
}
const usageFrames = (frames: string[]) => frames.filter(x => x.startsWith('\x00__usage__')).map(x => JSON.parse(x.slice('\x00__usage__'.length)))

async function withDurableHistory(backend: 'sqlite' | 'jsonl', check: (f: ReturnType<typeof fixture>, reload: () => Promise<Message[]>, usage: () => Promise<unknown>) => Promise<void>) {
  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-stream-disconnect-'))
  const dbPath = path.join(fixturePath, 'agent.db')
  vi.stubEnv('DATA_DIR', dbPath)
  const db = new LocalSqliteProcessClient({ url: 'file:' + dbPath })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  try {
    await createConversations(db); await createSessions(db)
    await db.execute('ALTER TABLE sessions ADD COLUMN metadata TEXT')
    for (const column of ['message_id', 'model_id', 'reasoning_content', 'metadata']) await db.execute('ALTER TABLE conversations ADD COLUMN ' + column + ' TEXT')
    const create = () => backend === 'sqlite' ? new SQLiteConversationHistory(1_000_000) : new JSONLConversationHistory(1_000_000)
    const f = fixture('general')
    f.ctx.history = create()
    await check(f, () => create().getFullHistory(f.ctx), () => create().getSessionUsage(f.ctx))
  } finally {
    db.close(); await db.whenClosed()
    if (path.dirname(fixturePath) !== path.resolve(os.tmpdir()) || !path.basename(fixturePath).startsWith('aether-stream-disconnect-')) throw new Error('Unsafe stream disconnect fixture cleanup')
    fs.rmSync(fixturePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
}

describe('safe regeneration after a terminal tool output limit', () => {
  it.each(['code', 'general'] as const)('interrupts the complete mixed batch in %s before admitting new complete calls', async profile => {
    const f = fixture(profile)
    let calls = 0
    f.llm.stream = vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      expect(options!.requestInputTokenEstimate).toBe(estimateRequestInput(messages, options!.systemPrompt, options!.tools!))
      expect(options!.requestInputTokenEstimate! + options!.maxTokens!).toBeLessThanOrEqual(100_000)
      const count = ++calls, id = 'attempt-' + count
      await options!.onRequestAttempt!({ type: 'start', requestAttemptId: id, provider: 'test', model: 'model', estimatedInputTokens: options!.requestInputTokenEstimate, maxOutputTokens: options!.maxTokens })
      await options!.onRequestAttempt!({ type: 'finish', requestAttemptId: id, provider: 'test', model: 'model', outcome: 'succeeded', usage: { promptTokens: count * 20, completionTokens: count * 5 } })
      if (count === 1) yield { done: true, reasoningContent: 'delegating review', finishReason: 'length', promptTokens: 20, completionTokens: 5,
        toolCalls: [tc('complete-but-unstarted', '{"path":"outside-scope","content":"unused"}', 0, 'write_file'), tc('truncated-child', unfinished, 1)] }
      else if (count === 2) {
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        expect(f.ctx.tools.preflight).not.toHaveBeenCalled()
        expect(options!.systemPrompt).toContain(notice)
        expect(options!.systemPrompt).not.toContain('UNTRUSTED_ARGUMENT_INJECTION')
        expect(options!.systemPrompt).not.toContain('outside-scope')
        expect(options!.tools!.map(t => t.name)).toEqual(['subagent', 'write_file'])
        expect(messages.filter(m => m.role === 'tool')).toHaveLength(2)
        expect(messages.filter(m => m.role === 'tool').every(m => m.metadata?.status === 'interrupted')).toBe(true)
        pairIds(messages)
        yield { done: true, finishReason: 'tool_calls', promptTokens: 40, completionTokens: 10,
          toolCalls: [tc('new-child', '{"task":"Review authorized brief.json."}')] }
      } else {
        expect(String(options!.systemPrompt)).not.toContain(notice)
        yield { done: true, content: 'verified', promptTokens: 60, completionTokens: 15 }
      }
    })
    const frames = await f.run()
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).toHaveBeenCalledWith('subagent', { task: 'Review authorized brief.json.' }, expect.anything())
    expect(f.ctx.tools.preflight).toHaveBeenCalledTimes(1)
    expect(f.history.find(m => m.toolCall?.id === 'truncated-child')!.toolCall).toMatchObject({ args: {}, _rawArgs: unfinished, _parseError: expect.any(String) })
    expect(f.history.find(m => m.metadata?.outputToolRecovery)).toMatchObject({ content: '', reasoningContent: 'delegating review', metadata: { partial: true, recoveryIndex: 1 }, usage: { promptTokens: 20, completionTokens: 5 } })
    expect(f.history.filter(m => m.role === 'user')).toHaveLength(1)
    expect(f.history.some(m => String(m.content).includes(notice))).toBe(false)
    expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(3)
    expect(f.attempts.filter(x => x.type === 'start')).toHaveLength(3)
    expect(f.attempts.filter(x => x.type === 'finish')).toHaveLength(3)
    expect(f.budget.snapshot).toMatchObject({ charged: 150, reserved: 0 })
    expect(usageFrames(frames).at(-1)).toMatchObject({ promptTokens: 120, completionTokens: 30, totalTokens: 150 })
    expect(f.outcomes).toEqual([{ status: 'succeeded', output: 'verified', stopReason: 'completed' }])
    pairIds(f.history)
  })

  it('retains distinct segments, the final reply and each request usage across multiple recoveries', async () => {
    const f = fixture(), raws = [unfinished + '-first', unfinished + '-second']
    let calls = 0
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      const count = ++calls
      if (count <= 2) yield { done: true, content: 'checkpoint-' + count, reasoningContent: 'reasoning-' + count, finishReason: 'length', promptTokens: count * 10, completionTokens: count * 3, toolCalls: [tc('partial-' + count, raws[count - 1])] }
      else yield { done: true, content: 'final', promptTokens: 30, completionTokens: 9 }
    })
    const frames = await f.run()
    const segments = f.history.filter(m => m.metadata?.outputToolRecovery)
    expect(segments).toHaveLength(2)
    expect(segments.map(m => m.content)).toEqual(['checkpoint-1', 'checkpoint-2'])
    expect(segments.map(m => m.metadata?.recoveryIndex)).toEqual([1, 2])
    expect(segments.map(m => m.usage?.completionTokens)).toEqual([3, 6])
    expect(segments.every(m => m.id !== 'final-assistant')).toBe(true)
    expect(f.history.find(m => m.id === 'final-assistant')).toMatchObject({ content: 'final', usage: { promptTokens: 30, completionTokens: 9 } })
    expect(new Set(f.history.map(m => m.id)).size).toBe(f.history.length)
    expect(f.history.filter(m => m.toolCall).map(m => (m.toolCall as ToolCall & { _rawArgs: string })._rawArgs)).toEqual(raws)
    expect(f.history.filter(m => m.role === 'user')).toHaveLength(1)
    expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(3)
    expect(usageFrames(frames).at(-1)).toMatchObject({ promptTokens: 60, completionTokens: 18, totalTokens: 78 })
    expect(f.outcomes).toEqual([{ status: 'succeeded', output: 'checkpoint-1checkpoint-2final', stopReason: 'completed' }])
    pairIds(f.history)
  })

  it('keeps regenerating identical incomplete arguments without imposing a retry ceiling', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* (_messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      const count = ++calls
      if (count <= 12) {
        if (count > 2) expect(options!.systemPrompt).toContain('Reduce the next argument payload further')
        yield { done: true, finishReason: 'length', promptTokens: 10, completionTokens: 3, toolCalls: [tc('same-provider-id')] }
      } else if (count === 13) yield { done: true, toolCalls: [tc('same-provider-id', '{"task":"Review authorized brief.json."}')] }
      else yield { done: true, content: 'done' }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(14)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.preflight).toHaveBeenCalledTimes(1)
    expect(f.history.filter(m => m.role === 'tool')).toHaveLength(13)
    expect(f.history.filter(m => m.metadata?.outputToolRecovery)).toHaveLength(12)
    expect(f.history.filter(m => m.metadata?.outputToolRecovery).every(m => m.usage?.completionTokens === 3)).toBe(true)
    expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(14)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: 'done' })
    pairIds(f.history)
    expect(f.history.filter(m => m.toolCall).slice(1).every(m => m.metadata?.providerToolCallId === 'same-provider-id')).toBe(true)
    expect(pairToolHistory(f.history).map(m => m.id)).toEqual(f.history.map(m => m.id))
  })

  it('buffers args and names before a real provider ID and keeps the generated ID stable across later chunks', async () => {
    const f = fixture()
    let calls = 0, baselineStarts = 0
    const frames: string[] = []
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (++calls === 1) yield { done: true, finishReason: 'length', toolCalls: [tc('same-provider')] }
      else if (calls === 2) {
        baselineStarts = frames.filter(x => x.startsWith('\x00__tool_start__')).length
        yield { done: false, toolCalls: [{ args: '{"task":"', index: 0 }] }
        yield { done: false, toolCalls: [{ name: 'subagent', args: 'Review authorized brief.json."', index: 0 }] }
        expect(frames.filter(x => x.startsWith('\x00__tool_start__'))).toHaveLength(baselineStarts)
        yield { done: false, toolCalls: [{ id: 'same-provider', args: '}', index: 0 }] }
        yield { done: false, toolCalls: [{ id: 'later-provider-id', index: 0 }] }
        yield { done: true, finishReason: 'tool_calls' }
      } else yield { done: true, content: 'done' }
    })
    await f.run({}, frame => frames.push(frame))
    const call = f.history.find(m => m.toolCall && m.metadata?.providerToolCallId === 'same-provider')!
    expect(call.toolCall!.id).toMatch(/^call_/)
    expect(call.toolCall!.id).not.toBe('same-provider')
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    const regenerated = frames.filter(x => x.startsWith('\x00__tool_start__') || x.startsWith('\x00__tool_args__') || x.startsWith('\x00__tool_call__') || x.startsWith('\x00__tool_result__'))
      .map(x => JSON.parse(x.slice(x.indexOf('__', 3) + 2))).filter(x => x.toolCallId !== 'same-provider')
    expect(new Set(regenerated.map(x => x.toolCallId))).toEqual(new Set([call.toolCall!.id]))
    expect(f.ctx.runObserver!.onToolStart).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: call.toolCall!.id }))
    expect(f.ctx.runObserver!.onToolEnd).toHaveBeenLastCalledWith(expect.objectContaining({ toolCallId: call.toolCall!.id }))
    pairIds(f.history)
  })

  it('preserves the provider ID and the stable internal ID when regeneration fails in transport', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (++calls === 1) yield { done: true, finishReason: 'length', toolCalls: [tc('same-provider')] }
      else { yield { done: false, toolCalls: [tc('same-provider')] }; throw new Error('socket disconnected') }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    const recovered = f.history.find(m => m.toolCall && m.metadata?.providerToolCallId === 'same-provider')!
    expect(recovered.toolCall!.id).not.toBe('same-provider')
    expect(recovered.metadata?.interruptedToolArguments).toMatchObject({ raw: unfinished })
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'provider_error' })
    pairIds(f.history)
  })

  it('does not mistake an earlier terminal frame for a later nonterminal length marker', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, finishReason: 'stop' }
      yield { done: false, finishReason: 'length', toolCalls: [tc('invalid-terminal-sequence')] }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it('keeps text suffix continuation separate from tool-call regeneration', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      switch (++calls) {
        case 1: yield { done: true, content: '[', finishReason: 'length' }; break
        case 2:
          expect(messages.at(-1)!.content).toContain('starting exactly where the response stopped')
          yield { done: true, finishReason: 'length', toolCalls: [tc('separate-fragment')] }; break
        case 3:
          expect(options!.systemPrompt).toContain(notice)
          expect(messages.some(m => String(m.content).includes('starting exactly where the response stopped'))).toBe(false)
          yield { done: true, content: 'verified', finishReason: 'length' }; break
        default:
          expect(String(options!.systemPrompt)).not.toContain(notice)
          expect(messages.at(-1)!.content).toContain('starting exactly where the response stopped')
          yield { done: true, content: ']' }
      }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(4)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.history.filter(m => m.role === 'user')).toHaveLength(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: '[verified]' })
    pairIds(f.history)
  })

  it('honors cancellation at the initial usage frame before dispatching a model request', async () => {
    const f = fixture(), controller = new AbortController()
    f.ctx.signal = controller.signal
    await f.run({}, frame => { if (frame.startsWith('\x00__usage__')) controller.abort() })
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' })
  })

  it('does not infer recoverability from a nonterminal length marker', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: false, finishReason: 'length', toolCalls: [tc('no-terminal')], completionTokens: 8192 } })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it.each(['transport', '400'])('does not recover a %s failure following a partial announcement', async kind => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: false, completionTokens: 8192, toolCalls: [tc('unstarted-error')] }
      throw Object.assign(new Error(kind === '400' ? '400 Repetitive tool calls' : 'socket disconnected'), { status: kind === '400' ? 400 : undefined })
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'provider_error' })
    expect(f.history.find(m => m.role === 'tool')).toMatchObject({ metadata: { status: 'interrupted' } })
  })

  it('does not recover an explicit terminal provider error', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, finishReason: 'error', toolCalls: [tc('error')] } })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'provider_error' })
  })

  it('honors cancellation during interruption settlement without another dispatch', async () => {
    const f = fixture(), controller = new AbortController()
    f.ctx.signal = controller.signal
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, finishReason: 'length', toolCalls: [tc('first'), tc('second', unfinished, 1)] } })
    await f.run({}, frame => { if (frame.startsWith('\x00__tool_result__')) controller.abort() })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' })
    expect(f.history.filter(m => m.role === 'tool')).toHaveLength(2)
    pairIds(f.history)
  })

  it('retains the normal permission gate for newly generated complete calls', async () => {
    const f = fixture()
    f.ctx.tools.preflight = vi.fn(async () => ({ success: false, output: 'Approval required', needsConfirmation: true }))
    let calls = 0
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (++calls === 1) yield { done: true, finishReason: 'length', toolCalls: [tc('incomplete')] }
      else yield { done: true, toolCalls: [tc('new-write', '{"path":"protected","content":"new"}', 0, 'write_file')] }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.ctx.tools.preflight).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'blocked', stopReason: 'permission' })
  })

  it('rechecks the context window before attempting regeneration', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 6_000 }
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, finishReason: 'length', toolCalls: [tc('too-large')] }
      f.ctx.modelCaps!.contextWindow = 256
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit' })
    expect(f.history.find(m => m.toolCall)?.toolCall).toMatchObject({ _rawArgs: unfinished })
  })

  it.each(['partial', 'announcement', 'result', 'observer'] as const)('does not dispatch recovery after %s persistence fails', async failure => {
    const f = fixture(), append = f.ctx.history.append
    f.ctx.history.append = vi.fn(async (message: Message, ctx: AgentContext) => {
      if (failure === 'partial' && message.metadata?.outputToolRecovery
        || failure === 'announcement' && message.toolCall?.id === 'first-fault'
        || failure === 'result' && message.role === 'tool' && message.toolCallId === 'first-fault') throw new Error('injected storage fault')
      return append(message, ctx)
    })
    if (failure === 'observer') f.ctx.runObserver!.onToolEnd = vi.fn(async () => { throw new Error('injected observer fault') })
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, finishReason: 'length', toolCalls: [tc('first-fault'), tc('second-fault', unfinished, 1)] } })
    const frames = await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.ctx.tools.preflight).not.toHaveBeenCalled()
    expect(f.history.find(m => m.role === 'tool' && m.toolCallId === 'second-fault')).toMatchObject({ metadata: { status: 'interrupted' } })
    expect(frames.filter(x => x.startsWith('\x00__tool_result__'))).toHaveLength(2)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'runtime_error', error: { code: 'PERSISTENCE_ERROR' } })
  })

  it.each(['\x00__tool_end__', '\x00__usage__'])('settles all announced siblings before a viewer disconnects at the recovery %s frame', async prefix => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, finishReason: 'length', toolCalls: [tc('first-viewer'), tc('second-viewer', unfinished, 1)] } })
    for await (const frame of new ReActStrategy(f.llm).run('Implement approved work.', f.ctx)) {
      if (f.history.some(m => m.metadata?.outputToolRecovery) && frame.startsWith(prefix)) break
    }
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.history.filter(m => m.role === 'tool')).toHaveLength(2)
    expect(f.history.filter(m => m.role === 'tool').every(m => m.metadata?.status === 'interrupted')).toBe(true)
    pairIds(f.history)
  })

  for (const backend of ['sqlite', 'jsonl'] as const) for (const recovered of [false, true]) {
    it.each(['start', 'args', 'terminal-context', 'catch-context'] as const)(`durably settles the complete chunk on ${backend} %s return (recovered IDs: ${recovered})`, async point => {
      await withDurableHistory(backend, async (f, reload, usage) => {
        let calls = 0, returned = false
        const targetRequest = recovered ? 2 : 1
        const fragment = '{"task":"keep original raw fragment"'
        f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
          const current = ++calls
          if (recovered && current === 1) {
            yield { done: true, finishReason: 'length', promptTokens: 10, completionTokens: 3, toolCalls: [tc('repeat-provider')] }
            return
          }
          yield { done: point === 'terminal-context', finishReason: point === 'terminal-context' ? 'tool_calls' : undefined,
            content: 'retained checkpoint', reasoningContent: 'retained reasoning', promptTokens: 23, completionTokens: 7,
            toolCalls: [tc('repeat-provider', fragment), tc('sibling-provider', '{"path":"sibling.txt"}', 1, 'write_file')] }
          if (point === 'catch-context') throw new Error('socket disconnected after announcement')
          yield { done: true, content: 'must never be received' }
        })
        for await (const frame of new ReActStrategy(f.llm).run('Implement approved work.', f.ctx)) {
          if (calls !== targetRequest) continue
          const isTarget = point === 'start' && frame.startsWith('\x00__tool_start__')
            || point === 'args' && frame.startsWith('\x00__tool_args__')
            || point === 'terminal-context' && frame.startsWith('\x00__usage__') && JSON.parse(frame.slice('\x00__usage__'.length)).currentPromptTokens === 23
            || point === 'catch-context' && frame.startsWith('\x00__usage__') && JSON.parse(frame.slice('\x00__usage__'.length)).totalTokens !== undefined
          if (isTarget) { returned = true; break }
        }
        expect(returned).toBe(true)
        expect(f.llm.stream).toHaveBeenCalledTimes(targetRequest)
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        expect(f.ctx.tools.preflight).not.toHaveBeenCalled()
        const messages = await reload()
        const announcements = messages.filter(m => m.toolCall).slice(recovered ? 1 : 0)
        expect(announcements).toHaveLength(2)
        expect(announcements.map(m => (m.metadata?.interruptedToolArguments as { raw: string }).raw)).toEqual([fragment, '{"path":"sibling.txt"}'])
        expect(announcements[0].metadata?.interruptedToolArguments).toMatchObject({ parseError: expect.any(String) })
        expect(announcements.every(m => Object.keys(m.toolCall!.args).length === 0)).toBe(true)
        if (recovered) {
          expect(announcements.map(m => m.metadata?.providerToolCallId)).toEqual(['repeat-provider', 'sibling-provider'])
          expect(announcements.every(m => m.toolCall!.id.startsWith('call_'))).toBe(true)
        }
        expect(messages.filter(m => m.role === 'tool')).toHaveLength(2 + (recovered ? 1 : 0))
        expect(messages.filter(m => m.role === 'tool').every(m => m.metadata?.status === 'interrupted')).toBe(true)
        expect(messages.find(m => m.id === 'final-assistant')).toMatchObject({ content: 'retained checkpoint', reasoningContent: 'retained reasoning',
          metadata: { partial: true, stopReason: point === 'catch-context' ? 'provider_error' : 'incomplete' }, usage: { promptTokens: 23, completionTokens: 7 } })
        expect(await usage()).toMatchObject({ promptTokens: 23 + (recovered ? 10 : 0), completionTokens: 7 + (recovered ? 3 : 0), totalTokens: 30 + (recovered ? 13 : 0) })
        expect(f.ctx.runObserver!.onToolEnd).toHaveBeenCalledTimes(2 + (recovered ? 1 : 0))
        expect(f.outcomes).toEqual(point === 'catch-context'
          ? [{ status: 'failed', stopReason: 'provider_error', partialOutput: 'retained checkpoint', error: {
              code: 'PROVIDER_ERROR', message: 'socket disconnected after announcement', retryable: false } }]
          : [{ status: 'failed', stopReason: 'incomplete' }])
        pairIds(messages)
        expect(pairToolHistory(messages).map(m => m.id)).toEqual(messages.map(m => m.id))
      })
    })
  }

  for (const backend of ['sqlite', 'jsonl'] as const) {
    it.each(['none', 'partial', 'announcement', 'result', 'observer'] as const)(`settles the complete ${backend} response on usage callback failure (${backend}: %s save fault)`, async failure => {
      await withDurableHistory(backend, async (f, reload, usage) => {
        const append = f.ctx.history.append.bind(f.ctx.history)
        f.ctx.history.append = vi.fn(async (message: Message, ctx: AgentContext) => {
          if (failure === 'partial' && message.metadata?.partial
            || failure === 'announcement' && message.toolCall?.id === 'usage-one'
            || failure === 'result' && message.role === 'tool' && message.toolCallId === 'usage-one') throw new Error('injected usage cleanup storage fault')
          return append(message, ctx)
        })
        if (failure === 'observer') f.ctx.runObserver!.onToolEnd = vi.fn(async event => {
          if (event.toolCallId === 'usage-one') throw new Error('injected usage cleanup observer fault')
        })
        f.ctx.runObserver!.onUsage = vi.fn(async () => { throw new Error('usage observer failed') })
        f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
          yield { done: true, finishReason: 'length', content: 'complete checkpoint', reasoningContent: 'complete reasoning', promptTokens: 23, completionTokens: 7,
            toolCalls: [tc('usage-one', '{"task":"Review brief.json."}'), tc('usage-two', '{"path":"untouched.txt"}', 1, 'write_file')] }
        })
        const frames = await f.run()
        const messages = await reload()
        expect(messages.find(m => m.toolCall?.id === 'usage-two')).toBeDefined()
        expect(messages.find(m => m.role === 'tool' && m.toolCallId === 'usage-two')).toMatchObject({ metadata: { status: 'interrupted' } })
        if (failure !== 'partial') {
          expect(messages.find(m => m.id === 'final-assistant')).toMatchObject({ content: 'complete checkpoint', reasoningContent: 'complete reasoning',
            metadata: { partial: true, stopReason: 'runtime_error' }, usage: { promptTokens: 23, completionTokens: 7 } })
          expect(await usage()).toMatchObject({ promptTokens: 23, completionTokens: 7, totalTokens: 30 })
        }
        if (failure === 'none') {
          expect(messages.filter(m => m.toolCall).map(m => (m.metadata?.interruptedToolArguments as { raw: string }).raw)).toEqual(['{"task":"Review brief.json."}', '{"path":"untouched.txt"}'])
          expect(f.outcomes).toEqual([{ status: 'failed', stopReason: 'runtime_error', partialOutput: 'complete checkpoint',
            error: { code: 'RUNTIME_ERROR', message: 'usage observer failed', retryable: false } }])
          pairIds(messages)
        } else {
          expect(f.outcomes).toEqual([{ status: 'failed', stopReason: 'runtime_error', partialOutput: 'complete checkpoint',
            error: { code: 'PERSISTENCE_ERROR', message: expect.stringContaining('Cause: usage observer failed'), retryable: false } }])
        }
        expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(1)
        expect(f.ctx.runObserver!.onToolEnd).toHaveBeenCalledTimes(2)
        expect(f.llm.stream).toHaveBeenCalledTimes(1)
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        expect(f.ctx.tools.preflight).not.toHaveBeenCalled()
        expect(frames.filter(x => x.startsWith('\x00__tool_result__'))).toHaveLength(2)
        expect(frames.at(-1)).toContain('usage observer failed')
      })
    })

    it(`retains the entire ${backend} chunk when the output callback fails before tool frames`, async () => {
      await withDurableHistory(backend, async (f, reload, usage) => {
        f.ctx.runObserver!.onOutput = vi.fn(async () => { throw new Error('output observer disconnected') })
        f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
          yield { done: true, content: 'already delivered text', reasoningContent: 'same chunk reasoning', promptTokens: 23, completionTokens: 7,
            toolCalls: [tc('callback-one'), tc('callback-two', unfinished, 1)] }
        })
        const frames = await f.run()
        const messages = await reload()
        expect(messages.filter(m => m.toolCall).map(m => (m.metadata?.interruptedToolArguments as { raw: string }).raw)).toEqual([unfinished, unfinished])
        expect(messages.filter(m => m.role === 'tool')).toHaveLength(2)
        expect(messages.filter(m => m.role === 'tool').every(m => m.metadata?.status === 'interrupted')).toBe(true)
        expect(messages.find(m => m.id === 'final-assistant')).toMatchObject({ content: 'already delivered text', reasoningContent: 'same chunk reasoning',
          metadata: { partial: true, stopReason: 'provider_error' }, usage: { promptTokens: 23, completionTokens: 7 } })
        expect(await usage()).toMatchObject({ promptTokens: 23, completionTokens: 7, totalTokens: 30 })
        expect(f.outcomes).toEqual([{ status: 'failed', stopReason: 'provider_error', partialOutput: 'already delivered text',
          error: { code: 'PROVIDER_ERROR', message: 'output observer disconnected', retryable: false } }])
        expect(f.llm.stream).toHaveBeenCalledTimes(1)
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        expect(f.ctx.tools.preflight).not.toHaveBeenCalled()
        expect(frames.filter(x => x.startsWith('\x00__tool_result__'))).toHaveLength(2)
        pairIds(messages)
      })
    })

    it.each(['cancelled', 'budget'] as const)(`retains the known %s outcome on a ${backend} catch usage return`, async reason => {
      await withDurableHistory(backend, async (f, reload) => {
        const controller = new AbortController()
        f.ctx.signal = controller.signal
        f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
          yield { done: false, content: 'known partial', promptTokens: 23, completionTokens: 7,
            toolCalls: [tc('known-one'), tc('known-two', unfinished, 1)] }
          if (reason === 'cancelled') { controller.abort(); throw new DOMException('cancelled by user', 'AbortError') }
          throw Object.assign(new Error('request budget exhausted'), { code: 'TOKEN_BUDGET_EXCEEDED' })
        })
        let returned = false
        for await (const frame of new ReActStrategy(f.llm).run('Implement approved work.', f.ctx)) {
          if (frame.startsWith('\x00__usage__') && JSON.parse(frame.slice('\x00__usage__'.length)).totalTokens !== undefined) { returned = true; break }
        }
        expect(returned).toBe(true)
        const messages = await reload()
        expect(messages.filter(m => m.role === 'tool')).toHaveLength(2)
        expect(messages.filter(m => m.role === 'tool').every(m => m.metadata?.status === (reason === 'cancelled' ? 'cancelled' : 'interrupted'))).toBe(true)
        expect(f.outcomes).toEqual(reason === 'cancelled'
          ? [{ status: 'cancelled', stopReason: 'cancelled', partialOutput: 'known partial' }]
          : [{ status: 'failed', stopReason: 'budget', partialOutput: 'known partial', error: {
              code: 'TOKEN_BUDGET_EXCEEDED', message: 'request budget exhausted', retryable: false } }])
        expect(f.llm.stream).toHaveBeenCalledTimes(1)
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        pairIds(messages)
      })
    })

    it(`settles all received siblings as cancelled on a ${backend} viewer abort`, async () => {
      await withDurableHistory(backend, async (f, reload) => {
        const controller = new AbortController()
        f.ctx.signal = controller.signal
        f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
          yield { done: false, toolCalls: [tc('cancel-one'), tc('cancel-two', unfinished, 1)], promptTokens: 23, completionTokens: 7 }
          yield { done: true, content: 'must never be received' }
        })
        for await (const frame of new ReActStrategy(f.llm).run('Implement approved work.', f.ctx)) {
          if (frame.startsWith('\x00__tool_start__')) { controller.abort(); break }
        }
        const messages = await reload()
        expect(messages.filter(m => m.role === 'tool')).toHaveLength(2)
        expect(messages.filter(m => m.role === 'tool').every(m => m.metadata?.status === 'cancelled')).toBe(true)
        expect(f.outcomes).toEqual([{ status: 'cancelled', stopReason: 'cancelled' }])
        expect(f.llm.stream).toHaveBeenCalledTimes(1)
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        pairIds(messages)
      })
    })

    it.each(['partial', 'announcement', 'result', 'observer'] as const)(`reports ${backend} %s save failure during return without abandoning later siblings`, async failure => {
      await withDurableHistory(backend, async (f, reload) => {
        const append = f.ctx.history.append.bind(f.ctx.history)
        f.ctx.history.append = vi.fn(async (message: Message, ctx: AgentContext) => {
          if (failure === 'partial' && message.metadata?.partial
            || failure === 'announcement' && message.toolCall?.id === 'fault-one'
            || failure === 'result' && message.role === 'tool' && message.toolCallId === 'fault-one') throw new Error('injected return storage fault')
          return append(message, ctx)
        })
        if (failure === 'observer') f.ctx.runObserver!.onToolEnd = vi.fn(async event => {
          if (event.toolCallId === 'fault-one') throw new Error('injected return observer fault')
        })
        f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
          yield { done: false, promptTokens: 23, completionTokens: 7, toolCalls: [tc('fault-one'), tc('fault-two', unfinished, 1)] }
          yield { done: true, content: 'must never be received' }
        })
        for await (const frame of new ReActStrategy(f.llm).run('Implement approved work.', f.ctx)) {
          if (frame.startsWith('\x00__tool_start__')) break
        }
        const messages = await reload()
        expect(messages.find(m => m.toolCall?.id === 'fault-two')).toBeDefined()
        expect(messages.find(m => m.role === 'tool' && m.toolCallId === 'fault-two')).toMatchObject({ metadata: { status: 'interrupted' } })
        expect(f.outcomes).toEqual([{ status: 'failed', stopReason: 'runtime_error', partialOutput: '', error: {
          code: 'PERSISTENCE_ERROR', message: expect.stringContaining('(incomplete)'), retryable: false } }])
        expect(f.llm.stream).toHaveBeenCalledTimes(1)
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        expect(f.ctx.tools.preflight).not.toHaveBeenCalled()
        expect(f.ctx.runObserver!.onToolEnd).toHaveBeenCalledTimes(2)
      })
    })
  }

  it('does not JSON-repair a normal max_tokens fragment before retaining it', async () => {
    const f = fixture(), raw = '{"task":"repairable but incomplete"'
    let calls = 0
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (++calls === 1) yield { done: true, finishReason: 'length', toolCalls: [tc('repairable', raw)] }
      else yield { done: true, content: 'remaining work explained' }
    })
    await f.run()
    const retained = f.history.find(m => m.toolCall?.id === 'repairable')!
    expect(retained.toolCall!.args).toEqual({})
    expect(retained.metadata?.interruptedToolArguments).toMatchObject({ raw, parseError: expect.any(String) })
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it.each(['sqlite', 'jsonl'] as const)('retains original fragments, distinct segment IDs and exact usage through a real %s restart', async backend => {
    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-output-recovery-'))
    const dbPath = path.join(fixturePath, 'agent.db')
    vi.stubEnv('DATA_DIR', dbPath)
    const db = new LocalSqliteProcessClient({ url: 'file:' + dbPath })
    vi.spyOn(database, 'getDb').mockReturnValue(db)
    try {
      await createConversations(db); await createSessions(db)
      await db.execute('ALTER TABLE sessions ADD COLUMN metadata TEXT')
      for (const column of ['message_id', 'model_id', 'reasoning_content', 'metadata']) await db.execute('ALTER TABLE conversations ADD COLUMN ' + column + ' TEXT')
      const create = () => backend === 'sqlite' ? new SQLiteConversationHistory(1_000_000) : new JSONLConversationHistory(1_000_000)
      const f = fixture('general'), storage = create()
      f.ctx.history = storage
      const raws = Array.from({ length: 12 }, () => '{"task":"same incomplete"')
      let calls = 0
      f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
        const count = ++calls
        if (count <= 12) yield { done: true, reasoningContent: 'reasoning-' + count, finishReason: 'length', promptTokens: 10, completionTokens: 3, toolCalls: [tc('same-provider', raws[count - 1])] }
        else if (count === 13) yield { done: true, promptTokens: 20, completionTokens: 4, toolCalls: [tc('same-provider', '{"task":"Review authorized brief.json."}')] }
        else yield { done: true, content: 'final reply', promptTokens: 30, completionTokens: 5 }
      })
      await f.run()
      const restarted = create(), messages = await restarted.getFullHistory(f.ctx)
      const segments = messages.filter(m => m.metadata?.outputToolRecovery)
      expect(segments).toHaveLength(12)
      expect(segments.map(m => m.reasoningContent)).toEqual(Array.from({ length: 12 }, (_, i) => 'reasoning-' + (i + 1)))
      expect(segments.map(m => m.usage?.completionTokens)).toEqual(Array.from({ length: 12 }, () => 3))
      expect(messages.find(m => m.id === 'final-assistant')).toMatchObject({ content: 'final reply', usage: { promptTokens: 30, completionTokens: 5 } })
      expect(new Set(messages.map(m => m.id)).size).toBe(messages.length)
      const announcements = messages.filter(m => m.toolCall && m.metadata?.interruptedToolArguments)
      expect(announcements.map(m => (m.metadata?.interruptedToolArguments as { raw: string }).raw)).toEqual(raws)
      expect(announcements.every(m => (m.metadata?.interruptedToolArguments as { parseError: string }).parseError)).toBe(true)
      expect(messages.filter(m => m.role === 'user')).toHaveLength(1)
      expect(messages.filter(m => m.role === 'tool' && m.metadata?.status === 'interrupted')).toHaveLength(12)
      expect(messages.filter(m => m.toolCall).slice(1).every(m => m.metadata?.providerToolCallId === 'same-provider')).toBe(true)
      expect(messages.some(m => String(m.content).includes(notice))).toBe(false)
      expect(await restarted.getSessionUsage(f.ctx)).toMatchObject({ promptTokens: 170, completionTokens: 45, totalTokens: 215 })
      expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: 'final reply' })
      expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
      pairIds(messages)
      expect(pairToolHistory(messages).map(m => m.id)).toEqual(messages.map(m => m.id))
    } finally {
      db.close(); await db.whenClosed()
      if (path.dirname(fixturePath) !== path.resolve(os.tmpdir()) || !path.basename(fixturePath).startsWith('aether-output-recovery-')) throw new Error('Unsafe output recovery fixture cleanup')
      fs.rmSync(fixturePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('honors explicit iteration limits instead of starting a regeneration request', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, finishReason: 'length', toolCalls: [tc('last-iteration')] } })
    await f.run({ maxIterations: 1 })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it('cannot recover again after the physical request budget has been exhausted', async () => {
    const f = fixture(), budget = new RequestBudget(100_000)
    f.ctx.requestBudget = budget
    f.ctx.onRequestAttempt = event => { budget.observe(event) }
    let calls = 0
    f.llm.stream = vi.fn(async function* (_messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      const id = 'physical-' + ++calls
      await options!.onRequestAttempt!({ type: 'start', requestAttemptId: id, provider: 'test', model: 'model', estimatedInputTokens: options!.requestInputTokenEstimate, maxOutputTokens: options!.maxTokens })
      await options!.onRequestAttempt!({ type: 'finish', requestAttemptId: id, provider: 'test', model: 'model', outcome: 'succeeded', usage: { promptTokens: 99_000, completionTokens: 1_000 } })
      yield { done: true, finishReason: 'length', promptTokens: 99_000, completionTokens: 1_000, toolCalls: [tc('first-limit')] }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(budget.snapshot).toMatchObject({ charged: 100_000, reserved: 0, remaining: 0 })
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'budget' })
  })

  it('does not regenerate a tool batch during reserved finalization', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* (_messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      if (++calls === 1) yield { done: true, finishReason: 'length', toolCalls: [tc('first')] }
      else {
        expect(options!.tools).toEqual([])
        yield { done: true, finishReason: 'length', toolCalls: [tc('finalization-must-not-run')] }
      }
    })
    await f.run({ maxIterations: 2, finalizeOnLimit: true })
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'max_steps' })
  })

  it('recovers an actual Anthropic SDK max_tokens partial tool wire without executing the fragment', async () => {
    const f = fixture('general'), bodies: Record<string, unknown>[] = []
    let request = 0
    const sse = (id: string, raw: string | undefined, reason: string, text = 'verified') => {
      const message = { id: 'message-' + id, type: 'message', role: 'assistant', model: 'deepseek-v4.1-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } }
      const events = [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: raw === undefined ? { type: 'text', text: '' } : { type: 'tool_use', id, name: 'subagent', input: {} } },
        { type: 'content_block_delta', index: 0, delta: raw === undefined ? { type: 'text_delta', text } : { type: 'input_json_delta', partial_json: raw } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: reason === 'max_tokens' ? 8192 : 10 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      bodies.push(JSON.parse(String(init?.body)))
      const count = ++request
      if (count === 2) {
        expect(f.ctx.tools.execute).not.toHaveBeenCalled()
        expect(String(bodies[1].system)).toContain(notice)
        expect(JSON.stringify(bodies[1])).toContain('Model response ended before this tool could execute')
      }
      return count === 1 ? sse('sdk-partial', unfinished, 'max_tokens') : count === 2 ? sse('sdk-text', undefined, 'max_tokens', '[')
        : count === 3 ? sse('sdk-partial', '{"task":"Review authorized brief.json."}', 'tool_use') : sse('sdk-final', undefined, 'end_turn', ']')
    }))
    const adapter = new AnthropicAdapter('local-test', 'deepseek-v4.1-flash', 'http://127.0.0.1:1', { 'X-Access-Token': 'local-test-token' })
    await f.run({}, undefined, adapter)
    expect(request).toBe(4)
    expect(bodies[0].max_tokens).toBe(8192)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).toHaveBeenCalledWith('subagent', { task: 'Review authorized brief.json.' }, expect.anything())
    expect(f.history.find(m => m.toolCall?.id === 'sdk-partial')!.toolCall).toMatchObject({ _rawArgs: unfinished })
    expect(f.history.find(m => m.metadata?.outputToolRecovery)!.usage).toMatchObject({ promptTokens: 20, completionTokens: 8192 })
    expect(f.history.find(m => m.toolCall && m.metadata?.providerToolCallId === 'sdk-partial')!.toolCall!.id).not.toBe('sdk-partial')
    expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(4)
    expect(f.attempts.filter(x => x.type === 'start')).toHaveLength(4)
    expect(f.budget.snapshot).toMatchObject({ charged: 16484, reserved: 0 })
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: '[]' })
    pairIds(f.history)
  })
})

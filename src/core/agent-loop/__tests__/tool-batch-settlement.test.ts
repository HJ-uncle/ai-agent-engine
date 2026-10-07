import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Pending, ToolCall, ToolResult } from '../../agent-context/index.js'
import type { LLMAdapter } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllEnvs() })

function fixture(calls: ToolCall[]) {
  const history: Message[] = []
  const outcomes: unknown[] = []
  let requestCount = 0
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', rootRunId: 'root-1', turnId: 'turn-1',
    userMessageId: 'user-1', assistantMessageId: 'assistant-1', workspaceDir: '.', tokenBudget: 100_000,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'test' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: vi.fn(async () => 0),
    },
    tools: { list: () => [], has: () => true, preflight: vi.fn(async () => undefined as ToolResult | undefined),
      executionMode: vi.fn(() => 'serial'), execute: vi.fn(async () => ({ success: true, output: 'ok' } as ToolResult)) },
    runObserver: { onOutcome: vi.fn(async outcome => { outcomes.push(outcome) }), onToolStart: vi.fn(), onToolEnd: vi.fn() },
    onPending: vi.fn(async (_pending: Pending) => {}),
  } as unknown as AgentContext
  const llm = { model: 'test', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* () {
      if (requestCount++ === 0 && calls.length) yield { done: true, toolCalls: calls.map((call, index) => ({ ...call, args: JSON.stringify(call.args), index })) }
      else yield { done: true, content: 'done' }
    }) } as LLMAdapter
  async function run(input: string | null = 'task') {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, { maxIterations: 3 }).run(input, ctx)) frames.push(frame)
    return frames
  }
  return { ctx, llm, history, outcomes, run }
}
const call = (id: string, name = 'write_file'): ToolCall => ({ id, name, args: { path: `${id}.txt` } })
const toolResults = (frames: string[]) => frames.filter(frame => frame.startsWith('\x00__tool_result__')).map(frame => JSON.parse(frame.slice('\x00__tool_result__'.length)))

describe('D3 batch side effects and terminal evidence', () => {
  it('keeps the complete tool result in Code mode instead of applying the chat truncation cap', async () => {
    const f = fixture([call('large', 'read_file')])
    const content = 'source line\n'.repeat(1_000)
    f.ctx.toolProfile = 'code'
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output: content }))
    await f.run()
    const result = f.history.find(message => message.role === 'tool')
    expect(result?.content).toBe(content)
  })

  it('preflights the entire batch before writing, persists pending before its event, and pairs every skipped sibling', async () => {
    const f = fixture([call('write-first'), call('approve', 'execute_cmd'), call('read-last', 'read_file')])
    let persisted = false
    f.ctx.tools.preflight = vi.fn(async name => name === 'execute_cmd' ? { success: false, output: 'approval required', needsConfirmation: true, pendingAction: { type: 'exec_policy' } } : undefined)
    f.ctx.onPending = vi.fn(async pending => { expect(pending).toMatchObject({ requestId: 'approve', toolCallId: 'approve', kind: 'permission' }); persisted = true })
    const frames = await f.run()
    expect(persisted).toBe(true)
    expect(f.ctx.tools.preflight).toHaveBeenCalledTimes(3)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['interrupted', 'waiting', 'interrupted'])
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['write-first', 'read-last'])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'blocked', stopReason: 'permission' })
  })

  it('an ask between siblings leaves no preceding orphan and performs no side effects', async () => {
    const f = fixture([call('before'), { id: 'ask', name: 'ask_user', args: { question: 'Choose a path' } }, call('after')])
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.ctx.onPending).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ask', requestId: 'ask', question: 'Choose a path' }))
    expect(toolResults(frames)).toHaveLength(3)
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['before', 'after'])
  })

  it('only proven read-only calls overlap and unknown tools execute one by one', async () => {
    const f = fixture([call('r1', 'read_file'), call('r2', 'read_file'), call('w1'), call('w2')])
    f.ctx.tools.executionMode = name => name === 'read_file' ? 'readonly' : 'serial'
    const running = new Set<string>()
    let readOverlap = false
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      const id = invocation.currentToolCallId!
      running.add(id)
      if (id === 'r2') readOverlap = running.has('r1')
      if (id.startsWith('w')) expect([...running]).toEqual([id])
      await new Promise(resolve => setTimeout(resolve, 5))
      running.delete(id)
      return { success: true, output: id }
    })
    await f.run()
    expect(readOverlap).toBe(true)
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(4)
  })

  it('settles every started sibling after a dynamic confirmation and a failure limit', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '1')
    const f = fixture([call('waiting', 'read_file'), call('failed', 'read_file'), call('finished', 'read_file')])
    f.ctx.tools.executionMode = () => 'readonly'
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => invocation.currentToolCallId === 'waiting'
      ? { success: false, output: 'confirm', needsConfirmation: true }
      : { success: invocation.currentToolCallId === 'finished', output: invocation.currentToolCallId! })
    const frames = await f.run()
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(3)
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['waiting', 'failed', 'succeeded'])
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['failed', 'finished'])
  })

  it('does not trip the repeated-failure circuit for retryable transient outages', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '1')
    const retry = call('retry', 'read_file')
    const f = fixture([retry])
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, toolCalls: [{ ...retry, args: JSON.stringify(retry.args) }] }
    })
    f.ctx.tools.execute = vi.fn(async () => ({ success: false, status: 'failed', output: 'temporary network timeout',
      error: 'ETIMEDOUT', metadata: { retryable: true } } as ToolResult))
    await f.run()
    expect(f.outcomes.at(-1)).not.toMatchObject({ stopReason: 'repeated_failure' })
    expect(f.outcomes.at(-1)).toMatchObject({ stopReason: 'max_steps' })
  })

  it('continues settling siblings if one history append fails', async () => {
    const f = fixture([call('first'), call('second')])
    const append = f.ctx.history.append
    f.ctx.history.append = vi.fn(async (message, context) => {
      if (message.role === 'tool' && message.toolCallId === 'first') throw new Error('storage unavailable')
      return append(message, context)
    })
    const frames = await f.run()
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(2)
    expect(toolResults(frames)).toHaveLength(2)
    expect(f.history.some(message => message.role === 'tool' && message.toolCallId === 'second')).toBe(true)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('resumes the exact approved call once before the model and emits its original terminal card', async () => {
    const f = fixture([])
    f.ctx.resumeToolCall = { toolCall: call('approved', 'execute_cmd'), messageId: 'original-tool-message', decision: 'approved' }
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      expect(invocation).toMatchObject({ currentToolCallId: 'approved', approvedToolCallId: 'approved' })
      expect(f.llm.stream).not.toHaveBeenCalled()
      return { success: true, output: 'executed original command', metadata: { test: 1 } }
    })
    const frames = await f.run(null)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(toolResults(frames)[0]).toMatchObject({ toolCallId: 'approved', messageId: 'original-tool-message', status: 'succeeded', metadata: { test: 1 }, outputPreview: 'executed original command' })
    expect(toolResults(frames)[0].durationMs).toBeTypeOf('number')
    expect(f.history.find(message => message.role === 'assistant')?.id).toBe('assistant-1')
    expect(frames).toContain('\x00__assistant_msg_id__assistant-1')
  })

  it('rejecting an approval performs no tool side effect and pairs the original call', async () => {
    const f = fixture([])
    f.ctx.resumeToolCall = { toolCall: call('rejected', 'execute_cmd'), decision: 'rejected' }
    const frames = await f.run(null)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames)[0]).toMatchObject({ toolCallId: 'rejected', status: 'interrupted', success: false })
    expect(f.history[0]).toMatchObject({ role: 'tool', toolCallId: 'rejected' })
  })

  it('publishes actual recorded file changes even when the writer reports partial failure', async () => {
    const f = fixture([call('partial')])
    f.ctx.tools.execute = async () => ({ success: false, output: 'partial write', change: { id: 'actual-change', path: 'partial.txt' }, metadata: { fileMutationApplied: true } })
    const frames = await f.run()
    expect(frames.some(frame => frame.startsWith('\x00__file_change__') && frame.includes('actual-change'))).toBe(true)
    expect(f.history.find(message => message.role === 'user')).toMatchObject({ id: 'user-1', metadata: { rootRunId: 'root-1', turnId: 'turn-1' } })
  })

  it('cancels every announced tool when its provider aborts before completing the batch', async () => {
    const f = fixture([])
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    f.llm.stream = async function* () {
      yield { done: false, toolCalls: [{ id: 'announced', name: 'write_file', args: '{"path":', index: 0 }] }
      controller.abort()
      throw new DOMException('cancelled', 'AbortError')
    }
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames)).toMatchObject([{ toolCallId: 'announced', status: 'cancelled' }])
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['announced'])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'cancelled' })
  })

  it('marks announced tools interrupted on an output limit without executing them', async () => {
    const f = fixture([])
    f.llm.stream = async function* () { yield { done: true, finishReason: 'length', toolCalls: [{ id: 'limited', name: 'write_file', args: '{}', index: 0 }] } }
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames)).toMatchObject([{ toolCallId: 'limited', status: 'interrupted' }])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it('reports a pending persistence failure without emitting an answerable card or retrying tools', async () => {
    const f = fixture([{ id: 'ask', name: 'ask_user', args: { question: 'A?' } }, call('skipped')])
    f.ctx.onPending = async () => { throw new Error('database failed') }
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(frames.some(frame => frame.startsWith('\x00__permission_request__'))).toBe(false)
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['failed', 'interrupted'])
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('waits for active siblings to cancel and gives a terminal result to queued serial work', async () => {
    const f = fixture([call('active', 'read_file'), call('abort', 'read_file'), call('unstarted')])
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    f.ctx.tools.executionMode = name => name === 'read_file' ? 'readonly' : 'serial'
    let cleanedUp = false
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      if (invocation.currentToolCallId === 'active') await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => { cleanedUp = true; reject(controller.signal.reason) }, { once: true })
      })
      else { controller.abort(); throw controller.signal.reason }
      return { success: true, output: 'unreachable' }
    })
    const frames = await f.run()
    expect(cleanedUp).toBe(true)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(2)
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(3)
  })

  it('persists all sibling results before a stream consumer can return at the first terminal frame', async () => {
    const f = fixture([call('one'), call('two'), call('three')])
    const iterator = new ReActStrategy(f.llm, { maxIterations: 3 }).run('task', f.ctx)[Symbol.asyncIterator]()
    try {
      for (;;) {
        const step = await iterator.next()
        if (step.done) throw new Error('No tool end was emitted')
        if (step.value.startsWith('\x00__tool_end__')) break
      }
      expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['one', 'two', 'three'])
      expect(f.ctx.runObserver?.onToolEnd).toHaveBeenCalledTimes(3)
    } finally { await iterator.return?.() }
  })
})

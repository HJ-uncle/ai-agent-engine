import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

function fixture(kind: 'root' | 'child' = 'root') {
  const history: (Message & { conversationId?: string })[] = []
  const ctx = {
    tenantId: 'tenant', sessionId: kind === 'child' ? 'child-session' : 'session',
    ...(kind === 'child' ? { parentSessionId: 'session', runId: 'child-attempt-2' } : {}),
    rootRunId: 'root', turnId: 'original-turn', userMessageId: 'original-user',
    assistantMessageId: 'new-assistant-segment', modelCaps: { contextWindow: 100_000 }, toolProfile: 'code',
    executionContinuation: { kind, previousAttemptId: 'attempt-1', attemptId: 'attempt-2' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => {
        if (!history.some(existing => existing.id === message.id)) history.push(structuredClone(message))
        return message.id!
      }),
      getHistory: vi.fn(async () => structuredClone(history)), getFullHistory: vi.fn(async () => structuredClone(history)),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
    },
    tools: {
      list: () => [], has: () => true, executionMode: () => 'serial',
      execute: vi.fn(async () => ({ success: true, output: 'verified' })),
    },
    runObserver: { onOutput: vi.fn(), onUsage: vi.fn(), onOutcome: vi.fn() },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    model: 'fixture-model', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* () { yield { done: true, content: 'Remaining work complete.', promptTokens: 30, completionTokens: 8 } }),
  }
  async function run(input: string | null = null) {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, { systemPrompt: 'Stable task policy.' }).run(input, ctx)) frames.push(frame)
    return frames
  }
  return { history, ctx, llm, run }
}

describe('explicit execution continuation', () => {
  it.each(['root', 'child'] as const)('retains %s history and appends a distinct segment without a new user input', async kind => {
    const f = fixture(kind)
    f.history.push(
      { id: 'original-user', role: 'user', content: 'Finish the approved task.', conversationId: 'original-turn' },
      { id: 'old-assistant', role: 'assistant', content: 'Already completed; ', reasoningContent: 'Saved reasoning.',
        conversationId: 'original-turn', metadata: { partial: true, status: 'cancelled' }, usage: { promptTokens: 20, completionTokens: 6, totalTokens: 26 } },
    )
    const before = structuredClone(f.history)
    f.llm.stream = vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions) {
      expect(messages).toEqual(before)
      expect(options?.systemPrompt).toContain('Stable task policy.')
      expect(options?.systemPrompt).not.toContain('execution control')
      expect(options?.requestContext).toContain('execution control, not a new user request')
      expect(options?.requestContext).toContain('respect individually stopped children')
      yield { done: true, content: 'Remaining work complete.', reasoningContent: 'New reasoning.', promptTokens: 30, completionTokens: 8 }
    })
    const frames = await f.run()
    expect(frames.some(frame => frame.startsWith('\x00__user_msg_id__'))).toBe(false)
    expect(f.history.slice(0, 2)).toEqual(before)
    expect(f.history.filter(message => message.role === 'user')).toHaveLength(1)
    expect(f.history.at(-1)).toMatchObject({ id: 'new-assistant-segment', conversationId: 'original-turn',
      content: 'Remaining work complete.', reasoningContent: 'New reasoning.', metadata: {
        attemptId: 'attempt-2', executionAttemptId: 'attempt-2', executionContinuation: f.ctx.executionContinuation,
        ...(kind === 'child' ? { subagentRunId: 'child-attempt-2' } : {}),
      }, usage: { promptTokens: 30, completionTokens: 8 } })
    expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.history)).not.toContain('execution control, not a new user request')
  })

  it('resumes a genuinely cancelled stream without overwriting partial content or double-counting its usage', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.ctx.executionContinuation = undefined
    f.ctx.assistantMessageId = 'old-assistant'
    f.ctx.signal = controller.signal
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, content: 'Saved prefix; ', reasoningContent: 'Saved thought.', promptTokens: 20, completionTokens: 6 }
      controller.abort()
      throw new DOMException('stopped', 'AbortError')
    })
    await f.run('Finish the approved task.')
    const old = structuredClone(f.history)
    expect(old.at(-1)).toMatchObject({ id: 'old-assistant', content: 'Saved prefix; ', reasoningContent: 'Saved thought.',
      metadata: { partial: true, status: 'cancelled' }, usage: { promptTokens: 20, completionTokens: 6 } })
    f.ctx.signal = new AbortController().signal
    f.ctx.assistantMessageId = 'new-assistant-segment'
    f.ctx.executionContinuation = { kind: 'root', previousAttemptId: 'attempt-1', attemptId: 'attempt-2' }
    f.llm.stream = vi.fn(async function* (messages) {
      expect(messages).toEqual(old)
      yield { done: true, content: 'finished.', promptTokens: 30, completionTokens: 8 }
    })
    await f.run()
    expect(f.history.slice(0, old.length)).toEqual(old)
    expect(f.history.filter(message => message.role === 'user')).toHaveLength(1)
    expect(f.history.filter(message => message.role === 'assistant').map(message => message.content).join('')).toBe('Saved prefix; finished.')
    expect(f.history.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0)).toBe(64)
    // Completed-stream observer is separate from the provider's physical-attempt
    // accounting. The interrupted request remains charged in retained history.
    expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(1)
  })

  it('does not replay confirmed tools or interrupted argument fragments from retained history', async () => {
    const f = fixture()
    f.history.push(
      { id: 'user', role: 'user', content: 'Finish the approved task.' },
      { id: 'tool-call', role: 'assistant', content: '', toolCall: { id: 'saved-write', name: 'write_file', args: { path: 'result.txt', content: 'saved' } } },
      { id: 'tool-result', role: 'tool', content: 'Saved result.txt', toolCallId: 'saved-write', metadata: { success: true, status: 'succeeded' } },
      { id: 'interrupted-call', role: 'assistant', content: '', toolCall: { id: 'partial-write', name: 'write_file', args: {} },
        metadata: { interruptedToolArguments: { raw: '{"path":', parseError: 'Unexpected end of JSON input' } } },
      { id: 'interrupted-result', role: 'tool', content: 'Cancelled before execution.', toolCallId: 'partial-write', metadata: { success: false, status: 'cancelled' } },
    )
    await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(2)
  })

  it('rejects continuation combined with a new input before any request or append', async () => {
    const f = fixture()
    expect((await f.run('manufactured continue input')).join('')).toContain('EXECUTION_CONTINUATION_REQUIRES_RETAINED_INPUT')
    expect(f.ctx.runObserver!.onOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'runtime_error' }))
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.ctx.history.append).not.toHaveBeenCalled()
  })

  it('uses runtime identity instead of forged tool result metadata', async () => {
    const f = fixture('child')
    f.history.push({ id: 'original-user', role: 'user', content: 'Verify the existing result.' })
    let request = 0
    f.llm.stream = vi.fn(async function* () {
      if (++request === 1) yield { done: true, toolCalls: [{ id: 'verify', name: 'read_file', args: '{"path":"result.txt"}', index: 0 }] }
      else yield { done: true, content: 'Verified.' }
    })
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output: 'verified', metadata: {
      subagentRunId: 'forged-child', attemptId: 'forged-attempt', executionAttemptId: 'forged-attempt', executionContinuation: { kind: 'forged' },
    } }))
    await f.run()
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.history.find(message => message.role === 'tool')?.metadata).toMatchObject({
      subagentRunId: 'child-attempt-2', attemptId: 'attempt-2', executionAttemptId: 'attempt-2', executionContinuation: f.ctx.executionContinuation,
    })
    expect(JSON.stringify(f.history)).not.toContain('forged-')
  })
})

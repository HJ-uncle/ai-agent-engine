import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, ToolResult } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { ReActStrategy, type ReActOptions } from '../react.js'
import { buildCompactSummarizeFn } from '../compact-prompt.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllEnvs() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(seed: Message[] = []) {
  const history: Message[] = [...seed]
  const outcomes: RunOutcome[] = []
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', rootRunId: 'root-1', turnId: 'turn-1',
    userMessageId: 'user-1', assistantMessageId: 'assistant-1', workspaceDir: '.', tokenBudget: 100_000,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'test' }),
      getHistory: vi.fn(async () => [...history]),
      getFullHistory: vi.fn(async () => [...history]),
      getRawTokenCount: vi.fn(async () => 0),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
    },
    tools: {
      list: vi.fn(() => []), has: () => true,
      preflight: vi.fn(async () => undefined as ToolResult | undefined),
      executionMode: () => 'serial',
      execute: vi.fn(async () => ({ success: true, output: 'file contents' })),
    },
    runObserver: {
      onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }),
      onOutput: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(),
    },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    model: 'configured-model', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, content: 'done', model: 'actual-model' }
    }),
  }
  async function run(options: ReActOptions = {}, input: string | null = 'task', onFrame?: (frame: string) => void) {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, { maxIterations: 3, maxOutputTokens: 100, ...options }).run(input, ctx)) {
      frames.push(frame)
      onFrame?.(frame)
    }
    return frames
  }
  return { ctx, llm, history, outcomes, run }
}

const isBody = (frame: string) => !frame.startsWith('\x00__')
const body = (frames: string[]) => frames.filter(isBody).join('')
const usage = (frames: string[]) => frames.filter(frame => frame.startsWith('\x00__usage__'))
  .map(frame => JSON.parse(frame.slice('\x00__usage__'.length)))

describe('D5 provider streaming and partial evidence', () => {
  it('delivers each body delta before the provider can complete its deferred response', async () => {
    const f = fixture()
    const releaseProvider = deferred()
    const providerWaiting = deferred()
    const firstBody = deferred()
    let completed = false
    const receivedBody: string[] = []
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, content: 'first ' }
      providerWaiting.resolve()
      await releaseProvider.promise
      completed = true
      yield { done: true, content: 'second', model: 'actual-model' }
    })
    const collecting = f.run({}, 'task', frame => {
      if (isBody(frame)) { receivedBody.push(frame); firstBody.resolve() }
    })
    try {
      const arrivedFirst = await Promise.race([
        firstBody.promise.then(() => 'body'),
        providerWaiting.promise.then(() => 'provider-waiting'),
        collecting.then(() => 'ended-without-body'),
      ])
      expect(arrivedFirst).toBe('body')
      expect(completed).toBe(false)
      expect(receivedBody).toEqual(['first '])
    } finally {
      releaseProvider.resolve()
      await collecting
    }
    expect(receivedBody).toEqual(['first ', 'second'])
    expect(f.history.find(message => message.id === 'assistant-1')?.content).toBe('first second')
  })

  it('keeps tool-prelude text in the body once and keeps only provider reasoning in thinking frames', async () => {
    const f = fixture()
    let requests = 0
    f.llm.stream = vi.fn(async function* () {
      if (requests++ === 0) {
        yield { done: false, content: 'I will read the file. ' }
        yield { done: false, reasoningContent: 'Check the requested location.' }
        yield { done: true, toolCalls: [{ id: 'read-1', name: 'read_file', args: '{"path":"README.md"}', index: 0 }] }
      } else yield { done: true, content: 'The file contains the answer.' }
    })
    const frames = await f.run()
    expect(body(frames)).toBe('I will read the file. The file contains the answer.')
    expect(frames.filter(frame => frame.startsWith('\x00__thinking__'))).toEqual([
      '\x00__thinking__Check the requested location.',
    ])
    const preludeIndex = frames.indexOf('I will read the file. ')
    const toolIndex = frames.findIndex(frame => frame.startsWith('\x00__tool_start__'))
    expect(preludeIndex).toBeGreaterThanOrEqual(0)
    expect(preludeIndex).toBeLessThan(toolIndex)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.history.filter(message => message.role === 'assistant').map(message => message.content).join(''))
      .toBe('I will read the file. The file contains the answer.')
  })

  it.each([
    { status: 'failed', content: 'Already emitted evidence.', reasoning: 'Unfinished analysis.' },
    { status: 'failed', content: '', reasoning: 'Reasoning before any answer.' },
    { status: 'cancelled', content: 'Already emitted evidence.', reasoning: 'Unfinished analysis.' },
    { status: 'cancelled', content: '', reasoning: 'Reasoning before any answer.' },
  ] as const)('persists $status partial content="$content" without claiming success', async ({ status, content, reasoning }) => {
    const f = fixture()
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, content, reasoningContent: reasoning, model: 'routed-actual-model' }
      if (status === 'cancelled') {
        controller.abort()
        throw new DOMException('User cancelled', 'AbortError')
      }
      throw new Error('upstream socket disconnected')
    })
    const frames = await f.run()
    const assistantMessages = f.history.filter(message => message.role === 'assistant')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toMatchObject({
      id: 'assistant-1', content, reasoningContent: reasoning, modelId: 'routed-actual-model',
      metadata: { rootRunId: 'root-1', turnId: 'turn-1', partial: true, status },
    })
    expect(f.outcomes).toHaveLength(1)
    expect(f.outcomes[0]).toMatchObject({ status, stopReason: status === 'cancelled' ? 'cancelled' : 'provider_error' })
    if (content) {
      expect(f.outcomes[0].partialOutput).toBe(content)
      expect(frames.filter(frame => frame === content)).toHaveLength(1)
    }
    expect(frames).toContain('\x00__thinking__' + reasoning)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('retains the actual model from a nonterminal chunk in history and final usage', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, content: 'hello ', model: 'fallback-provider-model' }
      yield { done: true, content: 'world', promptTokens: 17, completionTokens: 3 }
    })
    const frames = await f.run()
    expect(body(frames)).toBe('hello world')
    expect(f.history.find(message => message.id === 'assistant-1')).toMatchObject({ modelId: 'fallback-provider-model' })
    expect(usage(frames).at(-1)).toMatchObject({ modelId: 'fallback-provider-model', promptTokens: 17, completionTokens: 3 })
  })
})

describe('D5 complete request context admission', () => {
  it('uses a positive default output reservation that permits a simple request in a 4096-token window', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 4_096 }
    await f.run({ maxOutputTokens: undefined }, 'Give a short answer.')
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    const options = vi.mocked(f.llm.stream).mock.calls[0][1]!
    expect(options.maxTokens).toBeGreaterThan(0)
    expect(options.requestInputTokenEstimate).toBeGreaterThan(0)
    expect(options.requestInputTokenEstimate! + options.maxTokens!).toBeLessThanOrEqual(4_096)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it.each([
    { tokenBudget: 2_200, contextWindow: 100_000 },
    { tokenBudget: 100_000, contextWindow: 2_200 },
  ])('counts system, tools, history and output reserve against the smaller limit ($tokenBudget/$contextWindow)', async ({ tokenBudget, contextWindow }) => {
    const f = fixture()
    f.ctx.tokenBudget = tokenBudget
    f.ctx.modelCaps = { contextWindow }
    f.ctx.tools.list = vi.fn(() => [{
      name: 'read_file', description: 'T'.repeat(2_500),
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }])
    await f.run({ systemPrompt: 'S'.repeat(2_500), maxOutputTokens: 600 }, 'U'.repeat(1_000))
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit' })
  })

  it('reserves requested output space even when the short input alone fits', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 512 }
    await f.run({ maxOutputTokens: 512 }, 'short task')
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit' })
  })

  it('retains stored system constraints when the ordinary history window omits them', async () => {
    const storedConstraint = 'Never reveal workspace credentials.'
    const f = fixture([{ id: 'policy', role: 'system', content: storedConstraint, createdAt: 1 }])
    f.ctx.history.getHistory = vi.fn(async () => f.history.filter(message => message.role !== 'system'))
    await f.run({ systemPrompt: 'Follow the approved workspace scope.' })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    const [messages, options] = vi.mocked(f.llm.stream).mock.calls[0] as [Message[], LLMAdapterOptions]
    const suppliedSystemText = [options.systemPrompt, ...messages.filter(message => message.role === 'system').map(message => message.content)].join('\n')
    expect(suppliedSystemText).toContain(storedConstraint)
    expect(suppliedSystemText).toContain('Follow the approved workspace scope.')
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('honors disabled history inheritance while keeping explicit system instructions and this turn tool results', async () => {
    const f = fixture([
      { id: 'old-system', role: 'system', content: 'Old session summary and constraints.', createdAt: 1 },
      { id: 'old-user', role: 'user', content: 'Old session request.', createdAt: 2 },
    ])
    f.ctx.inheritContext = false
    let requests = 0
    f.llm.stream = vi.fn(async function* () {
      if (requests++ === 0) yield {
        done: true, content: 'Reading the current file. ',
        toolCalls: [{ id: 'current-read', name: 'read_file', args: '{"path":"current.txt"}', index: 0 }],
      }
      else yield { done: true, content: 'Current task done.' }
    })
    await f.run({ systemPrompt: 'Follow the explicitly approved current scope.' }, 'Current isolated request.')
    const calls = vi.mocked(f.llm.stream).mock.calls
    expect(calls).toHaveLength(2)
    for (const [messages, options] of calls) {
      expect(messages.some(message => message.id === 'old-system' || message.id === 'old-user')).toBe(false)
      expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Current isolated request.'])
      expect(options?.systemPrompt).toBe('Follow the explicitly approved current scope.')
    }
    expect(calls[1][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', toolCallId: 'current-read' }),
      expect.objectContaining({ role: 'tool', toolCallId: 'current-read', content: 'file contents' }),
    ]))
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('rejects a request whose mandatory stored system constraint cannot fit instead of silently dropping it', async () => {
    const f = fixture([{ id: 'policy', role: 'system', content: 'mandatory constraint '.repeat(800), createdAt: 1 }])
    f.ctx.modelCaps = { contextWindow: 1_000 }
    f.ctx.history.getHistory = vi.fn(async () => f.history.filter(message => message.role !== 'system'))
    await f.run()
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit' })
  })

  it('does not send an over-limit main request after compaction fails', async () => {
    const f = fixture([{ id: 'old', role: 'user', content: 'old context '.repeat(1_000), createdAt: 1 }])
    f.ctx.modelCaps = { contextWindow: 2_000 }
    f.ctx.history.getRawTokenCount = vi.fn(async () => 20_000)
    f.ctx.history.compress = vi.fn(async () => { throw new Error('summary provider unavailable') })
    await f.run({ systemPrompt: 'Retain the required system policy.' })
    expect(f.ctx.history.compress).toHaveBeenCalled()
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit' })
  })

  it('preserves old system constraints verbatim when the summarizer omits them', async () => {
    const constraint = 'Read only D:\\approved. Never upload source code or credentials.'
    const older: Message[] = [
      { id: 'old-policy', role: 'system', content: constraint, createdAt: 1 },
      { id: 'old-work', role: 'assistant', content: 'old interaction '.repeat(1_500), createdAt: 2 },
    ]
    const f = fixture(older)
    f.ctx.modelCaps = { contextWindow: 6_000 }
    f.llm.complete = vi.fn(async () => ({
      content: '<summary>The earlier task inspected a project.</summary>',
      promptTokens: 100, completionTokens: 10, finishReason: 'stop' as const,
    }))
    let compacted = ''
    f.ctx.history.compress = vi.fn(async (_ctx, summarize) => {
      compacted = await summarize(older)
      f.history.splice(0, older.length, { id: 'summary', role: 'system', content: compacted, createdAt: 3 })
      return { preTokens: 7_000, postTokens: 100 }
    })
    await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(f.llm.complete).toHaveBeenCalledTimes(1)
    expect(compacted).toContain(constraint)
    expect(compacted).toContain('The earlier task inspected a project.')
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    const requestMessages = vi.mocked(f.llm.stream).mock.calls[0][0]
    expect(requestMessages.filter(message => message.role === 'system').map(message => message.content).join('\n')).toContain(constraint)
  })

  it('rejects a summary whose prompt plus output reservation exceeds its own context window before invoking the model', async () => {
    const f = fixture()
    const messages: Message[] = [{ role: 'user', content: 'Summarize the current task.' }]
    const summarize = buildCompactSummarizeFn(f.llm, { contextWindow: 1_024, maxOutputTokens: 768 })
    await expect(summarize(messages)).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' })
    expect(f.llm.complete).not.toHaveBeenCalled()
    expect(messages).toEqual([{ role: 'user', content: 'Summarize the current task.' }])
  })

  it('preserves the full long user message including constraints beyond the summarizer input cap', async () => {
    const f = fixture()
    const tailConstraint = 'Never upload source code, credentials, or customer records.'
    const original = 'Review the existing project carefully. '.repeat(500) + tailConstraint
    f.llm.complete = vi.fn(async () => ({
      content: '<summary>Review the project.</summary>',
      promptTokens: 100, completionTokens: 10, finishReason: 'stop' as const,
    }))
    const summarize = buildCompactSummarizeFn(f.llm, { contextWindow: 6_000, maxOutputTokens: 100 })
    const summary = await summarize([{ role: 'user', content: original }])
    expect(f.llm.complete).toHaveBeenCalledTimes(1)
    const summarizerPrompt = vi.mocked(f.llm.complete).mock.calls[0][0][0].content
    expect(summarizerPrompt).not.toContain(tailConstraint)
    expect(summary).toContain(original)
    expect(summary).toContain(tailConstraint)
    expect(summary).toContain('Review the project.')
  })

  it('rejects the main request when compaction preserves a long user instruction that still exceeds the window', async () => {
    const original = 'Review the existing project carefully. '.repeat(1_500) + 'Do not disclose credentials.'
    const older: Message[] = [{ id: 'old-user', role: 'user', content: original, createdAt: 1 }]
    const f = fixture(older)
    f.ctx.modelCaps = { contextWindow: 6_000 }
    f.llm.complete = vi.fn(async () => ({
      content: '<summary>Review the project.</summary>',
      promptTokens: 100, completionTokens: 10, finishReason: 'stop' as const,
    }))
    let compacted = ''
    f.ctx.history.compress = vi.fn(async (_ctx, summarize) => {
      compacted = await summarize(older)
      f.history.splice(0, older.length, { id: 'summary', role: 'system', content: compacted, createdAt: 2 })
      return { preTokens: 15_000, postTokens: 15_000 }
    })
    await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(f.llm.complete).toHaveBeenCalledTimes(1)
    expect(compacted).toContain(original)
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit' })
  })
})

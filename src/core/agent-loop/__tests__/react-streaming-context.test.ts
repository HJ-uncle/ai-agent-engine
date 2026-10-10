import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, ToolResult } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { ReActStrategy, projectModelMessage, type ReActOptions } from '../react.js'
import { estimateRequestInput } from '../finalization.js'
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

describe('context snapshots and cumulative input usage', () => {
  it('publishes the admitted input before a slow provider responds, then corrects it before completion without billing early', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 100_000 }
    const releaseInput = deferred(), releaseFinish = deferred(), waiting = deferred(), metered = deferred()
    let completed = false
    const observed: Record<string, unknown>[] = []
    f.llm.stream = vi.fn(async function* () {
      waiting.resolve()
      await releaseInput.promise
      yield { done: false, model: 'fallback', contextWindow: 64_000, promptTokens: 32_000, completionTokens: 0 }
      metered.resolve()
      await releaseFinish.promise
      completed = true
      yield { done: true, content: 'Final answer.', completionTokens: 7 }
    })
    const collecting = f.run({}, 'Inspect the complete project.', frame => {
      if (frame.startsWith('\x00__usage__')) observed.push(JSON.parse(frame.slice('\x00__usage__'.length)))
    })
    try {
      await waiting.promise
      expect(observed.at(-1)).toMatchObject({ currentPromptTokens: expect.any(Number), contextWindow: 100_000,
        modelId: 'configured-model', contextUsageEstimated: true, contextUsageProvisional: false,
        requestInputTokenEstimate: expect.any(Number) })
      expect(observed.at(-1)!.currentPromptTokens).toBe(vi.mocked(f.llm.stream).mock.calls[0][1]!.requestInputTokenEstimate)
      expect(observed.some(frame => frame.promptTokens !== undefined || frame.totalTokens !== undefined)).toBe(false)
      releaseInput.resolve()
      await metered.promise
      expect(completed).toBe(false)
      expect(observed.at(-1)).toMatchObject({ currentPromptTokens: 32_000, contextWindow: 64_000,
        modelId: 'fallback', contextUsageEstimated: false, contextUsageProvisional: true })
      expect(observed.at(-1)).not.toHaveProperty('promptTokens')
      expect(f.history.filter(message => message.role === 'assistant')).toHaveLength(0)
    } finally {
      releaseInput.resolve(); releaseFinish.resolve()
      await collecting
    }
    expect(observed.at(-1)).toMatchObject({ promptTokens: 32_000, completionTokens: 7, totalTokens: 32_007,
      currentPromptTokens: 32_000, contextWindow: 64_000, contextUsageEstimated: false, contextUsageProvisional: false })
    expect(f.history.find(message => message.role === 'assistant')?.metadata).toMatchObject({ contextUsageEstimated: false,
      contextUsageProvisional: false, requestInputTokenEstimate: observed[0].requestInputTokenEstimate })
  })

  it('retains fixed request estimates and distinguishes gateway-start input from corrected terminal input', async () => {
    const f = fixture()
    f.ctx.toolProfile = 'code'
    f.ctx.modelCaps = { contextWindow: 128_000 }
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, content: 'Working.', promptTokens: 19_848 }
      yield { done: true, promptTokens: 56_306, completionTokens: 1_295, cacheHitTokens: 55_296 }
    })
    const frames = await f.run()
    const samples = usage(frames)
    const estimate = vi.mocked(f.llm.stream).mock.calls[0][1]!.requestInputTokenEstimate
    expect(samples.every(frame => frame.requestInputTokenEstimate === estimate)).toBe(true)
    expect(samples.find(frame => frame.currentPromptTokens === 19_848)).toMatchObject({ contextUsageEstimated: false,
      contextUsageProvisional: true, contextWindow: 128_000 })
    expect(samples.find(frame => frame.currentPromptTokens === 19_848)).not.toHaveProperty('totalTokens')
    expect(samples.at(-1)).toMatchObject({ currentPromptTokens: 56_306, promptTokens: 56_306,
      totalTokens: 57_601, contextUsageEstimated: false, contextUsageProvisional: false })
    expect(f.history.find(message => message.role === 'assistant')?.metadata).toMatchObject({ contextUsageProvisional: false,
      requestInputTokenEstimate: estimate })
  })

  it('persists incomplete reported input as provisional after a provider disconnects', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 128_000 }
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, content: 'Partial evidence.', promptTokens: 19_975, completionTokens: 5 }
      throw new Error('Synthetic connection lost before terminal usage')
    })
    const frames = await f.run()
    expect(usage(frames).at(-1)).toMatchObject({ currentPromptTokens: 19_975, totalTokens: 19_980,
      contextUsageEstimated: false, contextUsageProvisional: true })
    expect(f.history.find(message => message.role === 'assistant')?.metadata).toMatchObject({ partial: true,
      contextUsageEstimated: false, contextUsageProvisional: true, requestInputTokenEstimate: expect.any(Number) })
  })

  it('pairs persisted and live input with the effective fallback context window', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 100_000 }
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, content: 'fallback answer', model: 'fallback', contextWindow: 64_000, promptTokens: 12_000, completionTokens: 2 }
    })
    const frames = await f.run()
    expect(usage(frames).at(-1)).toMatchObject({ modelId: 'fallback', currentPromptTokens: 12_000, contextWindow: 64_000 })
    expect(f.history.find(message => message.role === 'assistant')?.usage).toMatchObject({ currentPromptTokens: 12_000, contextWindow: 64_000 })
    expect(f.ctx.modelCaps.contextWindow).toBe(100_000)
  })

  it.each([false, true])('keeps estimated usage for tool-only partial responses (cancelled: %s)', async cancelled => {
    const f = fixture()
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, toolCalls: [{ id: 'partial-tool', name: 'read_file', args: '{"path":"' + 'x'.repeat(500), index: 0 }] }
      if (cancelled) { controller.abort(); throw new DOMException('User stopped', 'AbortError') }
      throw new Error('socket failed during tool args')
    })
    const frames = await f.run()
    const metered = f.history.filter(message => message.usage)
    expect(metered).toHaveLength(1)
    expect(metered[0].metadata).toMatchObject({ partial: true, usageEstimated: true })
    expect(metered[0].usage!.promptTokens).toBeGreaterThan(0)
    expect(metered[0].usage!.completionTokens).toBeGreaterThan(0)
    expect(usage(frames).at(-1).totalTokens).toBe(metered[0].usage!.totalTokens)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves reported zero output with textual content (interrupted: %s)', async interrupted => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, content: 'Text whose zero output count must remain the provider value.' }
      yield { done: !interrupted, promptTokens: 17, completionTokens: 0 }
      if (interrupted) throw new Error('socket failed after metering')
    })
    const frames = await f.run()
    expect(f.history.find(message => message.role === 'assistant')).toMatchObject({
      usage: { promptTokens: 17, completionTokens: 0, totalTokens: 17 }, metadata: { usageEstimated: false },
    })
    expect(usage(frames).at(-1)).toMatchObject({ promptTokens: 17, completionTokens: 0, totalTokens: 17 })
  })

  it('persists a metered request even when the provider disconnects before any output', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () {
      yield { done: false, promptTokens: 17, completionTokens: 0 }
      throw new Error('socket failed before text')
    })
    const frames = await f.run()
    expect(f.history.find(message => message.role === 'assistant')).toMatchObject({
      content: '', usage: { promptTokens: 17, completionTokens: 0, totalTokens: 17 },
      metadata: { partial: true, usageEstimated: false },
    })
    expect(usage(frames).at(-1)).toMatchObject({ totalTokens: 17 })
  })

  it.each([false, true])('keeps published partial cache and reasoning counters aligned with durable calls (cancelled: %s)', async cancelled => {
    const f = fixture()
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    let requests = 0
    f.llm.stream = vi.fn(async function* () {
      if (requests++ === 0) {
        yield { done: true, toolCalls: [{ id: 'first-read', name: 'read_file', args: '{}', index: 0 }],
          promptTokens: 100, completionTokens: 20, cacheHitTokens: 60, cacheMissTokens: 40, reasoningTokens: 5 }
      } else {
        yield { done: false, content: 'Partial evidence.', promptTokens: 200, completionTokens: 30,
          cacheHitTokens: 150, cacheMissTokens: 50, reasoningTokens: 10 }
        if (cancelled) { controller.abort(); throw new DOMException('Stopped', 'AbortError') }
        throw new Error('Disconnected after input metering')
      }
    })
    const frames = await f.run()
    const billed = f.history.filter(message => message.role === 'assistant' && message.usage)
    const totals = Object.fromEntries(['promptTokens', 'completionTokens', 'totalTokens', 'cacheHitTokens', 'cacheMissTokens', 'reasoningTokens']
      .map(key => [key, billed.reduce((sum, message) => sum + (message.usage![key] ?? 0), 0)]))
    expect(totals).toEqual({ promptTokens: 300, completionTokens: 50, totalTokens: 350,
      cacheHitTokens: 210, cacheMissTokens: 90, reasoningTokens: 15 })
    expect(usage(frames).at(-1)).toMatchObject({ ...totals, currentPromptTokens: 200, contextUsageEstimated: false })
  })

  it('keeps explicit zero input and all its disjoint breakdown components at zero', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, content: 'Answer', promptTokens: 0, completionTokens: 3 }
    })
    const frames = await f.run()
    const latest = usage(frames).at(-1)
    expect(latest).toMatchObject({ promptTokens: 0, currentPromptTokens: 0, completionTokens: 3, totalTokens: 3 })
    expect(latest.systemPromptTokens + latest.systemToolsTokens + latest.skillTokens + latest.ragTokens
      + latest.messagesTokens + latest.userInputTokens + latest.toolResultsTokens).toBe(0)
  })

  it('keeps estimated input components disjoint and exact even with small provider counts', async () => {
    const f = fixture([{ role: 'system', content: 'required saved policy' }])
    f.ctx.tools.list = () => [{ name: 'read_file', description: 'Read', parameters: {} }]
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, content: 'Done', promptTokens: 3, completionTokens: 1 }
    })
    const frames = await f.run({ promptBreakdown: { systemPromptTokens: 10, skillTokens: 10,
      ragTokens: 10, systemToolsTokens: 20, builtinToolsTokens: 10, mcpToolsTokens: 10 } })
    const frame = usage(frames).at(-1)
    expect(frame.promptTokens).toBe(3)
    expect(frame.systemPromptTokens + frame.systemToolsTokens + frame.skillTokens + frame.ragTokens
      + frame.messagesTokens + frame.userInputTokens + frame.toolResultsTokens).toBe(3)
    expect(frame.builtinToolsTokens + frame.mcpToolsTokens).toBe(frame.systemToolsTokens)
  })

  it.each([true, false])('keeps latest context separate from cumulative billing across tools and compaction (provider usage: %s)', async providerUsage => {
    vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS', '600000')
    const f = fixture()
    f.ctx.toolProfile = 'code'
    f.ctx.modelCaps = { contextWindow: 100_000 }
    f.ctx.tools.list = () => [{ name: 'read_file', description: 'Read a project file', parameters: { type: 'object' } }]
    let toolRequests = 0
    f.ctx.tools.execute = vi.fn(async () => ({ success: true,
      output: ++toolRequests <= 2 ? 'result 1 '.repeat(2_000) : 'old context '.repeat(40_000) }))
    f.ctx.history.compress = vi.fn(async () => {
      const user = f.history.find(message => message.role === 'user')!
      f.history.splice(0, f.history.length, { role: 'system', content: 'Earlier files verified; pending final answer.' }, user)
      return { preTokens: 120_000, postTokens: 100 }
    })
    let invocation = 0
    f.llm.stream = vi.fn(async function* () {
      const index = invocation++
      const toolCalls = index === 0
        ? [{ id: 'read-1', name: 'read_file', args: '{}', index: 0 }, { id: 'read-2', name: 'read_file', args: '{}', index: 1 }]
        : index === 1 ? [{ id: 'read-3', name: 'read_file', args: '{}', index: 0 }] : undefined
      yield { done: true, content: toolCalls ? '' : 'Verified final result.', toolCalls,
        promptTokens: providerUsage ? [12_000, 22_000, 10_000][index] : undefined, completionTokens: 20 }
    })
    const frames = await f.run()
    const snapshots = usage(frames).filter(frame => typeof frame.promptTokens === 'number')
    const inputs = providerUsage ? [12_000, 22_000, 10_000]
      : vi.mocked(f.llm.stream).mock.calls.map(([, options]) => options!.requestInputTokenEstimate!)
    expect(snapshots.map(frame => frame.currentPromptTokens)).toEqual(inputs)
    expect(inputs[2]).toBeLessThan(inputs[1])
    expect(snapshots.map(frame => frame.promptTokens)).toEqual([inputs[0], inputs[0] + inputs[1], inputs[0] + inputs[1] + inputs[2]])
    expect(snapshots.every(frame => frame.contextWindow === 100_000)).toBe(true)
    const persisted = vi.mocked(f.ctx.history.append).mock.calls.map(([message]) => message)
      .filter(message => message.role === 'assistant' && message.usage)
    expect(persisted.map(message => message.usage!.currentPromptTokens)).toEqual(inputs)
    expect(persisted.map(message => message.usage!.promptTokens)).toEqual(inputs)
    // One provider request with two tools is billed once, and archived outputs
    // no longer appear in the final request's context breakdown.
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(3)
    expect(persisted.at(-1)!.usage).toMatchObject({ toolResultsTokens: 0 })
    expect(persisted[1].usage!.userInputTokens).toBeGreaterThan(0)
    for (const frame of snapshots) expect(frame.systemPromptTokens + frame.systemToolsTokens + frame.skillTokens
      + frame.ragTokens + frame.messagesTokens + frame.toolResultsTokens + frame.userInputTokens).toBe(frame.promptTokens)
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })
})

describe('D5 provider streaming and partial evidence', () => {
  it('keeps archived tool output out of model requests and token estimates', async () => {
    const originalOutput = 'diagnostic output '.repeat(10_000)
    const message: Message = { id: 'old-tool', role: 'tool', toolName: 'execute_cmd', toolCallId: 'test-command',
      content: '[tool result cleared]', metadata: { status: 'succeeded', success: true, outputPreview: originalOutput,
        __aetherMicroCompactArchive: { content: originalOutput, tokens: 40_000 } } }
    const projected = projectModelMessage(message)
    expect(projected).toMatchObject({ content: '[tool result cleared]', metadata: { status: 'succeeded', success: true } })
    expect(projected.metadata).not.toHaveProperty('outputPreview')
    expect(projected.metadata).not.toHaveProperty('__aetherMicroCompactArchive')
    expect(message.metadata.outputPreview).toBe(originalOutput)
    expect(estimateRequestInput([projected], undefined, [])).toBeLessThan(200)
    expect(estimateRequestInput([projected], undefined, [])).toBeLessThan(estimateRequestInput([{ ...message, content: originalOutput }], undefined, []) / 100)

    const f = fixture([{ id: 'prior-user', role: 'user', content: 'Run the checks' },
      { id: 'prior-call', role: 'assistant', content: '', toolCall: { id: 'test-command', name: 'execute_cmd', args: { command: 'node' } } }, message])
    f.ctx.modelCaps = { contextWindow: 2_000 }
    await f.run({}, 'Continue using the existing checks.')
    expect(f.ctx.history.compress).not.toHaveBeenCalled()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    const request = vi.mocked(f.llm.stream).mock.calls[0][0]
    expect(request.find(item => item.id === 'old-tool')).toEqual(projected)
    expect(f.history.find(item => item.id === 'old-tool')?.metadata.outputPreview).toBe(originalOutput)
  })

  it.each(['', 'private reasoning only'])('keeps empty-output failures diagnosable without claiming success: %s', async reasoning => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () {
      if (reasoning) yield { done: false, reasoningContent: reasoning }
      yield { done: true, model: 'actual-empty-model', finishReason: 'stop' as const, promptTokens: 17, completionTokens: reasoning ? 5 : 0 }
    })
    const frames = await f.run({}, 'private user request')
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(body(frames)).toBe('')
    expect(f.outcomes).toEqual([expect.objectContaining({
      status: 'failed', stopReason: 'empty_output',
      error: { code: 'EMPTY_OUTPUT', message: expect.stringContaining(reasoning ? '仅返回了思考内容' : '未收到模型的最终回答或工具调用'), retryable: false },
    })])
    const assistant = f.history.filter(message => message.role === 'assistant')
    expect(assistant).toHaveLength(1)
    const responseDiagnostics = {
      provider: 'test', modelId: 'actual-empty-model', finishReason: 'stop', chunkCount: reasoning ? 2 : 1,
      terminalChunkReceived: true, contentCharacters: 0, reasoningCharacters: reasoning.length,
      promptTokens: 17, completionTokens: reasoning ? 5 : 0,
    }
    expect(assistant[0]).toMatchObject({
      id: 'assistant-1', content: '', reasoningContent: reasoning,
      usage: { promptTokens: 17, completionTokens: reasoning ? 5 : 0 },
      metadata: { rootRunId: 'root-1', status: 'failed', stopReason: 'empty_output', responseDiagnostics },
    })
    expect(f.ctx.logger.warn).toHaveBeenCalledWith({ rootRunId: 'root-1', sessionId: 'session', ...responseDiagnostics }, 'Model response had no final answer')
    expect(JSON.stringify(vi.mocked(f.ctx.logger.warn).mock.calls)).not.toContain('private')
    expect(usage(frames).at(-1)).toMatchObject({ modelId: 'actual-empty-model', promptTokens: 17, completionTokens: reasoning ? 5 : 0 })
    expect(f.outcomes.some(outcome => outcome.output)).toBe(false)
  })

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
  it('admits a Qwen code request with large replay/diff metadata while preserving the complete stored evidence', async () => {
    const metadata = { change: { oldContent: 'old source '.repeat(30_000), newContent: 'new source '.repeat(30_000) },
      subagent: { events: [{ output: 'child replay '.repeat(20_000) }] }, outputPreview: 'tool preview '.repeat(10_000) }
    const previous: Message[] = [
      { id: 'prior-request', role: 'user', content: 'Implement the approved project.' },
      { id: 'prior-call', role: 'assistant', content: '', tokens: 0,
        toolCall: { id: 'write-1', name: 'write_file', args: { path: 'src/main.ts', content: 'source text '.repeat(2_500) } } },
      { id: 'prior-result', role: 'tool', content: 'File written.', toolCallId: 'write-1', metadata },
    ]
    const f = fixture(previous)
    f.ctx.toolProfile = 'code'
    f.ctx.modelCaps = { contextWindow: 128_000 }
    await f.run({}, 'Continue and verify the project.')
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.history.compress).not.toHaveBeenCalled()
    const [request, options] = vi.mocked(f.llm.stream).mock.calls[0]
    expect(options!.requestInputTokenEstimate).toBeLessThan(12_000)
    expect(options!.maxTokens! + options!.requestInputTokenEstimate!).toBe(128_000)
    expect(request.find(message => message.id === 'prior-result')?.metadata.change).toEqual(metadata.change)
    expect(f.history.find(message => message.id === 'prior-result')?.metadata).toEqual(metadata)
  })

  it('reserves code completion headroom even though its wire output cap is omitted', async () => {
    const f = fixture()
    f.ctx.toolProfile = 'code'
    f.ctx.modelCaps = { contextWindow: 2_000 }
    const input = 'x '.repeat(2_950)
    expect(estimateRequestInput([{ role: 'user', content: input }], undefined, [])).toBeLessThan(2_000)
    await f.run({}, input)
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit',
      error: { message: expect.stringContaining('output reservation (256)') } })
    expect(f.outcomes.at(-1)?.error?.message).not.toContain('undefined')
  })

  it('Code mode uses the remaining context capacity and ignores the local token budget', async () => {
    const f = fixture()
    f.ctx.toolProfile = 'code'
    f.ctx.tokenBudget = 1
    f.ctx.modelCaps = { contextWindow: 20_000 }
    await f.run({ maxOutputTokens: 100 }, 'Give a short answer.')
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    const options = vi.mocked(f.llm.stream).mock.calls[0][1]!
    expect(options.maxTokens! + options.requestInputTokenEstimate!).toBe(20_000)
    expect(options.maxTokens).toBeGreaterThan(8_192)
    expect(options.unboundedOutput).toBe(true)
    expect(options.contextWindow).toBe(20_000)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it.each(['qwen3.8-flash', 'MiniMax-M2.5', 'glm-5.3', 'kimi-k2.6', 'deepseek-v4.1-flash'])
    ('keeps %s reasoning plus answer allowance inside the configured 100K context', async model => {
      const f = fixture()
      Object.defineProperty(f.llm, 'model', { value: model })
      f.ctx.toolProfile = 'code'
      f.ctx.modelCaps = { contextWindow: 100_000 }
      await f.run({}, 'Complete the retained project without changing historical decisions.')
      const options = vi.mocked(f.llm.stream).mock.calls[0][1]!
      expect(options.contextWindow).toBe(100_000)
      expect(options.maxTokens! + options.requestInputTokenEstimate!).toBe(100_000)
      expect(options.maxTokens).toBeGreaterThan(8_192)
    })

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

  it('repeats compaction with a smaller retained suffix until the complete request fits', async () => {
    const f = fixture([{ id: 'old', role: 'assistant', content: 'old context '.repeat(5_000) }])
    f.ctx.modelCaps = { contextWindow: 6_000 }
    let pass = 0
    f.ctx.history.compress = vi.fn(async (_ctx, _summarize, retention) => {
      const before = estimateRequestInput(f.history, undefined, [])
      f.history.splice(0, f.history.length - 1, { id: 'summary', role: 'system', content: ++pass === 1
        ? 'old context '.repeat(2_500) : 'Earlier work verified; DECISION=43; pending checkpoint remains.' })
      return { preTokens: before, postTokens: estimateRequestInput(f.history, undefined, []) }
    })
    await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(2)
    const retentions = vi.mocked(f.ctx.history.compress).mock.calls.map(call => call[2] as { keepRecentTokens: number })
    expect(retentions[1].keepRecentTokens).toBeLessThanOrEqual(retentions[0].keepRecentTokens)
    const [request, options] = vi.mocked(f.llm.stream).mock.calls[0]
    expect(estimateRequestInput(request, options?.systemPrompt, options?.tools ?? []) + options!.maxTokens!).toBeLessThanOrEqual(6_000)
    expect(request.some(message => String(message.content).includes('DECISION=43'))).toBe(true)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it.each(['invalid', '2'])('still compacts before the hard window with threshold configuration %s', async value => {
    vi.stubEnv('COMPRESS_THRESHOLD_RATIO', value)
    const f = fixture([{ id: 'old', role: 'assistant', content: 'old context '.repeat(5_000) }])
    f.ctx.modelCaps = { contextWindow: 6_000 }
    f.ctx.history.compress = vi.fn(async () => {
      f.history.splice(0, f.history.length - 1, { id: 'summary', role: 'system', content: 'Earlier work verified; pending checkpoint.' })
      return { preTokens: 20_000, postTokens: 100 }
    })
    await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('budgets processed attachment content before compaction and never substitutes it into an older user row', async () => {
    const older: Message = { id: 'old-user', role: 'user', content: 'Earlier original instruction.' }
    const f = fixture([older])
    f.ctx.toolProfile = 'code'
    f.ctx.modelCaps = { contextWindow: 6_000 }
    const processed = 'Extracted attachment detail '.repeat(4_000) + 'CURRENT_LIMIT=43'
    let summarizedMessages: Message[] = []
    f.llm.complete = vi.fn(async (messages) => {
      summarizedMessages = messages
      return { content: '<summary>CURRENT_LIMIT=43; continue the current attachment task.</summary>' } as any
    })
    Object.defineProperty(f.ctx.history, 'retainsArchive', { value: true })
    f.ctx.history.compress = vi.fn(async (_ctx, summarize) => {
      const result = await summarize([...f.history])
      f.history.splice(1, f.history.length - 1, { id: 'summary', role: 'system', content: result, metadata: { isCompactSummary: true } })
      return { preTokens: 30_000, postTokens: 100 }
    })
    await f.run({ displayContent: 'See attachment.' }, processed)
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(summarizedMessages.some(message => String(message.content).includes('CURRENT_LIMIT=43'))).toBe(true)
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    const [request, options] = vi.mocked(f.llm.stream).mock.calls[0]
    expect(request.find(message => message.id === 'old-user')?.content).toBe(older.content)
    expect(options!.requestInputTokenEstimate! + 300).toBeLessThanOrEqual(6_000)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('replays saved model input on a later request while retaining the user-visible attachment message', async () => {
    const display = [{ type: 'workspace_file', path: 'retained-contract.txt', name: 'retained-contract.txt' }]
    const modelInput = 'Approved retained attachment: DECISION=43; do not change the idempotency key.'
    const f = fixture([{ id: 'attachment-turn', role: 'user', content: display, modelInputContent: modelInput }])
    await f.run({}, 'Verify the earlier attachment decision.')
    const [request, options] = vi.mocked(f.llm.stream).mock.calls[0]
    expect(request.find(message => message.id === 'attachment-turn')?.content).toBe(modelInput)
    expect(f.history.find(message => message.id === 'attachment-turn')?.content).toEqual(display)
    expect(options!.requestInputTokenEstimate).toBe(estimateRequestInput(request, options?.systemPrompt, options?.tools ?? []))
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
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


describe('thinking Off during finalization', () => {
  it('keeps Off after tools finish and the final summary disables further tools', async () => {
    const f = fixture()
    const requests: LLMAdapterOptions[] = []
    f.ctx.tools.list = () => [{ name: 'read_file', description: 'Read a project file', parameters: { type: 'object' } }]
    f.llm.stream = vi.fn(async function* (_messages: Message[], options?: LLMAdapterOptions) {
      requests.push(options!)
      if (requests.length === 1) {
        yield { done: true, finishReason: 'tool_calls' as const,
          toolCalls: [{ id: 'read-1', name: 'read_file', args: '{"path":"README.md"}' }] }
      } else {
        yield { done: true, content: 'Verified project description.', finishReason: 'stop' as const }
      }
    })
    const offConfig = { enable_thinking: false, reasoning_effort: 'low' }
    await f.run({ maxIterations: 2, finalizeOnLimit: true, thinkingEnabled: false, thinkingConfig: offConfig })
    expect(requests).toHaveLength(2)
    expect(requests[0].tools).toHaveLength(1)
    expect(requests[1].tools).toEqual([])
    expect(requests[1].thinkingEnabled).toBe(false)
    expect(requests[1].thinkingConfig).toEqual(offConfig)
    expect(requests[1].systemPrompt).toContain('探索已停止')
  })
})

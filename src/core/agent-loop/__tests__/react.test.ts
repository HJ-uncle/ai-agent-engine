import { vi } from 'vitest'
import { ReActStrategy, truncateToolOutput } from '../react.js'
import type { AgentContext, Message } from '../../agent-context/index.js'
import type { LLMAdapter, LLMResponse } from '../../llm-adapter/index.js'

// ─── Helper ───────────────────────────────────────────────────────────────────

async function collectYields(iterable: AsyncIterable<string>): Promise<string[]> {
  const results: string[] = []
  for await (const chunk of iterable) {
    // 过滤所有 \x00__xxx__ 控制帧（含旧版与新版协议别名）
    if (chunk.startsWith('\x00__')) continue
    results.push(chunk)
  }
  return results
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeLLMAdapter(responses: LLMResponse[]): LLMAdapter {
  let callIndex = 0
  return {
    provider: 'mock',
    model: 'mock-model',
    stream: vi.fn().mockImplementation(async function* () {
      const response = responses[callIndex]
      callIndex = Math.min(callIndex + 1, responses.length - 1)
      
      const chunk: any = {
        done: true,
        content: response.content,
        reasoningContent: response.reasoningContent,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        finishReason: response.finishReason,
      }
      
      if (response.toolCalls && response.toolCalls.length > 0) {
        chunk.toolCalls = response.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          args: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
          index: 0
        }))
      }
      
      yield chunk
    }),
    complete: vi.fn(),
    countTokens: vi.fn().mockReturnValue(10),
  } as unknown as LLMAdapter
}

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const historyMessages: Message[] = []

  return {
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    workspaceDir: '/tmp',
    tokenBudget: 100_000,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AgentContext['logger'],
    history: {
      append: vi.fn().mockImplementation(async (msg: Message) => {
        historyMessages.push(msg)
      }),
      getHistory: vi.fn().mockImplementation(async () => [...historyMessages]),
      clear: vi.fn().mockResolvedValue(undefined),
      summarize: vi.fn().mockResolvedValue(undefined),
      getTokenCount: vi.fn().mockResolvedValue(0),
      getRawTokenCount: vi.fn().mockResolvedValue(0),
    },
    tools: {
      register: vi.fn(),
      unregister: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockResolvedValue({ success: true, output: 'tool result' }),
      has: vi.fn().mockReturnValue(false),
    },
    memory: {
      remember: vi.fn(),
      recall: vi.fn(),
      list: vi.fn(),
      forget: vi.fn(),
    },
    ...overrides,
  } as unknown as AgentContext
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReActStrategy', () => {
  // ── 1. Direct answer (no tool calls) ────────────────────────────────────────
  it('yields final answer directly when LLM returns stop with no tool calls', async () => {
    const llm = makeLLMAdapter([
      {
        content: 'The answer is 42.',
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'stop',
      },
    ])

    const strategy = new ReActStrategy(llm, { maxIterations: 5 })
    const ctx = makeCtx()

    const results = await collectYields(strategy.run('What is the answer?', ctx))

    expect(results.join('')).toBe('The answer is 42.')
    expect(llm.stream).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ maxTokens: 8192 }))
    expect(llm.stream).toHaveBeenCalledTimes(1)
  })

  it('appends user message and final assistant message to history on direct answer', async () => {
    const llm = makeLLMAdapter([
      {
        content: 'Hello!',
        promptTokens: 5,
        completionTokens: 2,
        finishReason: 'stop',
      },
    ])

    const strategy = new ReActStrategy(llm, { maxIterations: 5 })
    const ctx = makeCtx()

    await collectYields(strategy.run('Hi', ctx))

    expect(ctx.history.append).toHaveBeenCalledTimes(2)
    const calls = (ctx.history.append as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toMatchObject({ role: 'user', content: 'Hi' })
    expect(calls[1][0]).toMatchObject({ role: 'assistant', content: 'Hello!' })
  })

  // ── 2. Tool call followed by final answer ────────────────────────────────────
  it('executes tool call and then yields final answer', async () => {
    const toolCallResponse: LLMResponse = {
      content: '',
      toolCalls: [{ id: 'call-1', name: 'calculator', args: { expression: '2+2' } }],
      promptTokens: 20,
      completionTokens: 10,
      finishReason: 'tool_calls',
    }
    const finalResponse: LLMResponse = {
      content: 'The result is 4.',
      promptTokens: 30,
      completionTokens: 8,
      finishReason: 'stop',
    }

    const llm = makeLLMAdapter([toolCallResponse, finalResponse])
    const ctx = makeCtx({
      tools: {
        register: vi.fn(),
        unregister: vi.fn(),
        list: vi.fn().mockReturnValue([
          {
            name: 'calculator',
            description: 'Evaluates math expressions',
            parameters: { type: 'object', properties: {} },
          },
        ]),
        execute: vi.fn().mockResolvedValue({ success: true, output: '4' }),
        has: vi.fn().mockReturnValue(true),
      } as unknown as AgentContext['tools'],
    })

    const strategy = new ReActStrategy(llm, { maxIterations: 5 })
    const results = await collectYields(strategy.run('What is 2+2?', ctx))

    expect(results.join('')).toBe('The result is 4.')
    expect(llm.stream).toHaveBeenCalledTimes(2)
    expect(ctx.tools.execute).toHaveBeenCalledWith(
      'calculator',
      { expression: '2+2' },
      expect.objectContaining({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, currentToolCallId: 'call-1' }),
    )
  })

  it('appends assistant + tool + final messages to history on tool call flow', async () => {
    const llm = makeLLMAdapter([
      {
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'search', args: { query: 'test' } }],
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'tool_calls',
      },
      {
        content: 'Search done.',
        promptTokens: 15,
        completionTokens: 3,
        finishReason: 'stop',
      },
    ])

    const ctx = makeCtx({
      tools: {
        register: vi.fn(),
        unregister: vi.fn(),
        list: vi.fn().mockReturnValue([
          { name: 'search', description: 'Search', parameters: { type: 'object' } },
        ]),
        execute: vi.fn().mockResolvedValue({ success: true, output: 'results' }),
        has: vi.fn().mockReturnValue(true),
      } as unknown as AgentContext['tools'],
    })

    const strategy = new ReActStrategy(llm, { maxIterations: 5 })
    await collectYields(strategy.run('Search for test', ctx))

    const appendCalls = (ctx.history.append as ReturnType<typeof vi.fn>).mock.calls
    // user, assistant (with toolCall), tool result, final assistant
    expect(appendCalls).toHaveLength(4)
    expect(appendCalls[0][0]).toMatchObject({ role: 'user' })
    expect(appendCalls[1][0]).toMatchObject({ role: 'assistant' })
    expect(appendCalls[1][0].toolCall).toBeDefined()
    expect(appendCalls[2][0]).toMatchObject({ role: 'tool', toolCallId: 'tc-1', toolName: 'search' })
    expect(appendCalls[3][0]).toMatchObject({ role: 'assistant', content: 'Search done.' })
  })

  // ── 3. Max iterations exceeded ───────────────────────────────────────────────
  it('yields max-iterations error message when tool calls loop forever', async () => {
    // LLM always returns tool call → never reaches final answer
    const alwaysToolCall: LLMResponse = {
      content: '',
      toolCalls: [{ id: 'tc-loop', name: 'looper', args: {} }],
      promptTokens: 5,
      completionTokens: 5,
      finishReason: 'tool_calls',
    }

    const llm = makeLLMAdapter(Array(5).fill(alwaysToolCall))
    const ctx = makeCtx({
      tools: {
        register: vi.fn(),
        unregister: vi.fn(),
        list: vi.fn().mockReturnValue([
          { name: 'looper', description: 'Loops', parameters: { type: 'object' } },
        ]),
        execute: vi.fn().mockResolvedValue({ success: true, output: 'looping' }),
        has: vi.fn().mockReturnValue(true),
      } as unknown as AgentContext['tools'],
    })

    const strategy = new ReActStrategy(llm, { maxIterations: 3 })
    const results = await collectYields(strategy.run('Loop forever', ctx))

    expect(results).toHaveLength(1)
    expect(results[0]).toContain('[Max iterations (3) exceeded')
    expect(llm.stream).toHaveBeenCalledTimes(3)
  })

  // ── 3b. Explicit maxIterations must not be amplified by Superpower mode ────
  // Regression guard (openspec change: superpower-methodology-and-tiers, 任务 11.2)：
  // subagent 等调用方会显式传 maxSteps→maxIterations，一旦被 max 模式 ×4 放大，
  // 子代理会跑出预期边界。显式值必须原样使用。
  it('respects explicit maxIterations even under SUPERPOWER_MODE=max', async () => {
    const prev = process.env.SUPERPOWER_MODE
    process.env.SUPERPOWER_MODE = 'max'
    try {
      const alwaysToolCall: LLMResponse = {
        content: '',
        toolCalls: [{ id: 'tc-loop', name: 'looper', args: {} }],
        promptTokens: 5,
        completionTokens: 5,
        finishReason: 'tool_calls',
      }
      const llm = makeLLMAdapter(Array(20).fill(alwaysToolCall))
      const ctx = makeCtx({
        tools: {
          register: vi.fn(),
          unregister: vi.fn(),
          list: vi.fn().mockReturnValue([
            { name: 'looper', description: 'Loops', parameters: { type: 'object' } },
          ]),
          execute: vi.fn().mockResolvedValue({ success: true, output: 'looping' }),
          has: vi.fn().mockReturnValue(true),
        } as unknown as AgentContext['tools'],
      })

      const strategy = new ReActStrategy(llm, { maxIterations: 3 })
      const results = await collectYields(strategy.run('Loop', ctx))

      // 若 Superpower 放大了显式 cap，llm.complete 会被调用 12 次（3×4）；
      // 现在必须维持 3 次。
      expect(llm.stream).toHaveBeenCalledTimes(3)
      expect(results[0]).toContain('[Max iterations (3) exceeded')
    } finally {
      if (prev === undefined) delete process.env.SUPERPOWER_MODE
      else process.env.SUPERPOWER_MODE = prev
    }
  })

  // ── 4. Token budget exhausted ────────────────────────────────────────────────
  it('yields truncation message when token budget is exhausted before LLM call', async () => {
    const llm = makeLLMAdapter([
      {
        content: 'Should not be reached.',
        promptTokens: 0,
        completionTokens: 0,
        finishReason: 'stop',
      },
    ])

    // getTokenCount returns a value >= tokenBudget
    const ctx = makeCtx({ tokenBudget: 100 })
    ;(ctx.history.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      { role: 'user', content: 'huge input', tokens: 200 }
    ])

    const strategy = new ReActStrategy(llm, { maxIterations: 5 })
    const results = await collectYields(strategy.run('Any input', ctx))

    expect(results).toHaveLength(1)
    expect(results[0]).toContain('[Response truncated: token budget exceeded]')
    expect(llm.stream).not.toHaveBeenCalled()
  })

  // ── 5. LLM error is caught and yielded ──────────────────────────────────────
  it('yields error message when LLM complete() throws', async () => {
    const llm: LLMAdapter = {
      provider: 'mock',
      model: 'mock-model',
      stream: vi.fn().mockImplementation(async function* () {
        throw new Error('Network timeout')
      }),
      complete: vi.fn(),
      countTokens: vi.fn().mockReturnValue(0),
    } as unknown as LLMAdapter

    const strategy = new ReActStrategy(llm, { maxIterations: 5 })
    const ctx = makeCtx()

    const results = await collectYields(strategy.run('What time is it?', ctx))

    expect(results).toHaveLength(1)
    expect(results[0]).toContain('[Error: LLM call failed - Network timeout]')
  })

  // ── 6. Tool execution error is captured gracefully ───────────────────────────
  it('captures tool execution errors and adds them to history as tool messages', async () => {
    const llm = makeLLMAdapter([
      {
        content: '',
        toolCalls: [{ id: 'fail-1', name: 'broken_tool', args: {} }],
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'tool_calls',
      },
      {
        content: 'I encountered an error.',
        promptTokens: 15,
        completionTokens: 5,
        finishReason: 'stop',
      },
    ])

    const ctx = makeCtx({
      tools: {
        register: vi.fn(),
        unregister: vi.fn(),
        list: vi.fn().mockReturnValue([
          { name: 'broken_tool', description: 'Broken', parameters: { type: 'object' } },
        ]),
        execute: vi.fn().mockRejectedValue(new Error('Tool crashed')),
        has: vi.fn().mockReturnValue(true),
      } as unknown as AgentContext['tools'],
    })

    const strategy = new ReActStrategy(llm, { maxIterations: 5 })
    const results = await collectYields(strategy.run('Use broken tool', ctx))

    // Should still complete (second LLM call returns final answer)
    expect(results.join('')).toContain('I encountered an error.')

    // Tool message should contain the error text
    const appendCalls = (ctx.history.append as ReturnType<typeof vi.fn>).mock.calls
    const toolMsg = appendCalls.find((c: unknown[]) => (c[0] as Message).role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg![0].content).toContain('Tool error: Tool crashed')
  })

  it('bounds oversized Code tool results before they re-enter the model context', async () => {
    const llm = makeLLMAdapter([
      {
        content: '',
        toolCalls: [{ id: 'huge-1', name: 'execute_cmd', args: { command: 'build' } }],
        promptTokens: 10,
        completionTokens: 5,
        finishReason: 'tool_calls',
      },
      { content: '继续处理。', promptTokens: 20, completionTokens: 4, finishReason: 'stop' },
    ])
    const ctx = makeCtx({
      toolProfile: 'code',
      tools: {
        register: vi.fn(),
        unregister: vi.fn(),
        list: vi.fn().mockReturnValue([{ name: 'execute_cmd', description: 'run', parameters: { type: 'object' } }]),
        execute: vi.fn().mockResolvedValue({ success: true, output: 'x'.repeat(200_000) }),
        has: vi.fn().mockReturnValue(true),
      } as unknown as AgentContext['tools'],
    })

    await collectYields(new ReActStrategy(llm, { maxIterations: 3 }).run('执行构建', ctx))

    const toolMessage = (ctx.history.append as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as Message)
      .find((message) => message.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(typeof toolMessage?.content).toBe('string')
    expect((toolMessage?.content as string).length).toBeLessThanOrEqual(64 * 1024)
    expect(toolMessage?.content).toContain('[truncated')
  })

  it('keeps a valid image data URL for the multimodal adapter', () => {
    const raw = JSON.stringify({
      filename: 'diagram.png', mimeType: 'image/png', size: 2_000_000,
      dataUrl: `data:image/png;base64,${'A'.repeat(200_000)}`, hasDataUrl: true,
    })
    const compact = truncateToolOutput(raw, 1_024)
    expect(JSON.parse(compact)).toMatchObject({ filename: 'diagram.png', mimeType: 'image/png', size: 2_000_000,
      hasDataUrl: true, dataUrl: expect.stringMatching(/^data:image\/png;base64,/) })
  })

  it('does not let a fake hasDataUrl marker bypass the transcript cap', () => {
    const raw = JSON.stringify({ hasDataUrl: true, dataUrl: `not-an-image-${'x'.repeat(200_000)}` })
    const compact = truncateToolOutput(raw, 1_024)
    expect(compact.length).toBeLessThanOrEqual(1_024)
    expect(JSON.parse(compact)).toMatchObject({ hasDataUrl: false, dataUrlStripped: true })
    expect(JSON.parse(compact).dataUrl).toBeUndefined()
  })

  // ── 7. systemPrompt and temperature are forwarded to LLM ────────────────────
  it('passes systemPrompt and temperature options to LLM complete()', async () => {
    const llm = makeLLMAdapter([
      {
        content: 'Done.',
        promptTokens: 5,
        completionTokens: 2,
        finishReason: 'stop',
      },
    ])

    const strategy = new ReActStrategy(llm, {
      maxIterations: 5,
      systemPrompt: 'You are a helpful assistant.',
      temperature: 0.7,
    })
    const ctx = makeCtx()

    await collectYields(strategy.run('Hello', ctx))

    expect(llm.stream).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        systemPrompt: 'You are a helpful assistant.',
        temperature: 0.7,
      }),
    )
  })
})

describe('structured run lifecycle', () => {
  it('rejects Message[] before history or provider writes', async () => {
    const llm = makeLLMAdapter([{ content: 'unused', promptTokens: 0, completionTokens: 0, finishReason: 'stop' }])
    const onOutcome = vi.fn()
    const ctx = makeCtx({ runObserver: { onOutcome } })
    await collectYields(new ReActStrategy(llm).run([{ role: 'user', content: 'invalid' }], ctx))
    expect(llm.stream).not.toHaveBeenCalled()
    expect(ctx.history.append).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('Message[]') }) }))
  })

  it('reports a provider failure and preserves partial output', async () => {
    const llm = makeLLMAdapter([])
    llm.stream = async function* () { yield { done: false, content: 'partial evidence' }; throw new Error('400 invalid request') }
    const onOutcome = vi.fn()
    await collectYields(new ReActStrategy(llm).run('research', makeCtx({ runObserver: { onOutcome } })))
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'provider_error', partialOutput: 'partial evidence' }))
    expect(onOutcome.mock.calls.some(([value]) => value.status === 'succeeded')).toBe(false)
  })

  it('reports max_steps as a failure even when the loop emits explanatory text', async () => {
    const onOutcome = vi.fn()
    const output = await collectYields(new ReActStrategy(makeLLMAdapter([]), { maxIterations: 0 }).run('research', makeCtx({ runObserver: { onOutcome } })))
    expect(output.join('')).toContain('Max iterations')
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'max_steps' }))
  })

  it('durably saves both launches and isolates invocation contexts across awaits', async () => {
    const llm = makeLLMAdapter([])
    let count = 0
    let nextRequest: Message[] = []
    llm.stream = async function* (messages) {
      if (count++ === 0) yield { done: true, toolCalls: [
        { id: 'child-a', name: 'subagent', args: '{"task":"a"}', index: 0 },
        { id: 'child-b', name: 'subagent', args: '{"task":"b"}', index: 1 },
      ] }
      else { nextRequest = messages; yield { done: true, content: 'complete', promptTokens: 2, completionTokens: 1 } }
    }
    const onOutcome = vi.fn()
    const ctx = makeCtx({ runObserver: { onOutcome } })
    const seen: string[] = []
    ctx.tools.execute = async (_name, _args, invocation) => {
      const launched = await ctx.history.getHistory(ctx)
      expect(launched.filter(message => message.toolCall).map(message => message.toolCall?.id)).toEqual(['child-a', 'child-b'])
      await Promise.resolve()
      seen.push(invocation.currentToolCallId ?? '')
      expect(invocation.currentMessageId).toBeTruthy()
      return { success: true, output: invocation.currentToolCallId ?? '' }
    }
    await collectYields(new ReActStrategy(llm).run('research', ctx))
    expect(seen.sort()).toEqual(['child-a', 'child-b'])
    expect(ctx.currentToolCallId).toBeUndefined()
    const roles = nextRequest.filter(message => message.role !== 'user').map(message => `${message.role}:${message.toolCall?.id ?? message.toolCallId ?? ''}`)
    expect(roles).toEqual(['assistant:child-a', 'tool:child-a', 'assistant:child-b', 'tool:child-b'])
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }))
  })

  it('persists every sibling result before finishing cancellation', async () => {
    const abort = new AbortController()
    const llm = makeLLMAdapter([])
    llm.stream = async function* () { yield { done: true, toolCalls: [
      { id: 'a', name: 'read_file', args: '{}', index: 0 },
      { id: 'b', name: 'read_file', args: '{}', index: 1 },
    ] } }
    const onOutcome = vi.fn()
    const ctx = makeCtx({ signal: abort.signal, runObserver: { onOutcome } })
    ctx.tools.execute = async () => { abort.abort(); throw new DOMException('cancel', 'AbortError') }
    await collectYields(new ReActStrategy(llm).run('research', ctx))
    const history = await ctx.history.getHistory(ctx)
    expect(history.filter(message => message.role === 'tool').map(message => message.toolCallId).sort()).toEqual(['a', 'b'])
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })
})

describe('run resource and permission boundaries', () => {
  it('a length-limited model reply is partial, never succeeded', async () => {
    const llm = makeLLMAdapter([])
    llm.stream = async function* () { yield { done: true, content: 'unfinished evidence', finishReason: 'length' } }
    const onOutcome = vi.fn()
    const ctx = makeCtx({ runId: 'bounded', runObserver: { onOutcome } })
    await collectYields(new ReActStrategy(llm).run('task', ctx))
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'output_limit', partialOutput: 'unfinished evidence' }))
    expect((await ctx.history.getHistory(ctx)).find(message => message.id === 'subagent-outcome:bounded')?.content).toBe('unfinished evidence')
  })

  it('budget rejection keeps its own error code and does not shrink the context capacity', async () => {
    const llm = makeLLMAdapter([])
    llm.stream = async function* () { throw Object.assign(new Error('quota reached'), { code: 'TOKEN_BUDGET_EXCEEDED' }); yield { done: true } }
    const onOutcome = vi.fn()
    const ctx = makeCtx({ runObserver: { onOutcome } })
    await collectYields(new ReActStrategy(llm).run('task', ctx))
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'budget', error: expect.objectContaining({ code: 'TOKEN_BUDGET_EXCEEDED' }) }))
    expect(ctx.tokenBudget).toBe(100_000)
  })

  it('a forbidden child tool ends as blocked without another model call', async () => {
    const llm = makeLLMAdapter([{ content: '', toolCalls: [{ id: 'forbidden', name: 'write_file', args: {} }], promptTokens: 5, completionTokens: 1, finishReason: 'tool_calls' }])
    const onOutcome = vi.fn()
    const ctx = makeCtx({ runId: 'blocked', runObserver: { onOutcome } })
    ctx.tools.execute = async () => ({ success: false, output: 'Permission denied', metadata: { blocked: true } })
    await collectYields(new ReActStrategy(llm).run('task', ctx))
    expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'blocked', stopReason: 'permission' }))
    expect(llm.stream).toHaveBeenCalledTimes(1)
  })
})

it('does not execute partial tool dispatches when the provider hits its output limit', async () => {
  const llm = makeLLMAdapter([])
  llm.stream = async function* () { yield { done: true, finishReason: 'length', toolCalls: [
    { id: 'complete-first', name: 'write_file', args: '{"path":"first.ts"}', index: 0 },
    { id: 'truncated-second', name: 'write_file', args: '{"path":', index: 1 },
  ] } }
  const onOutcome = vi.fn()
  const ctx = makeCtx({ runObserver: { onOutcome } })
  await collectYields(new ReActStrategy(llm).run('task', ctx))
  expect(ctx.tools.execute).not.toHaveBeenCalled()
  expect(onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'output_limit' }))
})


describe('ReAct bounded finalization with opt-in cumulative budgets', () => {
  it('stops exploration on the last child iteration, returns evidence, and preserves incomplete status', async () => {
    const outcome = vi.fn()
    const llm = makeLLMAdapter([
      { content: '', toolCalls: [{ id: 'read-probe', name: 'read_file', args: { path: 'probe.ts' } }], promptTokens: 10, completionTokens: 3, finishReason: 'tool_calls' },
      { content: 'probe.ts contains the entry point; other modules were not checked.', promptTokens: 20, completionTokens: 8, finishReason: 'stop' },
    ])
    const ctx = makeCtx({ runObserver: { onOutcome: outcome } })
    ctx.tools.list = vi.fn().mockReturnValue([{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }])
    const output = await collectYields(new ReActStrategy(llm, { maxIterations: 2, finalizeOnLimit: true }).run('Inspect project', ctx))
    expect(ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(llm.stream).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ tools: [], maxTokens: 4096 }))
    expect(output.join('')).toContain('探索步数上限')
    expect(output.join('')).toContain('probe.ts contains')
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'max_steps', partialOutput: expect.stringContaining('probe.ts') }))
  })

  it('never executes a tool returned against the reserved no-tools finalization request', async () => {
    const llm = makeLLMAdapter([
      { content: '', toolCalls: [{ id: 'first', name: 'read_file', args: { path: 'a' } }], promptTokens: 10, completionTokens: 3, finishReason: 'tool_calls' },
      { content: '', toolCalls: [{ id: 'illegal-write', name: 'write_file', args: { path: 'b', data: 'bad' } }], promptTokens: 10, completionTokens: 3, finishReason: 'tool_calls' },
    ])
    const ctx = makeCtx()
    const output = await collectYields(new ReActStrategy(llm, { maxIterations: 2, finalizeOnLimit: true }).run('Inspect', ctx))
    expect(ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(output.join('')).toContain('tool result')
    expect(output.join('')).toContain('证据片段')
  })

  it('uses one no-tools summary only when an explicit budget cannot fund exploration plus a final answer', async () => {
    const { RequestBudget } = await import('../../subagent/budget.js')
    const budget = new RequestBudget(12_000)
    const outcome = vi.fn()
    const llm = makeLLMAdapter([{ content: 'Only the recorded evidence is available.', promptTokens: 20, completionTokens: 8, finishReason: 'stop' }])
    const ctx = makeCtx({ requestBudget: budget, runObserver: { onOutcome: outcome } })
    await collectYields(new ReActStrategy(llm, { maxIterations: 4 }).run('Inspect', ctx))
    expect(llm.stream).toHaveBeenCalledTimes(1)
    expect(llm.stream).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ tools: [], maxTokens: 4096 }))
    expect(ctx.tools.execute).not.toHaveBeenCalled()
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'budget', partialOutput: expect.stringContaining('recorded evidence') }))
  })

  it('returns saved evidence without another model call when even a summary cannot fit', async () => {
    const { RequestBudget } = await import('../../subagent/budget.js')
    const budget = new RequestBudget(10)
    const llm = makeLLMAdapter([{ content: 'must not run', promptTokens: 1, completionTokens: 1, finishReason: 'stop' }])
    const ctx = makeCtx({ requestBudget: budget })
    await ctx.history.append({ role: 'assistant', content: '', toolCall: { id: 'r', name: 'read_file', args: { path: 'entry.ts' } }, createdAt: 1 }, ctx)
    await ctx.history.append({ role: 'tool', content: 'export function realEntry() {}', toolCallId: 'r', toolName: 'read_file', createdAt: 2 }, ctx)
    const output = await collectYields(new ReActStrategy(llm).run('Inspect', ctx))
    expect(llm.stream).not.toHaveBeenCalled()
    expect(output.join('')).toContain('realEntry')
    expect(output.join('')).toContain('entry.ts')
    expect(output.join('')).not.toContain('LLM call failed')
  })
})

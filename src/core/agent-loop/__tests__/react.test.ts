import { vi } from 'vitest'
import { ReActStrategy } from '../react.js'
import type { AgentContext, Message } from '../../agent-context/index.js'
import type { LLMAdapter, LLMResponse } from '../../llm-adapter/index.js'

// ─── Helper ───────────────────────────────────────────────────────────────────

async function collectYields(iterable: AsyncIterable<string>): Promise<string[]> {
  const results: string[] = []
  for await (const chunk of iterable) {
    if (!chunk.includes('__tool_start__') && 
        !chunk.includes('__tool_end__') && 
        !chunk.includes('__thinking__') && 
        !chunk.includes('__usage__')) {
      results.push(chunk)
    }
  }
  return results
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeLLMAdapter(responses: LLMResponse[]): LLMAdapter {
  let callIndex = 0
  return {
    provider: 'mock',
    model: 'mock-model',
    complete: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex]
      callIndex = Math.min(callIndex + 1, responses.length - 1)
      return response
    }),
    stream: vi.fn(),
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

    expect(results).toHaveLength(1)
    expect(results[0]).toBe('The answer is 42.')
    expect(llm.complete).toHaveBeenCalledTimes(1)
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

    expect(results).toHaveLength(1)
    expect(results[0]).toBe('The result is 4.')
    expect(llm.complete).toHaveBeenCalledTimes(2)
    expect(ctx.tools.execute).toHaveBeenCalledWith(
      'calculator',
      { expression: '2+2' },
      ctx,
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
    expect(llm.complete).toHaveBeenCalledTimes(3)
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
    expect(llm.complete).not.toHaveBeenCalled()
  })

  // ── 5. LLM error is caught and yielded ──────────────────────────────────────
  it('yields error message when LLM complete() throws', async () => {
    const llm: LLMAdapter = {
      provider: 'mock',
      model: 'mock-model',
      complete: vi.fn().mockRejectedValue(new Error('Network timeout')),
      stream: vi.fn(),
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
    expect(results[0]).toBe('I encountered an error.')

    // Tool message should contain the error text
    const appendCalls = (ctx.history.append as ReturnType<typeof vi.fn>).mock.calls
    const toolMsg = appendCalls.find((c: unknown[]) => (c[0] as Message).role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg![0].content).toContain('Tool error: Tool crashed')
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

    expect(llm.complete).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        systemPrompt: 'You are a helpful assistant.',
        temperature: 0.7,
      }),
    )
  })
})

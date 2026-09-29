import { afterEach, describe, expect, it, vi } from 'vitest'
import { FallbackAdapter } from '../retry.js'
import { OpenAIAdapter } from '../openai.js'
import { OllamaAdapter } from '../ollama.js'
import { createAdapterFromResolved, type ResolvedModelConfig } from '../resolve-model.js'
import { BudgetExceededError, RequestBudget } from '../../subagent/budget.js'
import type { LLMAdapter, LLMAdapterOptions, LLMRequestAttemptEvent, LLMStreamChunk } from '../types.js'

const messages = [{ role: 'user' as const, content: 'Read the requested project file.' }]
const options: LLMAdapterOptions = { model: 'requested-primary', maxTokens: 32, systemPrompt: 'Stay inside this project.' }
const unavailable = () => Object.assign(new Error('Provider unavailable'), { status: 503 })

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

function fixtureAdapter(model: string, error?: unknown, progress: LLMStreamChunk[] = []): LLMAdapter {
  return {
    provider: 'openai', model, countTokens: text => Math.ceil(text.length / 4),
    complete: vi.fn(async () => {
      if (error) throw error
      return { content: `${model} answer`, promptTokens: 5, completionTokens: 2, finishReason: 'stop' as const }
    }),
    stream: vi.fn(async function* () {
      for (const chunk of progress) yield chunk
      if (error) throw error
      yield { content: `${model} answer`, done: false }
      yield { done: true, finishReason: 'stop' as const, promptTokens: 5, completionTokens: 2 }
    }),
  }
}

async function collect(adapter: LLMAdapter, requestOptions = options, chunks: LLMStreamChunk[] = []) {
  for await (const chunk of adapter.stream(messages, requestOptions)) chunks.push(chunk)
  return chunks
}

function wire(frames: unknown[], done = true) {
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
}

function successResponse(model = 'fallback-server-model') {
  return new Response(wire([
    { id: 'answer', model, choices: [{ index: 0, delta: { content: 'Fallback answer' }, finish_reason: null }] },
    { id: 'answer', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ]), { headers: { 'content-type': 'text/event-stream' } })
}

describe('D5 stream fallback delivery boundary', () => {
  it('switches on retryable failure before delivery and sends the selected model with unchanged request constraints', async () => {
    const primary = fixtureAdapter('primary', unavailable())
    const fallback = fixtureAdapter('fallback')
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback] })
    const chunks = await collect(adapter)
    expect(primary.stream).toHaveBeenCalledWith(messages, { ...options, model: 'primary' })
    expect(fallback.stream).toHaveBeenCalledWith(messages, { ...options, model: 'fallback' })
    expect(chunks.map(chunk => chunk.content ?? '').join('')).toBe('fallback answer')
    expect(chunks.every(chunk => chunk.model === 'fallback')).toBe(true)
    expect(chunks.at(-1)).toMatchObject({ done: true, promptTokens: 5, completionTokens: 2 })
    expect(options.model).toBe('requested-primary')
  })

  it.each([
    { content: 'partial content', done: false },
    { reasoningContent: 'partial reasoning', done: false },
    { toolCalls: [{ id: 'tool-1', name: 'read_file', args: '{"path":' }], done: false },
    { promptTokens: 9, completionTokens: 1, done: false },
    { done: true, finishReason: 'stop' as const },
  ])('does not switch after delivering $content $reasoningContent $toolCalls $done', async progress => {
    const error = unavailable()
    const primary = fixtureAdapter('primary', error, [progress])
    const fallback = fixtureAdapter('fallback')
    const delivered: LLMStreamChunk[] = []
    await expect(collect(new FallbackAdapter({ primary, fallbacks: [fallback] }), options, delivered)).rejects.toBe(error)
    expect(delivered).toEqual([{ ...progress, model: 'primary' }])
    expect(primary.stream).toHaveBeenCalledTimes(1)
    expect(fallback.stream).not.toHaveBeenCalled()
  })

  it.each([
    new DOMException('Stopped', 'AbortError'),
    new BudgetExceededError(),
    Object.assign(new Error('network forbidden by policy'), { code: 'POLICY_DENIED', retryable: false }),
    Object.assign(new Error('invalid request'), { status: 400 }),
    Object.assign(new Error('invalid credentials'), { status: 401 }),
    Object.assign(new Error('forbidden'), { status: 403 }),
    Object.assign(new Error('unknown model'), { status: 404 }),
    Object.assign(new Error('invalid input'), { status: 422 }),
    new Error('unexpected programming failure'),
  ])('does not hide non-retryable failure: %s', async error => {
    const primary = fixtureAdapter('primary', error)
    const fallback = fixtureAdapter('fallback')
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback] })
    await expect(collect(adapter)).rejects.toBe(error)
    await expect(adapter.complete(messages, options)).rejects.toBe(error)
    expect(fallback.stream).not.toHaveBeenCalled()
    expect(fallback.complete).not.toHaveBeenCalled()
  })

  it('honors an aborted signal before either provider starts', async () => {
    const primary = fixtureAdapter('primary', unavailable())
    const fallback = fixtureAdapter('fallback')
    await expect(collect(new FallbackAdapter({ primary, fallbacks: [fallback] }), {
      ...options, signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(primary.stream).not.toHaveBeenCalled()
    expect(fallback.stream).not.toHaveBeenCalled()
  })

  it('uses the selected model for non-streaming fallback and preserves response usage', async () => {
    const primary = fixtureAdapter('primary', unavailable())
    const fallback = fixtureAdapter('fallback')
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback] })
    expect(await adapter.complete(messages, options)).toMatchObject({ model: 'fallback', promptTokens: 5, completionTokens: 2 })
    expect(fallback.complete).toHaveBeenCalledWith(messages, { ...options, model: 'fallback' })
  })

  it('rejects a fallback with a smaller context window before sending it instead of dropping system or tools', async () => {
    const primary = fixtureAdapter('primary', unavailable())
    const fallback = fixtureAdapter('fallback')
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback], modelContextWindows: { fallback: 100 } })
    await expect(collect(adapter, { ...options, requestInputTokenEstimate: 80 })).rejects.toMatchObject({
      code: 'CONTEXT_WINDOW_EXCEEDED', retryable: false, model: 'fallback', contextWindow: 100,
    })
    expect(fallback.stream).not.toHaveBeenCalled()
    expect(options.systemPrompt).toBe('Stay inside this project.')
  })
})

describe('D5 actual OpenAI and factory fallback requests', () => {
  it('reaches fallback through createAdapterFromResolved, preserves tool schema and records exactly one event pair per physical request', async () => {
    vi.stubEnv('LLM_FALLBACK_MODEL', 'fallback-model')
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (body.model === 'primary-model') return new Response(JSON.stringify({ error: { message: 'temporarily unavailable', type: 'server_error' } }), {
        status: 503, headers: { 'content-type': 'application/json' },
      })
      return successResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const config: ResolvedModelConfig = { model: 'primary-model', provider: 'openai', apiKey: 'fixture-only',
      baseUrl: 'http://model.invalid', capabilities: { vision: false, thinking: false, toolCalling: true } }
    const adapter = createAdapterFromResolved(config)
    const tool = { name: 'read_file', description: 'Read a bound workspace file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: vi.fn(async () => ({ success: true, output: 'must not execute' })) }
    const events: LLMRequestAttemptEvent[] = []
    const budget = new RequestBudget()
    const chunks = await collect(adapter, { ...options, model: 'primary-model', tools: [tool],
      onRequestAttempt: event => { budget.observe(event); events.push(event) } })

    expect(bodies.map(body => body.model)).toEqual(['primary-model', 'primary-model', 'primary-model', 'primary-model', 'fallback-model'])
    expect(bodies.every(body => JSON.stringify(body.tools) === JSON.stringify(bodies[0].tools))).toBe(true)
    expect(bodies.at(-1)?.tools).toEqual([{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }])
    expect(bodies.at(-1)?.messages).toEqual(expect.arrayContaining([{ role: 'system', content: options.systemPrompt }]))
    expect(chunks.at(-1)).toMatchObject({ done: true, model: 'fallback-server-model', promptTokens: 5, completionTokens: 2 })
    expect(events).toHaveLength(fetchMock.mock.calls.length * 2)
    const starts = events.filter(event => event.type === 'start')
    const finishes = events.filter(event => event.type === 'finish')
    expect(new Set(starts.map(event => event.requestAttemptId)).size).toBe(5)
    expect(finishes.map(event => event.requestAttemptId)).toEqual(starts.map(event => event.requestAttemptId))
    expect(finishes.map(event => event.outcome)).toEqual(['failed', 'failed', 'failed', 'failed', 'succeeded'])
    expect(finishes.at(-1)).toMatchObject({ model: 'fallback-model', usage: { promptTokens: 5, completionTokens: 2 } })
    const unknownReservations = starts.slice(0, -1).reduce((total, event) => total + (event.estimatedInputTokens ?? 0) + (event.maxOutputTokens ?? 4096), 0)
    expect(budget.snapshot).toMatchObject({ charged: unknownReservations + 7, reserved: 0, unknown: true })
    expect(tool.execute).not.toHaveBeenCalled()
  }, 15_000)

  it.each([false, true])('treats EOF without terminal marker as failed (partial delivery: %s)', async partial => {
    let requests = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests++
      if (requests > 1) return successResponse()
      return new Response(wire([{ id: 'incomplete', choices: [{ index: 0, delta: partial ? { content: 'Partial answer' } : { role: 'assistant' }, finish_reason: null }] }], false),
        { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events: LLMRequestAttemptEvent[] = []
    const adapter = new FallbackAdapter({ primary: new OpenAIAdapter('primary', 'fixture-only', 'http://model.invalid'),
      fallbacks: [new OpenAIAdapter('fallback', 'fixture-only', 'http://model.invalid')] })
    const delivered: LLMStreamChunk[] = []
    const result = collect(adapter, { ...options, onRequestAttempt: event => { events.push(event) } }, delivered)
    if (partial) {
      await expect(result).rejects.toMatchObject({ code: 'INCOMPLETE_STREAM' })
      expect(requests).toBe(1)
      expect(delivered.map(chunk => chunk.content).join('')).toBe('Partial answer')
      expect(delivered.some(chunk => chunk.done)).toBe(false)
    } else {
      expect((await result).at(-1)).toMatchObject({ done: true, model: 'fallback-server-model' })
      expect(requests).toBe(2)
    }
    expect(events[1]).toMatchObject({ type: 'finish', outcome: 'failed' })
    expect(events).toHaveLength(requests * 2)
  })
})

describe('D5 native Ollama failure boundaries', () => {
  it.each(['complete', 'stream'] as const)('permits %s fallback for HTTP 503 and accounts for both selected model requests', async mode => {
    const selectedModels: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      selectedModels.push(body.model)
      if (body.model === 'local-primary') return new Response('service unavailable', { status: 503 })
      const result = { model: 'local-fallback', message: { content: 'Recovered locally' }, done: true,
        done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 }
      return new Response(JSON.stringify(result) + (mode === 'stream' ? '\n' : ''), {
        headers: { 'content-type': mode === 'stream' ? 'application/x-ndjson' : 'application/json' },
      })
    }))
    const events: LLMRequestAttemptEvent[] = []
    const adapter = new FallbackAdapter({ primary: new OllamaAdapter('local-primary', 'http://model.invalid'),
      fallbacks: [new OllamaAdapter('local-fallback', 'http://model.invalid')] })
    const request = { ...options, onRequestAttempt: (event: LLMRequestAttemptEvent) => { events.push(event) } }
    if (mode === 'complete') expect(await adapter.complete(messages, request)).toMatchObject({ content: 'Recovered locally', model: 'local-fallback' })
    else expect((await collect(adapter, request)).at(-1)).toMatchObject({ done: true, model: 'local-fallback', promptTokens: 5, completionTokens: 2 })
    expect(selectedModels).toEqual(['local-primary', 'local-fallback'])
    expect(events.map(event => event.type)).toEqual(['start', 'finish', 'start', 'finish'])
    expect(events[1]).toMatchObject({ outcome: 'failed', model: 'local-primary' })
    expect(events[3]).toMatchObject({ outcome: 'succeeded', model: 'local-fallback', usage: { promptTokens: 5, completionTokens: 2 } })
  })

  it.each([false, true])('requires done:true before recording stream success (partial delivery: %s)', async partial => {
    let requests = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests++
      const result = requests === 1
        ? { model: 'local-primary', message: { content: partial ? 'Partial local answer' : '' }, done: false }
        : { model: 'local-fallback', message: { content: 'Complete fallback answer' }, done: true, prompt_eval_count: 5, eval_count: 2 }
      return new Response(JSON.stringify(result) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
    }))
    const events: LLMRequestAttemptEvent[] = []
    const adapter = new FallbackAdapter({ primary: new OllamaAdapter('local-primary', 'http://model.invalid'),
      fallbacks: [new OllamaAdapter('local-fallback', 'http://model.invalid')] })
    const delivered: LLMStreamChunk[] = []
    const result = collect(adapter, { ...options, onRequestAttempt: event => { events.push(event) } }, delivered)
    if (partial) {
      await expect(result).rejects.toMatchObject({ code: 'INCOMPLETE_STREAM' })
      expect(requests).toBe(1)
      expect(delivered).toEqual([{ content: 'Partial local answer', done: false, model: 'local-primary' }])
    } else {
      expect((await result).at(-1)).toMatchObject({ done: true, model: 'local-fallback' })
      expect(requests).toBe(2)
    }
    expect(events[1]).toMatchObject({ type: 'finish', outcome: 'failed' })
    expect(events).toHaveLength(requests * 2)
  })
})

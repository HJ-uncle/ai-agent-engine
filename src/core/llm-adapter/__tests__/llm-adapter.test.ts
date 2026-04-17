import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OllamaAdapter } from '../ollama.js'
import { OpenAIAdapter } from '../openai.js'
import { withRetry, FallbackAdapter } from '../retry.js'
import type { LLMAdapter, LLMResponse, LLMAdapterOptions } from '../types.js'
import type { Message } from '../../agent-context/index.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMessages(content = 'hello'): Message[] {
  return [{ role: 'user', content }]
}

function makeMockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: vi.fn().mockResolvedValue(body),
    body: null,
  } as unknown as Response
}

// ─── OllamaAdapter ────────────────────────────────────────────────────────────

describe('OllamaAdapter', () => {
  let adapter: OllamaAdapter

  beforeEach(() => {
    adapter = new OllamaAdapter('llama3.2')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('complete() — returns LLMResponse on successful fetch', async () => {
    const mockBody = {
      message: { content: 'Hello, world!' },
      prompt_eval_count: 10,
      eval_count: 20,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(mockBody)))

    const result = await adapter.complete(makeMessages())

    expect(result.content).toBe('Hello, world!')
    expect(result.promptTokens).toBe(10)
    expect(result.completionTokens).toBe(20)
    expect(result.finishReason).toBe('stop')

    const fetchMock = fetch as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/chat')
    expect(init.method).toBe('POST')

    vi.unstubAllGlobals()
  })

  it('complete() — throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse({}, false, 500)))

    await expect(adapter.complete(makeMessages())).rejects.toThrow('Ollama API error: 500')

    vi.unstubAllGlobals()
  })

  it('complete() — sends systemPrompt as system message', async () => {
    const mockBody = {
      message: { content: 'ok' },
      prompt_eval_count: 5,
      eval_count: 5,
    }
    const fetchSpy = vi.fn().mockResolvedValue(makeMockResponse(mockBody))
    vi.stubGlobal('fetch', fetchSpy)

    await adapter.complete(makeMessages(), { model: 'llama3.2', systemPrompt: 'You are helpful.' })

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })

    vi.unstubAllGlobals()
  })
})

// ─── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('succeeds on second attempt after first failure', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('rate limit exceeded')
      return 'success'
    })

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 })

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after exceeding maxRetries', async () => {
    const fn = vi.fn(async () => {
      throw new Error('rate limit exceeded')
    })

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 }),
    ).rejects.toThrow('rate limit exceeded')

    // attempt 0, 1, 2 → 3 total calls
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn(async () => {
      throw new Error('invalid input')
    })

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 }),
    ).rejects.toThrow('invalid input')

    // should fail immediately without retrying
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('returns value immediately if first call succeeds', async () => {
    const fn = vi.fn(async () => 42)

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 })

    expect(result).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ─── FallbackAdapter ──────────────────────────────────────────────────────────

describe('FallbackAdapter', () => {
  function makeMockAdapter(name: string, failWith?: Error): LLMAdapter {
    return {
      provider: name,
      model: `${name}-model`,
      complete: vi.fn(async (_msgs: Message[], _opts?: LLMAdapterOptions): Promise<LLMResponse> => {
        if (failWith) throw failWith
        return {
          content: `response from ${name}`,
          promptTokens: 5,
          completionTokens: 10,
          finishReason: 'stop',
        }
      }),
      stream: vi.fn(async function* () { yield { done: true } }),
      countTokens: vi.fn((text: string) => text.length),
    }
  }

  it('returns primary response when primary succeeds', async () => {
    const primary = makeMockAdapter('primary')
    const fallback = makeMockAdapter('fallback')
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback] })

    const result = await adapter.complete(makeMessages())

    expect(result.content).toBe('response from primary')
    expect(primary.complete).toHaveBeenCalledOnce()
    expect(fallback.complete).not.toHaveBeenCalled()
  })

  it('falls back to secondary when primary fails', async () => {
    const primary = makeMockAdapter('primary', new Error('primary failed'))
    const fallback = makeMockAdapter('fallback')
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback] })

    const result = await adapter.complete(makeMessages())

    expect(result.content).toBe('response from fallback')
    expect(primary.complete).toHaveBeenCalledOnce()
    expect(fallback.complete).toHaveBeenCalledOnce()
  })

  it('throws when all adapters fail', async () => {
    const primary = makeMockAdapter('primary', new Error('primary failed'))
    const fallback = makeMockAdapter('fallback', new Error('fallback failed'))
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback] })

    await expect(adapter.complete(makeMessages())).rejects.toThrow('fallback failed')
  })

  it('provider and model reflect primary adapter', () => {
    const primary = makeMockAdapter('myProvider')
    const adapter = new FallbackAdapter({ primary, fallbacks: [] })

    expect(adapter.provider).toBe('myProvider')
    expect(adapter.model).toBe('myProvider-model')
  })
})

// ─── OpenAIAdapter.countTokens ────────────────────────────────────────────────

describe('OpenAIAdapter.countTokens', () => {
  it('returns Math.ceil(text.length / 4)', () => {
    // Construct adapter without triggering real OpenAI client during tests
    // by stubbing the OpenAI constructor via the module mock approach.
    // We verify the pure math of countTokens directly.
    const adapter = new OpenAIAdapter('gpt-4o-mini')

    expect(adapter.countTokens('')).toBe(0)
    expect(adapter.countTokens('1234')).toBe(1)       // 4 / 4 = 1
    expect(adapter.countTokens('12345')).toBe(2)      // ceil(5/4) = 2
    expect(adapter.countTokens('hello world')).toBe(Math.ceil('hello world'.length / 4))
    expect(adapter.countTokens('a'.repeat(100))).toBe(25)
  })
})

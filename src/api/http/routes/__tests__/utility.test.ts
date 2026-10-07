import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { utilityRoutes } from '../utility.js'
import { createAdapterFromResolved, resolveModelConfig } from '../../../../core/llm-adapter/resolve-model.js'

vi.mock('../../../../core/llm-adapter/resolve-model.js', () => ({
  createAdapterFromResolved: vi.fn(),
  resolveModelConfig: vi.fn(),
}))

const complete = vi.fn()
let app: FastifyInstance

beforeEach(async () => {
  complete.mockReset().mockResolvedValue({ content: '  generated result  ' })
  vi.mocked(resolveModelConfig).mockReset().mockResolvedValue({
    model: 'gpt-4o-mini',
    provider: 'openai',
  } as never)
  vi.mocked(createAdapterFromResolved).mockReset().mockReturnValue({ complete } as never)

  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: 'tenant-a' } })
  })
  await app.register(utilityRoutes)
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
})

describe('utility chat model resolution', () => {
  it('uses the authenticated tenant and does not override the resolved model with an empty string', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/utility/chat',
      payload: { userPrompt: 'please rewrite this' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ text: 'generated result' })
    expect(resolveModelConfig).toHaveBeenCalledWith({ tenantId: 'tenant-a', model: undefined })
    expect(complete).toHaveBeenCalledWith(
      [{ role: 'user', content: 'please rewrite this' }],
      { model: 'gpt-4o-mini', temperature: 0.3, maxTokens: 2000 },
    )
    expect(complete.mock.calls[0][1].model).not.toBe('')
  })

  it('passes the utility instruction through adapter systemPrompt', async () => {
    await app.inject({
      method: 'POST',
      url: '/utility/chat',
      payload: { systemPrompt: 'Use one concise line.', userPrompt: 'write a title' },
    })

    expect(complete).toHaveBeenCalledWith(
      [{ role: 'user', content: 'write a title' }],
      expect.objectContaining({ systemPrompt: 'Use one concise line.' }),
    )
  })

  it('resolves an explicitly selected model in the authenticated tenant', async () => {
    await app.inject({
      method: 'POST',
      url: '/utility/chat',
      payload: { model: 'claude-3-5-sonnet', userPrompt: 'write a title' },
    })

    expect(resolveModelConfig).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      model: 'claude-3-5-sonnet',
    })
  })

  it('disables hidden reasoning for DeepSeek utility calls so visible text is not starved', async () => {
    vi.mocked(resolveModelConfig).mockResolvedValueOnce({
      model: 'deepseek-v4.1-flash',
      provider: 'deepseek',
    } as never)
    complete.mockResolvedValueOnce({ content: '  visible answer  ' })

    const response = await app.inject({
      method: 'POST',
      url: '/utility/chat',
      payload: { model: 'deepseek-v4.1-flash', userPrompt: 'write a commit title', maxTokens: 200 },
    })

    expect(response.json().data).toEqual({ text: 'visible answer' })
    expect(complete).toHaveBeenCalledWith(
      [{ role: 'user', content: 'write a commit title' }],
      expect.objectContaining({
        model: 'deepseek-v4.1-flash',
        // Preserve enough room for short utility output while disabling the
        // hidden reasoning budget that previously consumed all 200 tokens.
        maxTokens: 10000,
        thinkingConfig: {
          enable_thinking: false,
          reasoning_effort: 'low',
        },
        responseThinkingField: null,
      }),
    )
  })

  it('keeps Anthropic-compatible gateways on their native wire contract', async () => {
    vi.mocked(resolveModelConfig).mockResolvedValueOnce({
      model: 'deepseek-v4.1-flash',
      provider: 'deepseek',
      baseUrl: 'https://token-plan.example/apps/anthropic',
      capabilities: { thinking: true },
    } as never)
    complete.mockResolvedValueOnce({ content: '  visible answer  ' })

    const response = await app.inject({
      method: 'POST',
      url: '/utility/chat',
      payload: {
        model: 'deepseek-v4.1-flash',
        systemPrompt: 'Use one concise line.',
        userPrompt: 'write a commit title',
        maxTokens: 1500,
      },
    })

    expect(response.json().data).toEqual({ text: 'visible answer' })
    const options = complete.mock.calls[0][1] as Record<string, unknown>
    expect(options).toMatchObject({
      model: 'deepseek-v4.1-flash',
      systemPrompt: 'Use one concise line.',
      maxTokens: 10000,
    })
    expect(options).not.toHaveProperty('thinkingConfig')
    expect(options).not.toHaveProperty('responseThinkingField')
  })

  it('turns an upstream empty content into a utility error envelope', async () => {
    complete.mockResolvedValueOnce({ content: '', reasoningContent: 'hidden reasoning', finishReason: 'length' })
    const response = await app.inject({
      method: 'POST',
      url: '/utility/chat',
      payload: { userPrompt: 'write a title' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ code: 50201, message: '模型返回内容为空', data: null })
  })
})

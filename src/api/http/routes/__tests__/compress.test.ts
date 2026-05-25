import { FastifyInstance } from 'fastify'
import { SQLiteConversationHistory } from '../../../../storage/conversation/index.js'
import { conversationRoutes } from '../conversation.js'
import Fastify from 'fastify'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock llm-adapter factory
vi.mock('../../../../core/llm-adapter/factory.js', () => {
  return {
    createLLMAdapter: () => ({
      model: 'test-model',
      complete: async () => ({
        content: 'Mocked Summary',
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120
      })
    })
  }
})

describe('Conversation Compression API', () => {
  let fastify: FastifyInstance
  let history: SQLiteConversationHistory

  beforeEach(async () => {
    history = new SQLiteConversationHistory()
    fastify = Fastify()
    fastify.decorateRequest('authContext', null)
    fastify.addHook('onRequest', async (req) => {
      ;(req as any).authContext = { tenantId: 'test-tenant' }
    })
    await fastify.register(conversationRoutes)
  })

  afterEach(async () => {
    await history.clear({ tenantId: 'test-tenant', sessionId: 'test-session' })
    await history.clear({ tenantId: 'test-tenant', sessionId: 'test-session-err' })
    await fastify.close()
  })

  it('should compress history and preserve data integrity', async () => {
    // 1. Prepare data
    await history.append({ role: 'user', content: 'Hello AI' }, { tenantId: 'test-tenant', sessionId: 'test-session' })
    await history.append({ role: 'assistant', content: 'Hi User!' }, { tenantId: 'test-tenant', sessionId: 'test-session' })
    await history.append({ role: 'user', content: 'Can you summarize this?' }, { tenantId: 'test-tenant', sessionId: 'test-session' })

    // 2. Call compress endpoint
    const response = await fastify.inject({
      method: 'POST',
      url: '/conversation/compress?sessionId=test-session'
    })

    console.log(response.json())

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json.data.success).toBe(true)
    expect(json.data.stats).toBeDefined()
    expect(json.data.stats.compressedTokens).toBe(20)

    // 3. Verify history after compression
    const messages = await history.getHistory({ tenantId: 'test-tenant', sessionId: 'test-session' })
    expect(messages.length).toBe(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('【历史上下文摘要】')
    expect(messages[0].content).toContain('Mocked Summary')
    expect(messages[0].usage).toBeDefined()
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toContain('我已经为您完成了上下文压缩')
  })

  it('should rollback history if LLM completion fails', async () => {
    // 1. Prepare data
    await history.append({ role: 'user', content: 'Message 1' }, { tenantId: 'test-tenant', sessionId: 'test-session-err' })
    await history.append({ role: 'assistant', content: 'Message 2' }, { tenantId: 'test-tenant', sessionId: 'test-session-err' })

    // Override mock for error
    const factory = await import('../../../../core/llm-adapter/factory.js')
    const adapter = factory.createLLMAdapter()
    vi.spyOn(adapter, 'complete').mockRejectedValueOnce(new Error('LLM Timeout'))
    vi.spyOn(factory, 'createLLMAdapter').mockReturnValueOnce(adapter)

    // 2. Call compress endpoint
    const response = await fastify.inject({
      method: 'POST',
      url: '/conversation/compress?sessionId=test-session-err'
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json.code).toBe(50000)
    expect(json.message).toContain('LLM Timeout')

    // 3. Verify history is untouched
    const messages = await history.getHistory({ tenantId: 'test-tenant', sessionId: 'test-session-err' })
    expect(messages.length).toBe(2)
    expect(messages[0].role).toBe('user')
    expect(messages[1].role).toBe('assistant')
  })
})
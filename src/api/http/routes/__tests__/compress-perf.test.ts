import { FastifyInstance } from 'fastify'
import { SQLiteConversationHistory } from '../../../../storage/conversation/index.js'
import { conversationRoutes } from '../conversation.js'
import Fastify from 'fastify'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock llm-adapter factory with simulated delay
vi.mock('../../../../core/llm-adapter/factory.js', () => {
  return {
    createLLMAdapter: () => ({
      model: 'test-model',
      complete: async () => {
        // Simulate LLM delay
        await new Promise(resolve => setTimeout(resolve, 500))
        return {
          content: 'Mocked Summary for Performance Test',
          promptTokens: 1000,
          completionTokens: 150,
          totalTokens: 1150
        }
      }
    })
  }
})

describe('Conversation Compression API Performance', () => {
  let fastify: FastifyInstance
  let history: SQLiteConversationHistory

  beforeEach(async () => {
    history = new SQLiteConversationHistory()
    fastify = Fastify()
    fastify.decorateRequest('authContext', { tenantId: 'perf-tenant' })
    await fastify.register(conversationRoutes)
  })

  afterEach(async () => {
    await history.clear({ tenantId: 'perf-tenant', sessionId: 'perf-session' })
    await fastify.close()
  })

  it('should complete compression within 2 seconds', async () => {
    // Prepare 50 messages to simulate long history
    for (let i = 0; i < 50; i++) {
      await history.append({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message content ${i} `.repeat(20), tokens: 100 }, { tenantId: 'perf-tenant', sessionId: 'perf-session' })
    }

    const startTime = Date.now()
    const response = await fastify.inject({
      method: 'POST',
      url: '/conversation/compress?sessionId=perf-session'
    })
    const endTime = Date.now()

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json.data.success).toBe(true)

    const duration = endTime - startTime
    console.log(`Compression took ${duration}ms`)
    
    // Ensure it's under 2000ms
    expect(duration).toBeLessThan(2000)
  })
})
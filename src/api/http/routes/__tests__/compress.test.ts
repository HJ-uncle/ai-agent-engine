import { FastifyInstance } from 'fastify'
import { initDb, closeDb } from '../../../../storage/sqlite/db.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { conversationRoutes } from '../conversation.js'
import Fastify from 'fastify'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'

// Vitest setup supplies an isolated per-spec database; these integration tests need its real schema.
beforeAll(async () => { await initDb() })
afterAll(() => { closeDb() })

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
  let history: ReturnType<typeof createConversationHistory>

  beforeEach(async () => {
    history = createConversationHistory()
    fastify = Fastify()
    fastify.decorateRequest('authContext', null)
    fastify.addHook('onRequest', async (req) => {
      ;(req as any).authContext = { tenantId: 'test-tenant' }
    })
    await fastify.register(conversationRoutes)
  })

  afterEach(async () => {
    await history.clear({ tenantId: 'test-tenant', sessionId: 'test-session' }, { tombstone: false })
    await history.clear({ tenantId: 'test-tenant', sessionId: 'test-session-err' }, { tombstone: false })
    await fastify.close()
  })

  it('should compress history and preserve data integrity', async () => {
    // 1. Prepare data（8 条，超过手动压缩下限且超出保留 6 条的窗口）
    for (let i = 1; i <= 8; i++) {
      await history.append({ role: i % 2 ? 'user' : 'assistant', content: `Message ${i}` }, { tenantId: 'test-tenant', sessionId: 'test-session' })
    }

    // 2. Call compress endpoint
    const response = await fastify.inject({
      method: 'POST',
      url: '/conversation/compress?sessionId=test-session'
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json.data.success).toBe(true)
    expect(json.data.stats).toBeDefined()
    expect(json.data.stats.compressedTokens).toBeGreaterThan(0)

    // 3. Verify history after compression（8 条 → 摘要 1 条 + 最近 6 条 + 压缩反馈 1 条 = 8 条）
    const messages = await history.getHistory({ tenantId: 'test-tenant', sessionId: 'test-session' })
    expect(messages.length).toBe(8)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Mocked Summary')
    expect(messages[7].role).toBe('assistant')
    expect(messages[7].content).toContain('我已经为您完成了上下文压缩')

    const archive = await fastify.inject({
      method: 'GET',
      url: '/conversation/archive?sessionId=test-session'
    })
    expect(archive.statusCode).toBe(200)
    const archiveJson = archive.json()
    expect(archiveJson.metadata.compressed).toBe(true)
    expect(archiveJson.metadata.archiveMessageCount).toBeGreaterThan(messages.length)
    expect(archiveJson.data.some((message: { content?: string }) => message.content === 'Message 1')).toBe(true)
  })

  it('should rollback history if LLM completion fails', async () => {
    // 1. Prepare data（超过手动压缩的 4 条下限）
    for (let i = 1; i <= 8; i++) {
      await history.append({ role: i % 2 ? 'user' : 'assistant', content: `Message ${i}` }, { tenantId: 'test-tenant', sessionId: 'test-session-err' })
    }

    // Override mock for error
    const factory = await import('../../../../core/llm-adapter/factory.js')
    const adapter = factory.createLLMAdapter()
    vi.spyOn(adapter, 'complete').mockRejectedValueOnce(new Error('LLM Timeout'))
    vi.spyOn(factory, 'createLLMAdapter').mockReturnValueOnce(adapter)

    const beforeMessages = await history.getHistory({ tenantId: 'test-tenant', sessionId: 'test-session-err' })

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
    expect(messages.length).toBe(8)
    expect(messages[0].role).toBe('user')
    expect(messages[1].role).toBe('assistant')
    expect(messages[2].role).toBe('user')
  })
})

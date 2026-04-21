import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { messagesRoutes } from '../messages.js'
import { conversationRoutes } from '../conversation.js'

vi.mock('../../../../storage/sqlite/db.js', () => {
  const executeMock = vi.fn().mockResolvedValue({ rows: [{ session_id: 'test-session-id' }] })
  return {
    getDb: vi.fn(() => ({
      execute: executeMock
    }))
  }
})

// Mock SQLiteConversationHistory
const mockHistory = {
  getMessageById: vi.fn(),
  getRawTokenCount: vi.fn(),
  deleteMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  deleteMessagesAfterId: vi.fn(),
  clear: vi.fn(),
  listSessions: vi.fn(),
  getHistory: vi.fn(),
  getByConversationId: vi.fn(),
}

vi.mock('../../../../storage/conversation/index.js', () => ({
  SQLiteConversationHistory: vi.fn(() => mockHistory)
}))

// Mock AI execution dependencies
vi.mock('../../../../core/llm-adapter/index.js', () => ({
  createLLMAdapter: vi.fn(() => ({}))
}))
vi.mock('../../../../core/stream-pipeline/index.js', () => ({
  createPipeline: vi.fn(() => ({ pipe: vi.fn() })),
  sseStream: vi.fn(async (stream, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' })
    reply.raw.end()
  })
}))
vi.mock('../../../../tools/mcp/loader.js', () => ({
  registerMCPTools: vi.fn()
}))

describe('Messages & Conversation Routes', () => {
  let fastify: ReturnType<typeof Fastify>

  beforeEach(async () => {
    vi.clearAllMocks()
    fastify = Fastify()

    // Add mock auth hook to set tenantId
    fastify.addHook('onRequest', async (request: any) => {
      request.authContext = { tenantId: 'tenant-1' }
    })

    await fastify.register(messagesRoutes, { prefix: '/api/v1' })
    await fastify.register(conversationRoutes, { prefix: '/api/v1' })
  })

  describe('Token Queries', () => {
    it('GET /api/v1/messages/:messageId/tokens returns tokens for a message', async () => {
      mockHistory.getMessageById.mockResolvedValue({ id: 'msg-1', tokens: 42 })
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/messages/msg-1/tokens'
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ messageId: 'msg-1', tokens: 42 })
      expect(mockHistory.getMessageById).toHaveBeenCalledWith('msg-1', 'tenant-1')
    })

    it('GET /api/v1/sessions/:sessionId/tokens returns total tokens for a session', async () => {
      mockHistory.getRawTokenCount.mockResolvedValue(150)
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/sessions/session-1/tokens'
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ sessionId: 'session-1', totalTokens: 150 })
      expect(mockHistory.getRawTokenCount).toHaveBeenCalledWith({ tenantId: 'tenant-1', sessionId: 'session-1' })
    })
  })

  describe('Message Editing and Regenerating', () => {
    it('PUT /api/v1/messages/:messageId edits message and hard deletes subsequent messages', async () => {
      mockHistory.getMessageById.mockResolvedValue({ id: 'msg-1', dbId: 10, role: 'user' })
      const res = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/messages/msg-1',
        payload: { content: 'updated question' }
      })
      
      if (res.statusCode === 500) {
        console.error(res.json())
      }
      expect(res.statusCode).toBe(200)
      // Updates message content
      expect(mockHistory.updateMessageContent).toHaveBeenCalledWith('msg-1', 'tenant-1', 'updated question', expect.any(Number))
      // Hard deletes messages after it
      expect(mockHistory.deleteMessagesAfterId).toHaveBeenCalledWith(10, 'test-session-id', 'tenant-1')
    })

    it('POST /api/v1/messages/:messageId/regenerate hard deletes AI message and subsequent messages', async () => {
      mockHistory.getMessageById.mockResolvedValue({ id: 'msg-2', dbId: 11, role: 'assistant' })
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/messages/msg-2/regenerate',
        payload: {}
      })
      
      expect(res.statusCode).toBe(200)
      // Hard deletes the current message
      expect(mockHistory.deleteMessage).toHaveBeenCalledWith('msg-2', 'tenant-1')
      // Hard deletes all messages after it
      expect(mockHistory.deleteMessagesAfterId).toHaveBeenCalledWith(11, 'test-session-id', 'tenant-1')
    })
  })

  describe('Deletion', () => {
    it('DELETE /api/v1/messages/:messageId hard deletes a single message', async () => {
      mockHistory.getMessageById.mockResolvedValue({ id: 'msg-1' })
      const res = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/messages/msg-1'
      })
      
      expect(res.statusCode).toBe(200)
      expect(mockHistory.deleteMessage).toHaveBeenCalledWith('msg-1', 'tenant-1')
      expect(res.json()).toEqual({ success: true, messageId: 'msg-1' })
    })

    it('DELETE /api/v1/sessions/:sessionId hard deletes the entire session', async () => {
      const res = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/sessions/sess-1'
      })
      
      expect(res.statusCode).toBe(200)
      expect(mockHistory.clear).toHaveBeenCalledWith({ tenantId: 'tenant-1', sessionId: 'sess-1' })
      expect(res.json()).toEqual({ success: true, sessionId: 'sess-1' })
    })
  })
})

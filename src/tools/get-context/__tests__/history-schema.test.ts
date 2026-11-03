import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { searchHistoryTool } from '../search-history-tool.js'

it('published history schema rejects requests the runtime cannot execute', async () => {
  const app = Fastify()
  app.post('/query', { schema: { body: searchHistoryTool.parameters } }, async () => ({ accepted: true }))
  try {
    for (const payload of [{}, { query: '   ' }, { query: 'decision', imageIndex: 0 }, { messageId: '', imageIndex: 0 }, { messageId: 'message', limit: 11 }]) {
      expect((await app.inject({ method: 'POST', url: '/query', payload })).statusCode, JSON.stringify(payload)).toBe(400)
    }
    for (const payload of [{ query: 'decision' }, { messageId: 'message', imageIndex: 0 }, { query: 'decision', messageId: 'message' }]) {
      expect((await app.inject({ method: 'POST', url: '/query', payload })).statusCode, JSON.stringify(payload)).toBe(200)
    }
  } finally { await app.close() }
})

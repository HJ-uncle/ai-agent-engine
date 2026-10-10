import { FastifyInstance } from 'fastify'
import { initDb, closeDb } from '../../../../storage/sqlite/db.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { autoCompactSession, conversationRoutes } from '../conversation.js'
import Fastify from 'fastify'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { createAdapterFromResolved } from '../../../../core/llm-adapter/resolve-model.js'

// Vitest setup supplies an isolated per-spec database; these integration tests need its real schema.
beforeAll(async () => { await initDb() })
afterAll(() => { closeDb() })

vi.mock('../../../../core/llm-adapter/resolve-model.js', () => {
  return {
    resolveModelConfig: vi.fn(async () => ({ model: 'test-model', provider: 'test', capabilities: { contextWindow: 100_000 } })),
    createAdapterFromResolved: vi.fn(() => ({
      model: 'test-model',
      complete: async () => ({
        content: 'Mocked Summary',
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120
      })
    }))
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
    vi.restoreAllMocks()
    await history.clear({ tenantId: 'test-tenant', sessionId: 'test-session' }, { tombstone: false })
    await history.clear({ tenantId: 'test-tenant', sessionId: 'test-session-err' }, { tombstone: false })
    await fastify.close()
  })

  it.each(['running', 'waiting'] as const)('does not compact or cancel a %s root', async status => {
    const ctx = { tenantId: 'test-tenant', sessionId: `active-${status}` }
    for (let i = 0; i < 8; i++) await history.append({ id: `${status}-${i}`, role: i % 2 ? 'assistant' : 'user', content: `original-${i}` }, ctx)
    const run = await rootRunStore.create(ctx.tenantId, ctx.sessionId, 'test-model', [], {})
    if (status === 'waiting') await rootRunStore.update(ctx.tenantId, run.runId, { status })
    const before = await history.getFullHistory(ctx)
    const states = vi.fn()
    const result = await autoCompactSession(ctx.tenantId, ctx.sessionId, { info: vi.fn() }, undefined, { onCompaction: states })
    expect(result).toBeUndefined()
    expect(states).not.toHaveBeenCalled()
    expect(await history.getFullHistory(ctx)).toEqual(before)
    expect((await rootRunStore.get(ctx.tenantId, run.runId))?.status).toBe(status)
    await rootRunStore.update(ctx.tenantId, run.runId, { status: 'cancelled' })
    await history.clear(ctx)
  })

  it('background compaction preserves only real assistant messages and skips a newly active root', async () => {
    const ctx = { tenantId: 'test-tenant', sessionId: 'background-compaction' }
    for (let i = 0; i < 8; i++) await history.append({ id: `background-${i}`, role: i % 2 ? 'assistant' : 'user', content: `original-${i}` }, ctx)
    const complete = vi.fn(async () => ({ content: 'Background summary', finishReason: 'stop' as const, promptTokens: 10, completionTokens: 3, totalTokens: 13 }))
    vi.mocked(createAdapterFromResolved).mockReturnValueOnce({ model: 'test-model', provider: 'test', complete,
      stream: async function* () { throw new Error('Background compaction must use complete') }, countTokens: () => 0 })
    const logger = { info: vi.fn() }
    const run = await rootRunStore.create(ctx.tenantId, ctx.sessionId, 'test-model', [], {})
    const before = await history.getFullHistory(ctx)
    await autoCompactSession(ctx.tenantId, ctx.sessionId, logger)
    expect(complete).not.toHaveBeenCalled()
    expect(await history.getFullHistory(ctx)).toEqual(before)
    expect((await rootRunStore.get(ctx.tenantId, run.runId))?.status).toBe('running')
    await rootRunStore.update(ctx.tenantId, run.runId, { status: 'succeeded' })
    await autoCompactSession(ctx.tenantId, ctx.sessionId, logger)
    expect(complete).toHaveBeenCalledTimes(1)
    const messages = await history.getFullHistory(ctx)
    expect(messages).toHaveLength(7)
    expect(messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['original-3', 'original-5', 'original-7'])
    expect((await history.getArchive!(ctx)).messages).toHaveLength(8)
    await history.clear(ctx)
  })

  it('does not display progress or contact a model when recent exchanges cannot be reduced', async () => {
    const ctx = { tenantId: 'test-tenant', sessionId: 'test-session' }
    for (let index = 0; index < 6; index++) await history.append({ id: `recent-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Keep recent message ${index}` }, ctx)
    const before = await history.getFullHistory(ctx)
    const calls = vi.mocked(createAdapterFromResolved).mock.calls.length
    const states = vi.fn()
    expect(await autoCompactSession(ctx.tenantId, ctx.sessionId, { info: vi.fn() }, undefined, { onCompaction: states })).toBeUndefined()
    expect(states).not.toHaveBeenCalled()
    expect(vi.mocked(createAdapterFromResolved).mock.calls).toHaveLength(calls)
    expect(await history.getFullHistory(ctx)).toEqual(before)
  })

  it('should compress history and preserve data integrity', async () => {
    // Eight rows exceed the six-message retention window.
    for (let i = 1; i <= 8; i++) {
      await history.append({ role: i % 2 ? 'user' : 'assistant', content: `Message ${i}` }, { tenantId: 'test-tenant', sessionId: 'test-session' })
    }

    const states = vi.fn()
    const stats = await autoCompactSession('test-tenant', 'test-session', { info: vi.fn() }, undefined, { onCompaction: states })
    expect(stats?.postTokens).toBeGreaterThan(0)
    expect(states.mock.calls.map(([state]) => state.phase)).toEqual(['running', 'succeeded'])

    // 3. Verify history after compression（8 条 → 摘要 1 条 + 最近 6 条；
    // 压缩结果通过 API 返回，不伪造一条 assistant 消息污染用户对话。）
    const messages = await history.getHistory({ tenantId: 'test-tenant', sessionId: 'test-session' })
    expect(messages.length).toBe(7)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Mocked Summary')

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

  it('pages retained messages through HTTP without materializing the full JSONL file', async () => {
    const ctx = { tenantId: 'test-tenant', sessionId: 'test-session' }
    const ids = Array.from({ length: 12 }, (_, index) => `paged-${index}`)
    for (const [index, id] of ids.entries()) await history.append({ id, role: index % 2 ? 'assistant' : 'user', content: `Page original ${index}`, metadata: { turnId: `turn-${Math.floor(index / 2)}` } }, ctx)
    await history.compress(ctx, async () => 'Retained facts', 3)
    const readFile = fs.promises.readFile.bind(fs.promises)
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: Parameters<typeof fs.promises.readFile>[0], ...args: unknown[]) => {
      if (String(file).endsWith('.jsonl')) throw new Error('A paged HTTP request must stream its archive')
      return (readFile as (...parameters: unknown[]) => Promise<unknown>)(file, ...args)
    }) as typeof fs.promises.readFile)
    try {
      const recovered: string[] = []
      for (let page = 1; page <= 4; page++) {
        const response = await fastify.inject(`/conversation/archive?sessionId=test-session&current=${page}&pageSize=3`)
        const body = response.json()
        expect(body.code).toBe(200)
        expect(body.pagination).toEqual({ current: page, pageSize: 3, total: 12, totalPages: 4 })
        expect(body.metadata.archiveMessageCount).toBe(12)
        expect(body.metadata.currentMessageCount).toBe(4)
        expect(body.metadata.compressed).toBe(true)
        expect(body.metadata.archiveRevision).toBeTypeOf('string')
        expect(body.data.map((message: { id: string }) => message.id)).toEqual(ids.slice((page - 1) * 3, page * 3))
        recovered.push(...body.data.map((message: { id: string }) => message.id))
      }
      expect(recovered).toEqual(ids)
      expect(new Set(recovered).size).toBe(12)
      for (const query of ['current=0&pageSize=3', 'current=NaN&pageSize=3', 'current=1&pageSize=0']) expect((await fastify.inject(`/conversation/archive?sessionId=test-session&${query}`)).json().code).toBe(40001)
    } finally { readSpy.mockRestore() }
  })

  it('should rollback history if LLM completion fails', async () => {
    // The summarizer has reducible history outside the retained tail.
    for (let i = 1; i <= 8; i++) {
      await history.append({ role: i % 2 ? 'user' : 'assistant', content: `Message ${i}` }, { tenantId: 'test-tenant', sessionId: 'test-session-err' })
    }

    // Override mock for error
    const adapter = createAdapterFromResolved({ model: 'test-model', provider: 'test', capabilities: {} })
    vi.spyOn(adapter, 'complete').mockRejectedValueOnce(new Error('LLM Timeout'))
    vi.mocked(createAdapterFromResolved).mockReturnValueOnce(adapter)

    const beforeMessages = await history.getHistory({ tenantId: 'test-tenant', sessionId: 'test-session-err' })

    const states = vi.fn()
    await expect(autoCompactSession('test-tenant', 'test-session-err', { info: vi.fn() }, undefined, { onCompaction: states })).rejects.toThrow('LLM Timeout')
    expect(states.mock.calls.map(([state]) => state.phase)).toEqual(['running', 'failed'])
    expect(states.mock.calls[1][0].error).toBe('LLM Timeout')

    // 3. Verify history is untouched
    const messages = await history.getHistory({ tenantId: 'test-tenant', sessionId: 'test-session-err' })
    expect(messages).toEqual(beforeMessages)
    expect(messages.length).toBe(8)
    expect(messages[0].role).toBe('user')
    expect(messages[1].role).toBe('assistant')
    expect(messages[2].role).toBe('user')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeMemoryDb, getMemoryDb, initMemoryDb } from '../db.js'
import { MEMORY_SCHEMA } from '../schema.js'
import { SQLiteMemoryManager } from '../memory-manager.js'
import { OpenAIMemoryEmbeddingService, createMemoryEmbeddingService, backfillMemoryEmbeddings } from '../embedding.js'
import { buildMemoryRecallBlock, extractAndStoreMemories, renderMemoryRecallBlock } from '../../../middleware/memory/extractor.js'
import { createLLMAdapterWithDbConfig } from '../../../core/llm-adapter/index.js'
import { estimateRequestInput } from '../../../core/agent-loop/finalization.js'
import type { MemoryContext } from '../types.js'

vi.mock('../../sqlite/system-config.js', () => ({ systemConfigStore: { get: vi.fn(async () => null) } }))
vi.mock('../../../core/llm-adapter/index.js', () => ({ createLLMAdapterWithDbConfig: vi.fn(async () => ({
  provider: 'anthropic', model: 'qwen3.8-flash', complete: vi.fn(async () => ({ content: 'urgent outage' })),
})) }))

describe('independent memory embedding service', () => {
  let directory: string
  let server: http.Server
  let baseUrl: string
  let manager: SQLiteMemoryManager
  let requests: Array<{ model: string; input: string[]; dimensions?: number }>
  let mode: 'valid' | 'wrong-model' | 'wrong-dimensions' | 'duplicate-indices' | 'missing-item'
  let beforeResponse: (() => Promise<void>) | undefined
  const context: MemoryContext = { tenantId: 'a', sessionId: 'one', scope: 'session' }
  const vector = (text: string) => /Escalation|urgent outage/i.test(text) ? [1, 0, 0] : [0, 1, 0]

  beforeEach(async () => {
    await closeMemoryDb()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-embedding-'))
    vi.stubEnv('DATA_DIR', path.join(directory, 'agent.db'))
    for (const key of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_API_KEY', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_SEND_DIMENSIONS']) vi.stubEnv(key, '')
    await initMemoryDb(MEMORY_SCHEMA)
    manager = new SQLiteMemoryManager()
    requests = []; mode = 'valid'; beforeResponse = undefined
    server = http.createServer(async (request, response) => {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      requests.push(body)
      await beforeResponse?.()
      const data = body.input.map((item: string, index: number) => ({ object: 'embedding', index: mode === 'duplicate-indices' ? 0 : index,
        embedding: mode === 'wrong-dimensions' ? [1, 0] : vector(item) }))
      if (mode === 'missing-item') data.pop()
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', model: mode === 'wrong-model' ? 'wrong-model' : body.model, data: data.reverse(), usage: { prompt_tokens: 5, total_tokens: 5 } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  })

  afterEach(async () => {
    server?.closeAllConnections()
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    await closeMemoryDb()
    vi.unstubAllEnvs()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const service = (baseUrl: string, model = 'test-semantic-v1') => new OpenAIMemoryEmbeddingService({ baseUrl, model, dimensions: 3 })

  it('returns ordered vectors from a real HTTP endpoint and binds the identity to service/model/dimension', async () => {
    const a = service(baseUrl)
    expect(await a.embed(['Escalation SLA', 'Routine workflow'])).toEqual([[1, 0, 0], [0, 1, 0]])
    expect(requests[0]).toMatchObject({ model: 'test-semantic-v1', input: ['Escalation SLA', 'Routine workflow'] })
    expect(service(baseUrl + '/embeddings').spaceId).toBe(a.spaceId)
    expect(service(baseUrl, 'test-semantic-v2').spaceId).not.toBe(a.spaceId)
    expect(new OpenAIMemoryEmbeddingService({ baseUrl, model: a.model, dimensions: 4 }).spaceId).not.toBe(a.spaceId)
    expect(new OpenAIMemoryEmbeddingService({ baseUrl: baseUrl + '/other', model: a.model, dimensions: 3 }).spaceId).not.toBe(a.spaceId)
  })

  it.each(['wrong-model', 'wrong-dimensions', 'duplicate-indices', 'missing-item'] as const)('rejects %s responses before vectors can enter storage', async invalid => {
    mode = invalid
    await expect(service(baseUrl).embed(['Escalation', 'Routine'])).rejects.toThrow(/Embedding service/)
  })

  it('reports no independently configured semantic service rather than inventing one', async () => {
    expect(await createMemoryEmbeddingService()).toBeUndefined()
    vi.stubEnv('EMBEDDING_MODEL', 'test-semantic-v1')
    await expect(createMemoryEmbeddingService()).rejects.toThrow(/require EMBEDDING_BASE_URL/)
  })

  it('retries missing or old-space rows incrementally after partial batches and keeps session/tenant isolation', async () => {
    const a = service(baseUrl)
    const original = await manager.createNode({ type: 'decision', summary: 'Escalation SLA: 30 seconds' }, context)
    const old = await manager.createNode({ type: 'fact', summary: 'Routine workflow', embedding: [1, 0, 0], embeddingSpace: 'old-model-space' }, context)
    const foreign = await manager.createNode({ type: 'fact', summary: 'Escalation foreign' }, { ...context, sessionId: 'two' })
    const foreignTenant = await manager.createNode({ type: 'fact', summary: 'Escalation other tenant' }, { ...context, tenantId: 'b' })
    const first = await backfillMemoryEmbeddings(manager, context, a, { limit: 1 })
    expect(first).toMatchObject({ attempted: 1, stored: 1, errors: [] })
    await closeMemoryDb(); await initMemoryDb(MEMORY_SCHEMA)
    const second = await backfillMemoryEmbeddings(new SQLiteMemoryManager(), context, a, { limit: 1 })
    expect(second).toMatchObject({ attempted: 1, stored: 1, errors: [] })
    expect(await backfillMemoryEmbeddings(manager, context, a)).toMatchObject({ attempted: 0, stored: 0 })
    expect((await manager.getNode(original.id, context))?.embeddingSpace).toBe(a.spaceId)
    expect((await manager.getNode(old.id, context))?.embeddingSpace).toBe(a.spaceId)
    expect((await manager.getNode(foreign.id, { ...context, sessionId: 'two' }))?.embeddingSpace).toBeNull()
    expect((await manager.getNode(foreignTenant.id, { ...context, tenantId: 'b' }))?.embeddingSpace).toBeNull()
    expect((await manager.recallSimilar([1, 0, 0], 10, context, 0.1, a.spaceId)).map(node => node.id)).toEqual([original.id])
  })

  it('leaves failed batches retryable and prevents stale backfill after a concurrent text edit', async () => {
    const a = service(baseUrl)
    const node = await manager.createNode({ type: 'decision', summary: 'Escalation initial' }, context)
    mode = 'wrong-dimensions'
    expect(await backfillMemoryEmbeddings(manager, context, a)).toMatchObject({ attempted: 1, stored: 0, errors: [expect.any(String)] })
    expect((await manager.getNode(node.id, context))?.embedding).toBeUndefined()
    mode = 'valid'
    beforeResponse = async () => { await manager.updateNode(node.id, { summary: 'Routine revised' }, context); beforeResponse = undefined }
    expect(await backfillMemoryEmbeddings(manager, context, a)).toMatchObject({ attempted: 1, stored: 0, changed: 1 })
    expect((await manager.getNode(node.id, context))?.embedding).toBeUndefined()
    expect(await backfillMemoryEmbeddings(manager, context, a)).toMatchObject({ attempted: 1, stored: 1, errors: [] })
    expect((await manager.getNode(node.id, context))?.embedding).toEqual([0, 1, 0])
  })

  it('never compares same-dimensional vectors from different models and reindexes when the model changes', async () => {
    const a = service(baseUrl)
    const b = service(baseUrl, 'test-semantic-v2')
    const node = await manager.createNode({ type: 'decision', summary: 'Escalation rule' }, context)
    await backfillMemoryEmbeddings(manager, context, a)
    expect(await manager.recallSimilar([1, 0, 0], 10, context, 0.1, b.spaceId)).toEqual([])
    await backfillMemoryEmbeddings(manager, context, b)
    expect(await manager.recallSimilar([1, 0, 0], 10, context, 0.1, a.spaceId)).toEqual([])
    expect((await manager.getNode(node.id, context))?.embeddingSpace).toBe(b.spaceId)
    await manager.updateNode(node.id, { summary: 'Routine rule' }, context)
    expect((await manager.getNode(node.id, context))?.embeddingSpace).toBeNull()
    const row = await getMemoryDb().execute({ sql: 'SELECT embedding_json,embedding,embedding_space FROM memory_nodes WHERE id=?', args: [node.id] })
    expect(row.rows[0]).toMatchObject({ embedding_json: null, embedding: null, embedding_space: null })
  })

  it('recalls semantically related memory through an Anthropic chat adapter with no embed capability', async () => {
    vi.stubEnv('EMBEDDING_BASE_URL', baseUrl); vi.stubEnv('EMBEDDING_MODEL', 'test-semantic-v1'); vi.stubEnv('EMBEDDING_DIMENSIONS', '3')
    await manager.createNode({ type: 'decision', summary: 'Escalation SLA is 30 seconds', importance: 0.9 }, context)
    await manager.createNode({ type: 'fact', summary: 'Routine task reviews are weekly', importance: 0.8 }, context)
    const block = await buildMemoryRecallBlock('a', 'What should I do during an urgent outage?', { provider: 'anthropic', model: 'qwen3.8-flash' }, { sessionId: 'one', scope: 'session' })
    expect(block).toContain('Escalation SLA is 30 seconds')
    expect(block).not.toContain('Routine task reviews are weekly')
    expect(requests).toHaveLength(2) // one backfill request, one query request
    expect(requests.every(request => request.model === 'test-semantic-v1')).toBe(true)
  })

  it('atomically deduplicates repeated extraction while allowing the same fact in another session', async () => {
    const input = { type: 'decision' as const, summary: 'Use exact decimal arithmetic', importance: 0.9 }
    const results = await Promise.all(Array.from({ length: 5 }, () => manager.createExtractedNodeIfAbsent(input, context)))
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(new Set(results.map(result => result.node.id)).size).toBe(1)
    expect(await manager.countNodes({}, context)).toBe(1)
    const separate = await manager.createExtractedNodeIfAbsent(input, { ...context, sessionId: 'two' })
    expect(separate.created).toBe(true)
    expect(separate.node.id).not.toBe(results[0].node.id)
  })

  it('maintains the native 1536-dimensional path alongside other dimensions and invalidates the identity on edit', async () => {
    const embedding = [1, ...Array(1535).fill(0)]
    const node = await manager.createNode({ type: 'fact', summary: 'native 1536', embedding, embeddingSpace: 'native-space' }, context)
    expect(node.embedding).toEqual(embedding)
    expect((await manager.recallSimilar(embedding, 5, context, 0.1, 'native-space')).map(node => node.id)).toEqual([node.id])
    await manager.updateNode(node.id, { summary: 'updated native', embedding, embeddingSpace: 'native-new' }, context)
    expect((await manager.getNode(node.id, context))?.embeddingSpace).toBe('native-new')
    expect(await manager.updateEmbeddingIfUnchanged(node.id, 'updated native', null, embedding, 'backfilled-native', context)).toBe(true)
    expect((await manager.getNode(node.id, context))?.embeddingSpace).toBe('backfilled-native')
  })

  it('migrates an existing database without replacing stored memories or assigning unverified vector identities', async () => {
    const original = await manager.createNode({ type: 'fact', summary: 'Retained original memory', tags: ['original'] }, context)
    await getMemoryDb().execute('ALTER TABLE memory_nodes DROP COLUMN embedding_space')
    await closeMemoryDb(); await initMemoryDb(MEMORY_SCHEMA)
    const restored = await manager.getNode(original.id, context)
    expect(restored).toMatchObject({ id: original.id, summary: original.summary, embeddingSpace: null, tags: ['original'] })
  })

  it('stores important facts from a large turn and its tail without duplicate nodes across extraction chunks or retries', async () => {
    const complete = vi.fn(async (messages: Array<{ content: string | any[] }>) => ({
      content: JSON.stringify([{ type: 'decision', content: messages[0].content.includes('TAIL:') ? 'Escalation tail contract must remain' : 'Stable shared API contract', importance: 0.9, emotion: 0, tags: ['contract'] }]),
      promptTokens: 1, completionTokens: 1, finishReason: 'stop' as const,
    }))
    vi.mocked(createLLMAdapterWithDbConfig).mockResolvedValue({ provider: 'anthropic', model: 'MiniMax-M2.5', complete, stream: vi.fn(), countTokens: () => 0 })
    const input = { messages: [{ role: 'user', content: '保留开发证据，进行跨模型开发与复核。\n'.repeat(4000) + 'TAIL:不得丢失约束' }],
      tenantId: 'a', sessionId: 'one', sourceTurnId: 'retained-turn-1', memoryScope: 'session' as const, llm: { provider: 'anthropic', model: 'MiniMax-M2.5', contextWindow: 8_000 } }
    const result = await extractAndStoreMemories(input)
    expect(result).toMatchObject({ extracted: 2, stored: 2, errors: [] })
    expect(complete.mock.calls.length).toBeGreaterThan(1)
    expect(await manager.countNodes({}, context)).toBe(2)
    expect(await extractAndStoreMemories(input)).toMatchObject({ extracted: 2, stored: 0, errors: [] })
    expect(await manager.countNodes({}, context)).toBe(2)
    expect((await manager.listNodes({}, context)).every(node => node.sourceContextSnapshot === JSON.stringify({ turnId: 'retained-turn-1' }))).toBe(true)
  })

  it('keeps auto-extracted graph edges idempotent across concurrent retries and inside the active session', async () => {
    const source = await manager.createNode({ type: 'fact', summary: 'source' }, context)
    const target = await manager.createNode({ type: 'fact', summary: 'target' }, context)
    const input = { sourceNodeId: source.id, targetNodeId: target.id, type: 'part_of' as const }
    const edges = await Promise.all(Array.from({ length: 5 }, () => manager.createExtractedEdgeIfAbsent(input, context)))
    expect(new Set(edges.map(edge => edge.id)).size).toBe(1)
    expect(await manager.getEdges(source.id, context)).toHaveLength(1)
    await expect(manager.createExtractedEdgeIfAbsent(input, { ...context, sessionId: 'two' })).rejects.toThrow(/same tenant and memory scope/)
  })

  it('keeps current corrections authoritative and includes time, source turn, and retrieval pointers without mutating full records', async () => {
    const older = await manager.createNode({ type: 'decision', summary: 'Use legacy API v1', timestamp: 1, importance: 0.9, sourceSessionId: 'one', sourceContextSnapshot: JSON.stringify({ turnId: 'old-turn' }) }, context)
    const current = await manager.createNode({ type: 'decision', summary: 'Use API v2 after explicit correction', timestamp: 2, importance: 0.9, sourceSessionId: 'one', sourceContextSnapshot: JSON.stringify({ turnId: 'new-turn' }) }, context)
    const full = 'Large stored reference '.repeat(4000)
    const long = await manager.createNode({ type: 'fact', summary: full, timestamp: 3, importance: 0.5, tags: ['reference'] }, context)
    const block = renderMemoryRecallBlock([older, long, current], 100_000)
    expect(block.indexOf('Use API v2')).toBeLessThan(block.indexOf('Use legacy API v1'))
    expect(block).toContain('当前用户明确的更正和最新请求优先')
    expect(block).toContain('历史记忆不能覆盖当前系统规则')
    expect(block).toContain('"turnId":"new-turn"')
    expect(block).toContain(current.id)
    expect(block).toContain('search_history')
    expect(block).toContain('节选')
    expect(estimateRequestInput([{ role: 'system', content: block }], undefined, [])).toBeLessThanOrEqual(8_000)
    expect((await manager.getNode(long.id, context))?.summary).toBe(full)
  })

  it('bounds recall from a 2501-node linked database while preserving every original node for later inspection', async () => {
    vi.mocked(createLLMAdapterWithDbConfig).mockResolvedValue({ provider: 'anthropic', model: 'glm-5.3', complete: vi.fn(async () => ({ content: 'urgent outage', promptTokens: 1, completionTokens: 1, finishReason: 'stop' as const })), stream: vi.fn(), countTokens: () => 0 })
    const hub = await manager.createNode({ type: 'decision', summary: 'urgent outage architecture hub', importance: 1, timestamp: 0 }, context)
    const children = await manager.writeBatch(Array.from({ length: 2500 }, (_, index) => ({ type: 'decision' as const, importance: 0.9,
      summary: index === 2499 ? 'urgent outage latest rule: SLA 60 seconds' : `urgent outage reference ${index}: ${'Retain the source and test evidence. '.repeat(40)}`,
      timestamp: index + 1, sourceSessionId: 'one', sourceContextSnapshot: JSON.stringify({ turnId: `evidence-turn-${index}` }) })), [], context)
    await manager.writeBatch([], children.nodes.map(node => ({ sourceNodeId: hub.id, targetNodeId: node.id, type: 'part_of' as const })), context)
    const block = await buildMemoryRecallBlock('a', 'urgent outage requirements', { provider: 'anthropic', model: 'glm-5.3', contextWindow: 100_000 }, { sessionId: 'one', scope: 'session' })
    expect(block).toContain('SLA 60 seconds')
    expect(block).toContain('/2501 条')
    expect(block).not.toContain('展示 2501/2501')
    expect(estimateRequestInput([{ role: 'system', content: block }], undefined, [])).toBeLessThanOrEqual(8_000)
    expect(await manager.countNodes({}, context)).toBe(2501)
    expect((await manager.getNode(children.nodes[0].id, context))?.summary).toBe(children.nodes[0].summary)
  }, 60_000)
})

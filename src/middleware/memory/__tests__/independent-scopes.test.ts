/** Real SQLite runtime memory boundaries; only provider responses are deterministic. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeMemoryDb, initMemoryDb } from '../../../storage/memory/db.js'
import { MEMORY_SCHEMA } from '../../../storage/memory/schema.js'
import { SQLiteMemoryManager } from '../../../storage/memory/memory-manager.js'
import { getSessionMemorySettings, setMemoryPreferences, setSessionMemoryEnabled, setSessionMemoryScope } from '../../../storage/memory/settings.js'
import { createLLMAdapterWithDbConfig } from '../../../core/llm-adapter/index.js'
import { buildMemoryRecallBlock, extractAndStoreMemories, reserveMemoryExtraction } from '../extractor.js'
import type { MemoryScope } from '../../../storage/memory/types.js'
import { createMemoryTools } from '../../../tools/memory/memory-tool.js'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { getActiveMemoryExtractionCount } from '../../../storage/memory/extraction-coordinator.js'
import type { LLMAdapterOptions, LLMRequestAttemptEvent } from '../../../core/llm-adapter/types.js'
import type { MemoryRequestAttemptEvent } from '../types.js'

vi.mock('../../../storage/sqlite/system-config.js', () => ({ systemConfigStore: { get: vi.fn(async () => null) } }))
vi.mock('../../../core/llm-adapter/index.js', () => ({ createLLMAdapterWithDbConfig: vi.fn() }))

let directory: string
let manager: SQLiteMemoryManager
const tenantId = 'runtime-memory-tenant', sessionId = 'current-session'
const session = { tenantId, sessionId, scope: 'session' as const }
const global = { tenantId, sessionId: '', scope: 'global' as const }
const credentials = { provider: 'anthropic', model: 'fixture-memory', contextWindow: 8_000, apiFormat: 'anthropic' as const }

beforeEach(async () => {
  await closeMemoryDb()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-independent-memory-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'agent.db'))
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'true')
  for (const key of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_API_KEY']) vi.stubEnv(key, '')
  await initMemoryDb(MEMORY_SCHEMA)
  manager = new SQLiteMemoryManager()
  vi.mocked(createLLMAdapterWithDbConfig).mockReset()
})
afterEach(async () => {
  await closeMemoryDb()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
})

function adapter(content: string) {
  const complete = vi.fn(async (_messages: Array<{ content: unknown }>) => ({ content, promptTokens: 1, completionTokens: 1, finishReason: 'stop' as const }))
  vi.mocked(createLLMAdapterWithDbConfig).mockResolvedValue({ provider: 'anthropic', model: 'fixture-memory', complete, stream: vi.fn(), countTokens: () => 0 })
  return complete
}
function extracted(scopes: readonly MemoryScope[]) {
  return extractAndStoreMemories({ tenantId, sessionId, memoryScopes: scopes, llm: credentials,
    messages: [{ role: 'user', content: 'Current private project requirement.' }] })
}

describe('independent runtime memory scopes', () => {
  it('skips providers when authorized namespaces are empty even if other namespaces contain data', async () => {
    await manager.createNode({ type: 'fact', summary: 'Foreign private contract' }, { ...session, sessionId: 'other-session' })
    await manager.createNode({ type: 'fact', summary: 'Foreign tenant contract' }, { ...global, tenantId: 'other-tenant' })
    expect(await buildMemoryRecallBlock(tenantId, 'Find my contract', credentials, { sessionId, scopes: ['session', 'global'] })).toBe('')
    expect(createLLMAdapterWithDbConfig).not.toHaveBeenCalled()
  })

  it.each(['你好！', ' 在吗？ ', 'HELLO!', '嗨'])('skips an exact greeting without a provider: %s', async query => {
    await manager.createNode({ type: 'fact', summary: 'Existing contract' }, session)
    expect(await buildMemoryRecallBlock(tenantId, query, credentials, { sessionId, scopes: ['session'] })).toBe('')
    expect(createLLMAdapterWithDbConfig).not.toHaveBeenCalled()
  })

  it('keeps requests following a greeting and renders direct hits before higher-importance graph neighbors', async () => {
    const complete = adapter('contract')
    const direct = await manager.createNode({ type: 'decision', summary: 'contract: use the new API', importance: 0.2 }, session)
    const neighbor = await manager.createNode({ type: 'fact', summary: 'Unrelated historical documentation '.repeat(100), importance: 1 }, session)
    await manager.createEdge({ sourceNodeId: direct.id, targetNodeId: neighbor.id, type: 'part_of' }, session)
    const block = await buildMemoryRecallBlock(tenantId, '你好，继续处理 contract', credentials, { sessionId, scopes: ['session'] })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(block).toContain(direct.summary)
    expect(block.indexOf(direct.id)).toBeLessThan(block.indexOf(neighbor.id))
  })

  it('forwards utility cancellation and complete provider usage with distinct stages', async () => {
    await manager.createNode({ type: 'fact', summary: 'contract reference' }, session)
    const controller = new AbortController(), events: MemoryRequestAttemptEvent[] = []
    const usage = { promptTokens: 81, completionTokens: 3, cacheHitTokens: 40, cacheMissTokens: 36, cacheWriteTokens: 5, reasoningTokens: 2, unknown: false }
    let calls = 0
    const complete = vi.fn(async (_messages: unknown, options?: LLMAdapterOptions) => {
      expect(options?.signal).toBe(controller.signal)
      expect(options?.thinkingEnabled).toBe(false)
      const identity = { requestAttemptId: `attempt-${++calls}`, provider: 'anthropic', model: 'fixture-memory' }
      const start: LLMRequestAttemptEvent = { type: 'start', ...identity, estimatedInputTokens: 85, maxOutputTokens: options?.maxTokens }
      await options?.onRequestAttempt?.(start)
      await options?.onRequestAttempt?.({ type: 'finish', ...identity, outcome: 'succeeded', usage })
      return { content: calls === 1 ? 'contract' : '[]', promptTokens: 81, completionTokens: 3, finishReason: 'stop' as const }
    })
    vi.mocked(createLLMAdapterWithDbConfig).mockResolvedValue({ provider: 'anthropic', model: 'fixture-memory', complete, stream: vi.fn(), countTokens: () => 0 })
    const llm = { ...credentials, signal: controller.signal, onRequestAttempt: (event: MemoryRequestAttemptEvent) => { events.push(event) } }
    expect(await buildMemoryRecallBlock(tenantId, 'contract', llm, { sessionId, scopes: ['session'] })).toContain('contract reference')
    await extractAndStoreMemories({ tenantId, sessionId, memoryScopes: ['session'], llm, messages: [{ role: 'user', content: 'Current request' }] })
    expect(events.map(event => event.stage)).toEqual(['memory_recall', 'memory_recall', 'memory_extraction', 'memory_extraction'])
    expect(events.filter(event => event.type === 'finish').map(event => event.usage)).toEqual([usage, usage])
    expect(complete.mock.calls[0][1]).toMatchObject({ maxTokens: 100, thinkingEnabled: false })
  })

  it('does not create providers or write memory for requests cancelled before recall or extraction', async () => {
    await manager.createNode({ type: 'fact', summary: 'Retained contract' }, session)
    const controller = new AbortController(); controller.abort(new Error('Stopped fixture request'))
    const llm = { ...credentials, signal: controller.signal }
    expect(await buildMemoryRecallBlock(tenantId, 'contract', llm, { sessionId, scopes: ['session'] })).toBe('')
    expect(await extractAndStoreMemories({ tenantId, sessionId, memoryScopes: ['session'], llm, messages: [{ role: 'user', content: 'Do not store' }] }))
      .toMatchObject({ stored: 0, errors: [expect.stringContaining('Stopped fixture request')] })
    expect(createLLMAdapterWithDbConfig).not.toHaveBeenCalled()
    expect(await manager.countNodes({}, session)).toBe(1)
    expect(getActiveMemoryExtractionCount(session)).toBe(0)
  })

  it('omitted policy performs no recall, extraction, reservation or provider call', async () => {
    await manager.createNode({ type: 'fact', summary: 'Existing private memory' }, session)
    expect(reserveMemoryExtraction({ tenantId, sessionId })).toBeUndefined()
    expect(await extractAndStoreMemories({ tenantId, sessionId, llm: credentials, messages: [{ role: 'user', content: 'Never save automatically' }] }))
      .toEqual({ extracted: 0, stored: 0, errors: [] })
    expect(await buildMemoryRecallBlock(tenantId, 'Existing private memory', credentials, { sessionId })).toBe('')
    expect(createLLMAdapterWithDbConfig).not.toHaveBeenCalled()
    expect(await manager.countNodes({}, session)).toBe(1)
    expect(getActiveMemoryExtractionCount(session)).toBe(0)
  })
  it('defaults off, and explicit opt-in to both scopes still extracts private content exclusively into this session', async () => {
    const initial = await getSessionMemorySettings(tenantId, sessionId, 'code')
    expect(initial).toMatchObject({ globalEnabled: false, sessionEnabled: false, effectiveScopes: [] })
    const complete = adapter(JSON.stringify([{ type: 'decision', content: 'Keep the private project contract', importance: 0.9, emotion: 0, tags: ['project'] }]))
    await setMemoryPreferences(tenantId, { globalEnabled: true, sessionDefaultEnabled: true })
    const both = await getSessionMemorySettings(tenantId, sessionId)
    expect(both.effectiveScopes).toEqual(['global', 'session'])
    expect(await extracted(both.effectiveScopes)).toMatchObject({ stored: 1, errors: [] })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(createLLMAdapterWithDbConfig).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic', model: 'fixture-memory', apiFormat: 'anthropic',
    }))
    expect(await manager.countNodes({}, session)).toBe(1)
    expect(await manager.countNodes({}, global)).toBe(0)
    expect(await manager.countNodes({}, { ...session, sessionId: 'other-session' })).toBe(0)
  })

  it('extracts globally only when the global gate is on and session memory is off', async () => {
    adapter(JSON.stringify([{ type: 'fact', content: 'Shared explicit convention', importance: 0.8, emotion: 0, tags: ['convention'] }]))
    await setMemoryPreferences(tenantId, { globalEnabled: true })
    await setSessionMemoryEnabled(tenantId, sessionId, false)
    const settings = await getSessionMemorySettings(tenantId, sessionId)
    expect(settings.effectiveScopes).toEqual(['global'])
    expect(await extracted(settings.effectiveScopes)).toMatchObject({ stored: 1 })
    expect(await manager.countNodes({}, global)).toBe(1)
    expect(await manager.countNodes({}, session)).toBe(0)
  })

  it('recalls both authorized namespaces once and deduplicates text without reading a parent or another tenant', async () => {
    const complete = adapter('urgent outage')
    await manager.createNode({ type: 'fact', summary: 'urgent outage session fact' }, session)
    await manager.createNode({ type: 'fact', summary: 'urgent outage shared fact' }, global)
    await manager.createNode({ type: 'fact', summary: 'urgent outage duplicate fact' }, session)
    await manager.createNode({ type: 'fact', summary: 'urgent outage duplicate fact' }, global)
    await manager.createNode({ type: 'fact', summary: 'urgent outage parent secret' }, { ...session, sessionId: 'parent-session' })
    await manager.createNode({ type: 'fact', summary: 'urgent outage tenant secret' }, { ...global, tenantId: 'foreign-tenant' })
    const block = await buildMemoryRecallBlock(tenantId, 'urgent outage', credentials, { sessionId, scopes: ['global', 'session'] })
    expect(block).toContain('urgent outage session fact')
    expect(block).toContain('urgent outage shared fact')
    expect(block.match(/urgent outage duplicate fact/g)).toHaveLength(1)
    expect(block).not.toContain('secret')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(createLLMAdapterWithDbConfig).toHaveBeenCalledTimes(1)
    expect(createLLMAdapterWithDbConfig).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic', model: 'fixture-memory', apiFormat: 'anthropic',
    }))
  })

  it('legacy global cannot enable the global gate, and both off avoids provider calls and storage writes', async () => {
    await setSessionMemoryScope(tenantId, sessionId, 'global')
    const legacy = await getSessionMemorySettings(tenantId, sessionId)
    expect(legacy.globalEnabled).toBe(false)
    expect(legacy.effectiveScopes).toEqual([])
    await setSessionMemoryEnabled(tenantId, sessionId, false)
    const off = await getSessionMemorySettings(tenantId, sessionId)
    expect(off.effectiveScopes).toEqual([])
    expect(await extracted(off.effectiveScopes)).toEqual({ extracted: 0, stored: 0, errors: [] })
    expect(await buildMemoryRecallBlock(tenantId, 'urgent outage', credentials, { sessionId, scopes: off.effectiveScopes })).toBe('')
    expect(createLLMAdapterWithDbConfig).not.toHaveBeenCalled()
    expect(await manager.countNodes({}, session)).toBe(0)
    expect(await manager.countNodes({}, global)).toBe(0)
  })

  it('server capability disable overrides explicit scopes before any provider operation', async () => {
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    expect(await extracted(['global', 'session'])).toEqual({ extracted: 0, stored: 0, errors: [] })
    expect(await buildMemoryRecallBlock(tenantId, 'urgent outage', credentials, { sessionId, scopes: ['global', 'session'] })).toBe('')
    expect(createLLMAdapterWithDbConfig).not.toHaveBeenCalled()
  })

  it('does not recreate exact managed facts when extraction ignores exclusions, while retaining independent facts', async () => {
    const complete = adapter(JSON.stringify([
      { type: 'preference', content: 'Prefer blue', importance: 0.9, emotion: 0, tags: ['color'] },
      { type: 'preference', content: 'Prefer red', importance: 0.9, emotion: 0, tags: ['color'] },
      { type: 'decision', content: 'Project deadline is Friday', importance: 0.9, emotion: 0, tags: ['project'] },
    ]))
    const result = await extractAndStoreMemories({ tenantId, sessionId, memoryScopes: ['session'], llm: credentials,
      messages: [
        { role: 'user', content: 'Save blue, forget red. Project deadline is Friday.' },
        { role: 'assistant', content: '', toolCall: { id: 'save', name: 'remember', args: { content: 'Prefer blue' } } },
        { role: 'tool', content: 'saved', toolCallId: 'save', metadata: { success: true, memoryMutation: { action: 'remember', id: 'blue', summary: 'Prefer blue' } } },
        { role: 'assistant', content: '', toolCall: { id: 'delete', name: 'forget', args: { id: 'red' } } },
        { role: 'tool', content: 'deleted', toolCallId: 'delete', metadata: { success: true, memoryMutation: { action: 'forget', id: 'red', summary: 'Prefer red' } } },
      ] })
    expect(result).toMatchObject({ stored: 1, errors: [] })
    expect((await manager.listNodes({}, session)).map(node => node.summary)).toEqual(['Project deadline is Friday'])
    expect(complete.mock.calls[0][0][0].content).toContain('本轮已执行的记忆操作')
  })

  it('revalidates a delayed extraction after a later scoped deletion without losing unrelated facts or future consent', async () => {
    const deleted = await manager.createNode({ type: 'preference', summary: 'Prefer blue', tags: ['color'] }, session)
    const foreign = await manager.createNode({ type: 'preference', summary: 'Prefer blue', tags: ['color'] }, { ...session, sessionId: 'other' })
    let release!: () => void, started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const arrived = new Promise<void>(resolve => { started = resolve })
    const output = JSON.stringify([
      { type: 'preference', content: 'Prefer blue', importance: 0.9, emotion: 0, tags: ['color'] },
      { type: 'decision', content: 'Project deadline is Friday', importance: 0.9, emotion: 0, tags: ['project'] },
    ])
    const complete = adapter(output)
    complete.mockImplementationOnce(async () => { started(); await pending; return { content: output, promptTokens: 1, completionTokens: 1, finishReason: 'stop' } })
    const extraction = extractAndStoreMemories({ tenantId, sessionId, memoryScopes: ['session'], llm: credentials,
      messages: [{ role: 'user', content: 'Prefer blue. Project deadline is Friday.' }] })
    await arrived
    await manager.deleteNode(deleted.id, session)
    release()
    expect(await extraction).toMatchObject({ stored: 1, errors: [] })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1][0][0].content).toContain('"action":"forget","summary":"Prefer blue"')
    expect((await manager.listNodes({}, session)).map(node => node.summary)).toEqual(['Project deadline is Friday'])
    expect(await manager.getNode(foreign.id, { ...session, sessionId: 'other' })).not.toBeNull()
    // A later explicit user save is independent of the finished extraction.
    const saved = await createMemoryTools().find(tool => tool.name === 'remember')!.execute(
      { content: 'Prefer blue', type: 'preference', tags: ['color'] }, { tenantId, sessionId, memoryScopes: ['session'] } as unknown as AgentContext)
    expect(saved.success).toBe(true)
    expect(await manager.findNodeBySummary('Prefer blue', session)).not.toBeNull()
  })

  it('retains deletion exclusions across a delayed history load before extractor entry and releases the reservation', async () => {
    const node = await manager.createNode({ type: 'fact', summary: 'Forget before loading history' }, session)
    expect(getActiveMemoryExtractionCount(session)).toBe(0)
    const reservation = reserveMemoryExtraction({ tenantId, sessionId, memoryScopes: ['session'] })!
    expect(getActiveMemoryExtractionCount(session)).toBe(1)
    expect(getActiveMemoryExtractionCount(global)).toBe(0)
    let release!: () => void
    const historyLoaded = new Promise<void>(resolve => { release = resolve })
    const complete = adapter(JSON.stringify([
      { type: 'fact', content: 'Forget before loading history', importance: 0.9, emotion: 0, tags: ['old'] },
      { type: 'fact', content: 'Independent fact', importance: 0.9, emotion: 0, tags: ['new'] },
    ]))
    const extraction = (async () => {
      await historyLoaded
      return extractAndStoreMemories({ tenantId, sessionId, memoryScopes: ['session'], llm: credentials, extractionTracker: reservation,
        messages: [{ role: 'user', content: 'Forget before loading history; Independent fact' }] })
    })()
    await manager.deleteNode(node.id, session)
    release()
    expect(await extraction).toMatchObject({ stored: 1, errors: [] })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0][0].content).toContain('"action":"forget","summary":"Forget before loading history"')
    expect(await manager.findNodeBySummary('Forget before loading history', session)).toBeNull()
    expect(await manager.findNodeBySummary('Independent fact', session)).not.toBeNull()
    expect(reservation.matches(session)).toBe(false)
    expect(reservation.snapshot().exclusions).toEqual([])
    expect(getActiveMemoryExtractionCount(session)).toBe(0)
    // A fresh explicitly authorized turn receives no historical suppression.
    expect(await extractAndStoreMemories({ tenantId, sessionId, memoryScopes: ['session'], llm: credentials,
      messages: [{ role: 'user', content: 'Save Forget before loading history again.' }] })).toMatchObject({ stored: 1, errors: [] })
    expect(await manager.findNodeBySummary('Forget before loading history', session)).not.toBeNull()
  })

  it('keeps the final commit guarded when deletion happens during delayed embedding', async () => {
    const target = await manager.createNode({ type: 'preference', summary: 'Old color' }, session)
    let release!: () => void, started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const arrived = new Promise<void>(resolve => { started = resolve })
    const output = JSON.stringify([{ type: 'decision', content: 'Unrelated deadline', importance: 0.9, emotion: 0, tags: ['project'] }])
    const complete = adapter(output)
    const embed = vi.fn(async () => [[1, 0]])
    embed.mockImplementationOnce(async () => { started(); await pending; return [[1, 0]] })
    // The factory has not been called yet; attach an independent deferred embed adapter.
    vi.mocked(createLLMAdapterWithDbConfig).mockResolvedValue({ provider: 'anthropic', model: 'fixture-memory', complete, embed, stream: vi.fn(), countTokens: () => 0 })
    const extraction = extracted(['session'])
    await arrived
    await manager.deleteNode(target.id, session)
    release()
    expect(await extraction).toMatchObject({ stored: 1, errors: [] })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(await manager.findNodeBySummary('Unrelated deadline', session)).not.toBeNull()
    expect(await manager.getNode(target.id, session)).toBeNull()
  })

  it('does not invalidate extraction for failed or foreign-scope deletions', async () => {
    const foreignScope = { ...session, sessionId: 'other' }
    const foreign = await manager.createNode({ type: 'fact', summary: 'Local reusable fact' }, foreignScope)
    const output = JSON.stringify([{ type: 'fact', content: 'Local reusable fact', importance: 0.9, emotion: 0, tags: ['local'] }])
    const complete = adapter(output)
    complete.mockImplementationOnce(async () => {
      await manager.deleteNode(foreign.id, session)
      await manager.deleteNode(foreign.id, foreignScope)
      return { content: output, promptTokens: 1, completionTokens: 1, finishReason: 'stop' }
    })
    expect(await extracted(['session'])).toMatchObject({ stored: 1, errors: [] })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(await manager.findNodeBySummary('Local reusable fact', session)).not.toBeNull()
  })

  it('reports continuous concurrent mutations instead of committing a stale third response', async () => {
    const targets = await Promise.all([0, 1, 2].map(index => manager.createNode({ type: 'fact', summary: `Old ${index}` }, session)))
    const output = JSON.stringify([{ type: 'fact', content: 'Retained in original history', importance: 0.9, emotion: 0, tags: ['local'] }])
    const complete = adapter(output)
    let next = 0
    complete.mockImplementation(async () => {
      await manager.deleteNode(targets[next++].id, session)
      return { content: output, promptTokens: 1, completionTokens: 1, finishReason: 'stop' }
    })
    const result = await extracted(['session'])
    expect(result.stored).toBe(0)
    expect(result.errors).toEqual([expect.stringContaining('Memory changed during extraction three times')])
    expect(complete).toHaveBeenCalledTimes(3)
    expect(await manager.countNodes({}, session)).toBe(0)
  })

  it('uses exact case- and whitespace-sensitive strings for the code exclusion guard', async () => {
    const complete = adapter(JSON.stringify([
      { type: 'fact', content: 'src/Token.ts', importance: 0.8, emotion: 0, tags: ['path'] },
      { type: 'fact', content: 'src/token.ts', importance: 0.8, emotion: 0, tags: ['path'] },
      { type: 'fact', content: 'key = A  B', importance: 0.8, emotion: 0, tags: ['code'] },
      { type: 'fact', content: 'key = A B', importance: 0.8, emotion: 0, tags: ['code'] },
    ]))
    const result = await extractAndStoreMemories({ tenantId, sessionId, memoryScopes: ['session'], llm: credentials, messages: [
      { role: 'user', content: 'Case and spacing distinguish these source values.' },
      ...['src/Token.ts', 'key = A  B'].flatMap((summary, index) => [
        { role: 'assistant', content: '', toolCall: { id: `call-${index}`, name: 'forget', args: { id: `node-${index}` } } },
        { role: 'tool', content: 'Deleted', toolCallId: `call-${index}`, metadata: { success: true, memoryMutation: { action: 'forget', id: `node-${index}`, summary } } },
      ]),
    ] })
    expect(result).toMatchObject({ stored: 2, errors: [] })
    expect((await manager.listNodes({}, session)).map(node => node.summary).sort()).toEqual(['key = A B', 'src/token.ts'])
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

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
import { buildMemoryRecallBlock, extractAndStoreMemories } from '../extractor.js'
import type { MemoryScope } from '../../../storage/memory/types.js'

vi.mock('../../../storage/sqlite/system-config.js', () => ({ systemConfigStore: { get: vi.fn(async () => null) } }))
vi.mock('../../../core/llm-adapter/index.js', () => ({ createLLMAdapterWithDbConfig: vi.fn() }))

let directory: string
let manager: SQLiteMemoryManager
const tenantId = 'runtime-memory-tenant', sessionId = 'current-session'
const session = { tenantId, sessionId, scope: 'session' as const }
const global = { tenantId, sessionId: '', scope: 'global' as const }
const credentials = { provider: 'anthropic', model: 'fixture-memory', contextWindow: 8_000 }

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
  const complete = vi.fn(async () => ({ content, promptTokens: 1, completionTokens: 1, finishReason: 'stop' as const }))
  vi.mocked(createLLMAdapterWithDbConfig).mockResolvedValue({ provider: 'anthropic', model: 'fixture-memory', complete, stream: vi.fn(), countTokens: () => 0 })
  return complete
}
function extracted(scopes: readonly MemoryScope[]) {
  return extractAndStoreMemories({ tenantId, sessionId, memoryScopes: scopes, llm: credentials,
    messages: [{ role: 'user', content: 'Current private project requirement.' }] })
}

describe('independent runtime memory scopes', () => {
  it('defaults to session only, and both scopes still extract private content exclusively into this session', async () => {
    const initial = await getSessionMemorySettings(tenantId, sessionId, 'code')
    expect(initial).toMatchObject({ globalEnabled: false, sessionEnabled: true, effectiveScopes: ['session'] })
    const complete = adapter(JSON.stringify([{ type: 'decision', content: 'Keep the private project contract', importance: 0.9, emotion: 0, tags: ['project'] }]))
    await setMemoryPreferences(tenantId, { globalEnabled: true })
    const both = await getSessionMemorySettings(tenantId, sessionId)
    expect(both.effectiveScopes).toEqual(['global', 'session'])
    expect(await extracted(both.effectiveScopes)).toMatchObject({ stored: 1, errors: [] })
    expect(complete).toHaveBeenCalledTimes(1)
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
  })

  it('legacy global cannot enable the global gate, and both off avoids provider calls and storage writes', async () => {
    await setSessionMemoryScope(tenantId, sessionId, 'global')
    const legacy = await getSessionMemorySettings(tenantId, sessionId)
    expect(legacy.globalEnabled).toBe(false)
    expect(legacy.effectiveScopes).toEqual(['session'])
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
})

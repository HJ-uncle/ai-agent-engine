import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeMemoryDb, initMemoryDb } from '../../../storage/memory/db.js'
import { MEMORY_SCHEMA } from '../../../storage/memory/schema.js'
import { SQLiteMemoryManager } from '../../../storage/memory/memory-manager.js'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { createMemoryTools } from '../memory-tool.js'

describe('memory tools scope policy', () => {
  let fixture: string
  let tools: ReturnType<typeof createMemoryTools>
  const previousDataDir = process.env.DATA_DIR

  beforeEach(async () => {
    await closeMemoryDb()
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'true')
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-tools-'))
    process.env.DATA_DIR = path.join(fixture, 'agent.db')
    await initMemoryDb(MEMORY_SCHEMA)
    tools = createMemoryTools()
  })

  afterEach(async () => {
    await closeMemoryDb()
    vi.unstubAllEnvs()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    try { fs.rmSync(fixture, { recursive: true, force: true }) } catch { /* SQLite may release the file shortly after close. */ }
  })

  function context(sessionId: string, memoryScope: 'off' | 'global' | 'session') {
    return { tenantId: 'tenant-tools', sessionId, memoryScope } as any
  }

  function tool(name: string) {
    return tools.find(candidate => candidate.name === name)!
  }

  it('refuses all memory operations when the request policy is off', async () => {
    const result = await tool('remember').execute({ content: 'secret', type: 'fact', tags: ['x'] }, context('A', 'off'))
    expect(result.success).toBe(false)
    expect(result.error).toBe('MEMORY_DISABLED')
  })

  it('keeps session tools isolated and ignores any model supplied session target', async () => {
    const created = await tool('remember').execute({ content: 'only A', type: 'fact', tags: ['private'], sessionId: 'B' }, context('A', 'session'))
    expect(created.success).toBe(true)

    const aList = await tool('list_memories').execute({ limit: 10 }, context('A', 'session'))
    const bList = await tool('list_memories').execute({ limit: 10 }, context('B', 'session'))
    expect(aList.output).toContain('only A')
    expect(bList.output).toBe('记忆体为空。')
  })

  it('allows global memory to be shared while keeping code profile off by default', async () => {
    const created = await tool('remember').execute({ content: 'shared', type: 'fact', tags: ['shared'] }, context('A', 'global'))
    expect(created.success).toBe(true)
    const bList = await tool('list_memories').execute({}, context('B', 'global'))
    expect(bList.output).toContain('shared')

    const codeContext = { tenantId: 'tenant-tools', sessionId: 'C', toolProfile: 'code' } as any
    const codeResult = await tool('list_memories').execute({}, codeContext)
    expect(codeResult.success).toBe(false)
    expect(codeResult.error).toBe('MEMORY_DISABLED')
  })
  it('reads both authorized scopes once, deduplicates facts and writes only to the current session', async () => {
    const manager = new SQLiteMemoryManager()
    const global = { tenantId: 'tenant-tools', scope: 'global' as const, sessionId: '' }
    const session = { tenantId: 'tenant-tools', scope: 'session' as const, sessionId: 'A' }
    await manager.createNode({ type: 'fact', summary: 'duplicate policy', tags: ['both'] }, session)
    await manager.createNode({ type: 'fact', summary: 'duplicate policy', tags: ['both'] }, global)
    await manager.createNode({ type: 'fact', summary: 'global reference', tags: ['both'] }, global)
    await manager.createNode({ type: 'fact', summary: 'foreign session secret', tags: ['both'] }, { ...session, sessionId: 'B' })
    await manager.createNode({ type: 'fact', summary: 'foreign tenant secret', tags: ['both'] }, { ...global, tenantId: 'other' })
    const ctx = { tenantId: 'tenant-tools', sessionId: 'A', rootSessionId: 'B', memoryScope: 'global', memoryScopes: ['global', 'session'] } as unknown as AgentContext
    const recalled = await tool('recall').execute({ tags: ['both'] }, ctx)
    expect(recalled.output).toContain('global reference')
    expect(recalled.output.match(/duplicate policy/g)).toHaveLength(1)
    expect(recalled.output).not.toContain('secret')
    expect((await tool('list_memories').execute({ limit: 1 }, ctx)).output).toContain('最近的 1 条记忆')
    await tool('remember').execute({ content: 'current session private', type: 'fact', tags: ['private'], scope: 'global', sessionId: 'B' }, ctx)
    expect(await manager.findNodeBySummary('current session private', session)).not.toBeNull()
    expect(await manager.findNodeBySummary('current session private', global)).toBeNull()
    expect(await manager.findNodeBySummary('current session private', { ...session, sessionId: 'B' })).toBeNull()
  })

  it('uses global writes only when session memory is disabled and refuses cross-scope links', async () => {
    const manager = new SQLiteMemoryManager()
    const ctx = { tenantId: 'tenant-tools', sessionId: 'A', memoryScopes: ['global'] } as unknown as AgentContext
    await tool('remember').execute({ content: 'global write', type: 'fact', tags: ['public'] }, ctx)
    const global = { tenantId: 'tenant-tools', scope: 'global' as const, sessionId: '' }
    const node = await manager.findNodeBySummary('global write', global)
    expect(node).not.toBeNull()
    const privateNode = await manager.createNode({ type: 'fact', summary: 'private node' }, { ...global, scope: 'session', sessionId: 'A' })
    const both = { ...ctx, memoryScopes: ['global', 'session'] } as unknown as AgentContext
    const linked = await tool('link_memories').execute({ sourceId: node!.id, targetId: privateNode.id, type: 'part_of', description: 'must not cross scopes' }, both)
    expect(linked.success).toBe(false)
    expect((await tool('forget').execute({ id: node!.id }, both)).success).toBe(true)
    expect(await manager.getNode(node!.id, global)).toBeNull()
  })

  it('an explicit empty policy or server disable defeats legacy scope and forged model arguments', async () => {
    const ctx = { tenantId: 'tenant-tools', sessionId: 'A', memoryScope: 'global', memoryScopes: [] } as unknown as AgentContext
    expect((await tool('remember').execute({ content: 'no write', type: 'fact', tags: [], memoryScopes: ['global'] }, ctx)).error).toBe('MEMORY_DISABLED')
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    for (const candidate of tools) {
      expect((await candidate.execute({}, { ...ctx, memoryScopes: ['global', 'session'] })).error).toBe('MEMORY_DISABLED')
    }
  })

})

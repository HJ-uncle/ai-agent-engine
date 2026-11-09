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
    expect(bList.output).toContain('记忆体为空。')
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
  it('exposes every authorized duplicate ID for precise management and writes only to the current session', async () => {
    const manager = new SQLiteMemoryManager()
    const global = { tenantId: 'tenant-tools', scope: 'global' as const, sessionId: '' }
    const session = { tenantId: 'tenant-tools', scope: 'session' as const, sessionId: 'A' }
    const sessionCopy = await manager.createNode({ type: 'fact', summary: 'duplicate policy', tags: ['both'] }, session)
    const globalCopy = await manager.createNode({ type: 'fact', summary: 'duplicate policy', tags: ['both'] }, global)
    await manager.createNode({ type: 'fact', summary: 'global reference', tags: ['both'] }, global)
    await manager.createNode({ type: 'fact', summary: 'foreign session secret', tags: ['both'] }, { ...session, sessionId: 'B' })
    await manager.createNode({ type: 'fact', summary: 'foreign tenant secret', tags: ['both'] }, { ...global, tenantId: 'other' })
    const ctx = { tenantId: 'tenant-tools', sessionId: 'A', rootSessionId: 'B', memoryScope: 'global', memoryScopes: ['global', 'session'] } as unknown as AgentContext
    const recalled = await tool('recall').execute({ tags: ['both'] }, ctx)
    expect(recalled.output).toContain('global reference')
    expect(recalled.output.match(/duplicate policy/g)).toHaveLength(2)
    expect(recalled.output).toContain(`[${sessionCopy.id}] [session]`)
    expect(recalled.output).toContain(`[${globalCopy.id}] [global]`)
    expect(recalled.output).not.toContain('secret')
    expect((await tool('list_memories').execute({ limit: 1 }, ctx)).output).toContain('最近的 1 条记忆')
    await tool('remember').execute({ content: 'current session private', type: 'fact', tags: ['private'], scope: 'global', sessionId: 'B' }, ctx)
    expect(await manager.findNodeBySummary('current session private', session)).not.toBeNull()
    expect(await manager.findNodeBySummary('current session private', global)).toBeNull()
    expect(await manager.findNodeBySummary('current session private', { ...session, sessionId: 'B' })).toBeNull()
  })

  it('deletes only the requested ID and returns its original fact for extraction exclusion', async () => {
    const manager = new SQLiteMemoryManager()
    const scope = { tenantId: 'tenant-tools', scope: 'session' as const, sessionId: 'A' }
    const first = await manager.createNode({ type: 'preference', summary: 'Prefer blue', tags: ['color'] }, scope)
    const second = await manager.createNode({ type: 'preference', summary: 'Prefer blue', tags: ['color'] }, scope)
    const unrelated = await manager.createNode({ type: 'preference', summary: 'Prefer green', tags: ['color'] }, scope)
    const result = await tool('forget').execute({ id: first.id }, context('A', 'session'))
    expect(result).toMatchObject({ success: true, metadata: { memoryMutation: { action: 'forget', id: first.id, summary: 'Prefer blue' } } })
    expect(await manager.getNode(first.id, scope)).toBeNull()
    expect(await manager.getNode(second.id, scope)).not.toBeNull()
    expect(await manager.getNode(unrelated.id, scope)).not.toBeNull()
    const recalled = await tool('recall').execute({ tags: ['color'] }, context('A', 'session'))
    expect(recalled.output).toContain(second.id)
    expect(recalled.output).not.toContain(first.id)
    expect((await tool('forget').execute({ id: second.id }, context('B', 'session'))).error).toBe('MEMORY_NOT_FOUND')
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

  it('pages past 125 unrelated records across authorized scopes and deletes only matched old copies', async () => {
    const manager = new SQLiteMemoryManager()
    const session = { tenantId: 'tenant-tools', scope: 'session' as const, sessionId: 'A' }
    const global = { ...session, scope: 'global' as const, sessionId: '' }
    const noise = Array.from({ length: 125 }, (_, index) => ({ type: 'fact' as const, summary: `Unrelated ${index}`, timestamp: 100, strength: 1, tags: ['archive'] }))
    const privateNoise = await manager.writeBatch(noise.slice(0, 60), [], session)
    const sharedNoise = await manager.writeBatch(noise.slice(60), [], global)
    const one = await manager.createNode({ type: 'preference', summary: 'PAGE_TARGET_742', timestamp: 1, strength: 0.1, tags: ['archive'] }, session)
    const two = await manager.createNode({ type: 'preference', summary: 'PAGE_TARGET_742', timestamp: 1, strength: 0.1, tags: ['archive'] }, global)
    const foreignScope = { ...session, sessionId: 'B' }
    const foreign = await manager.createNode({ type: 'preference', summary: 'PAGE_TARGET_742', tags: ['archive'] }, foreignScope)
    const otherTenant = await manager.createNode({ type: 'preference', summary: 'PAGE_TARGET_742', tags: ['archive'] }, { ...session, tenantId: 'other' })
    const ctx = { tenantId: 'tenant-tools', sessionId: 'A', memoryScopes: ['global', 'session'] } as unknown as AgentContext
    const expected = [...privateNoise.nodes, ...sharedNoise.nodes].map(node => node.id).sort()
    expected.push(...[one.id, two.id].sort())
    for (const name of ['recall', 'list_memories']) {
      const seen: string[] = []
      let offset = 0
      for (;;) {
        const result = await tool(name).execute({ tags: ['archive'], limit: 30, offset }, ctx)
        const page = result.metadata!.memoryPage as { hasMore: boolean; nextOffset: number | null }
        const nodes = result.metadata!.memoryNodes as Array<{ id: string }>
        seen.push(...nodes.map(node => node.id))
        if (!page.hasMore) { expect(page.nextOffset).toBeNull(); break }
        expect(page.nextOffset).toBe(offset + nodes.length)
        offset = page.nextOffset!
      }
      expect(seen).toEqual(expected)
      expect(seen.slice(0, 100)).not.toContain(one.id)
      expect(seen.slice(0, 100)).not.toContain(two.id)
    }
    // Each deletion shifts offsets. Requerying page zero drains all matching
    // copies even with a one-item page, while unrelated/scope data survives.
    for (let index = 0; index < 2; index++) {
      const result = await tool('recall').execute({ tags: [], keyword: 'PAGE_TARGET_742', limit: 1, offset: 0 }, ctx)
      const nodes = result.metadata!.memoryNodes as Array<{ id: string }>
      expect(nodes).toHaveLength(1)
      expect(result.output).toContain('删除一批后从 offset=0 重查')
      expect((await tool('forget').execute({ id: nodes[0].id }, ctx)).success).toBe(true)
    }
    const final = await tool('list_memories').execute({ keyword: 'PAGE_TARGET_742', offset: 0 }, ctx)
    expect(final.metadata).toMatchObject({ memoryPage: { returned: 0, hasMore: false, nextOffset: null }, memoryNodes: [] })
    expect(await manager.countNodes({}, session)).toBe(60)
    expect(await manager.countNodes({}, global)).toBe(65)
    expect(await manager.getNode(foreign.id, foreignScope)).not.toBeNull()
    expect(await manager.getNode(otherTenant.id, { ...session, tenantId: 'other' })).not.toBeNull()
  })

  it('treats keyword as an exact case-sensitive substring rather than SQL wildcards, words, or regex', async () => {
    const manager = new SQLiteMemoryManager()
    const scope = { tenantId: 'tenant-tools', scope: 'session' as const, sessionId: 'A' }
    const values = ['Token.ts', 'token.ts', "literal%_[]'  value", "literalAX[]' value"]
    for (const summary of values) await manager.createNode({ type: 'fact', summary }, scope)
    for (const name of ['recall', 'list_memories']) {
      for (const keyword of values) {
        const result = await tool(name).execute({ tags: [], keyword }, context('A', 'session'))
        expect((result.metadata!.memoryNodes as Array<{ summary: string }>).map(node => node.summary)).toEqual([keyword])
      }
      const result = await tool(name).execute({ tags: [], keyword: "') OR (1=1)--" }, context('A', 'session'))
      expect(result.metadata).toMatchObject({ memoryPage: { returned: 0, hasMore: false } })
    }
  })

})

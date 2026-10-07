import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeMemoryDb, initMemoryDb } from '../../../storage/memory/db.js'
import { MEMORY_SCHEMA } from '../../../storage/memory/schema.js'
import { createMemoryTools } from '../memory-tool.js'

describe('memory tools scope policy', () => {
  let fixture: string
  let tools: ReturnType<typeof createMemoryTools>
  const previousDataDir = process.env.DATA_DIR

  beforeEach(async () => {
    closeMemoryDb()
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-tools-'))
    process.env.DATA_DIR = path.join(fixture, 'agent.db')
    await initMemoryDb(MEMORY_SCHEMA)
    tools = createMemoryTools()
  })

  afterEach(() => {
    closeMemoryDb()
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
})

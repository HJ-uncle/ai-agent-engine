import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeMemoryDb, initMemoryDb } from '../db.js'
import { MEMORY_SCHEMA } from '../schema.js'
import { SQLiteMemoryManager } from '../memory-manager.js'
import type { MemoryContext } from '../types.js'

describe('memory keyword search', () => {
  let fixture: string
  let manager: SQLiteMemoryManager
  const context: MemoryContext = { tenantId: 'keyword-tenant', sessionId: 'keyword-session', scope: 'session' }
  const previousDataDir = process.env.DATA_DIR

  beforeEach(async () => {
    await closeMemoryDb()
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-keywords-'))
    process.env.DATA_DIR = path.join(fixture, 'agent.db')
    await initMemoryDb(MEMORY_SCHEMA)
    manager = new SQLiteMemoryManager()
  })

  afterEach(async () => {
    await closeMemoryDb()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(fixture, { recursive: true, force: true })
  })

  it('searches all 2000 terms without expression-depth failure or dropping the final term', async () => {
    const first = await manager.createNode({ type: 'fact', summary: 'archive keyword0000', timestamp: 1 }, context)
    const middle = await manager.createNode({ type: 'fact', summary: 'archive', detail: 'keyword1000 detail', timestamp: 2 }, context)
    const last = await manager.createNode({ type: 'fact', summary: 'keyword1999 archive', timestamp: 3 }, context)
    await manager.createNode({ type: 'fact', summary: 'unrelated archive', timestamp: 4 }, context)
    const keyword = Array.from({ length: 2000 }, (_, i) => `keyword${String(i).padStart(4, '0')}`).join('\n')

    expect((await manager.listNodes({ keyword, orderDir: 'ASC' }, context)).map(node => node.id)).toEqual([first.id, middle.id, last.id])
    expect(await manager.countNodes({ keyword }, context)).toBe(3)
    expect((await manager.listNodes({ keyword, orderDir: 'ASC', offset: 1, limit: 1 }, context)).map(node => node.id)).toEqual([middle.id])
  })

  it('preserves scope, tenant, tags, and other filters for a long keyword query', async () => {
    const keyword = `${Array.from({ length: 1200 }, (_, i) => `miss${i}`).join(' ')} scopehit`
    const kept = await manager.createNode({ type: 'fact', summary: 'scopehit', importance: 0.8, tags: ['keep'] }, context)
    await manager.createNode({ type: 'fact', summary: 'scopehit', importance: 0.8, tags: ['other'] }, context)
    await manager.createNode({ type: 'fact', summary: 'scopehit', importance: 0.1, tags: ['keep'] }, context)
    for (const foreign of [
      { ...context, tenantId: 'other-tenant' },
      { ...context, sessionId: 'other-session' },
      { ...context, scope: 'global' as const },
    ]) await manager.createNode({ type: 'fact', summary: 'scopehit', importance: 0.8, tags: ['keep'] }, foreign)
    const filter = { keyword, tags: ['keep'], minImportance: 0.5 }

    expect((await manager.listNodes(filter, context)).map(node => node.id)).toEqual([kept.id])
    expect(await manager.countNodes(filter, context)).toBe(1)
  })

  it('retains keyword splitting and LIKE semantics while binding quotes as data', async () => {
    const english = await manager.createNode({ type: 'fact', summary: 'Alpha report' }, context)
    const chinese = await manager.createNode({ type: 'fact', summary: '项目', detail: '季度归档' }, context)
    const quoted = await manager.createNode({ type: 'fact', summary: "O'Reilly" }, context)
    const wildcard = await manager.createNode({ type: 'fact', summary: 'prefixsuffix' }, context)

    expect(new Set((await manager.listNodes({ keyword: 'ALPHA，季度。ALPHA' }, context)).map(node => node.id))).toEqual(new Set([english.id, chinese.id]))
    expect((await manager.listNodes({ keyword: "O'Reilly" }, context)).map(node => node.id)).toEqual([quoted.id])
    expect(await manager.countNodes({ keyword: "')OR(1=1)--" }, context)).toBe(0)
    expect((await manager.listNodes({ keyword: 'prefix%suffix' }, context)).map(node => node.id)).toEqual([wildcard.id])
    expect((await manager.listNodes({ keyword: '目' }, context)).map(node => node.id)).toEqual([chinese.id])
  })
})

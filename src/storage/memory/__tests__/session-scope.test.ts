import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeMemoryDb, initMemoryDb } from '../db.js'
import { MEMORY_SCHEMA } from '../schema.js'
import { SQLiteMemoryManager } from '../memory-manager.js'
import type { MemoryContext } from '../types.js'

describe('memory session scope isolation', () => {
  let fixture: string
  let manager: SQLiteMemoryManager
  const globalCtx: MemoryContext = { tenantId: 'tenant-a', sessionId: 'session-a', scope: 'global' }
  const sessionACtx: MemoryContext = { tenantId: 'tenant-a', sessionId: 'session-a', scope: 'session' }
  const sessionBCtx: MemoryContext = { tenantId: 'tenant-a', sessionId: 'session-b', scope: 'session' }

  beforeEach(async () => {
    await closeMemoryDb()
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-scope-'))
    process.env.DATA_DIR = path.join(fixture, 'agent.db')
    await initMemoryDb(MEMORY_SCHEMA)
    manager = new SQLiteMemoryManager()
  })

  afterEach(async () => {
    await closeMemoryDb()
    await new Promise(resolve => setTimeout(resolve, 50))
    try { fs.rmSync(fixture, { recursive: true, force: true }) } catch { /* Windows may release SQLite handles later. */ }
  })

  it('keeps global and each session isolated for CRUD, tags, and listing', async () => {
    const global = await manager.createNode({ type: 'fact', summary: 'global fact', tags: ['shared'] }, globalCtx)
    const a = await manager.createNode({ type: 'fact', summary: 'session A fact', tags: ['private'] }, sessionACtx)
    const b = await manager.createNode({ type: 'fact', summary: 'session B fact', tags: ['private'] }, sessionBCtx)

    expect((await manager.listNodes({}, globalCtx)).map(node => node.id)).toEqual([global.id])
    expect((await manager.listNodes({}, sessionACtx)).map(node => node.id)).toEqual([a.id])
    expect((await manager.listNodes({}, sessionBCtx)).map(node => node.id)).toEqual([b.id])
    expect(await manager.getNode(a.id, globalCtx)).toBeNull()
    expect(await manager.getNode(b.id, sessionACtx)).toBeNull()
    expect(await manager.getTags(a.id, globalCtx)).toEqual([])

    expect(await manager.updateNode(a.id, { summary: 'blocked update' }, globalCtx)).toBeNull()
    await manager.deleteNode(b.id, sessionACtx)
    expect(await manager.getNode(b.id, sessionBCtx)).not.toBeNull()
    await manager.removeTag(a.id, 'private', sessionACtx)
    expect(await manager.getTags(a.id, sessionACtx)).toEqual([])
  })

  it('only permits edges inside the same tenant and scope and traverses safely', async () => {
    const a1 = await manager.createNode({ type: 'fact', summary: 'a1' }, sessionACtx)
    const a2 = await manager.createNode({ type: 'fact', summary: 'a2' }, sessionACtx)
    const b = await manager.createNode({ type: 'fact', summary: 'b' }, sessionBCtx)
    const global = await manager.createNode({ type: 'fact', summary: 'global' }, globalCtx)

    await expect(manager.createEdge({ sourceNodeId: a1.id, targetNodeId: b.id, type: 'part_of' }, sessionACtx)).rejects.toThrow()
    await expect(manager.createEdge({ sourceNodeId: a1.id, targetNodeId: global.id, type: 'part_of' }, sessionACtx)).rejects.toThrow()
    await expect(manager.createEdge({ sourceNodeId: a1.id, targetNodeId: a2.id, type: 'part_of' }, sessionACtx)).resolves.toBeTruthy()

    expect((await manager.getNeighbors(a1.id, undefined, sessionACtx)).map(node => node.id)).toEqual([a2.id])
    expect(await manager.getNeighbors(a1.id, undefined, sessionBCtx)).toEqual([])
    expect((await manager.traversePath(a1.id, 2, undefined, sessionACtx)).map(node => node.id)).toEqual([a2.id])
    expect(await manager.getRelatedNodes([a1.id], undefined, globalCtx)).toEqual([])
  })

  it('does not cross tenants even when session ids are equal', async () => {
    const otherTenant: MemoryContext = { tenantId: 'tenant-b', sessionId: 'session-a', scope: 'session' }
    const own = await manager.createNode({ type: 'fact', summary: 'own' }, sessionACtx)
    const foreign = await manager.createNode({ type: 'fact', summary: 'foreign' }, otherTenant)
    expect(await manager.getNode(foreign.id, sessionACtx)).toBeNull()
    expect((await manager.listNodes({}, otherTenant)).map(node => node.id)).toEqual([foreign.id])
    await expect(manager.createEdge({ sourceNodeId: own.id, targetNodeId: foreign.id, type: 'part_of' }, sessionACtx)).rejects.toThrow()
  })

  it('keeps vector recall inside the active scope', async () => {
    const a = await manager.createNode({ type: 'fact', summary: 'vector A', embedding: [1, 0, 0] }, sessionACtx)
    await manager.createNode({ type: 'fact', summary: 'vector B', embedding: [1, 0, 0] }, sessionBCtx)
    await manager.createNode({ type: 'fact', summary: 'vector global', embedding: [1, 0, 0] }, globalCtx)
    expect((await manager.recallSimilar([1, 0, 0], 10, sessionACtx)).map(node => node.id)).toEqual([a.id])
    expect((await manager.recallSimilar([1, 0, 0], 10, globalCtx)).map(node => node.summary)).toEqual(['vector global'])
  })

  it('requires a session id for session-scoped operations', async () => {
    await expect(manager.createNode({ type: 'fact', summary: 'invalid' }, { tenantId: 'tenant-a', sessionId: '', scope: 'session' })).rejects.toThrow(/sessionId/)
  })

  it('bounds graph expansion deterministically while leaving explicit full traversal available', async () => {
    const root = await manager.createNode({ type: 'fact', summary: 'graph root' }, sessionACtx)
    const children = await manager.writeBatch(Array.from({ length: 20 }, (_, index) => ({ type: 'fact' as const, summary: `child ${index}`, timestamp: index })), [], sessionACtx)
    await manager.writeBatch([], children.nodes.map(node => ({ sourceNodeId: root.id, targetNodeId: node.id, type: 'part_of' as const })), sessionACtx)
    const first = await manager.traversePath(root.id, 2, undefined, sessionACtx, 5)
    expect(first).toHaveLength(5)
    expect((await manager.traversePath(root.id, 2, undefined, sessionACtx, 5)).map(node => node.id)).toEqual(first.map(node => node.id))
    expect(await manager.traversePath(root.id, 2, undefined, sessionBCtx, 5)).toEqual([])
    expect(await manager.traversePath(root.id, 2, undefined, sessionACtx)).toHaveLength(20)
    expect(await manager.getRelatedNodes([root.id], undefined, sessionACtx, 5)).toHaveLength(5)
    expect(await manager.getRelatedNodes([root.id], undefined, globalCtx, 5)).toEqual([])
  })

  it('returns equal-distance vectors and equal-ranked lists in stable ID order with sorted tags', async () => {
    const nodes = await manager.writeBatch(Array.from({ length: 5 }, (_, index) => ({ type: 'fact' as const, summary: `ordered ${index}`,
      timestamp: 1, importance: 0.5, embedding: [1, 0, 0], tags: ['z-last', 'a-first'] })), [], sessionACtx)
    const ids = nodes.nodes.map(node => node.id).sort()
    expect((await manager.listNodes({ orderBy: 'importance' }, sessionACtx)).map(node => node.id)).toEqual(ids)
    expect((await manager.recallSimilar([1, 0, 0], 5, sessionACtx)).map(node => node.id)).toEqual(ids)
    expect(await manager.getTags(ids[0], sessionACtx)).toEqual(['a-first', 'z-last'])
    expect((await manager.listNodes({}, sessionACtx)).every(node => node.tags.join(',') === 'a-first,z-last')).toBe(true)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeMemoryDb, getMemoryDb, initMemoryDb } from '../db.js'
import { MEMORY_SCHEMA } from '../schema.js'
import { SQLiteMemoryManager } from '../memory-manager.js'
import type { MemoryContext } from '../types.js'

let fixture: string
beforeEach(async () => {
  await closeMemoryDb()
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-process-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
})
afterEach(async () => {
  await closeMemoryDb()
  vi.unstubAllEnvs()
  fs.rmSync(fixture, { recursive: true, force: true })
})

describe('memory database process isolation', () => {
  it('serializes five sessions doing repeated tag replacement and batch writes, preserves rollback and survives reopen', async () => {
    const initializations = Array.from({ length: 5 }, () => initMemoryDb(MEMORY_SCHEMA))
    expect(new Set(initializations).size).toBe(1)
    await Promise.all(initializations)
    const manager = new SQLiteMemoryManager()
    const sessions = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const context: MemoryContext = { tenantId: 'stress', sessionId: `session-${index}`, scope: 'session' }
      const base = await manager.createNode({ type: 'fact', summary: `owner-${index}`, tags: ['initial'] }, context)
      for (let iteration = 0; iteration < 40; iteration++) {
        await manager.updateNode(base.id, { tags: [`owner-${index}`, `revision-${iteration}`] }, context)
        if (iteration % 2 === 0) {
          const batch = await manager.writeBatch([
            { type: 'fact', summary: `batch-${index}-${iteration}-a`, tags: ['batch'] },
            { type: 'fact', summary: `batch-${index}-${iteration}-b` },
          ], [], context)
          expect(batch.nodes).toHaveLength(2)
        }
      }
      await expect(manager.writeBatch([{ type: 'fact', summary: 'must roll back', tags: ['rollback'] }], [
        { sourceNodeId: 'missing-node', targetNodeId: base.id, type: 'part_of' },
      ], context)).rejects.toThrow('both edge endpoints')
      expect(await manager.countNodes({}, context)).toBe(41)
      expect(((await manager.getNode(base.id, context))?.tags ?? []).sort()).toEqual([`owner-${index}`, 'revision-39'].sort())
      return { context, id: base.id }
    }))
    expect((await getMemoryDb().execute('PRAGMA cache_size')).rows[0].cache_size).toBe(-2000)
    expect((await getMemoryDb().execute('PRAGMA mmap_size')).rows[0].mmap_size).toBe(0)
    await closeMemoryDb()
    await initMemoryDb(MEMORY_SCHEMA)
    for (const { context, id } of sessions) {
      expect(await manager.countNodes({}, context)).toBe(41)
      expect((await manager.getNode(id, context))?.tags).toContain('revision-39')
    }
    expect((await getMemoryDb().execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe('ok')
  })

  it('retries failed initialization and notices a directly closed client before returning the cached initialization', async () => {
    const failed = initMemoryDb([])
    await expect(failed).rejects.toThrow()
    const initial = initMemoryDb(MEMORY_SCHEMA)
    expect(initial).not.toBe(failed)
    await initial
    const previous = getMemoryDb()
    previous.close()
    const reopened = initMemoryDb(MEMORY_SCHEMA)
    expect(reopened).not.toBe(initial)
    expect(getMemoryDb()).not.toBe(previous)
    await reopened
    expect((await getMemoryDb().execute("SELECT name FROM sqlite_schema WHERE name='memory_nodes'")).rows).toHaveLength(1)
  })
})

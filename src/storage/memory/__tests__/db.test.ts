import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeMemoryDb, getMemoryDb, initMemoryDb } from '../db.js'
import { MEMORY_SCHEMA } from '../schema.js'

describe('memory database schema initialization', () => {
  let fixture: string

  beforeEach(() => {
    closeMemoryDb()
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-schema-'))
    process.env.DATA_DIR = path.join(fixture, 'agent.db')
  })

  afterEach(async () => {
    closeMemoryDb()
    await new Promise((resolve) => setTimeout(resolve, 100))
    try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* Windows may release SQLite handles slightly later. */ }
  })

  it('creates every graph table and dependent index when vector extensions are unavailable', async () => {
    await initMemoryDb(MEMORY_SCHEMA)

    const result = await getMemoryDb().execute(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND (name LIKE 'memory_%' OR name LIKE 'idx_memory_%') ORDER BY name",
    )
    const names = result.rows.map((row) => String(row.name))

    expect(names).toEqual(expect.arrayContaining([
      'memory_graph_meta',
      'memory_nodes',
      'memory_edges',
      'memory_tags',
      'memory_node_tags',
      'idx_memory_nodes_tenant',
      'idx_memory_edges_tenant',
      'idx_memory_tags_tenant',
      'idx_memory_node_tags_tag',
    ]))
  })
})

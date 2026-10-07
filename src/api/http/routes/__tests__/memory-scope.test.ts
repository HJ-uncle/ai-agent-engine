import Fastify, { type FastifyRequest } from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryRoutes } from '../memory.js'
import { closeMemoryDb, initMemoryDb } from '../../../../storage/memory/db.js'
import { MEMORY_SCHEMA } from '../../../../storage/memory/schema.js'

describe('memory HTTP scope isolation', () => {
  let fixture: string
  let app: ReturnType<typeof Fastify>
  const previousDataDir = process.env.DATA_DIR
  const previousMemoryFlag = process.env.ENABLE_LONG_TERM_MEMORY

  beforeEach(async () => {
    closeMemoryDb()
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-http-'))
    process.env.DATA_DIR = path.join(fixture, 'agent.db')
    delete process.env.ENABLE_LONG_TERM_MEMORY
    await initMemoryDb(MEMORY_SCHEMA)
    app = Fastify()
    app.addHook('onRequest', async (request: FastifyRequest) => {
      ;(request as any).authContext = { tenantId: 'tenant-http' }
    })
    await app.register(memoryRoutes)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    closeMemoryDb()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (previousMemoryFlag === undefined) delete process.env.ENABLE_LONG_TERM_MEMORY
    else process.env.ENABLE_LONG_TERM_MEMORY = previousMemoryFlag
    try { fs.rmSync(fixture, { recursive: true, force: true }) } catch { /* SQLite may release the file shortly after close. */ }
  })

  async function remember(body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/memory/remember', payload: body })
  }

  it('keeps global and session lists separate and requires sessionId', async () => {
    const global = await remember({ key: 'owner', value: 'global' })
    const a = await remember({ key: 'owner', value: 'A', scope: 'session', sessionId: 'A' })
    await remember({ key: 'owner', value: 'B', scope: 'session', sessionId: 'B' })
    expect(global.statusCode).toBe(200)
    expect(a.statusCode).toBe(200)

    const globalList = await app.inject({ method: 'GET', url: '/memory/list' })
    const sessionAList = await app.inject({ method: 'GET', url: '/memory/list?scope=session&sessionId=A' })
    const sessionBList = await app.inject({ method: 'GET', url: '/memory/list?scope=session&sessionId=B' })
    expect(JSON.parse(globalList.body).data).toHaveLength(1)
    expect(JSON.parse(sessionAList.body).data).toHaveLength(1)
    expect(JSON.parse(sessionAList.body).data[0].scope).toBe('session')
    expect(JSON.parse(sessionBList.body).data[0].value).toContain('B')

    const invalid = await app.inject({ method: 'GET', url: '/memory/list?scope=session' })
    expect(invalid.statusCode).toBe(400)
  })

  it('prevents cross-scope update/delete/link and returns scoped graph edges', async () => {
    const first = JSON.parse((await remember({ key: 'first', value: 'one', scope: 'session', sessionId: 'A' })).body).data.id
    const second = JSON.parse((await remember({ key: 'second', value: 'two', scope: 'session', sessionId: 'A' })).body).data.id
    const foreign = JSON.parse((await remember({ key: 'foreign', value: 'x', scope: 'session', sessionId: 'B' })).body).data.id
    const link = await app.inject({
      method: 'POST',
      url: '/memory/link',
      payload: { sourceId: first, targetId: second, type: 'part_of', scope: 'session', sessionId: 'A' },
    })
    expect(link.statusCode).toBe(200)

    const graph = await app.inject({ method: 'GET', url: '/memory/graph?scope=session&sessionId=A' })
    const graphData = JSON.parse(graph.body).data
    expect(graphData.nodes).toHaveLength(2)
    expect(graphData.edges).toHaveLength(1)
    expect(graphData.edges[0].source).toBe(first)

    const crossUpdate = await app.inject({ method: 'PUT', url: `/memory/${first}?scope=session&sessionId=B`, payload: { summary: 'blocked' } })
    const crossDelete = await app.inject({ method: 'DELETE', url: `/memory/${first}?scope=session&sessionId=B` })
    const crossLink = await app.inject({ method: 'POST', url: '/memory/link', payload: { sourceId: first, targetId: foreign, type: 'part_of', scope: 'session', sessionId: 'A' } })
    expect(crossUpdate.statusCode).toBe(404)
    expect(crossDelete.statusCode).toBe(404)
    expect(crossLink.statusCode).toBe(404)
  })

  it('exposes and persists the per-session memory mode', async () => {
    const before = await app.inject({ method: 'GET', url: '/memory/settings?sessionId=A' })
    expect(JSON.parse(before.body).data.memoryScope).toBe('global')
    const update = await app.inject({ method: 'PUT', url: '/memory/settings', payload: { sessionId: 'A', memoryScope: 'session' } })
    expect(update.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: '/memory/settings?sessionId=A' })
    expect(JSON.parse(after.body).data.effectiveScope).toBe('session')
  })
})

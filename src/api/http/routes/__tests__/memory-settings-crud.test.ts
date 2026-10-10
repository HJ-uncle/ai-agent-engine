import Fastify, { type FastifyRequest } from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryRoutes } from '../memory.js'
import { closeMemoryDb, initMemoryDb } from '../../../../storage/memory/db.js'
import { MEMORY_SCHEMA } from '../../../../storage/memory/schema.js'

describe('memory settings CRUD API', () => {
  let fixture: string
  let app: ReturnType<typeof Fastify>
  beforeEach(async () => {
    await closeMemoryDb()
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-memory-crud-'))
    process.env.DATA_DIR = path.join(fixture, 'agent.db')
    await initMemoryDb(MEMORY_SCHEMA)
    app = Fastify()
    app.addHook('onRequest', async (request: FastifyRequest) => { ;(request as any).authContext = { tenantId: 'settings-tenant' } })
    await app.register(memoryRoutes)
    await app.ready()
  })
  afterEach(async () => {
    await app.close(); await closeMemoryDb()
    try { fs.rmSync(fixture, { recursive: true, force: true }) } catch { /* Windows handle release is eventual. */ }
  })

  it('creates, reads, edits (including replacing tags), and deletes a session memory', async () => {
    const created = await app.inject({ method: 'POST', url: '/memory/nodes?scope=session&sessionId=s1', payload: { summary: 'API preference', type: 'preference', importance: 0.9, detail: 'Use concise output', tags: ['ui', 'preference'] } })
    expect(created.statusCode).toBe(201)
    const id = JSON.parse(created.body).data.id
    const read = await app.inject({ method: 'GET', url: `/memory/${id}?scope=session&sessionId=s1` })
    expect(JSON.parse(read.body).data.tags).toEqual(expect.arrayContaining(['ui', 'preference']))
    const edited = await app.inject({ method: 'PUT', url: `/memory/${id}?scope=session&sessionId=s1`, payload: { summary: 'Updated preference', tags: ['updated'] } })
    expect(edited.statusCode).toBe(200)
    expect(JSON.parse(edited.body).data.tags).toEqual(['updated'])
    expect((await app.inject({ method: 'GET', url: `/memory/${id}?scope=global` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/memory/${id}?scope=session&sessionId=s1` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/memory/${id}?scope=session&sessionId=s1` })).statusCode).toBe(404)
  })

  it('uses database count and offset for collections larger than 1000, with keyword filtering', async () => {
    for (let i = 0; i < 1_005; i++) {
      const response = await app.inject({ method: 'POST', url: '/memory/nodes', payload: { summary: i === 1004 ? 'needle unique' : `entry ${i}`, tags: i === 1004 ? ['needle'] : [] } })
      expect(response.statusCode).toBe(201)
    }
    const page = await app.inject({ method: 'GET', url: '/memory/list?current=3&pageSize=400' })
    const pageBody = JSON.parse(page.body)
    expect(pageBody.data).toHaveLength(205)
    expect(pageBody.pagination).toMatchObject({ current: 3, pageSize: 400, total: 1005, totalPages: 3 })
    const search = await app.inject({ method: 'GET', url: '/memory/list?keyword=needle&pageSize=20' })
    expect(JSON.parse(search.body).pagination.total).toBe(1)
  })

  it('rejects invalid type, importance, tags and scope changes', async () => {
    expect((await app.inject({ method: 'POST', url: '/memory/nodes', payload: { summary: 'x', importance: 2 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/memory/nodes', payload: { summary: 'x', type: 'unknown' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/memory/nodes', payload: { summary: 'x', tags: ['ok', 1] } })).statusCode).toBe(400)
    const id = JSON.parse((await app.inject({ method: 'POST', url: '/memory/nodes', payload: { summary: 'x' } })).body).data.id
    expect((await app.inject({ method: 'PUT', url: `/memory/${id}`, payload: { scope: 'session', summary: 'bad' } })).statusCode).toBe(400)
  })
})

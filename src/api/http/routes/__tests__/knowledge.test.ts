import Fastify, { type FastifyInstance, type HTTPMethods } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { knowledgeRoutes } from '../knowledge.js'

let db: Client
let app: FastifyInstance
let activeTenant = 'tenant-a'

beforeEach(async () => {
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  activeTenant = 'tenant-a'
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: activeTenant } })
  })
  await app.register(knowledgeRoutes)
})

afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
})

async function request(method: any, url: string, payload?: any, headers?: Record<string, string>) {
  const response = await app.inject({ method, url, payload, headers })
  return { status: response.statusCode, body: response.json() as any }
}

async function createBase(name = 'Docs') {
  const result = await request('POST', '/knowledge/bases', { name, description: 'test base' })
  expect(result.status).toBe(200)
  expect(result.body.code).toBe(200)
  return result.body.data as { id: string }
}

describe('knowledge HTTP routes', () => {
  it('reports the formats supported by the running extractor', async () => {
    const result = await request('GET', '/knowledge/formats')
    expect(result.body.code).toBe(200)
    expect(result.body.data.extensions).toEqual(expect.arrayContaining(['.md', '.xlsx', '.docx', '.pdf']))
  })

  it('creates, lists, reads, updates and deletes knowledge bases', async () => {
    const base = await createBase()
    expect((await request('POST', '/knowledge/bases', { name: 'Docs' })).body.code).toBe(40901)
    expect((await request('GET', '/knowledge/bases')).body.data).toHaveLength(1)
    expect((await request('GET', `/knowledge/bases/${base.id}`)).body.data.name).toBe('Docs')

    const updated = await request('PUT', `/knowledge/bases/${base.id}`, { name: 'Renamed', description: 'updated' })
    expect(updated.body.data).toMatchObject({ id: base.id, name: 'Renamed', description: 'updated' })
    expect((await request('DELETE', `/knowledge/bases/${base.id}`)).body.data).toEqual({ deleted: true })
    expect((await request('GET', `/knowledge/bases/${base.id}`)).body.code).toBe(40400)
  })

  it('keeps base and document data isolated between tenants', async () => {
    const base = await createBase()
    const created = await request('POST', '/knowledge/documents', {
      filename: 'guide.md', content: 'tenant A secret phrase', knowledgeBaseId: base.id
    })
    const docId = created.body.data.id as string
    expect(created.body.data).toMatchObject({ id: docId, knowledgeBaseId: base.id, content: 'tenant A secret phrase' })

    activeTenant = 'tenant-b'
    for (const [method, url, payload] of [
      ['GET', `/knowledge/bases/${base.id}`],
      ['PUT', `/knowledge/bases/${base.id}`, { name: 'hijack' }],
      ['DELETE', `/knowledge/bases/${base.id}`],
      ['GET', `/knowledge/documents/${docId}`],
      ['PUT', `/knowledge/documents/${docId}`, { content: 'hijack' }],
      ['DELETE', `/knowledge/documents/${docId}`],
    ] as const) {
      expect((await request(method, url, payload)).body.code).toBe(40400)
    }
    expect((await request('GET', '/knowledge/documents')).body.data).toEqual([])
    expect((await request('POST', '/knowledge/search', { query: 'secret' })).body.data).toEqual([])

    activeTenant = 'tenant-a'
    expect((await request('GET', `/knowledge/documents/${docId}`)).body.data).toMatchObject({
      id: docId, filename: 'guide.md', content: 'tenant A secret phrase', knowledgeBaseId: base.id
    })
    expect((await request('POST', '/knowledge/search', { query: 'secret' })).body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ documentId: docId, content: expect.stringContaining('secret') })])
    )
  })

  it('supports JSON and plain text document ingestion and preserves exact content on update', async () => {
    const base = await createBase()
    const plain = '第一行\r\n第二行\n末尾'
    const fromPlain = await request('POST', `/knowledge/documents?knowledgeBaseId=${base.id}`, plain, {
      'content-type': 'text/plain', 'x-filename': 'plain.txt'
    })
    expect(fromPlain.body.code).toBe(200)
    expect(fromPlain.body.data).toMatchObject({ filename: 'plain.txt', knowledgeBaseId: base.id, content: plain, status: 'ready', contentExact: true })

    const fromJson = await request('POST', '/knowledge/documents', {
      filename: 'json.md', content: 'json grouped content', knowledgeBaseId: base.id, contentType: 'text/markdown'
    })
    expect(fromJson.body.data).toMatchObject({ filename: 'json.md', contentType: 'text/markdown', knowledgeBaseId: base.id })
    const id = fromJson.body.data.id as string
    const changed = 'updated\nwith exact bytes\r\n中文'
    const updated = await request('PUT', `/knowledge/documents/${id}`, { filename: 'renamed.md', content: changed })
    expect(updated.body.data).toMatchObject({ id, filename: 'renamed.md', content: changed, contentExact: true, status: 'ready' })
    expect((await request('GET', `/knowledge/documents/${id}`)).body.data.content).toBe(changed)
    expect((await request('POST', '/knowledge/search', { query: 'exact bytes' })).body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ documentId: id })])
    )
    expect((await request('POST', '/knowledge/search', { query: 'json grouped' })).body.data).toEqual([])
  })

  it('removes document chunks and FTS rows when a document is deleted', async () => {
    const base = await createBase()
    const doc = await request('POST', '/knowledge/documents', { filename: 'gone.txt', content: 'unique deletion token', knowledgeBaseId: base.id })
    const id = doc.body.data.id as string
    expect((await request('POST', '/knowledge/search', { query: 'deletion' })).body.data.length).toBeGreaterThan(0)
    expect((await request('DELETE', `/knowledge/documents/${id}`)).body).toMatchObject({ code: 200, data: { deleted: true } })
    expect((await request('POST', '/knowledge/search', { query: 'deletion' })).body.data).toEqual([])
    expect((await request('GET', `/knowledge/documents/${id}`)).body.code).toBe(40400)
  })

  it('validates object payloads, empty values, scopes and limits', async () => {
    for (const payload of [{}, { name: '   ' }, { name: {} }, { name: 42 }]) {
      expect((await request('POST', '/knowledge/bases', payload)).body.code).toBe(40001)
    }
    for (const payload of [
      {}, { filename: 'x.txt' }, { filename: 'x.txt', content: '   ' },
      { filename: 'x.txt', content: {} }, { filename: {}, content: 'text' }
    ]) {
      expect((await request('POST', '/knowledge/documents', payload)).body.code).toBe(40001)
    }
    for (const payload of [{}, { query: '' }, { query: {} }, { query: 'x', limit: 0 }, { query: 'x', limit: 101 }, { query: 'x', limit: '5' }, { query: 'x', knowledgeBaseIds: {} }]) {
      expect((await request('POST', '/knowledge/search', payload)).body.code).toBe(40001)
    }
    expect((await request('GET', '/knowledge/bases/not-found')).body.code).toBe(40400)
    expect((await request('GET', '/knowledge/documents/not-found')).body.code).toBe(40400)
  })
})



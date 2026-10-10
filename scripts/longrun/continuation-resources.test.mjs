import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { resourceRequester, verifyKnowledgeCrud, knowledgeCrudPassed } from './continuation-resources.mjs'

test('resource requests exercise real JSON parsing and verify every CRUD transition', async () => {
  const app = Fastify()
  const documents = new Map()
  const received = []
  app.addHook('onRequest', async request => {
    received.push({ method: request.method, contentType: request.headers['content-type'], token: request.headers['x-aether-instance-token'] })
  })
  app.post('/api/v1/knowledge/documents', async request => {
    const document = { ...request.body, id: 'actual-document' }
    documents.set(document.id, document)
    return { code: 200, data: document }
  })
  app.get('/api/v1/knowledge/documents/:id', async request => {
    const document = documents.get(request.params.id)
    return document ? { code: 200, data: document } : { code: 40400, message: 'Document not found' }
  })
  app.put('/api/v1/knowledge/documents/:id', async request => {
    const document = { ...documents.get(request.params.id), ...request.body }
    documents.set(request.params.id, document)
    return { code: 200, data: document }
  })
  app.delete('/api/v1/knowledge/documents/:id', async request => ({ code: 200, data: { deleted: documents.delete(request.params.id) } }))
  const observations = []
  const fetcher = async (url, options) => {
    const response = await app.inject({ method: options.method, url: new URL(url).pathname, headers: options.headers, payload: options.body })
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() }
  }
  try {
    const request = resourceRequester('http://fixture', 'test-token', observations, fetcher)
    const crud = await verifyKnowledgeCrud(request, 'retained-base')
    assert.equal(knowledgeCrudPassed({ passed: true, crud }), true)
    assert.equal(documents.size, 0)
    assert.deepEqual(received.map(row => row.method), ['POST', 'GET', 'PUT', 'GET', 'DELETE', 'GET'])
    assert.ok(received.every(row => row.token === 'test-token'))
    assert.ok(received.filter(row => ['POST', 'PUT'].includes(row.method)).every(row => row.contentType === 'application/json'))
    assert.ok(received.filter(row => ['GET', 'DELETE'].includes(row.method)).every(row => row.contentType === undefined))
    assert.equal(observations.at(-1).code, 40400)
  } finally {
    await app.close()
  }
})

test('HTTP success cannot hide parser errors or invalid business envelopes', async () => {
  for (const body of [{ code: 400 }, { code: 40001 }, { code: 40400 }, {}, { code: 200, success: false }, { code: 200, error: { message: 'failed' } }]) {
    const observations = []
    const request = resourceRequester('http://fixture', 'test-token', observations, async () => ({ ok: true, status: 200, json: async () => body }))
    await assert.rejects(request('/knowledge/documents/x', { method: 'DELETE' }), /HTTP 200 code/)
    assert.equal(observations.length, 1)
  }
  const request = resourceRequester('http://fixture', 'test-token', [], async () => ({ ok: false, status: 500, json: async () => ({ code: 200 }) }))
  await assert.rejects(request('/knowledge/documents/x'), /HTTP 500/)
})

test('CRUD verification rejects lost updates and successful no-op deletion', async () => {
  for (const broken of ['update', 'delete']) {
    let document
    const request = async (_route, { method = 'GET', body } = {}) => {
      if (method === 'POST') return document = { ...body, id: 'doc' }
      if (method === 'PUT') {
        if (broken !== 'update') document = { ...document, ...body }
        return document
      }
      if (method === 'DELETE') return { deleted: true }
      return document
    }
    await assert.rejects(verifyKnowledgeCrud(request, 'kb'), broken === 'update' ? /update\/read mismatch/ : /did not remove/)
  }
})

test('CRUD verification cannot mistake request failures for absence after delete', async () => {
  let document, deleted = false
  const request = async (_route, { method = 'GET', body } = {}) => {
    if (method === 'POST') return document = { ...body, id: 'doc' }
    if (method === 'PUT') return document = { ...document, ...body }
    if (method === 'DELETE') { deleted = true; return { deleted: true } }
    if (deleted) throw new Error('request timeout')
    return document
  }
  await assert.rejects(verifyKnowledgeCrud(request, 'kb'), /request timeout/)
  assert.equal(knowledgeCrudPassed({ passed: true, observations: [{ method: 'DELETE', code: 400 }] }), false)
  assert.equal(knowledgeCrudPassed({ passed: true, crud: { documentId: 'doc', createReadVerified: true, updateReadVerified: true, deleteReadVerified: false } }), false)
})

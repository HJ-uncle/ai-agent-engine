// The HTTP route and metrics SQL are real; only the database location is replaced.
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { up as createSchema } from '../../../../storage/sqlite/migrations/001_initial.js'
import { recordTokenUsage, recordToolCall } from '../../../../observability/metrics.js'
import { metricsRoutes } from '../metrics.js'

let app: FastifyInstance
let db: Client

beforeEach(async () => {
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await createSchema(db)
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    const tenantId = request.headers['x-test-tenant']
    if (typeof tenantId === 'string') Object.assign(request, { authContext: { tenantId } })
  })
  await app.register(metricsRoutes)
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
  db.close()
})

async function seedUsage() {
  await recordTokenUsage({ tenantId: 'tenant-a', promptTokens: 20, completionTokens: 5 })
  await recordTokenUsage({ tenantId: 'tenant-a', promptTokens: 6, completionTokens: 4 })
  await recordTokenUsage({ tenantId: 'tenant-b', promptTokens: 100, completionTokens: 5 })
  await recordToolCall({ tenantId: 'tenant-a', sessionId: 'session-a', toolName: 'read_file', durationMs: 10, success: true })
  await recordToolCall({ tenantId: 'tenant-a', sessionId: 'session-a', toolName: 'read_file', durationMs: 30, success: false })
  await recordToolCall({ tenantId: 'tenant-b', sessionId: 'session-b', toolName: 'write_file', durationMs: 15, success: true })
}

describe('GET /metrics response contract', () => {
  it('serializes an empty database as a successful standard JSON response', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json()).toEqual({
      code: 200, message: expect.any(String), timestamp: expect.any(Number),
      data: { totalRequests: 0, totalTokens: 0, toolCallStats: [] }
    })
  })

  it('returns actual recorded token totals and tool success/duration aggregates', async () => {
    await seedUsage()
    const response = await app.inject({ method: 'GET', url: '/metrics' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ code: 200, data: {
      totalRequests: 3, totalTokens: 140,
      toolCallStats: [
        { toolName: 'read_file', count: 2, avgDurationMs: 20, successRate: 0.5 },
        { toolName: 'write_file', count: 1, avgDurationMs: 15, successRate: 1 }
      ]
    } })
  })

  it('preserves the supplied authentication tenant scope in the SQL aggregation', async () => {
    await seedUsage()
    const response = await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-test-tenant': 'tenant-a' } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ code: 200, data: {
      totalRequests: 2, totalTokens: 35,
      toolCallStats: [{ toolName: 'read_file', count: 2, avgDurationMs: 20, successRate: 0.5 }]
    } })
  })
})

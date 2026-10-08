import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// The response contract does not exercise background scheduling.
vi.mock('../src/scheduler/cron-scheduler.js', () => ({ cronScheduler: { start: vi.fn(), stop: vi.fn() } }))

// A full server creates command-job tables and starts its scheduler. Give this
// response-contract fixture its own DB instead of sharing the operator's DB.
describe('Standard API Responses', () => {
  const fixture = path.resolve('.e2e-tmp', 'standard-response-' + randomUUID())
  let app: FastifyInstance
  let database: typeof import('../src/storage/sqlite/db.js')
  let scheduler: typeof import('../src/scheduler/cron-scheduler.js').cronScheduler
  beforeAll(async () => {
    fs.mkdirSync(fixture, { recursive: true })
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('AETHER_INSTANCE_TOKEN', undefined)
    vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
    vi.stubEnv('WORKSPACE_ROOT', path.join(fixture, 'workspace'))
    database = await import('../src/storage/sqlite/db.js')
    await database.initDb()
    const { buildServer } = await import('../src/api/http/server.js')
    scheduler = (await import('../src/scheduler/cron-scheduler.js')).cronScheduler
    app = await buildServer()
  }, 30_000)
  afterAll(async () => {
    scheduler?.stop()
    await app?.close()
    // SQLite may spend its busy timeout draining the final WAL/mmap handles.
    // Keep that real cleanup inside the hook instead of timing it out early.
    if (database) {
      await database.getDb().execute('PRAGMA mmap_size = 0')
      await database.getDb().execute('PRAGMA wal_checkpoint(TRUNCATE)')
      database.closeDb()
    }
    vi.unstubAllEnvs()
    if (!fixture.startsWith(path.resolve('.e2e-tmp') + path.sep) || !path.basename(fixture).startsWith('standard-response-')) throw new Error('Unsafe response fixture cleanup')
    await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }, 30_000)

  it('1. 成功对象响应 (Success Object)', async () => {
    // Call health endpoint (whitelist) to see if it returns standard success
    const response = await app.inject({
      method: 'GET',
      url: '/health'
    })
    
    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveProperty('code', 200)
    expect(json).toHaveProperty('message', '操作成功')
    expect(json).toHaveProperty('data')
    expect(json.data).toHaveProperty('status', 'ok')
    expect(json).toHaveProperty('timestamp')
  })

  it('2. 成功列表与分页 (Pagination)', async () => {
    // /api/v1/agents with pagination, requires headers
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?current=1&pageSize=10',
      headers: {
        'X-Request-ID': 'test-req-id',
        'X-Client-Version': '1.0.0'
      }
    })
    
    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveProperty('code', 200)
    expect(json).toHaveProperty('message', '查询成功')
    expect(Array.isArray(json.data)).toBe(true)
    expect(json).toHaveProperty('pagination')
    expect(json.pagination).toHaveProperty('current', 1)
    expect(json.pagination).toHaveProperty('pageSize', 10)
  })

  it('3. 成功列表不带分页 (List without Pagination)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents',
      headers: {
        'X-Request-ID': 'test-req-id',
        'X-Client-Version': '1.0.0'
      }
    })
    
    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveProperty('code', 200)
    expect(json).toHaveProperty('message', '操作成功')
    expect(Array.isArray(json.data)).toBe(true)
    expect(json).not.toHaveProperty('pagination')
  })

  it('4. 缺少可选请求头时使用默认值仍返回标准响应', async () => {
    // The middleware intentionally supplies safe defaults for internal callers.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents'
    })
    
    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveProperty('code', 200)
    expect(Array.isArray(json.data)).toBe(true)
  })

  it('6. 测试 openapi.json 获取', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json'
    })
    
    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json.openapi).toBe('3.0.0')
    expect(json.info.title).toBe('Aether Engine API')
  })
})

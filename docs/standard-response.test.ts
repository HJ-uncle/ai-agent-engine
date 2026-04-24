import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildServer } from '../src/api/http/server.js'

// Setup env to avoid rejecting unauth immediately if we want
process.env.AUTH_ENABLED = 'false'

// Mock internal stores if needed, or we just test the middleware and standard response logic on simple endpoints.
describe('Standard API Responses', () => {
  let app: any

  beforeEach(async () => {
    app = await buildServer()
  })

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

  it.skip('4. 参数验证失败 (Header missing -> Fail Response)', async () => {
    // No headers
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents'
    })
    
    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveProperty('code', 40001)
    expect(json.message).toMatch(/X-Request-ID不能为空/)
    expect(json).toHaveProperty('data', null)
  })

  it('6. 测试 openapi.json 获取', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json'
    })
    
    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json.openapi).toBe('3.0.0')
    expect(json.info.title).toBe('AI Agent Engine API')
  })
})

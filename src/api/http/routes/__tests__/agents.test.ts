import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { agentRoutes } from '../agents.js'

// Mock SQLiteAgentStore
const mockAgentStore = {
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  delete: vi.fn()
}

vi.mock('../../../../storage/agent/index.js', () => {
  return {
    SQLiteAgentStore: vi.fn(() => mockAgentStore)
  }
})

describe('Agent Routes', () => {
  let fastify: ReturnType<typeof Fastify>

  beforeEach(async () => {
    vi.clearAllMocks()
    fastify = Fastify()

    fastify.addHook('onRequest', async (request: any) => {
      request.authContext = { tenantId: 'tenant-1' }
    })

    await fastify.register(agentRoutes, { prefix: '/api/v1' })
  })

  it('POST /api/v1/agents creates a new agent', async () => {
    const input = { name: 'Test Agent', model: 'gpt-4o' }
    const createdAgent = { id: 'agent-1', tenantId: 'tenant-1', ...input, skills: [], mcpServers: [], knowledgeBases: [], createdAt: 123, updatedAt: 123 }
    mockAgentStore.create.mockResolvedValue(createdAgent)

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: input
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual(createdAgent)
    expect(mockAgentStore.create).toHaveBeenCalledWith('tenant-1', expect.objectContaining(input))
  })

  it('POST /api/v1/agents fails without name', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { model: 'gpt-4o' }
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'name is required' })
  })

  it('GET /api/v1/agents lists all agents', async () => {
    const agents = [{ id: 'agent-1', name: 'Test' }]
    mockAgentStore.list.mockResolvedValue(agents)

    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/agents'
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ agents })
    expect(mockAgentStore.list).toHaveBeenCalledWith('tenant-1')
  })

  it('GET /api/v1/agents/:id returns an agent', async () => {
    const agent = { id: 'agent-1', name: 'Test' }
    mockAgentStore.getById.mockResolvedValue(agent)

    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/agents/agent-1'
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(agent)
    expect(mockAgentStore.getById).toHaveBeenCalledWith('agent-1', 'tenant-1')
  })

  it('PUT /api/v1/agents/:id updates an agent', async () => {
    const updatedAgent = { id: 'agent-1', name: 'Updated Name' }
    mockAgentStore.update.mockResolvedValue(updatedAgent)

    const res = await fastify.inject({
      method: 'PUT',
      url: '/api/v1/agents/agent-1',
      payload: { name: 'Updated Name' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(updatedAgent)
    expect(mockAgentStore.update).toHaveBeenCalledWith('agent-1', 'tenant-1', { name: 'Updated Name' })
  })

  it('DELETE /api/v1/agents/:id deletes an agent', async () => {
    mockAgentStore.delete.mockResolvedValue(true)

    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/v1/agents/agent-1'
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true, id: 'agent-1' })
    expect(mockAgentStore.delete).toHaveBeenCalledWith('agent-1', 'tenant-1')
  })
})

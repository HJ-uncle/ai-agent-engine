// Real Fastify routes and header parsing; factory/agent storage are isolated to avoid MCP discovery or database writes.
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryFactoryOptions } from '../../../../tools/registry-factory.js'
import { toolRoutes } from '../tools.js'
import { getRequestToolProfile } from '../../tool-profile.js'

const fixtures = vi.hoisted(() => ({ factory: vi.fn(), getAgent: vi.fn() }))
vi.mock('../../../../tools/registry-factory.js', () => ({ createToolRegistry: fixtures.factory }))
vi.mock('../../../../skills/index.js', () => ({ skillsRegistry: { getSkills: () => [] } }))
vi.mock('../../../../storage/agent/index.js', () => ({
  SQLiteAgentStore: class { getById(...args: unknown[]) { return fixtures.getAgent(...args) } },
}))

let app: FastifyInstance
beforeEach(async () => {
  fixtures.factory.mockReset()
  fixtures.getAgent.mockReset().mockResolvedValue(null)
  fixtures.factory.mockImplementation(async (options: RegistryFactoryOptions) => {
    const names = options.toolProfile === 'code' ? ['read_file', 'list_skills'] : ['read_file', 'agent_list', 'list_skills']
    return { registry: { list: () => names.map((name) => ({ name, description: name, parameters: { type: 'object' }, source: name === 'list_skills' ? 'skill' : undefined })) }, externalSkills: [], toolCategories: {} }
  })
  app = Fastify()
  await app.register(toolRoutes)
})
afterEach(async () => { await app.close() })

describe.each(['/tools', '/system-tools'])('%s tool-profile routing', (endpoint) => {
  it('keeps headerless clients in general even when the query asks for code', async () => {
    const response = await app.inject({ method: 'GET', url: `${endpoint}?toolProfile=code` })
    expect(response.statusCode).toBe(200)
    expect(fixtures.factory).toHaveBeenCalledWith({ toolProfile: 'general', allowedTools: null, allowedSkills: null })
    expect(response.json().data.map((tool: { name: string }) => tool.name)).toContain('agent_list')
  })

  it('passes the code header to the factory and returns its effective list', async () => {
    const response = await app.inject({ method: 'GET', url: endpoint, headers: { 'X-Aether-Tool-Profile': 'code' } })
    expect(response.statusCode).toBe(200)
    expect(fixtures.factory).toHaveBeenCalledWith({ toolProfile: 'code', allowedTools: null, allowedSkills: null })
    expect(response.json().data.map((tool: { name: string }) => tool.name)).toEqual(endpoint === '/tools' ? ['read_file', 'list_skills'] : ['read_file'])
  })

  it('accepts explicit general without retaining the preceding code request profile', async () => {
    await app.inject({ method: 'GET', url: endpoint, headers: { 'x-aether-tool-profile': 'code' } })
    const response = await app.inject({ method: 'GET', url: endpoint, headers: { 'x-aether-tool-profile': 'general' } })
    expect(response.statusCode).toBe(200)
    expect(fixtures.factory).toHaveBeenLastCalledWith({ toolProfile: 'general', allowedTools: null, allowedSkills: null })
    expect(response.json().data.map((tool: { name: string }) => tool.name)).toContain('agent_list')
  })

  it.each(['unknown', 'CODE', 'code,general'])('rejects invalid header %s before touching the factory or agent store', async (profile) => {
    const response = await app.inject({ method: 'GET', url: `${endpoint}?agentId=fixture&toolProfile=code`, headers: { 'x-aether-tool-profile': profile } })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toBe('X-Aether-Tool-Profile must be code or general')
    expect(fixtures.factory).not.toHaveBeenCalled()
    expect(fixtures.getAgent).not.toHaveBeenCalled()
  })

  it('does not let query or stored agent settings replace the code header', async () => {
    fixtures.getAgent.mockResolvedValue({ allowedTools: ['agent_list', 'read_file'], skills: ['fixture-skill'], toolProfile: 'general' })
    const response = await app.inject({ method: 'GET', url: `${endpoint}?agentId=fixture&toolProfile=general&profile=general`, headers: { 'x-aether-tool-profile': 'code' } })
    expect(response.statusCode).toBe(200)
    expect(fixtures.factory).toHaveBeenCalledWith({ toolProfile: 'code', allowedTools: ['agent_list', 'read_file'], allowedSkills: ['fixture-skill'] })
    expect(response.json().data.map((tool: { name: string }) => tool.name)).not.toContain('agent_list')
  })
})

describe('profile header authority', () => {
  it('ignores body and query profile fields instead of upgrading the header selection', () => {
    const request = { headers: { 'x-aether-tool-profile': 'code' }, body: { toolProfile: 'general', profile: 'general' }, query: { toolProfile: 'general' } }
    expect(getRequestToolProfile(request)).toBe('code')
    expect(getRequestToolProfile({ ...request, headers: {} })).toBe('general')
  })

  it('rejects repeated header values rather than guessing which profile wins', () => {
    expect(() => getRequestToolProfile({ headers: { 'x-aether-tool-profile': ['code', 'general'] } })).toThrow('X-Aether-Tool-Profile must be code or general')
  })
})

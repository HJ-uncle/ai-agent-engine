// Covers HTTP defaults and the policy used by commands, including configured and tenant-local overrides.
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { securityRoutes } from '../security.js'
import { clearSecurityMode, getSecurityMode, policyEngine, setSecurityMode } from '../../../../security/policy-engine.js'
import { closeDb, initDb } from '../../../../storage/sqlite/db.js'

describe('security mode defaults', () => {
  const sessionId = 'security-default-fixture'
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => { await initDb() })
  afterAll(() => { closeDb() })
  beforeEach(async () => {
    vi.stubEnv('DEFAULT_SECURITY_MODE', undefined)
    app = Fastify()
    await app.register(securityRoutes)
    await app.ready()
  })
  afterEach(async () => {
    await app.close()
    clearSecurityMode('default', sessionId)
    clearSecurityMode('another-tenant', sessionId)
    vi.unstubAllEnvs()
  })

  async function readMode() {
    const response = await app.inject({ method: 'GET', url: `/security/mode?sessionId=${sessionId}` })
    expect(response.statusCode).toBe(200)
    return response.json().data.mode
  }

  it('uses standard in both the API and runtime when no default was configured', async () => {
    expect(await readMode()).toBe('standard')
    expect(getSecurityMode('default', sessionId)).toBe('standard')
    const normal = await policyEngine.evaluate({ tenantId: 'default', sessionId, command: 'aether-fixture-command', args: [] })
    expect(normal.action).toBe('allow')
    const hardBoundary = await policyEngine.evaluate({ tenantId: 'default', sessionId, command: 'rm', args: ['fixture.txt'] })
    expect(hardBoundary.action).toBe('deny')
  })

  it.each(['safe', 'standard', 'full-access'] as const)('keeps an explicitly configured %s default', async mode => {
    vi.stubEnv('DEFAULT_SECURITY_MODE', mode)
    expect(await readMode()).toBe(mode)
    expect(getSecurityMode('default', sessionId)).toBe(mode)
  })

  it.each(['', 'standrad', 'STANDARD'])('fails closed for malformed explicit configuration %j', async value => {
    vi.stubEnv('DEFAULT_SECURITY_MODE', value)
    expect(await readMode()).toBe('safe')
    const unknown = await policyEngine.evaluate({ tenantId: 'default', sessionId, command: 'aether-fixture-command', args: [] })
    expect(unknown.action).toBe('ask')
  })

  it.each(['safe', 'standard', 'full-access'] as const)('keeps an explicit session %s choice scoped to its tenant', async mode => {
    setSecurityMode('default', sessionId, mode)
    expect(await readMode()).toBe(mode)
    expect(getSecurityMode('another-tenant', sessionId)).toBe('standard')
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'safe')
    expect(await readMode()).toBe(mode)
    expect(getSecurityMode('another-tenant', sessionId)).toBe('safe')
  })
})

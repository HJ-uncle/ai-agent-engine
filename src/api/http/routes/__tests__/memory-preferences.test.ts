/** Tenant defaults, nullable session overrides, legacy privacy, capability refusals and persistence. */
import Fastify, { type FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { memoryRoutes } from '../memory.js'
import { authMiddlewareHook, configureRequestAuthentication } from '../../middleware.js'
import { closeMemoryDb, getMemoryDb, initMemoryDb } from '../../../../storage/memory/db.js'
import { MEMORY_SCHEMA } from '../../../../storage/memory/schema.js'
import { getMemoryPreferences, getSessionMemorySettings, setMemoryPreferences, setSessionMemoryEnabled, setSessionMemoryScope } from '../../../../storage/memory/settings.js'

let app: FastifyInstance
const secret = 'memory-preferences-route-fixture-secret'
const tokens: Record<string, string> = {}
async function token(tenantId: string, roles: string[]) {
  return new SignJWT({ tenantId, roles }).setProtectedHeader({ alg: 'HS256' }).setSubject(`${tenantId}-user`)
    .setExpirationTime('10m').sign(new TextEncoder().encode(secret))
}
const headers = (who = 'a') => ({ authorization: `Bearer ${tokens[who]}` })
const prefs = (who = 'a') => app.inject({ url: '/memory/preferences', headers: headers(who) })
const changePrefs = (payload: object, who = 'a') => app.inject({ method: 'PUT', url: '/memory/preferences', headers: headers(who), payload })
const settings = (sessionId = 'session', who = 'a') => app.inject({ url: `/memory/settings?sessionId=${sessionId}`, headers: headers(who) })
const changeSession = (sessionEnabled: unknown, sessionId = 'session', who = 'a') => app.inject({ method: 'PUT', url: '/memory/settings', headers: headers(who), payload: { sessionId, sessionEnabled } })

beforeAll(async () => {
  vi.stubEnv('AUTH_ENABLED', 'true'); vi.stubEnv('JWT_SECRET', secret); vi.stubEnv('AETHER_INSTANCE_TOKEN', undefined)
  tokens.a = await token('tenant-a', ['tenant-admin']); tokens.b = await token('tenant-b', ['tenant-admin'])
  tokens.viewer = await token('tenant-a', []); tokens.admin = await token('tenant-a', ['admin'])
  configureRequestAuthentication()
  await initMemoryDb(MEMORY_SCHEMA)
  app = Fastify(); app.addHook('onRequest', authMiddlewareHook); await app.register(memoryRoutes)
})
afterEach(async () => {
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', undefined)
  await getMemoryDb().batch(['DELETE FROM memory_preferences', 'DELETE FROM memory_session_preferences', 'DELETE FROM memory_session_settings'], 'write')
})
afterAll(async () => { await app?.close(); await closeMemoryDb(); vi.unstubAllEnvs() })

describe('independent memory defaults and session inheritance', () => {
  it('defaults global memory off and session memory on for both Work and Code', async () => {
    expect((await prefs()).json().data).toEqual({ globalEnabled: false, sessionDefaultEnabled: true, enabled: true })
    for (const profile of ['general', 'code']) {
      const response = await app.inject({ url: `/memory/settings?sessionId=${profile}`, headers: { ...headers(), 'x-aether-tool-profile': profile } })
      expect(response.json().data).toMatchObject({ sessionOverride: null, sessionEnabled: true, globalEnabled: false,
        sessionDefaultEnabled: true, effectiveScopes: ['session'], effectiveScope: 'session' })
    }
  })
  it('can enable global and session memory together without an exclusive scope selector', async () => {
    expect((await changePrefs({ globalEnabled: true })).statusCode).toBe(200)
    expect((await settings()).json().data).toMatchObject({ globalEnabled: true, sessionEnabled: true, effectiveScopes: ['global', 'session'] })
    await changeSession(false)
    expect((await settings()).json().data).toMatchObject({ globalEnabled: true, sessionOverride: false, sessionEnabled: false, effectiveScopes: ['global'] })
  })
  it('applies changed defaults to inherited sessions and lets explicit choices override them', async () => {
    await changeSession(true, 'explicit-on'); await changeSession(false, 'explicit-off')
    await changePrefs({ sessionDefaultEnabled: false })
    expect((await settings('inherited')).json().data).toMatchObject({ sessionOverride: null, sessionEnabled: false, effectiveScopes: [] })
    expect((await settings('explicit-on')).json().data).toMatchObject({ sessionOverride: true, sessionEnabled: true, effectiveScopes: ['session'] })
    await changePrefs({ sessionDefaultEnabled: true })
    expect((await settings('explicit-off')).json().data).toMatchObject({ sessionOverride: false, sessionEnabled: false, effectiveScopes: [] })
  })
  it('resets a session to inheritance with null and follows future changes', async () => {
    await changeSession(false)
    expect((await changeSession(null)).json().data).toMatchObject({ sessionOverride: null, sessionEnabled: true })
    await changePrefs({ sessionDefaultEnabled: false })
    expect((await settings()).json().data).toMatchObject({ sessionOverride: null, sessionEnabled: false })
    await changePrefs({ sessionDefaultEnabled: true })
    expect((await settings()).json().data).toMatchObject({ sessionOverride: null, sessionEnabled: true })
  })
  it('keeps tenant defaults and equal-named session overrides isolated', async () => {
    await changePrefs({ globalEnabled: true, sessionDefaultEnabled: false })
    await changeSession(true)
    expect((await prefs('b')).json().data).toMatchObject({ globalEnabled: false, sessionDefaultEnabled: true })
    expect((await settings('session', 'b')).json().data).toMatchObject({ sessionOverride: null, globalEnabled: false, effectiveScopes: ['session'] })
    expect((await settings()).json().data).toMatchObject({ sessionOverride: true, globalEnabled: true, effectiveScopes: ['global', 'session'] })
  })
  it('requires a tenant or instance administrator to edit defaults', async () => {
    const denied = await changePrefs({ globalEnabled: true }, 'viewer')
    expect(denied.json().code).toBe(41015)
    expect((await prefs()).json().data.globalEnabled).toBe(false)
    expect((await changePrefs({ globalEnabled: true }, 'admin')).json().data.globalEnabled).toBe(true)
  })
  it('does not lose independent settings updates arriving together', async () => {
    await Promise.all([setMemoryPreferences('tenant-a', { globalEnabled: true }), setMemoryPreferences('tenant-a', { sessionDefaultEnabled: false })])
    expect(await getMemoryPreferences('tenant-a')).toMatchObject({ globalEnabled: true, sessionDefaultEnabled: false })
  })
  it('persists defaults and explicit/inherited choices across reopening the memory database', async () => {
    await changePrefs({ globalEnabled: true, sessionDefaultEnabled: false }); await changeSession(true, 'explicit'); await changeSession(null, 'inherit')
    await closeMemoryDb()
    expect((await prefs()).json().data).toMatchObject({ globalEnabled: true, sessionDefaultEnabled: false })
    expect((await settings('explicit')).json().data).toMatchObject({ sessionOverride: true, effectiveScopes: ['global', 'session'] })
    expect((await settings('inherit')).json().data).toMatchObject({ sessionOverride: null, effectiveScopes: ['global'] })
  })
  it.each(['global', 'session', 'off'] as const)('reads legacy %s choices without silently enabling tenant-global memory', async scope => {
    await getMemoryDb().execute({ sql: 'INSERT INTO memory_session_settings(tenant_id, session_id, scope) VALUES(?,?,?)', args: ['tenant-a', 'legacy', scope] })
    const result = await getSessionMemorySettings('tenant-a', 'legacy')
    expect(result.memoryScope).toBe(scope)
    expect(result.globalEnabled).toBe(false)
    expect(result.sessionOverride).toBe(scope === 'global' ? null : scope === 'session')
    expect(result.effectiveScopes).toEqual(scope === 'off' ? [] : ['session'])
    await setSessionMemoryEnabled('tenant-a', 'legacy', null)
    expect((await getSessionMemorySettings('tenant-a', 'legacy')).sessionOverride).toBe(null)
  })
  it('keeps the old setter as compatibility only and does not enable global sharing', async () => {
    await setSessionMemoryScope('tenant-a', 'legacy-api', 'global')
    expect(await getSessionMemorySettings('tenant-a', 'legacy-api')).toMatchObject({ memoryScope: 'global', globalEnabled: false, sessionOverride: null, effectiveScopes: ['session'] })
  })
})

describe('disabled server capability retains preferences and reports actionable Chinese refusals', () => {
  it('reports known disabled capability while retaining both enabled preferences', async () => {
    await changePrefs({ globalEnabled: true }); await changeSession(true)
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    expect((await prefs()).json().data).toMatchObject({ globalEnabled: true, sessionDefaultEnabled: true, enabled: false })
    expect((await settings()).json().data).toMatchObject({ sessionOverride: true, sessionEnabled: true, globalEnabled: true, enabled: false, effectiveScopes: [], effectiveScope: 'off' })
  })
  it('rejects global enable without mutating preferences and exposes a stable reason', async () => {
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    const response = await changePrefs({ globalEnabled: true })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 40900, message: '服务端已关闭长期记忆，请在服务端启用后重试。', data: { reason: 'MEMORY_DISABLED_BY_SERVER', globalEnabled: false, enabled: false } })
    expect((await prefs()).json().data.globalEnabled).toBe(false)
  })
  it('rejects session enable, preserves the explicit disabled choice, and allows inherit/close', async () => {
    await changeSession(false)
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    const rejected = await changeSession(true)
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({ data: { reason: 'MEMORY_DISABLED_BY_SERVER', sessionId: 'session', sessionOverride: false, sessionEnabled: false, effectiveScopes: [] } })
    expect((await settings()).json().data.sessionOverride).toBe(false)
    expect((await changeSession(null)).json().data).toMatchObject({ sessionOverride: null, sessionEnabled: true, effectiveScopes: [] })
    expect((await changeSession(false)).json().data).toMatchObject({ sessionOverride: false, effectiveScopes: [] })
  })
  it('allows disabling global and changing future-session defaults while the capability is disabled', async () => {
    await changePrefs({ globalEnabled: true })
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    expect((await changePrefs({ globalEnabled: false, sessionDefaultEnabled: false })).json().data).toMatchObject({ globalEnabled: false, sessionDefaultEnabled: false, enabled: false })
    expect((await changePrefs({ sessionDefaultEnabled: true })).json().data.sessionDefaultEnabled).toBe(true)
    expect(process.env.ENABLE_LONG_TERM_MEMORY).toBe('false')
  })
  it('retains legacy refusal status and does not overwrite a saved legacy scope', async () => {
    await setSessionMemoryScope('tenant-a', 'old', 'session')
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    const response = await app.inject({ method: 'PUT', url: '/memory/settings', headers: headers(), payload: { sessionId: 'old', memoryScope: 'global' } })
    expect(response.statusCode).toBe(409)
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', undefined)
    expect((await settings('old')).json().data).toMatchObject({ memoryScope: 'session', sessionOverride: true, effectiveScopes: ['session'] })
  })
})

describe('memory settings input validation', () => {
  it.each([{}, { globalEnabled: 'true' }, { sessionDefaultEnabled: 0 }, { globalEnabled: null }, { tenantId: 'tenant-b', globalEnabled: true }, []])('rejects malformed or identity-confusing preference patches %j', async payload => {
    expect((await changePrefs(payload)).statusCode).toBe(400)
    expect((await prefs()).json().data.globalEnabled).toBe(false)
  })
  it.each(['true', 1, {}, []])('rejects malformed session overrides %j', async value => {
    expect((await changeSession(value)).statusCode).toBe(400)
    expect((await settings()).json().data.sessionOverride).toBe(null)
  })
  it('rejects conflicting legacy and independent fields', async () => {
    const response = await app.inject({ method: 'PUT', url: '/memory/settings', headers: headers(), payload: { sessionId: 'session', sessionEnabled: false, memoryScope: 'global' } })
    expect(response.statusCode).toBe(400)
  })
})

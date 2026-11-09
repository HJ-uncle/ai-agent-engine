/** Missing policy must not grant memory; explicit opt-in stays available. */
import { afterEach, expect, it, vi } from 'vitest'
import { effectiveMemoryScopes, memoryContexts, memoryWriteScope } from '../policy.js'
import { defaultMemoryMode } from '../../../storage/memory/settings.js'

afterEach(() => vi.unstubAllEnvs())
it.each([undefined, 'general', 'code'] as const)('defaults %s to no memory even when the server supports memory', profile => {
  for (const flag of [undefined, 'true']) {
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', flag)
    expect(defaultMemoryMode(profile)).toBe('off')
    expect(effectiveMemoryScopes({ toolProfile: profile })).toEqual([])
    expect(memoryContexts({ toolProfile: profile, tenantId: 'fixture', sessionId: 'session' })).toEqual([])
    expect(memoryWriteScope({ toolProfile: profile })).toBeUndefined()
  }
})
it('explicit scopes still work and an authoritative empty selection remains closed', () => {
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', undefined)
  expect(effectiveMemoryScopes({ memoryScope: 'session' })).toEqual(['session'])
  expect(effectiveMemoryScopes({ memoryScope: 'global' })).toEqual(['global'])
  expect(effectiveMemoryScopes({ memoryScopes: ['global', 'session'] })).toEqual(['session', 'global'])
  expect(effectiveMemoryScopes({ memoryScopes: [], memoryScope: 'global' })).toEqual([])
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  expect(effectiveMemoryScopes({ memoryScopes: ['global', 'session'] })).toEqual([])
})

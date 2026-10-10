import { describe, expect, it } from 'vitest'
import { readEngineListenAddress, restoreEmbeddedProjectEnvironment } from '../server-listen.js'

describe('Engine listen environment', () => {
  it('keeps standalone defaults and legacy PORT/HOST deployments compatible', () => {
    expect(readEngineListenAddress({})).toEqual({ port: 12323, host: '0.0.0.0' })
    expect(readEngineListenAddress({ PORT: '12500', HOST: '127.0.0.1' }))
      .toEqual({ port: 12500, host: '127.0.0.1' })
  })

  it('uses the embedded listener without replacing project server variables', () => {
    const env = { PORT: '8765', HOST: '0.0.0.0', AETHER_ENGINE_PORT: '12400', AETHER_ENGINE_HOST: '127.0.0.1' }
    expect(readEngineListenAddress(env)).toEqual({ port: 12400, host: '127.0.0.1' })
    expect(env.PORT).toBe('8765')
    expect(env.HOST).toBe('0.0.0.0')
  })

  it('falls back independently when only one dedicated listener variable is set', () => {
    expect(readEngineListenAddress({ AETHER_ENGINE_PORT: '12400', HOST: '::' }))
      .toEqual({ port: 12400, host: '::' })
    expect(readEngineListenAddress({ PORT: '8765', AETHER_ENGINE_HOST: '127.0.0.1' }))
      .toEqual({ port: 8765, host: '127.0.0.1' })
  })

  it('consumes the bootstrap snapshot once and preserves the dedicated listener', () => {
    const env: NodeJS.ProcessEnv = {
      PORT: '12400', HOST: '127.0.0.1', AETHER_ENGINE_PORT: '12400', AETHER_ENGINE_HOST: '127.0.0.1',
      AETHER_ENGINE_PROJECT_ENV: JSON.stringify({ version: 1, PORT: '8765', HOST: '' }),
    }
    restoreEmbeddedProjectEnvironment(env)
    expect(env).toEqual({ PORT: '8765', HOST: '', AETHER_ENGINE_PORT: '12400', AETHER_ENGINE_HOST: '127.0.0.1' })
    expect(readEngineListenAddress(env)).toEqual({ port: 12400, host: '127.0.0.1' })
    env.PORT = '9000'
    restoreEmbeddedProjectEnvironment(env)
    expect(env.PORT).toBe('9000')
  })

  it('restores absence without changing standalone environment', () => {
    const env: NodeJS.ProcessEnv = {
      PORT: '12400', HOST: '127.0.0.1', AETHER_ENGINE_PORT: '12400', AETHER_ENGINE_HOST: '127.0.0.1',
      AETHER_ENGINE_PROJECT_ENV: JSON.stringify({ version: 1, PORT: null, HOST: null }),
    }
    restoreEmbeddedProjectEnvironment(env)
    expect(env).toEqual({ AETHER_ENGINE_PORT: '12400', AETHER_ENGINE_HOST: '127.0.0.1' })
    const standalone = { PORT: '9000', HOST: '::1' }
    restoreEmbeddedProjectEnvironment(standalone)
    expect(standalone).toEqual({ PORT: '9000', HOST: '::1' })
  })

  it.each(['{', 'null', '[]', '{}',
    JSON.stringify({ version: 2, PORT: null, HOST: null }),
    JSON.stringify({ version: 1, PORT: 9000, HOST: null }),
    JSON.stringify({ version: 1, PORT: null }),
  ])('rejects malformed bootstrap state atomically: %s', encoded => {
    const env = { PORT: '12400', HOST: '127.0.0.1', AETHER_ENGINE_PORT: '12400', AETHER_ENGINE_HOST: '127.0.0.1', AETHER_ENGINE_PROJECT_ENV: encoded }
    const original = { ...env }
    expect(() => restoreEmbeddedProjectEnvironment(env)).toThrow('Invalid embedded engine project environment snapshot')
    expect(env).toEqual(original)
  })

  it('does not consume a snapshot without a dedicated listener', () => {
    const env = { PORT: '12400', HOST: '127.0.0.1', AETHER_ENGINE_PROJECT_ENV: JSON.stringify({ version: 1, PORT: null, HOST: null }) }
    const original = { ...env }
    expect(() => restoreEmbeddedProjectEnvironment(env)).toThrow('Invalid embedded engine project environment snapshot')
    expect(env).toEqual(original)
  })
})

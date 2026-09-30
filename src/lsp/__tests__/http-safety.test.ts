import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { diagnose, purge, resolveSafePath, init } = vi.hoisted(() => ({
  diagnose: vi.fn(async (filePath: string) => ({ status: 'completed', filePath, language: 'typescript', adapter: 'typescript', diagnostics: [], durationMs: 1, fromCache: false })),
  purge: vi.fn(async () => 0),
  resolveSafePath: vi.fn((ctx: { workspacePaths?: string[] }, value: string) => {
    if (value.includes('..') || (ctx.workspacePaths?.[0] && !value.startsWith(ctx.workspacePaths[0]))) throw new Error('outside')
    return value
  }),
  init: vi.fn(),
}))
vi.mock('../index.js', () => ({ diagnoseFile: diagnose, listLspAdapters: vi.fn(async () => []), purgeLspCache: purge }))
vi.mock('../../workspace/index.js', () => ({ workspaceManager: { init, resolveSafePath } }))

import { lspRoutes } from '../../api/http/routes/lsp.js'

describe('D8 diagnostic HTTP input and workspace boundaries', () => {
  afterEach(() => vi.clearAllMocks())

  async function app() {
    const server = Fastify()
    server.decorateRequest('authContext', null)
    server.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: 'tenant-http' } }) })
    await server.register(lspRoutes)
    return server
  }

  it('passes a bound workspace path to the real diagnostic call and rejects traversal', async () => {
    const server = await app()
    try {
      const allowed = await server.inject({ method: 'POST', url: '/lsp/diagnose', payload: {
        filePath: 'src/main.ts', sessionId: 'session-http', workspacePaths: ['src'], timeoutMs: 500,
      } })
      expect(allowed.json().code).toBe(200)
      expect(diagnose).toHaveBeenCalledWith('src/main.ts', expect.objectContaining({ sessionId: 'session-http', timeoutMs: 500 }))
      const escaped = await server.inject({ method: 'POST', url: '/lsp/diagnose', payload: {
        filePath: '../secret.ts', sessionId: 'session-http', workspacePaths: ['src'],
      } })
      expect(escaped.json()).toMatchObject({ code: 40300 })
      expect(diagnose).toHaveBeenCalledTimes(1)
    } finally { await server.close() }
  })

  it('rejects malformed timeout and cache retention inputs before work', async () => {
    const server = await app()
    try {
      const timeout = await server.inject({ method: 'POST', url: '/lsp/diagnose', payload: { filePath: 'x.ts', timeoutMs: 'fast' } })
      expect(timeout.json()).toMatchObject({ code: 40000 })
      const days = await server.inject({ method: 'DELETE', url: '/lsp/cache?days=abc' })
      expect(days.json()).toMatchObject({ code: 40000 })
      expect(diagnose).not.toHaveBeenCalled()
      expect(purge).not.toHaveBeenCalled()
    } finally { await server.close() }
  })
})

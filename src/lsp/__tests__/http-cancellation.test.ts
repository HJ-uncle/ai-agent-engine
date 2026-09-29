import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lspRoutes } from '../../api/http/routes/lsp.js'

const { diagnose } = vi.hoisted(() => ({ diagnose: vi.fn() }))
vi.mock('../index.js', () => ({ diagnoseFile: diagnose, listLspAdapters: vi.fn(), purgeLspCache: vi.fn() }))
vi.mock('../../workspace/index.js', () => ({ workspaceManager: { init: () => process.cwd() } }))
afterEach(() => { vi.clearAllMocks() })

describe('diagnostic HTTP cancellation', () => {
  it('aborts adapter work when the client disconnects before the response', async () => {
    const server = Fastify()
    await server.register(lspRoutes)
    const address = await server.listen({ host: '127.0.0.1', port: 0 })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let observedAbort!: () => void
    const aborted = new Promise<void>(resolve => { observedAbort = resolve })
    diagnose.mockImplementation(async (filePath, opts) => new Promise(resolve => {
      opts.signal.addEventListener('abort', () => {
        observedAbort()
        resolve({ status: 'cancelled', filePath, language: 'typescript', adapter: 'typescript', diagnostics: [], durationMs: 1, fromCache: false })
      }, { once: true })
      started()
    }))
    const client = new AbortController()
    try {
      const request = fetch(`${address}/lsp/diagnose`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath: 'example.ts', content: 'const x = 1' }), signal: client.signal,
      })
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      await ready
      client.abort()
      await rejected
      await aborted
      expect(diagnose.mock.calls[0][1].signal.aborted).toBe(true)
    } finally { client.abort(); await server.close() }
  })
})

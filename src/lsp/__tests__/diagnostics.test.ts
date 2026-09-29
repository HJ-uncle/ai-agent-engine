import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diagnoseFile } from '../index.js'
import { typescriptAdapter } from '../adapters/typescript.js'
import { eslintAdapter } from '../adapters/eslint.js'
import { getGlobalToolPool, setGlobalToolPoolLimit } from '../../core/utils/concurrency-pool.js'
import { lspDiagnoseTool } from '../../tools/lsp/lsp-tool.js'
import type { AgentContext } from '../../core/agent-context/index.js'

const { cache, execute } = vi.hoisted(() => ({ cache: new Map<string, any>(), execute: vi.fn() }))
vi.mock('../../storage/sqlite/db.js', () => ({ getDb: () => ({ execute }) }))
vi.mock('../../security/audit-log.js', () => ({ auditLogStore: { append: vi.fn(async () => {}) } }))
vi.mock('../../workspace/index.js', () => ({ workspaceManager: { getWorkingDirectory: () => process.cwd() } }))

beforeEach(() => {
  cache.clear()
  execute.mockReset().mockImplementation(async ({ sql, args }: { sql: string; args: any[] }) => {
    const key = JSON.stringify(args.slice(0, 2))
    if (sql.startsWith('SELECT')) return { rows: cache.has(key) ? [cache.get(key)] : [] }
    if (sql.startsWith('INSERT')) cache.set(key, { language: args[2], diagnostics: args[3] })
    return { rows: [] }
  })
  vi.spyOn(typescriptAdapter, 'isAvailable').mockResolvedValue(true)
  vi.spyOn(eslintAdapter, 'isAvailable').mockResolvedValue(false)
  vi.spyOn(typescriptAdapter, 'diagnose').mockResolvedValue([])
})
afterEach(() => { vi.restoreAllMocks(); setGlobalToolPoolLimit(8) })
const args = { filePath: 'example.ts', content: 'const x = 1', adapters: ['typescript'] }
const options = { content: args.content, adapters: args.adapters }

describe('diagnostic execution outcomes and concurrency', () => {
  it('finishes code_diagnose when every global tool slot is occupied by diagnostics', async () => {
    setGlobalToolPoolLimit(2)
    const pool = getGlobalToolPool()
    const controller = new AbortController()
    const context = { signal: controller.signal, sessionId: 'test' } as AgentContext
    try {
      const results = await Promise.all([pool(() => lspDiagnoseTool.execute(args, context)), pool(() => lspDiagnoseTool.execute(args, context))])
      expect(results.every(result => result.success && result.output.includes('诊断通过'))).toBe(true)
      expect(typescriptAdapter.diagnose).toHaveBeenCalledTimes(2)
    } finally { controller.abort() }
  }, 3000)

  it('cancels both active and queued diagnostics and releases slots for the next run', async () => {
    let active = 0
    vi.mocked(typescriptAdapter.diagnose).mockImplementation(async (_file, _content, signal) => new Promise((_resolve, reject) => {
      active++
      signal!.addEventListener('abort', () => { active--; reject(signal!.reason) }, { once: true })
    }))
    const controller = new AbortController()
    const pool = getGlobalToolPool()
    const pending = Array.from({ length: 8 }, () => pool(() => diagnoseFile('file.ts', { ...options, signal: controller.signal })))
    await vi.waitFor(() => expect(active).toBe(4))
    expect(pool.active).toBe(8)
    controller.abort()
    expect((await Promise.all(pending)).map(result => result.status)).toEqual(Array(8).fill('cancelled'))
    expect(active).toBe(0)
    expect(cache.size).toBe(0)
    vi.mocked(typescriptAdapter.diagnose).mockResolvedValue([])
    expect((await diagnoseFile('file.ts', options)).status).toBe('completed')
  })

  it('never reports unsupported files or unavailable adapters as a pass', async () => {
    const context = {} as AgentContext
    const unsupported = await lspDiagnoseTool.execute({ filePath: 'notes.unknown', content: '' }, context)
    expect(unsupported.success).toBe(false)
    expect(unsupported.output).not.toContain('诊断通过')
    vi.mocked(typescriptAdapter.isAvailable).mockResolvedValue(false)
    const unavailable = await diagnoseFile('file.ts', options)
    expect(unavailable.status).toBe('unsupported')
    expect(typescriptAdapter.diagnose).not.toHaveBeenCalled()
    expect(cache.size).toBe(0)
  })

  it('does not cache adapter failures or reuse an old success after the adapter disappears', async () => {
    vi.mocked(typescriptAdapter.diagnose).mockRejectedValueOnce(new Error('CLI crashed'))
    expect(await diagnoseFile('file.ts', options)).toMatchObject({ status: 'error', error: 'typescript: CLI crashed' })
    expect(cache.size).toBe(0)
    expect((await diagnoseFile('file.ts', options)).status).toBe('completed')
    expect(cache.size).toBe(1)
    vi.mocked(typescriptAdapter.isAvailable).mockResolvedValue(false)
    expect((await diagnoseFile('file.ts', options)).status).toBe('unsupported')
  })

  it('keys cache entries by adapter selection as well as content', async () => {
    await diagnoseFile('file.ts', options)
    vi.mocked(eslintAdapter.isAvailable).mockResolvedValue(true)
    vi.spyOn(eslintAdapter, 'diagnose').mockResolvedValue([{ severity: 'warning', line: 1, column: 1, message: 'lint', source: 'eslint' }])
    const result = await diagnoseFile('file.ts', { content: args.content })
    expect(result).toMatchObject({ status: 'completed', fromCache: false, adapter: 'typescript+eslint' })
    expect(result.diagnostics).toHaveLength(1)
    expect((await diagnoseFile('file.ts', { content: args.content })).fromCache).toBe(true)
  })

  it('returns cancelled before performing work for a pre-aborted request', async () => {
    const result = await diagnoseFile('file.ts', { ...options, signal: AbortSignal.abort() })
    expect(result.status).toBe('cancelled')
    expect(typescriptAdapter.isAvailable).not.toHaveBeenCalled()
    expect(cache.size).toBe(0)
  })
})

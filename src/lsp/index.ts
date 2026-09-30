import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../storage/sqlite/db.js'
import { createPool } from '../core/utils/concurrency-pool.js'
import { isAbortError, throwIfAborted } from '../core/utils/abort.js'
import { auditLogStore } from '../security/audit-log.js'
import type { Diagnostic, DiagnoseResult, LspAdapter } from './types.js'
import { typescriptAdapter } from './adapters/typescript.js'
import { eslintAdapter } from './adapters/eslint.js'

export * from './types.js'

const ADAPTERS = new Map<string, LspAdapter>([
  [typescriptAdapter.name, typescriptAdapter], [eslintAdapter.name, eslintAdapter],
])

// Tool dispatch already owns a global tool slot. A separate bounded pool also
// limits HTTP diagnostics without recursively acquiring that same tool pool.
const diagnosticPool = createPool(4)

export async function listLspAdapters(): Promise<Array<{ name: string; language: string; extensions: string[]; available: boolean }>> {
  return Promise.all([...ADAPTERS.values()].map(async a => ({
    name: a.name, language: a.language, extensions: a.extensions, available: await a.isAvailable(),
  })))
}

async function readCache(filePath: string, hash: string, adapter: string): Promise<DiagnoseResult | null> {
  try {
    const res = await getDb().execute({
      sql: 'SELECT language, diagnostics FROM lsp_diagnostics_cache WHERE file_path = ? AND content_hash = ?',
      args: [filePath, hash],
    })
    if (res.rows.length === 0) return null
    const row = res.rows[0]
    return {
      status: 'completed', filePath, language: row.language as string, adapter,
      diagnostics: JSON.parse(row.diagnostics as string) as Diagnostic[], durationMs: 0, fromCache: true,
    }
  } catch { return null }
}

async function writeCache(filePath: string, hash: string, language: string, diagnostics: Diagnostic[]): Promise<void> {
  try {
    await getDb().execute({
      sql: `INSERT INTO lsp_diagnostics_cache (file_path, content_hash, language, diagnostics)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(file_path, content_hash) DO UPDATE SET
              diagnostics = excluded.diagnostics, created_at = unixepoch()`,
      args: [filePath, hash, language, JSON.stringify(diagnostics)],
    })
  } catch { /* cache is optional */ }
}

export interface DiagnoseOptions {
  content?: string
  adapters?: string[]
  signal?: AbortSignal
  tenantId?: string
  sessionId?: string
  useCache?: boolean
  timeoutMs?: number
}

export async function diagnoseFile(filePath: string, opts: DiagnoseOptions = {}): Promise<DiagnoseResult> {
  const { useCache = true } = opts
  const controller = new AbortController()
  const signal = controller.signal
  const abort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', abort, { once: true })
  if (opts.signal?.aborted) abort()
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0 ? Math.min(opts.timeoutMs!, 120_000) : 30_000
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(`诊断请求超时 (${timeoutMs}ms)`), { code: 'LSP_TIMEOUT' })), timeoutMs)
  timer.unref()
  const started = Date.now()
  const ext = path.extname(filePath).toLowerCase()
  let language = ext.slice(1) || 'unknown'
  let adapter = 'none'
  const finish = (status: DiagnoseResult['status'], diagnostics: Diagnostic[] = [], error?: string): DiagnoseResult => ({
    status, filePath, language, adapter, diagnostics, error,
    durationMs: Date.now() - started, fromCache: false,
  })

  try {
    throwIfAborted(signal)
    const content = opts.content ?? fs.readFileSync(filePath, 'utf-8')
    const candidates = [...ADAPTERS.values()].filter(a => a.extensions.includes(ext) && (!opts.adapters || opts.adapters.includes(a.name)))
    if (!candidates.length) return finish('unsupported', [], '没有支持此文件和所选配置的诊断适配器')
    language = candidates[0].language

    // Availability is checked before cache lookup: a cached empty result must
    // not turn a missing adapter into a successful diagnostic run.
    const availability = await withCancellation(Promise.all(candidates.map(async a => ({ a, available: await a.isAvailable(filePath) }))), signal)
    throwIfAborted(signal)
    const available = availability.filter(r => r.available).map(r => r.a)
    adapter = available.map(a => a.name).join('+') || 'none'
    const missing = opts.adapters?.filter(name => !available.some(a => a.name === name)) ?? []
    if (!available.length || missing.length) {
      return finish('unsupported', [], missing.length ? `诊断适配器不可用: ${missing.join(', ')}` : '此文件的诊断适配器均不可用')
    }

    // Versioned and adapter-aware keys invalidate old cached false successes
    // and keep TypeScript-only results out of TypeScript+ESLint requests.
    const hash = tenantCachePrefix(opts.tenantId) + crypto.createHash('sha1').update(JSON.stringify(['lsp-v3', opts.sessionId, adapter, content])).digest('hex')
    if (useCache) {
      const cached = await readCache(filePath, hash, adapter)
      throwIfAborted(signal)
      if (cached) return cached
    }

    const settled = await Promise.allSettled(available.map(a => diagnosticPool(async () => {
      try {
        throwIfAborted(signal)
        const diagnostics = await a.diagnose(filePath, content, signal)
        throwIfAborted(signal)
        return { name: a.name, diagnostics, error: undefined as string | undefined }
      } catch (error) {
        if ((error as { code?: string })?.code === 'LSP_TERMINATION_FAILED') throw error
        if (isAbortError(error, signal)) throw error
        return { name: a.name, diagnostics: [] as Diagnostic[], error: `${a.name}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }, signal)))
    throwIfAborted(signal)
    const results = settled.map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    const diagnostics = results.flatMap(r => r.diagnostics)
    const errors = results.flatMap(r => r.error ? [r.error] : [])
    if (errors.length) return finish('error', diagnostics, errors.join('; '))
    if (useCache) await writeCache(filePath, hash, language, diagnostics)
    throwIfAborted(signal)
    await auditLogStore.append({
      tenantId: opts.tenantId, sessionId: opts.sessionId,
      category: 'lsp', target: filePath, decision: 'allow', reason: 'diagnosed',
      details: { adapters: results.map(r => ({ name: r.name, count: r.diagnostics.length })), total: diagnostics.length },
    })
    throwIfAborted(signal)
    return finish('completed', diagnostics)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'LSP_TERMINATION_FAILED' || (signal.reason as { code?: string })?.code === 'LSP_TIMEOUT') {
      return { ...finish('error', [], error instanceof Error ? error.message : String(error)), errorCode: code === 'LSP_TERMINATION_FAILED' ? code : 'LSP_TIMEOUT' }
    }
    return isAbortError(error, signal)
      ? finish('cancelled', [], '诊断已取消')
      : finish('error', [], error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', abort)
  }
}

function tenantCachePrefix(tenantId = 'default'): string {
  return crypto.createHash('sha256').update(tenantId).digest('hex') + ':'
}

function withCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('诊断已取消', 'AbortError')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export async function purgeLspCache(days: number, tenantId?: string): Promise<number> {
  if (!Number.isFinite(days) || days < 1 || days > 3650) throw new Error('days must be between 1 and 3650')
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400
  const res = await getDb().execute({ sql: 'DELETE FROM lsp_diagnostics_cache WHERE created_at < ? AND content_hash LIKE ?', args: [cutoff, tenantCachePrefix(tenantId) + '%'] })
  return Number((res as any).rowsAffected ?? 0)
}

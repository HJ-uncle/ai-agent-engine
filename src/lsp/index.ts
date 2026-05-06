import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../storage/sqlite/db.js'
import { getGlobalToolPool } from '../core/utils/concurrency-pool.js'
import { auditLogStore } from '../security/audit-log.js'
import type { Diagnostic, DiagnoseResult, LspAdapter } from './types.js'
import { typescriptAdapter } from './adapters/typescript.js'
import { eslintAdapter } from './adapters/eslint.js'

export * from './types.js'

// ─── Registry ───────────────────────────────────────────────────────────
const ADAPTERS = new Map<string, LspAdapter>()
function register(a: LspAdapter) { ADAPTERS.set(a.name, a) }
register(typescriptAdapter)
register(eslintAdapter)

/** 根据扩展名筛选可用 adapter */
function adaptersForFile(filePath: string): LspAdapter[] {
  const ext = path.extname(filePath).toLowerCase()
  return Array.from(ADAPTERS.values()).filter((a) => a.extensions.includes(ext))
}

/** 全量列出 adapters 及其可用性（供前端设置页展示） */
export async function listLspAdapters(): Promise<Array<{ name: string; language: string; extensions: string[]; available: boolean }>> {
  const out: Array<{ name: string; language: string; extensions: string[]; available: boolean }> = []
  for (const a of ADAPTERS.values()) {
    out.push({ name: a.name, language: a.language, extensions: a.extensions, available: await a.isAvailable() })
  }
  return out
}

// ─── 缓存 ────────────────────────────────────────────────────────────────
function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex')
}

async function readCache(filePath: string, hash: string): Promise<DiagnoseResult | null> {
  try {
    const db = getDb()
    const res = await db.execute({
      sql: `SELECT language, diagnostics, created_at
            FROM lsp_diagnostics_cache
            WHERE file_path = ? AND content_hash = ?`,
      args: [filePath, hash],
    })
    if (res.rows.length === 0) return null
    const row = res.rows[0]
    return {
      filePath,
      language: row.language as string,
      adapter: 'cache',
      diagnostics: JSON.parse(row.diagnostics as string) as Diagnostic[],
      durationMs: 0,
      fromCache: true,
    }
  } catch {
    return null
  }
}

async function writeCache(filePath: string, hash: string, language: string, diagnostics: Diagnostic[]): Promise<void> {
  try {
    const db = getDb()
    await db.execute({
      sql: `INSERT INTO lsp_diagnostics_cache (file_path, content_hash, language, diagnostics)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(file_path, content_hash) DO UPDATE SET
              diagnostics = excluded.diagnostics,
              created_at = unixepoch()`,
      args: [filePath, hash, language, JSON.stringify(diagnostics)],
    })
  } catch { /* ignore */ }
}

// ─── 公共 API ────────────────────────────────────────────────────────────

export interface DiagnoseOptions {
  /** 若不传则从磁盘读取 */
  content?: string
  /** 指定只跑这些 adapter；不传则全跑 */
  adapters?: string[]
  signal?: AbortSignal
  tenantId?: string
  sessionId?: string
  /** 是否读写缓存（默认 true） */
  useCache?: boolean
}

/**
 * 对一个文件执行诊断。多 adapter 合并结果。
 */
export async function diagnoseFile(filePath: string, opts: DiagnoseOptions = {}): Promise<DiagnoseResult> {
  const { content, adapters, signal, useCache = true } = opts
  const t0 = Date.now()

  let actualContent: string
  if (content !== undefined) {
    actualContent = content
  } else {
    try {
      actualContent = fs.readFileSync(filePath, 'utf-8')
    } catch (e: any) {
      return {
        filePath,
        language: 'unknown',
        adapter: 'none',
        diagnostics: [{ severity: 'error', line: 1, column: 1, message: `无法读取文件: ${e.message}`, source: 'lsp' }],
        durationMs: Date.now() - t0,
        fromCache: false,
      }
    }
  }
  const hash = hashContent(actualContent)

  // 缓存优先
  if (useCache) {
    const cached = await readCache(filePath, hash)
    if (cached) {
      await auditLogStore.append({
        tenantId: opts.tenantId, sessionId: opts.sessionId,
        category: 'lsp', target: filePath, decision: 'allow',
        reason: 'cache-hit', details: { hash, count: cached.diagnostics.length },
      })
      return cached
    }
  }

  const candidates = adaptersForFile(filePath).filter((a) => !adapters || adapters.includes(a.name))
  if (candidates.length === 0) {
    return {
      filePath,
      language: path.extname(filePath).replace(/^\./, '') || 'unknown',
      adapter: 'none',
      diagnostics: [],
      durationMs: Date.now() - t0,
      fromCache: false,
    }
  }

  // 并行跑 adapters（经过全局池限流）
  const pool = getGlobalToolPool()
  const results = await Promise.all(
    candidates.map(async (a) => {
      if (!(await a.isAvailable())) return { a, diags: [] as Diagnostic[] }
      try {
        const diags = await pool(() => a.diagnose(filePath, content, signal))
        return { a, diags }
      } catch (e: any) {
        return { a, diags: [{ severity: 'error', line: 1, column: 1, message: `Adapter ${a.name} 失败: ${e.message}`, source: a.name } as Diagnostic] }
      }
    }),
  )

  const allDiags = results.flatMap((r) => r.diags)
  const language = candidates[0]?.language ?? 'unknown'
  if (useCache) await writeCache(filePath, hash, language, allDiags)

  await auditLogStore.append({
    tenantId: opts.tenantId, sessionId: opts.sessionId,
    category: 'lsp', target: filePath, decision: 'allow',
    reason: 'diagnosed',
    details: {
      adapters: results.map((r) => ({ name: r.a.name, count: r.diags.length })),
      total: allDiags.length,
    },
  })

  return {
    filePath,
    language,
    adapter: results.map((r) => r.a.name).join('+') || 'none',
    diagnostics: allDiags,
    durationMs: Date.now() - t0,
    fromCache: false,
  }
}

/**
 * 清理 N 天前的 LSP 缓存（维护用）
 */
export async function purgeLspCache(days: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400
  const db = getDb()
  const res = await db.execute({
    sql: 'DELETE FROM lsp_diagnostics_cache WHERE created_at < ?',
    args: [cutoff],
  })
  return Number((res as any).rowsAffected ?? 0)
}

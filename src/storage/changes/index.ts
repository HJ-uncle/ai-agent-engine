import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { Client, InValue } from '@libsql/client'
import { getDb } from '../sqlite/db.js'
import { rootRunStore } from '../root-runs/index.js'
import { canonicalFilePathSync, hashFileContent, readFileVersionSync, withFileLocks } from '../../shared/file-version.js'

export type ChangeKind = 'write' | 'delete'
export type ChangeStatus = 'pending' | 'kept' | 'reverted'

export interface FileChange {
  id: string
  /** Stable insertion order; timestamps are only for display and filtering. */
  seq: number
  tenantId: string
  sessionId: string
  turnId?: string
  runId?: string
  path: string
  kind: ChangeKind
  /** null means absent only when truncated is false and a hash is available. */
  oldContent: string | null
  newContent: string | null
  oldHash: string | null
  newHash: string | null
  truncated: boolean
  status: ChangeStatus
  createdAt: number
}

export interface RecordChangeInput {
  sessionId: string
  turnId?: string
  runId?: string
  path: string
  kind: ChangeKind
  oldContent: string | null
  newContent: string | null
  oldHash?: string | null
  newHash?: string | null
  truncated?: boolean
}

export interface RevertBatchInput {
  sessionId: string
  ids?: string[]
  createdAfter?: number
  scope?: 'pending' | 'all'
  fromTurnId?: string
}

export interface RevertResult {
  id: string
  path: string
  status: 'reverted' | 'already_reverted' | 'conflict' | 'unavailable' | 'failed'
  message?: string
  expectedHash?: string
  actualHash?: string
}

export interface RevertBatchResult {
  results: RevertResult[]
  total: number
  reverted: number
  conflicts: number
  unavailable: number
  failed: number
}

const MAX_CONTENT_CHARS = 100_000
const schemas = new WeakMap<Client, Promise<void>>()

function rowToChange(row: Record<string, unknown>): FileChange {
  return {
    id: String(row.id), seq: Number(row.seq), tenantId: String(row.tenant_id), sessionId: String(row.session_id),
    turnId: row.turn_id == null ? undefined : String(row.turn_id), runId: row.run_id == null ? undefined : String(row.run_id),
    path: String(row.path), kind: row.kind as ChangeKind,
    oldContent: row.old_content == null ? null : String(row.old_content),
    newContent: row.new_content == null ? null : String(row.new_content),
    oldHash: row.old_hash == null ? null : String(row.old_hash),
    newHash: row.new_hash == null ? null : String(row.new_hash),
    truncated: Number(row.truncated) === 1, status: row.status as ChangeStatus, createdAt: Number(row.created_at)
  }
}

function summarize(results: RevertResult[]): RevertBatchResult {
  return {
    results, total: results.length,
    reverted: results.filter(item => item.status === 'reverted').length,
    conflicts: results.filter(item => item.status === 'conflict').length,
    unavailable: results.filter(item => item.status === 'unavailable').length,
    failed: results.filter(item => item.status === 'failed').length
  }
}

export class ChangeStore {
  private get db() { return getDb() }

  private async ensureTable(): Promise<void> {
    const db = this.db
    let pending = schemas.get(db)
    if (!pending) {
      pending = (async () => {
        await db.execute(`CREATE TABLE IF NOT EXISTS file_changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, run_id TEXT,
          path TEXT NOT NULL, kind TEXT NOT NULL, old_content TEXT, new_content TEXT,
          old_hash TEXT, new_hash TEXT, truncated INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
        )`)
        const columns = new Set((await db.execute('PRAGMA table_info(file_changes)')).rows.map(row => String(row.name)))
        // Old development snapshots lack trustworthy byte versions: visible, but unavailable.
        if (!columns.has('seq')) {
          await db.execute('ALTER TABLE file_changes ADD COLUMN seq INTEGER')
          await db.execute('UPDATE file_changes SET seq=rowid WHERE seq IS NULL')
        }
        if (!columns.has('old_hash')) await db.execute('ALTER TABLE file_changes ADD COLUMN old_hash TEXT')
        if (!columns.has('new_hash')) await db.execute('ALTER TABLE file_changes ADD COLUMN new_hash TEXT')
        if (!columns.has('turn_id')) await db.execute('ALTER TABLE file_changes ADD COLUMN turn_id TEXT')
        if (!columns.has('run_id')) await db.execute('ALTER TABLE file_changes ADD COLUMN run_id TEXT')
        await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_file_changes_seq ON file_changes(seq)')
        await db.execute('CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(tenant_id, session_id, seq)')
      })()
      schemas.set(db, pending)
      pending.catch(() => { if (schemas.get(db) === pending) schemas.delete(db) })
    }
    await pending
  }

  /** Call inside the shared file lock, after the actual filesystem mutation succeeded. */
  async record(tenantId: string, input: RecordChangeInput): Promise<FileChange> {
    await this.ensureTable()
    const truncated = Boolean(input.truncated || (input.oldContent?.length ?? 0) > MAX_CONTENT_CHARS || (input.newContent?.length ?? 0) > MAX_CONTENT_CHARS)
    const oldHash = input.oldHash === undefined ? (input.truncated ? null : hashFileContent(input.oldContent)) : input.oldHash
    const newHash = input.newHash === undefined ? (input.truncated ? null : hashFileContent(input.newContent)) : input.newHash
    if (!truncated && (oldHash !== hashFileContent(input.oldContent) || newHash !== hashFileContent(input.newContent))) {
      throw new Error('File snapshot does not match the recorded byte version')
    }
    const result = await this.db.execute({
      // One SQL statement allocates order, including in old development tables.
      sql: `INSERT INTO file_changes (seq, id, tenant_id, session_id, turn_id, run_id, path, kind, old_content, new_content, old_hash, new_hash, truncated, status, created_at)
        SELECT COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ? FROM file_changes RETURNING *`,
      args: [uuidv4(), tenantId, input.sessionId, input.turnId ?? null, input.runId ?? null, canonicalFilePathSync(input.path), input.kind,
        (input.oldContent?.length ?? 0) > MAX_CONTENT_CHARS ? null : input.oldContent,
        (input.newContent?.length ?? 0) > MAX_CONTENT_CHARS ? null : input.newContent,
        oldHash, newHash, truncated ? 1 : 0, Date.now()]
    })
    return rowToChange(result.rows[0])
  }

  async getById(id: string, tenantId: string): Promise<FileChange | null> {
    await this.ensureTable()
    const result = await this.db.execute({ sql: 'SELECT * FROM file_changes WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    return result.rows[0] ? rowToChange(result.rows[0]) : null
  }

  /** Complete server-side scope; UI pagination must never define what "all" means. */
  async list(tenantId: string, sessionId: string, status?: ChangeStatus, createdAfter?: number): Promise<FileChange[]> {
    await this.ensureTable()
    let sql = 'SELECT * FROM file_changes WHERE tenant_id=? AND session_id=?'
    const args: InValue[] = [tenantId, sessionId]
    if (status) { sql += ' AND status=?'; args.push(status) }
    if (createdAfter !== undefined && Number.isFinite(createdAfter)) { sql += ' AND created_at > ?'; args.push(createdAfter) }
    sql += ' ORDER BY seq DESC'
    return (await this.db.execute({ sql, args })).rows.map(rowToChange)
  }

  async markStatus(id: string, tenantId: string, status: ChangeStatus): Promise<FileChange | null> {
    await this.ensureTable()
    await this.db.execute({ sql: `UPDATE file_changes SET status=? WHERE id=? AND tenant_id=? AND status!='reverted'`, args: [status, id, tenantId] })
    return this.getById(id, tenantId)
  }

  async keepAll(tenantId: string, sessionId: string): Promise<number> {
    await this.ensureTable()
    const result = await this.db.execute({
      sql: `UPDATE file_changes SET status='kept' WHERE tenant_id=? AND session_id=? AND status='pending'`, args: [tenantId, sessionId]
    })
    return result.rowsAffected ?? 0
  }

  async revertBatch(tenantId: string, input: RevertBatchInput): Promise<RevertBatchResult> {
    let turns: Set<string> | undefined
    if (input.fromTurnId !== undefined) {
      if (input.ids !== undefined || input.createdAfter !== undefined) throw Object.assign(new Error('fromTurnId 不能与 ids 或 createdAfter 混用'), { statusCode: 400 })
      const runs = await rootRunStore.list(tenantId, input.sessionId)
      const first = runs.find(run => run.turnId === input.fromTurnId)
      if (!first) throw Object.assign(new Error('当前会话中不存在该轮次，不能按时间猜测回退范围'), { statusCode: 400 })
      turns = new Set(runs.filter(run => run.seq >= first.seq).map(run => run.turnId))
    }
    const ids = input.ids === undefined ? undefined : [...new Set(input.ids)]
    let selected = ids === undefined
      ? await this.list(tenantId, input.sessionId, input.scope === 'all' ? undefined : 'pending', input.createdAfter)
      : await Promise.all(ids.map(id => this.getById(id, tenantId)))
    if (turns) selected = selected.filter(change => change?.turnId && turns!.has(change.turnId))
    const results: RevertResult[] = []
    const targets: FileChange[] = []
    selected.forEach((change, index) => {
      if (!change || change.sessionId !== input.sessionId) {
        results.push({ id: ids![index], path: '', status: 'unavailable', message: '改动不存在或不属于当前会话' })
      } else targets.push(change)
    })
    if (targets.length === 0) return summarize(results)
    try {
      await withFileLocks(targets.map(change => change.path), async (canonicalPaths) => {
        const ordered = targets.map((change, index) => ({ change, canonical: canonicalPaths[index] }))
          .sort((a, b) => a.canonical.localeCompare(b.canonical) || b.change.seq - a.change.seq)
        const blocked = new Set<string>()
        for (const target of ordered) {
          const { canonical } = target
          // Re-read after waiting: another request may already have reverted this change.
          const change = await this.getById(target.change.id, tenantId)
          const base = { id: target.change.id, path: target.change.path }
          if (!change || change.sessionId !== input.sessionId) {
            results.push({ ...base, status: 'unavailable', message: '改动不存在或不属于当前会话' })
            blocked.add(canonical)
            continue
          }
          if (change.status === 'reverted') { results.push({ ...base, status: 'already_reverted' }); continue }
          if (change.truncated || !change.oldHash || !change.newHash ||
            hashFileContent(change.oldContent) !== change.oldHash || hashFileContent(change.newContent) !== change.newHash) {
            results.push({ ...base, status: 'unavailable', message: '未保存可验证的完整文件快照，无法自动撤回' })
            blocked.add(canonical)
            continue
          }
          let fileMutationApplied = false
          try {
            // A matching hash alone is insufficient (A→B→B or A→B→A→B).
            // Any later live operation on this physical file must be reverted first,
            // including operations owned by another session/tenant; reveal no owner data.
            const later = await this.db.execute({
              sql: `SELECT 1 FROM file_changes WHERE path=? AND seq>? AND status!='reverted' LIMIT 1`,
              args: [change.path, change.seq]
            })
            const identity = path.resolve(change.path)
            const storedIdentity = process.platform === 'win32' ? identity.toLowerCase() : identity
            if (canonicalFilePathSync(change.path) !== canonical || storedIdentity !== canonical) {
              results.push({ ...base, status: 'conflict', message: '文件路径的实际目标已变化，未写入文件', expectedHash: change.newHash })
              blocked.add(canonical)
              continue
            }
            const current = readFileVersionSync(canonical)
            if (blocked.has(canonical) || later.rows.length > 0 || current.hash !== change.newHash) {
              results.push({ ...base, status: 'conflict', message: blocked.has(canonical) || later.rows.length > 0
                ? '该文件存在尚未撤回的较新改动，未覆盖后续版本'
                : '文件已被后续修改，当前版本与改动记录不一致', expectedHash: change.newHash, actualHash: current.hash })
              blocked.add(canonical)
              continue
            }
            // No await between byte verification and the synchronous write.
            if (change.oldContent === null) {
              if (current.content !== null) fs.unlinkSync(canonical)
            } else {
              fs.mkdirSync(path.dirname(canonical), { recursive: true })
              fs.writeFileSync(canonical, change.oldContent, 'utf8')
            }
            fileMutationApplied = true
            await this.markStatus(change.id, tenantId, 'reverted')
            results.push({ ...base, status: 'reverted' })
          } catch (error) {
            blocked.add(canonical)
            results.push({ ...base, status: 'failed', message: `${fileMutationApplied ? '文件已恢复，但改动状态保存失败' : '撤回失败'}：${error instanceof Error ? error.message : String(error)}` })
          }
        }
      })
    } catch (error) {
      for (const change of targets) {
        if (!results.some(item => item.id === change.id)) results.push({ id: change.id, path: change.path, status: 'failed', message: `无法锁定文件：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    return summarize(results)
  }
}

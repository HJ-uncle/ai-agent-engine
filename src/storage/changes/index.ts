import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { Client, InValue } from '@libsql/client'
import { getDb } from '../sqlite/db.js'
import { rootRunStore } from '../root-runs/index.js'
import { canonicalFilePathSync, hashFileContent, readFileVersionSync, withFileLocks } from '../../shared/file-version.js'
import { hasTrustedVersions, partitionChangeHistory, projectSegment, type NetFileChange, type ProjectionIssue } from './net-projection.js'
import { removeCreatedEmptyDirectories, type CreatedDirectory } from './directories.js'
import { CreatedDirectoryStore, type DirectoryChange, type DirectoryChangeInput } from './directory-store.js'

export type { NetFileChange, ProjectionIssue } from './net-projection.js'

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
  producerChildSessionId?: string
  producerRunId?: string
  path: string
  kind: ChangeKind
  /** Large/binary contents may be null while their exact bytes live in a snapshotRef. */
  oldContent: string | null
  newContent: string | null
  oldHash: string | null
  newHash: string | null
  oldSnapshotRef?: string
  newSnapshotRef?: string
  truncated: boolean
  status: ChangeStatus
  createdAt: number
  /** Observation is not proof that the command was the only writer. */
  source?: 'command-observation'
  commandJobId?: string
  requiresExplicitRevert?: boolean
  createdDirectories?: CreatedDirectory[]
}

export interface RecordChangeInput {
  sessionId: string
  turnId?: string
  runId?: string
  producerChildSessionId?: string
  producerRunId?: string
  path: string
  kind: ChangeKind
  oldContent: string | null
  newContent: string | null
  oldHash?: string | null
  newHash?: string | null
  oldSnapshotRef?: string
  newSnapshotRef?: string
  truncated?: boolean
  source?: 'command-observation'
  commandJobId?: string
  requiresExplicitRevert?: boolean
  createdDirectories?: CreatedDirectory[]
}

export interface RevertBatchInput {
  sessionId: string
  ids?: string[]
  createdAfter?: number
  scope?: 'pending' | 'all'
  fromTurnId?: string
  /** Only command observations explicitly shown and confirmed by the caller. */
  reviewedCommandChangeIds?: string[]
}

export interface RevertResult {
  id: string
  path: string
  status: 'reverted' | 'already_reverted' | 'conflict' | 'unavailable' | 'failed'
  message?: string
  expectedHash?: string
  actualHash?: string
  entryType?: 'directory'
}

export interface RevertBatchResult {
  results: RevertResult[]
  total: number
  reverted: number
  conflicts: number
  unavailable: number
  failed: number
  removedDirectories?: string[]
}

export interface RevertPreviewResult {
  total: number
  changes: Array<Pick<FileChange, 'id' | 'path' | 'status' | 'turnId' | 'source' | 'requiresExplicitRevert'> & { entryType?: 'directory' }>
}

const MAX_CONTENT_CHARS = 100_000
const schemas = new WeakMap<Client, Promise<void>>()

/** Durable byte snapshots live beside the configured database, not in SQLite text cells. */
function snapshotRoot(): string {
  const dataDir = process.env.DATA_DIR ? path.dirname(path.resolve(process.env.DATA_DIR)) : path.resolve('data')
  return path.join(dataDir, 'change-snapshots')
}

function readSnapshot(ref: string): Buffer {
  if (!/^[a-zA-Z0-9:_-]+\.bin$/.test(ref)) throw new Error('Invalid change snapshot reference')
  return fs.readFileSync(path.join(snapshotRoot(), ref))
}

function discardSnapshot(ref: string | undefined): void {
  if (!ref || !/^[a-zA-Z0-9_-]+\.bin$/.test(ref)) return
  try { fs.unlinkSync(path.join(snapshotRoot(), ref)) } catch { /* best effort cleanup */ }
}

function discardChangeSnapshots(change: Pick<FileChange, 'oldSnapshotRef' | 'newSnapshotRef'>): void {
  discardSnapshot(change.oldSnapshotRef)
  discardSnapshot(change.newSnapshotRef)
}

function rowToChange(row: Record<string, unknown>): FileChange {
  return {
    id: String(row.id), seq: Number(row.seq), tenantId: String(row.tenant_id), sessionId: String(row.session_id),
    turnId: row.turn_id == null ? undefined : String(row.turn_id), runId: row.run_id == null ? undefined : String(row.run_id),
    ...(row.producer_child_session_id == null ? {} : { producerChildSessionId: String(row.producer_child_session_id) }),
    ...(row.producer_run_id == null ? {} : { producerRunId: String(row.producer_run_id) }),
    path: String(row.path), kind: row.kind as ChangeKind,
    oldContent: row.old_content == null ? null : String(row.old_content),
    newContent: row.new_content == null ? null : String(row.new_content),
    oldHash: row.old_hash == null ? null : String(row.old_hash),
    newHash: row.new_hash == null ? null : String(row.new_hash),
    oldSnapshotRef: row.old_snapshot_ref == null ? undefined : String(row.old_snapshot_ref),
    newSnapshotRef: row.new_snapshot_ref == null ? undefined : String(row.new_snapshot_ref),
    truncated: Number(row.truncated) === 1, status: row.status as ChangeStatus, createdAt: Number(row.created_at),
    ...(row.source === 'command-observation' ? { source: 'command-observation' as const } : {}),
    ...(row.command_job_id == null ? {} : { commandJobId: String(row.command_job_id) }),
    ...(Number(row.requires_explicit_revert) === 1 ? { requiresExplicitRevert: true } : {}),
    ...(row.created_directories ? { createdDirectories: JSON.parse(String(row.created_directories)) as CreatedDirectory[] } : {}),
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

function storedPathIdentity(filePath: string): string {
  const absolute = path.resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function isDirectoryChange(change: FileChange): change is DirectoryChange {
  return 'entryType' in change && change.entryType === 'directory'
}

export class ChangeStore {
  constructor(private readonly boundDb?: Client) {}
  private get db() { return this.boundDb ?? getDb() }
  private get directories() { return new CreatedDirectoryStore(this.db) }

  async recordCreatedDirectories(tenantId: string, input: DirectoryChangeInput, directories: readonly CreatedDirectory[]): Promise<DirectoryChange[]> {
    return this.directories.record(tenantId, input, directories)
  }
  async latestDirectorySequence(): Promise<number> { return this.directories.latestSequence() }
  async hasDirectoryChangesAfter(directory: string, sequence: number, fileSequence?: number): Promise<boolean> {
    if (await this.directories.hasPathChangesAfter(directory, sequence)) return true
    if (fileSequence === undefined) return false
    await this.ensureTable()
    // File/office writers own the parent directories captured before their
    // mkdir as well; a concurrent command must not claim those directories.
    const rows = await this.db.execute({ sql: 'SELECT created_directories FROM file_changes WHERE seq>? AND created_directories IS NOT NULL', args: [fileSequence] })
    const identity = storedPathIdentity(directory)
    return rows.rows.some(row => (JSON.parse(String(row.created_directories)) as CreatedDirectory[]).some(item => storedPathIdentity(item.path) === identity))
  }

  private async ensureTable(): Promise<void> {
    const db = this.db
    let pending = schemas.get(db)
    if (!pending) {
      pending = (async () => {
        await db.execute(`CREATE TABLE IF NOT EXISTS file_changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, run_id TEXT,
          path TEXT NOT NULL, kind TEXT NOT NULL, old_content TEXT, new_content TEXT,
          old_hash TEXT, new_hash TEXT, old_snapshot_ref TEXT, new_snapshot_ref TEXT,
          truncated INTEGER NOT NULL DEFAULT 0,
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
        if (!columns.has('producer_child_session_id')) await db.execute('ALTER TABLE file_changes ADD COLUMN producer_child_session_id TEXT')
        if (!columns.has('producer_run_id')) await db.execute('ALTER TABLE file_changes ADD COLUMN producer_run_id TEXT')
        if (!columns.has('old_snapshot_ref')) await db.execute('ALTER TABLE file_changes ADD COLUMN old_snapshot_ref TEXT')
        if (!columns.has('new_snapshot_ref')) await db.execute('ALTER TABLE file_changes ADD COLUMN new_snapshot_ref TEXT')
        if (!columns.has('source')) await db.execute('ALTER TABLE file_changes ADD COLUMN source TEXT')
        if (!columns.has('command_job_id')) await db.execute('ALTER TABLE file_changes ADD COLUMN command_job_id TEXT')
        if (!columns.has('requires_explicit_revert')) await db.execute('ALTER TABLE file_changes ADD COLUMN requires_explicit_revert INTEGER NOT NULL DEFAULT 0')
        if (!columns.has('created_directories')) await db.execute('ALTER TABLE file_changes ADD COLUMN created_directories TEXT')
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
      sql: `INSERT INTO file_changes (seq, id, tenant_id, session_id, turn_id, run_id, path, kind, old_content, new_content, old_hash, new_hash, old_snapshot_ref, new_snapshot_ref, truncated, status, created_at, source, command_job_id, requires_explicit_revert, producer_child_session_id, producer_run_id, created_directories)
        SELECT COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ? FROM file_changes RETURNING *`,
      args: [uuidv4(), tenantId, input.sessionId, input.turnId ?? null, input.runId ?? null, canonicalFilePathSync(input.path), input.kind,
        (input.oldContent?.length ?? 0) > MAX_CONTENT_CHARS ? null : input.oldContent,
        (input.newContent?.length ?? 0) > MAX_CONTENT_CHARS ? null : input.newContent,
        oldHash, newHash, input.oldSnapshotRef ?? null, input.newSnapshotRef ?? null, truncated ? 1 : 0, Date.now(),
        input.source ?? null, input.commandJobId ?? null, input.requiresExplicitRevert ? 1 : 0, input.producerChildSessionId ?? null, input.producerRunId ?? null,
        input.createdDirectories?.length ? JSON.stringify(input.createdDirectories) : null]
    })
    return rowToChange(result.rows[0])
  }

  async getById(id: string, tenantId: string): Promise<FileChange | null> {
    await this.ensureTable()
    const result = await this.db.execute({ sql: 'SELECT * FROM file_changes WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    return result.rows[0] ? rowToChange(result.rows[0]) : null
  }

  /** A watermark does not disclose another session's changes; it only prevents
   * a command observation from taking ownership of a cooperating writer's edit. */
  async latestSequence(): Promise<number> {
    await this.ensureTable()
    return Number((await this.db.execute('SELECT COALESCE(MAX(seq),0) AS seq FROM file_changes')).rows[0].seq)
  }

  async hasPathChangesAfter(filePath: string, sequence: number): Promise<boolean> {
    await this.ensureTable()
    const identity = storedPathIdentity(filePath)
    const rows = await this.db.execute({ sql: 'SELECT DISTINCT path FROM file_changes WHERE seq>?', args: [sequence] })
    return rows.rows.some(row => storedPathIdentity(String(row.path)) === identity)
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

  private async storedPaths(): Promise<string[]> {
    return (await this.db.execute('SELECT DISTINCT path FROM file_changes')).rows.map(row => String(row.path))
  }

  private pathAliases(filePath: string, storedPaths: readonly string[]): string[] {
    const identity = storedPathIdentity(filePath)
    // JavaScript lowercasing matches the recorder on Windows; SQLite NOCASE
    // only folds ASCII and can otherwise silently lose legacy Unicode paths.
    return [...new Set([filePath, ...storedPaths.filter(candidate => storedPathIdentity(candidate) === identity)])]
  }

  private async pathHistory(filePath: string, storedPaths: readonly string[]): Promise<FileChange[]> {
    return (await this.db.execute({ sql: 'SELECT * FROM file_changes WHERE path IN (SELECT value FROM json_each(?)) ORDER BY seq ASC',
      args: [JSON.stringify(this.pathAliases(filePath, storedPaths))] })).rows.map(rowToChange)
  }

  /** Complete pending-file projection, independent of operation-log pagination. */
  async listNet(tenantId: string, sessionId: string, createdAfter?: number): Promise<NetFileChange[]> {
    const selected = await this.list(tenantId, sessionId, 'pending', createdAfter)
    const storedPaths = await this.storedPaths()
    const paths = [...new Set(selected.map(change => storedPathIdentity(change.path)))]
    const projected: NetFileChange[] = []
    for (const filePath of paths) {
      const project = async (canonical?: string, lockIssue?: ProjectionIssue) => {
        const history = await this.pathHistory(filePath, storedPaths)
        const ids = new Set(history.filter(change => change.tenantId === tenantId && change.sessionId === sessionId &&
          change.status === 'pending' && (createdAfter === undefined || change.createdAt > createdAfter)).map(change => change.id))
        let fileIssue = lockIssue
        let currentHash: string | undefined
        if (!fileIssue) {
          try {
            // `canonicalFilePathSync` preserves the on-disk casing on Windows so
            // it can still be used for the actual read/write operation.  Path
            // identity comparisons, however, are case-insensitive on Windows;
            // compare normalized identities here to avoid marking every file as
            // changed solely because the casing differs.
            if (!canonical || storedPathIdentity(canonical) !== storedPathIdentity(filePath)) fileIssue = 'path-changed'
            else currentHash = readFileVersionSync(canonical).hash
          } catch { fileIssue = 'unreadable' }
        }
        for (const segment of partitionChangeHistory(history, ids)) {
          const first = segment.changes[0]
          const last = segment.changes.at(-1)!
          const trusted = segment.changes.every(hasTrustedVersions)
          const later = history.some(change => change.seq > last.seq && change.status !== 'reverted')
          const issue: ProjectionIssue | undefined = fileIssue ?? (!trusted ? 'snapshot-unavailable' : later ? 'later-change' :
            currentHash !== last.newHash ? 'disk-diverged' : segment.discontinuous ? 'discontinuous-history' : undefined)
          // Equality includes existence (missing != empty), and only a verified live
          // endpoint can disappear. Keep untrusted or broken chains reviewable.
          if (!issue && first.oldHash === last.newHash) continue
          projected.push(projectSegment(segment, issue ?? (segment.changes.some(change => change.truncated && !change.oldSnapshotRef && !change.newSnapshotRef) ? 'snapshot-unavailable' : undefined)))
        }
      }
      try {
        await withFileLocks([filePath], async ([canonical]) => project(canonical))
      } catch (error) {
        // A retargeted/dangling/unreadable path must remain visible, not fail the panel.
        await project(undefined, error instanceof Error && /target|symbolic link/.test(error.message) ? 'path-changed' : 'unreadable')
      }
    }
    return projected.sort((a, b) => b.seq - a.seq)
  }

  /** Validate the entire request before changing any row, and serialize with reverts. */
  async keepMany(tenantId: string, ids: readonly string[], sessionId?: string): Promise<number> {
    await this.ensureTable()
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return 0
    const selected = await Promise.all(uniqueIds.map(id => this.getById(id, tenantId)))
    const invalid = () => Object.assign(new Error('改动不存在、不属于同一会话或已经撤回；未保留任何改动'), { statusCode: 409 })
    const expectedSession = sessionId ?? selected.find(change => change !== null)?.sessionId
    if (selected.some(change => !change || change.sessionId !== expectedSession || change.status === 'reverted')) throw invalid()
    return withFileLocks(selected.map(change => change!.path), async () => {
      // One atomic statement validates the full scope and updates it together.
      // JSON avoids SQLite's parameter limit without partial-update chunks.
      const result = await this.db.execute({
        sql: `WITH requested AS MATERIALIZED (SELECT value AS id FROM json_each(?)),
          eligible AS MATERIALIZED (SELECT id FROM file_changes WHERE tenant_id=? AND session_id=? AND status IN ('pending','kept') AND id IN (SELECT id FROM requested))
          UPDATE file_changes SET status='kept' WHERE id IN (SELECT id FROM eligible)
          AND (SELECT COUNT(*) FROM eligible)=(SELECT COUNT(*) FROM requested) RETURNING id`,
        args: [JSON.stringify(uniqueIds), tenantId, expectedSession!]
      })
      if (result.rows.length !== uniqueIds.length) throw invalid()
      return uniqueIds.length
    })
  }

  async markStatus(id: string, tenantId: string, status: ChangeStatus): Promise<FileChange | null> {
    await this.ensureTable()
    if (status === 'kept') {
      const existing = await this.getById(id, tenantId)
      if (!existing || existing.status === 'reverted') return existing
      await this.keepMany(tenantId, [id], existing.sessionId)
      return this.getById(id, tenantId)
    }
    const existing = await this.getById(id, tenantId)
    await this.db.execute({ sql: `UPDATE file_changes SET status=? WHERE id=? AND tenant_id=? AND status!='reverted'`, args: [status, id, tenantId] })
    if (status === 'reverted' && existing) discardChangeSnapshots(existing)
    return this.getById(id, tenantId)
  }

  async keepAll(tenantId: string, sessionId: string): Promise<number> {
    return this.keepMany(tenantId, (await this.list(tenantId, sessionId, 'pending')).map(change => change.id), sessionId)
  }

  private async markNetZeroReverted(tenantId: string, changes: readonly FileChange[]): Promise<void> {
    const result = await this.db.execute({
      sql: `WITH requested AS MATERIALIZED (SELECT value AS id FROM json_each(?)),
        eligible AS MATERIALIZED (SELECT id FROM file_changes WHERE tenant_id=? AND status!='reverted' AND id IN (SELECT id FROM requested))
        UPDATE file_changes SET status='reverted' WHERE id IN (SELECT id FROM eligible)
        AND (SELECT COUNT(*) FROM eligible)=(SELECT COUNT(*) FROM requested) RETURNING id`,
      args: [JSON.stringify(changes.map(change => change.id)), tenantId]
    })
    if (result.rows.length !== changes.length) throw new Error('改动状态已变化，零净变化回退未保存')
    for (const change of changes) discardChangeSnapshots(change)
  }

  private async selectRevertScope(tenantId: string, input: RevertBatchInput): Promise<{ ids?: string[]; selected: Array<FileChange | DirectoryChange | null> }> {
    let turns: Set<string> | undefined
    if (input.fromTurnId !== undefined) {
      if (input.ids !== undefined || input.createdAfter !== undefined) throw Object.assign(new Error('fromTurnId 不能与 ids 或 createdAfter 混用'), { statusCode: 400 })
      const runs = await rootRunStore.list(tenantId, input.sessionId)
      const first = runs.find(run => run.turnId === input.fromTurnId)
      if (!first) throw Object.assign(new Error('当前会话中不存在该轮次，不能按时间猜测回退范围'), { statusCode: 400 })
      turns = new Set(runs.filter(run => run.seq >= first.seq).map(run => run.turnId))
    }
    const ids = input.ids === undefined ? undefined : [...new Set(input.ids)]
    let selected: Array<FileChange | DirectoryChange | null> = ids === undefined
      ? [...await this.list(tenantId, input.sessionId, input.scope === 'all' ? undefined : 'pending', input.createdAfter),
        ...await this.directories.list(tenantId, input.sessionId, input.scope === 'all' ? undefined : 'pending', input.createdAfter)]
      : await Promise.all(ids.map(async id => await this.getById(id, tenantId) ?? await this.directories.get(id, tenantId)))
    if (turns) selected = selected.filter(change => change?.turnId && turns!.has(change.turnId))
    return { ids, selected }
  }

  async previewRevert(tenantId: string, input: RevertBatchInput): Promise<RevertPreviewResult> {
    const { selected } = await this.selectRevertScope(tenantId, input)
    return { total: selected.length, changes: selected.flatMap(change => !change || change.sessionId !== input.sessionId ? [] : [{
      id: change.id, path: change.path, status: change.status, turnId: change.turnId,
      source: change.source, requiresExplicitRevert: change.requiresExplicitRevert,
      ...('entryType' in change ? { entryType: change.entryType } : {}),
    }]) }
  }

  async revertBatch(tenantId: string, input: RevertBatchInput): Promise<RevertBatchResult> {
    const { ids, selected } = await this.selectRevertScope(tenantId, input)
    const reviewedCommands = new Set(input.reviewedCommandChangeIds ?? [])
    const results: RevertResult[] = []
    const targets: Array<FileChange | DirectoryChange> = []
    const removedDirectories: string[] = []
    const unreviewedPaths = new Set<string>()
    selected.forEach((change, index) => {
      if (!change || change.sessionId !== input.sessionId) {
        results.push({ id: ids![index], path: '', status: 'unavailable', message: '改动不存在或不属于当前会话' })
      } else if (change.requiresExplicitRevert && ids === undefined && !reviewedCommands.has(change.id) && change.status !== 'reverted') {
        results.push({ id: change.id, path: change.path, status: 'unavailable',
          ...('entryType' in change ? { entryType: change.entryType } : {}),
          message: '这是命令运行期间观察到的文件变化，可能包含并发编辑；请在改动面板审阅并明确选择后撤回' })
        unreviewedPaths.add(storedPathIdentity(change.path))
      } else targets.push(change)
    })
    if (targets.length === 0) return summarize(results)
    try {
      await withFileLocks(targets.map(change => change.path), async (canonicalPaths) => {
        const ordered = targets.map((change, index) => ({ change, canonical: canonicalPaths[index] }))
          .sort((a, b) => Number('entryType' in a.change) - Number('entryType' in b.change) ||
            ('entryType' in a.change ? b.canonical.length - a.canonical.length : 0) || a.canonical.localeCompare(b.canonical) || b.change.seq - a.change.seq)
        const blocked = new Set<string>()
        const selectedIds = new Set(targets.map(change => change.id))
        const storedPaths = await this.storedPaths()
        const pendingScope = ids === undefined && input.scope !== 'all'
        const noOpChains = new Map<string, FileChange[]>()
        // Only whole, selected, globally contiguous chains can be marked reverted
        // without replaying temporary creates/deletes. Partial historical scopes
        // continue to restore their actual boundary snapshot.
        for (const filePath of new Set(targets.filter(change => !('entryType' in change)).map(change => change.path))) {
          const history = await this.pathHistory(filePath, storedPaths)
          const liveIds = new Set(history.filter(change => selectedIds.has(change.id) && change.tenantId === tenantId &&
            change.sessionId === input.sessionId && change.status !== 'reverted' && (!pendingScope || change.status === 'pending')).map(change => change.id))
          for (const segment of partitionChangeHistory(history, liveIds)) {
            if (!segment.discontinuous && segment.changes.every(hasTrustedVersions) && segment.changes[0].oldHash === segment.changes.at(-1)!.newHash) {
              noOpChains.set(segment.changes.at(-1)!.id, segment.changes)
            }
          }
        }
        const handled = new Set<string>()
        for (const target of ordered) {
          if (handled.has(target.change.id)) continue
          const { canonical } = target
          // Re-read after waiting: another request may already have reverted this change.
          const change = 'entryType' in target.change ? await this.directories.get(target.change.id, tenantId) : await this.getById(target.change.id, tenantId)
          const base = { id: target.change.id, path: target.change.path, ...('entryType' in target.change ? { entryType: target.change.entryType } : {}) }
          if (!change || change.sessionId !== input.sessionId) {
            results.push({ ...base, status: 'unavailable', message: '改动不存在或不属于当前会话' })
            blocked.add(canonical)
            continue
          }
          if (change.status === 'reverted') { results.push({ ...base, status: 'already_reverted' }); continue }
          if (unreviewedPaths.has(storedPathIdentity(change.path))) {
            results.push({ ...base, status: 'unavailable', message: '该文件的回退范围包含尚未确认的命令改动，未部分恢复此文件' })
            blocked.add(canonical)
            continue
          }
          if (pendingScope && change.status !== 'pending') {
            results.push({ ...base, status: 'conflict', message: '改动已被保留，请刷新后选择需要撤回的范围' })
            blocked.add(canonical)
            continue
          }
          if (isDirectoryChange(change)) {
            try {
              // Explicit mkdir receipts can own a parent of directories created
              // by subsequent file writes. Remove those proven empty children
              // before attempting their parent.
              const completed = new Set(results.filter(result => result.status === 'reverted' || result.status === 'already_reverted').map(result => result.id))
              removedDirectories.push(...removeCreatedEmptyDirectories(targets.filter(item => completed.has(item.id)).flatMap(item => item.createdDirectories ?? [])))
              const removed = removeCreatedEmptyDirectories([change.directory])
              removedDirectories.push(...removed)
              let missing = false
              try { fs.lstatSync(change.path) } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                missing = true
              }
              if (!missing) results.push({ ...base, status: 'conflict', message: '目录包含保留的内容或目录身份已变化，未删除目录' })
              else {
                await this.directories.markReverted(change.id, tenantId)
                results.push({ ...base, status: removed.length ? 'reverted' : 'already_reverted' })
              }
            } catch (error) { results.push({ ...base, status: 'failed', message: `目录撤回失败：${error instanceof Error ? error.message : String(error)}` }) }
            continue
          }
          const noOp = noOpChains.get(change.id)
          // A missing snapshot belongs to this file, not to every later file in
          // the batch. Net-zero chains do not need their temporary byte copies.
          let oldVersionValid = Boolean(noOp), newVersionValid = Boolean(noOp)
          if (!noOp) {
            try {
              oldVersionValid = hashFileContent(change.oldSnapshotRef ? readSnapshot(change.oldSnapshotRef) : change.oldContent) === change.oldHash
              newVersionValid = hashFileContent(change.newSnapshotRef ? readSnapshot(change.newSnapshotRef) : change.newContent) === change.newHash
            } catch { /* report unavailable below and continue independent paths */ }
          }
          if (!noOp && (!change.oldHash || !change.newHash || !oldVersionValid || !newVersionValid)) {
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
              sql: `SELECT 1 FROM file_changes WHERE path IN (SELECT value FROM json_each(?)) AND seq>? AND status!='reverted' LIMIT 1`,
              args: [JSON.stringify(this.pathAliases(change.path, storedPaths)), change.seq]
            })
            // canonicalFilePathSync preserves the filesystem's spelling for
            // I/O, while storedPathIdentity applies Windows case folding for
            // comparisons. Compare identities here so `App.tsx` and `app.tsx`
            // are treated as the same target without rejecting every Windows
            // rollback because of casing.
            if (storedPathIdentity(change.path) !== storedPathIdentity(canonical)) {
              results.push({ ...base, status: 'conflict', message: '文件路径的实际目标已变化，未写入文件', expectedHash: change.newHash ?? undefined })
              blocked.add(canonical)
              continue
            }
            const current = readFileVersionSync(canonical)
            if (blocked.has(canonical) || later.rows.length > 0 || current.hash !== change.newHash) {
              results.push({ ...base, status: 'conflict', message: blocked.has(canonical) || later.rows.length > 0
                ? '该文件存在尚未撤回的较新改动，未覆盖后续版本'
                : '文件已被后续修改，当前版本与改动记录不一致', expectedHash: change.newHash ?? undefined, actualHash: current.hash })
              blocked.add(canonical)
              continue
            }
            if (noOp) {
              await this.markNetZeroReverted(tenantId, noOp)
              for (const item of [...noOp].reverse()) {
                handled.add(item.id)
                results.push({ id: item.id, path: item.path, status: 'reverted' })
              }
              continue
            }
            // No await between byte verification and the synchronous write.
            if (change.oldSnapshotRef) {
              const snapshot = readSnapshot(change.oldSnapshotRef)
              fs.mkdirSync(path.dirname(canonical), { recursive: true })
              fs.writeFileSync(canonical, snapshot)
            } else if (change.oldContent === null) {
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
    // Retry already-reverted records as well: another file may have kept their
    // created parent nonempty in a previous partial batch.
    const successful = new Set(results.filter(result => result.status === 'reverted' || result.status === 'already_reverted').map(result => result.id))
    const directories = targets.filter(change => successful.has(change.id)).flatMap(change => change.createdDirectories ?? [])
    try { removedDirectories.push(...removeCreatedEmptyDirectories(directories)) } catch (error) {
      results.push({ id: '', path: '', status: 'failed', message: `空目录清理失败：${error instanceof Error ? error.message : String(error)}` })
    }
    if (ids === undefined) {
      // A whole-turn rollback must not silently call itself complete while
      // directories created by its files remain. Explicit file-ID requests,
      // by contrast, need not remove a parent shared by unselected files.
      const reported = new Set(results.filter(result => result.entryType === 'directory').map(result => storedPathIdentity(result.path)))
      for (const directory of directories) {
        const identity = storedPathIdentity(directory.path)
        if (reported.has(identity)) continue
        const base = { id: `directory:${hashFileContent(directory.path).slice('sha256:'.length)}`, path: directory.path, entryType: 'directory' as const }
        try {
          fs.lstatSync(directory.path)
          results.push({ ...base, status: 'conflict', message: '本轮新建目录包含保留的内容或身份已变化，目录尚未撤回' })
          reported.add(identity)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            results.push({ ...base, status: 'failed', message: `无法确认目录回退状态：${error instanceof Error ? error.message : String(error)}` })
            reported.add(identity)
          }
        }
      }
    }
    return { ...summarize(results), removedDirectories }
  }
}

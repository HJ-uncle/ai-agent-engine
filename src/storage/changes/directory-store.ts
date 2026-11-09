import type { Client, InValue } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import type { FileChange, ChangeStatus, RecordChangeInput } from './index.js'
import { type CreatedDirectory } from './directories.js'
import { hashFileContent } from '../../shared/file-version.js'
import path from 'node:path'

export type DirectoryChange = FileChange & { entryType: 'directory'; directory: CreatedDirectory }
export type DirectoryChangeInput = Pick<RecordChangeInput, 'sessionId' | 'turnId' | 'runId' | 'source' | 'commandJobId' | 'requiresExplicitRevert'>
const schemas = new WeakMap<Client, Promise<void>>()

/** Directory ownership cannot be inferred from a file that was written later.
 * Keep explicit creation receipts separate from text/binary diff history. */
export class CreatedDirectoryStore {
  constructor(private readonly db: Client) {}

  private async ensure(): Promise<void> {
    let pending = schemas.get(this.db)
    if (!pending) {
      pending = (async () => {
        await this.db.execute(`CREATE TABLE IF NOT EXISTS created_directory_changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, run_id TEXT,
          path TEXT NOT NULL, identity_json TEXT NOT NULL, source TEXT, command_job_id TEXT,
          requires_explicit_revert INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
        )`)
        await this.db.execute('CREATE INDEX IF NOT EXISTS idx_directory_changes_scope ON created_directory_changes(tenant_id,session_id,seq)')
      })()
      schemas.set(this.db, pending)
      pending.catch(() => { if (schemas.get(this.db) === pending) schemas.delete(this.db) })
    }
    await pending
  }

  private fromRow(row: Record<string, unknown>): DirectoryChange {
    return {
      id: String(row.id), seq: Number(row.seq), tenantId: String(row.tenant_id), sessionId: String(row.session_id),
      turnId: row.turn_id == null ? undefined : String(row.turn_id), runId: row.run_id == null ? undefined : String(row.run_id),
      path: String(row.path), entryType: 'directory', directory: JSON.parse(String(row.identity_json)) as CreatedDirectory,
      kind: 'write', oldContent: null, newContent: 'directory', oldHash: 'missing', newHash: hashFileContent('directory'),
      truncated: false, status: row.status as ChangeStatus, createdAt: Number(row.created_at),
      ...(row.source === 'command-observation' ? { source: 'command-observation' as const } : {}),
      ...(row.command_job_id == null ? {} : { commandJobId: String(row.command_job_id) }),
      ...(Number(row.requires_explicit_revert) === 1 ? { requiresExplicitRevert: true } : {}),
    }
  }

  async record(tenantId: string, input: DirectoryChangeInput, directories: readonly CreatedDirectory[]): Promise<DirectoryChange[]> {
    if (!directories.length) return []
    await this.ensure()
    const results = await this.db.batch(directories.map(directory => ({ sql: `INSERT INTO created_directory_changes
        (id,tenant_id,session_id,turn_id,run_id,path,identity_json,source,command_job_id,requires_explicit_revert,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, args: [randomUUID(), tenantId, input.sessionId, input.turnId ?? null,
        input.runId ?? null, directory.path, JSON.stringify(directory), input.source ?? null, input.commandJobId ?? null,
        input.requiresExplicitRevert ? 1 : 0, Date.now()] })), 'write')
    return results.map(result => this.fromRow(result.rows[0]))
  }

  async get(id: string, tenantId: string): Promise<DirectoryChange | null> {
    await this.ensure()
    const result = await this.db.execute({ sql: 'SELECT * FROM created_directory_changes WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    return result.rows[0] ? this.fromRow(result.rows[0]) : null
  }

  async latestSequence(): Promise<number> {
    await this.ensure()
    return Number((await this.db.execute('SELECT COALESCE(MAX(seq),0) AS seq FROM created_directory_changes')).rows[0].seq)
  }

  async hasPathChangesAfter(directory: string, sequence: number): Promise<boolean> {
    await this.ensure()
    const identity = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    const rows = await this.db.execute({ sql: 'SELECT path FROM created_directory_changes WHERE seq>?', args: [sequence] })
    return rows.rows.some(row => identity(String(row.path)) === identity(directory))
  }

  async list(tenantId: string, sessionId: string, status?: ChangeStatus, createdAfter?: number): Promise<DirectoryChange[]> {
    await this.ensure()
    let sql = 'SELECT * FROM created_directory_changes WHERE tenant_id=? AND session_id=?'
    const args: InValue[] = [tenantId, sessionId]
    if (status) { sql += ' AND status=?'; args.push(status) }
    if (createdAfter !== undefined) { sql += ' AND created_at>?'; args.push(createdAfter) }
    return (await this.db.execute({ sql: sql + ' ORDER BY seq DESC', args })).rows.map(row => this.fromRow(row))
  }

  async markReverted(id: string, tenantId: string): Promise<void> {
    await this.db.execute({ sql: "UPDATE created_directory_changes SET status='reverted' WHERE id=? AND tenant_id=?", args: [id, tenantId] })
  }
}

import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../sqlite/db.js'

export type ChangeKind = 'write' | 'delete'
export type ChangeStatus = 'pending' | 'kept' | 'reverted'

/** 单条文件改动记录（写入/删除前的快照 + 执行后的新内容） */
export interface FileChange {
  id: string
  tenantId: string
  sessionId: string
  /** 绝对路径（引擎工作区视角） */
  path: string
  kind: ChangeKind
  /** 旧内容；null = 新建文件（或内容过大未存） */
  oldContent: string | null
  /** 新内容；null = 文件被删除（或内容过大未存） */
  newContent: string | null
  /** 任一侧内容超过阈值未入库时为 true，此时无法回退 */
  truncated: boolean
  status: ChangeStatus
  createdAt: number
}

export interface RecordChangeInput {
  sessionId: string
  path: string
  kind: ChangeKind
  oldContent: string | null
  newContent: string | null
  truncated?: boolean
}

/** 内容超过 100KB 不入库（SQLite 单行过大拖慢整库，且 UI 也不渲染这么大的 diff） */
const MAX_CONTENT_CHARS = 100_000

function rowToChange(row: Record<string, any>): FileChange {
  return {
    id: row['id'],
    tenantId: row['tenant_id'],
    sessionId: row['session_id'],
    path: row['path'],
    kind: row['kind'] as ChangeKind,
    oldContent: row['old_content'] ?? null,
    newContent: row['new_content'] ?? null,
    truncated: Number(row['truncated']) === 1,
    status: row['status'] as ChangeStatus,
    createdAt: row['created_at']
  }
}

export class ChangeStore {
  private get db() {
    return getDb()
  }

  /** 表结构自建（幂等），不依赖迁移脚本 */
  private async ensureTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        old_content TEXT,
        new_content TEXT,
        truncated INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `)
  }

  async record(tenantId: string, input: RecordChangeInput): Promise<FileChange> {
    await this.ensureTable()
    const id = uuidv4()
    const now = Date.now()
    await this.db.execute({
      sql: `INSERT INTO file_changes (id, tenant_id, session_id, path, kind, old_content, new_content, truncated, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      args: [
        id,
        tenantId,
        input.sessionId,
        input.path,
        input.kind,
        input.oldContent,
        input.newContent,
        input.truncated ? 1 : 0,
        now
      ]
    })
    return {
      id,
      tenantId,
      sessionId: input.sessionId,
      path: input.path,
      kind: input.kind,
      oldContent: input.oldContent,
      newContent: input.newContent,
      truncated: Boolean(input.truncated),
      status: 'pending',
      createdAt: now
    }
  }

  async getById(id: string, tenantId: string): Promise<FileChange | null> {
    await this.ensureTable()
    const res = await this.db.execute({
      sql: 'SELECT * FROM file_changes WHERE id=? AND tenant_id=?',
      args: [id, tenantId]
    })
    return res.rows[0] ? rowToChange(res.rows[0] as any) : null
  }

  /** 会话内改动列表；status 缺省返回全部，一般用 pending 画确认面板 */
  async list(tenantId: string, sessionId: string, status?: ChangeStatus): Promise<FileChange[]> {
    await this.ensureTable()
    let sql = 'SELECT * FROM file_changes WHERE tenant_id=? AND session_id=?'
    const args: any[] = [tenantId, sessionId]
    if (status) {
      sql += ' AND status=?'
      args.push(status)
    }
    sql += ' ORDER BY created_at DESC LIMIT 200'
    const res = await this.db.execute({ sql, args })
    return res.rows.map((r) => rowToChange(r as any))
  }

  async markStatus(id: string, tenantId: string, status: ChangeStatus): Promise<FileChange | null> {
    await this.ensureTable()
    await this.db.execute({
      sql: 'UPDATE file_changes SET status=? WHERE id=? AND tenant_id=?',
      args: [status, id, tenantId]
    })
    return this.getById(id, tenantId)
  }

  /** 批量确认：会话内所有 pending → kept（面板上的「保留」按钮） */
  async keepAll(tenantId: string, sessionId: string): Promise<number> {
    await this.ensureTable()
    const res = await this.db.execute({
      sql: `UPDATE file_changes SET status='kept' WHERE tenant_id=? AND session_id=? AND status='pending'`,
      args: [tenantId, sessionId]
    })
    return res.rowsAffected ?? 0
  }
}

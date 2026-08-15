/**
 * skill_imports 表存储层
 *
 * 导入记录的 CRUD 与状态推进。文件系统是 skills 的真源，本表承担
 * 审计追踪、进度查询、断点续传位图持久化。
 */

import { getDb } from '../sqlite/db.js'
import type { ConflictStrategy, SkillScope } from '../../skills/import-pipeline.js'

export type SkillImportStatus =
  | 'pending'      // 已创建记录
  | 'uploading'    // 分片上传中
  | 'merging'      // 分片合并中
  | 'validating'   // 校验中
  | 'extracting'   // 解压/导入中
  | 'imported'     // 成功
  | 'failed'       // 失败
  | 'cancelled'    // 取消

export interface SkillImportRecord {
  id: string
  tenantId: string
  userId: string | null
  filename: string
  fileSize: number
  fileSha256: string | null
  status: SkillImportStatus
  progress: number
  stage: string | null
  skillNames: string[]
  conflictStrategy: ConflictStrategy
  scope: SkillScope
  importedCount: number
  skippedCount: number
  errorCode: string | null
  errorMessage: string | null
  uploadedChunks: number[]
  createdAt: number
  updatedAt: number
}

function rowToRecord(row: Record<string, unknown>): SkillImportRecord {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    userId: (row['user_id'] as string) ?? null,
    filename: row['filename'] as string,
    fileSize: Number(row['file_size'] ?? 0),
    fileSha256: (row['file_sha256'] as string) ?? null,
    status: row['status'] as SkillImportStatus,
    progress: Number(row['progress'] ?? 0),
    stage: (row['stage'] as string) ?? null,
    skillNames: row['skill_names'] ? JSON.parse(row['skill_names'] as string) : [],
    conflictStrategy: (row['conflict_strategy'] as ConflictStrategy) ?? 'versioned',
    scope: (row['scope'] as SkillScope) ?? 'project',
    importedCount: Number(row['imported_count'] ?? 0),
    skippedCount: Number(row['skipped_count'] ?? 0),
    errorCode: (row['error_code'] as string) ?? null,
    errorMessage: (row['error_message'] as string) ?? null,
    uploadedChunks: row['uploaded_chunks'] ? JSON.parse(row['uploaded_chunks'] as string) : [],
    createdAt: Number(row['created_at'] ?? 0),
    updatedAt: Number(row['updated_at'] ?? 0),
  }
}

const TERMINAL_STATUSES = new Set<SkillImportStatus>(['imported', 'failed', 'cancelled'])

export class SkillImportStore {
  async create(input: {
    id: string
    tenantId: string
    userId?: string
    filename: string
    fileSize: number
    conflictStrategy?: ConflictStrategy
    scope?: SkillScope
  }): Promise<SkillImportRecord> {
    const db = getDb()
    await db.execute({
      sql: `INSERT INTO skill_imports (id, tenant_id, user_id, filename, file_size, status, conflict_strategy, scope)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [
        input.id,
        input.tenantId,
        input.userId ?? null,
        input.filename,
        input.fileSize,
        input.conflictStrategy ?? 'versioned',
        input.scope ?? 'project',
      ],
    })
    return (await this.get(input.id))!
  }

  async get(id: string): Promise<SkillImportRecord | null> {
    const db = getDb()
    const result = await db.execute({ sql: 'SELECT * FROM skill_imports WHERE id = ?', args: [id] })
    const row = result.rows[0]
    return row ? rowToRecord(row as Record<string, unknown>) : null
  }

  async update(id: string, patch: Partial<{
    status: SkillImportStatus
    progress: number
    stage: string
    skillNames: string[]
    importedCount: number
    skippedCount: number
    errorCode: string | null
    errorMessage: string | null
    uploadedChunks: number[]
    fileSha256: string
  }>): Promise<SkillImportRecord | null> {
    const sets: string[] = []
    const args: (string | number | null)[] = []
    const colMap: Record<string, string> = {
      status: 'status', progress: 'progress', stage: 'stage', importedCount: 'imported_count',
      skippedCount: 'skipped_count', errorCode: 'error_code', errorMessage: 'error_message',
      fileSha256: 'file_sha256',
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      if (k === 'skillNames') {
        sets.push('skill_names = ?'); args.push(JSON.stringify(v))
      } else if (k === 'uploadedChunks') {
        sets.push('uploaded_chunks = ?'); args.push(JSON.stringify(v))
      } else if (colMap[k]) {
        sets.push(`${colMap[k]} = ?`); args.push(v as string | number | null)
      }
    }
    if (sets.length === 0) return this.get(id)
    sets.push('updated_at = unixepoch()')
    args.push(id)
    const db = getDb()
    await db.execute({ sql: `UPDATE skill_imports SET ${sets.join(', ')} WHERE id = ?`, args })
    return this.get(id)
  }

  /** 分片上传成功后追加位图 */
  async appendChunk(id: string, chunkIndex: number): Promise<number[]> {
    const rec = await this.get(id)
    if (!rec) return []
    const next = [...new Set([...rec.uploadedChunks, chunkIndex])].sort((a, b) => a - b)
    await this.update(id, { uploadedChunks: next })
    return next
  }

  async list(tenantId: string, limit = 20): Promise<SkillImportRecord[]> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT * FROM skill_imports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
      args: [tenantId, limit],
    })
    return result.rows.map((r) => rowToRecord(r as Record<string, unknown>))
  }

  /** 按分片会话键（租户+文件名+大小）找最近一次未完成的分片导入（断点续传） */
  async findResumable(tenantId: string, filename: string, fileSize: number): Promise<SkillImportRecord | null> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT * FROM skill_imports
            WHERE tenant_id = ? AND filename = ? AND file_size = ? AND status IN ('pending', 'uploading')
            ORDER BY created_at DESC LIMIT 1`,
      args: [tenantId, filename, fileSize],
    })
    const row = result.rows[0]
    return row ? rowToRecord(row as Record<string, unknown>) : null
  }

  isTerminal(status: SkillImportStatus): boolean {
    return TERMINAL_STATUSES.has(status)
  }
}

export const skillImportStore = new SkillImportStore()

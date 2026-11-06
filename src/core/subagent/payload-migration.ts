import type { Client, InValue } from '@libsql/client'
import { SubagentPayloadCodec, SUBAGENT_PAYLOAD_FIELDS } from './payload-codec.js'
import { getSubagentPayloadFiles } from './payload-files.js'

const targets = [
  { table: 'subagent_runs', columns: { snapshot: 'state' }, versioned: true },
  { table: 'subagent_checkpoints', columns: { header: 'state' } },
  { table: 'subagent_tools', columns: { summary: 'summary' } },
  { table: 'subagent_tool_versions', columns: { summary: 'summary', detail: 'detail' } },
  { table: 'subagent_events', columns: { event: 'event' }, versioned: true },
  { table: 'subagent_outbox', columns: { event: 'event' }, versioned: true },
] as const
export type SubagentPayloadMigrationTable = typeof targets[number]['table']
export interface SubagentPayloadMigrationCursor { table: SubagentPayloadMigrationTable; rowid: string }
export interface SubagentPayloadMigrationOptions {
  /** Resume AFTER this row. A fresh scan is safe and retries any intentionally skipped rows. */
  after?: SubagentPayloadMigrationCursor
  maxRows?: number
  batchSize?: number
  /** Sum of the serialized UTF-8 columns in one row; checked in SQL before loading bodies. */
  maxRowBytes?: number
  signal?: AbortSignal
}
export interface SubagentPayloadMigrationResult {
  scanned: number
  migrated: number
  unchanged: number
  skippedLegacy: number
  skippedOversized: number
  skippedInvalid: number
  skippedNoncanonicalDetails: number
  alreadyEncodedColumns: number
  originalBytes: number
  storedBytes: number
  /** Logical JSON savings, NOT free disk space: SQLite retains pages until separate maintenance. */
  reducedInlineBytes: number
  after?: SubagentPayloadMigrationCursor
  hasMore: boolean
  aborted: boolean
  failure?: { at: SubagentPayloadMigrationCursor; code: string; message: string }
}
export interface SubagentPayloadTableStats {
  table: SubagentPayloadMigrationTable
  rows: number
  inlineBytes: number
  largestRowBytes: number
  oversizedRows: number
}

type Target = typeof targets[number]
type Kind = 'state' | 'summary' | 'detail' | 'event'
function bytesSql(target: Target): string {
  return Object.keys(target.columns).map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')
}
function budgets(options: SubagentPayloadMigrationOptions) {
  const maxRows = options.maxRows ?? 128, batchSize = options.batchSize ?? 16, maxRowBytes = options.maxRowBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256
    || !Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1 || maxRowBytes > 256 * 1024 * 1024)
    throw new RangeError('Invalid subagent migration budget')
  if (options.after) {
    const cursor = options.after
    if (!targets.some(target => target.table === cursor.table) || !/^-?(0|[1-9]\d*)$/.test(cursor.rowid)
      || BigInt(cursor.rowid) < -9223372036854775808n || BigInt(cursor.rowid) > 9223372036854775807n)
      throw new RangeError('Invalid subagent migration cursor')
  }
  return { maxRows, batchSize, maxRowBytes }
}
async function existingTables(db: Pick<Client, 'execute'>): Promise<Set<string>> {
  return new Set((await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${targets.map(target => `'${target.table}'`).join(',')})`)).rows.map(row => String(row.name)))
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function encoded(value: Record<string, unknown>, kind: Kind): boolean {
  const marker = (item: unknown) => object(item) && Object.hasOwn(item, SUBAGENT_PAYLOAD_FIELDS)
  if (marker(value)) return true
  if (kind !== 'event') return false
  return ['header', 'headerPatch', 'toolUpsert', 'view'].some(key => marker(value[key]))
    || object(value.view) && Array.isArray(value.view.toolCalls) && value.view.toolCalls.some(marker)
}

/** Aggregate read-only diagnostics. Does not initialize tables, payload directories, or a cursor. */
export async function getSubagentPayloadMigrationStats(db: Pick<Client, 'execute'>, options: { maxRowBytes?: number } = {}): Promise<SubagentPayloadTableStats[]> {
  const { maxRowBytes } = budgets(options), present = await existingTables(db)
  const result: SubagentPayloadTableStats[] = []
  for (const target of targets) {
    if (!present.has(target.table)) continue
    const row = (await db.execute({ sql: `SELECT count(*) AS n,COALESCE(sum(${bytesSql(target)}),0) AS bytes,
      COALESCE(max(${bytesSql(target)}),0) AS largest,COALESCE(sum(CASE WHEN ${bytesSql(target)}>? THEN 1 ELSE 0 END),0) AS oversized FROM ${target.table}`, args: [maxRowBytes] })).rows[0]
    result.push({ table: target.table, rows: Number(row.n), inlineBytes: Number(row.bytes), largestRowBytes: Number(row.largest), oversizedRows: Number(row.oversized) })
  }
  return result
}

/**
 * Offline, resumable migration of modern payloads only. No schema migration or retention/deletion.
 * Metadata batches are bounded; each row's files become durable BEFORE its own CAS transaction.
 * Errors stop at the previous cursor. Restarting from that cursor (or the beginning) is safe;
 * harmless unreferenced files from an interrupted publication are retained, never deleted here.
 */
export async function migrateSubagentPayloads(db: Client, options: SubagentPayloadMigrationOptions = {}): Promise<SubagentPayloadMigrationResult> {
  const { maxRows, batchSize, maxRowBytes } = budgets(options), present = await existingTables(db)
  const result: SubagentPayloadMigrationResult = { scanned: 0, migrated: 0, unchanged: 0, skippedLegacy: 0,
    skippedOversized: 0, skippedInvalid: 0, skippedNoncanonicalDetails: 0, alreadyEncodedColumns: 0,
    originalBytes: 0, storedBytes: 0, reducedInlineBytes: 0, after: options.after, hasMore: false, aborted: false }
  let codec: SubagentPayloadCodec | undefined
  const start = options.after ? targets.findIndex(target => target.table === options.after!.table) : 0
  for (let index = start; index < targets.length; index++) {
    const target = targets[index]
    if (!present.has(target.table)) continue
    let after = index === start ? options.after?.rowid : undefined
    for (;;) {
      if (options.signal?.aborted) { result.aborted = true; result.hasMore = true; return result }
      const args: InValue[] = after === undefined ? [] : [after]
      const candidates = (await db.execute({ sql: `SELECT CAST(rowid AS TEXT) AS migration_rowid,${bytesSql(target)} AS bytes
        FROM ${target.table} ${after === undefined ? '' : 'WHERE rowid>CAST(? AS INTEGER)'} ORDER BY rowid LIMIT ?`,
        args: [...args, Math.min(batchSize, Math.max(1, maxRows - result.scanned))] })).rows
      if (!candidates.length) break
      for (const candidate of candidates) {
        if (result.scanned >= maxRows) { result.hasMore = true; return result }
        if (options.signal?.aborted) { result.aborted = true; result.hasMore = true; return result }
        const cursor: SubagentPayloadMigrationCursor = { table: target.table, rowid: String(candidate.migration_rowid) }
        const advance = () => { result.scanned++; result.after = cursor; after = cursor.rowid }
        if (Number(candidate.bytes) > maxRowBytes) { result.skippedOversized++; advance(); continue }
        try {
          const columns = Object.keys(target.columns)
          // A concurrent grow cannot bypass the byte limit checked during the metadata scan.
          const row = (await db.execute({ sql: `SELECT tenant_id,${columns.join(',')} FROM ${target.table}
            WHERE rowid=CAST(? AS INTEGER) AND (${bytesSql(target)})<=?`, args: [cursor.rowid, maxRowBytes] })).rows[0]
          if (!row) throw Object.assign(new Error('Row changed after metadata scan; stop and retry'), { code: 'MIGRATION_ROW_CHANGED' })
          const replacements: Record<string, string> = {}
          let legacy = false
          for (const [column, kind] of Object.entries(target.columns) as [string, Kind][]) {
            const raw = row[column]
            if (typeof raw !== 'string') { result.skippedInvalid++; continue }
            let value: unknown
            try { value = JSON.parse(raw) } catch { result.skippedInvalid++; continue }
            if (!object(value)) { result.skippedInvalid++; continue }
            if ('versioned' in target && value.schemaVersion !== 2) { legacy = true; continue }
            if (encoded(value, kind)) { result.alreadyEncodedColumns++; continue }
            if (kind === 'detail' && JSON.stringify(value) !== raw) { result.skippedNoncanonicalDetails++; continue }
            codec ??= new SubagentPayloadCodec(await getSubagentPayloadFiles(db))
            const stored = await (kind === 'state' ? codec.encodeState(String(row.tenant_id), raw)
              : kind === 'summary' ? codec.encodeSummary(String(row.tenant_id), raw)
                : kind === 'detail' ? codec.encodeDetail(String(row.tenant_id), raw) : codec.encodeEvent(String(row.tenant_id), raw))
            const text = JSON.stringify(stored)
            // Preserve spelling and avoid growing a row that has no worthwhile external payload.
            if (encoded(stored, kind) && Buffer.byteLength(text) < Buffer.byteLength(raw)) replacements[column] = text
          }
          if (legacy) result.skippedLegacy++
          const changed = Object.keys(replacements)
          if (!changed.length) { result.unchanged++; advance(); continue }
          if (options.signal?.aborted) { result.aborted = true; result.hasMore = true; return result }
          const tx = await db.transaction('write')
          try {
            const updated = await tx.execute({ sql: `UPDATE ${target.table} SET ${changed.map(column => `${column}=?`).join(',')}
              WHERE rowid=CAST(? AS INTEGER) AND tenant_id=? AND ${columns.map(column => `${column}=?`).join(' AND ')}`,
              args: [...changed.map(column => replacements[column]), cursor.rowid, row.tenant_id, ...columns.map(column => row[column])] })
            if (updated.rowsAffected !== 1) throw Object.assign(new Error('Original raw payload changed; stop and retry'), { code: 'MIGRATION_CAS_MISMATCH' })
            if (options.signal?.aborted) { await tx.rollback(); result.aborted = true; result.hasMore = true; return result }
            await tx.commit()
          } catch (error) { if (!tx.closed) await tx.rollback(); throw error }
          finally { tx.close() }
          result.migrated++
          for (const column of changed) {
            result.originalBytes += Buffer.byteLength(String(row[column])); result.storedBytes += Buffer.byteLength(replacements[column])
          }
          result.reducedInlineBytes = result.originalBytes - result.storedBytes
          advance()
        } catch (error) {
          result.failure = { at: cursor, code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'MIGRATION_FAILED',
            message: error instanceof Error ? error.message : 'Subagent payload migration failed' }
          result.hasMore = true
          return result
        }
      }
    }
  }
  return result
}

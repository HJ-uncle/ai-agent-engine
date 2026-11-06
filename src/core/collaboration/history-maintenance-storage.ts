import { createHash } from 'node:crypto'
import type { Client, Row, Transaction } from '@libsql/client'

type TerminalState = 'committed' | 'invalidated'
type Scope = { tenantId: string; sessionId: string }
const FORMAT = 'aether-history-maintenance-terminal'
const schemas = new WeakMap<Client, Promise<void>>()
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && bytes(value) <= max

export interface HistoryMaintenanceTerminalManifest {
  format: typeof FORMAT
  schemaVersion: 1
  state: TerminalState
  kind: string
  /** Hash of the exact original recovery JSON, not of this terminal manifest. */
  originalPayloadHash: string
  originalPayloadBytes: number
  plan?: { fileIdentity: string; offset: number; bytes: number; hash: string; prefixHash?: string; lineCount: number }
  retired?: { count: number; hash: string }
  retained?: { count: number; hash: string }
  sourceRows?: { count: number; hash: string }
  retiredRowIds?: { count: number; hash: string }
  before?: string
  after?: string
  cleared?: number
  freedTokens?: number
}

export interface HistoryMaintenanceCompactionResult {
  scanned: number
  compacted: number
  skippedCorrupt: number
  originalPayloadBytes: number
  storedPayloadBytes: number
  /** Logical payload bytes only; SQLite file allocation is not reclaimed here. */
  reclaimedPayloadBytes: number
  afterId?: string
  hasMore: boolean
}
export interface HistoryMaintenanceCompactionOptions {
  batchSize?: number
  maxRows?: number
  /** A legacy single row larger than the budget is processed alone. */
  maxPayloadBytes?: number
  afterId?: string
  /** Cancellation is observed between committed batches, never halfway through a transaction. */
  signal?: AbortSignal
}
export interface HistoryMaintenanceStorageStats {
  pendingRows: number
  pendingPayloadBytes: number
  committedRows: number
  invalidatedRows: number
  terminalPayloadBytes: number
  uncompactedTerminalRows: number
  uncompactedTerminalPayloadBytes: number
  compactedRows: number
  originalPayloadBytes: number
  reclaimedPayloadBytes: number
}

/** Additive sidecar keeps old INSERT ... VALUES writers compatible with the original table. */
export function ensureHistoryMaintenanceStorageSchema(db: Client): Promise<void> {
  let pending = schemas.get(db)
  if (!pending) {
    pending = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_history_maintenance (
        maintenance_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,backend TEXT NOT NULL,
        root_run_id TEXT NOT NULL,root_attempt_id TEXT NOT NULL,invocation_run_id TEXT NOT NULL,
        history_epoch INTEGER NOT NULL,anchor_id TEXT NOT NULL,anchor_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','committed','invalidated')),
        committed_at INTEGER)`)
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_history_maintenance_pending
        ON collaboration_history_maintenance(tenant_id,session_id,backend,state)`)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_history_maintenance_compactions (
        maintenance_id TEXT PRIMARY KEY,format_version INTEGER NOT NULL CHECK(format_version=1),
        terminal_state TEXT NOT NULL CHECK(terminal_state IN ('committed','invalidated')),
        original_payload_hash TEXT NOT NULL,original_payload_bytes INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,manifest_bytes INTEGER NOT NULL,compacted_at INTEGER NOT NULL)`)
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_history_maintenance_terminal
        ON collaboration_history_maintenance(state,maintenance_id)`)
    })().catch(error => { schemas.delete(db); throw error })
    schemas.set(db, pending)
  }
  return pending
}

function corruption(message: string): Error { return Object.assign(new Error('History maintenance payload cannot be compacted: ' + message), { code: 'HISTORY_MAINTENANCE_PAYLOAD_CORRUPT' }) }
function isCorrupt(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'HISTORY_MAINTENANCE_PAYLOAD_CORRUPT' }
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key))

function readPayload(json: string, expectedHash: string): Record<string, unknown> & { kind: string } {
  if (!hash(expectedHash) || digest(json) !== expectedHash) throw corruption('hash mismatch')
  let value: unknown
  try { value = JSON.parse(json) } catch { throw corruption('invalid JSON') }
  if (!object(value) || !text(value.kind, 64)) throw corruption('invalid kind')
  return value as Record<string, unknown> & { kind: string }
}

function readTerminalManifest(json: string, expectedHash: string, state: TerminalState): HistoryMaintenanceTerminalManifest {
  const value = readPayload(json, expectedHash)
  if (value.format !== FORMAT || value.schemaVersion !== 1 || value.state !== state || !hash(value.originalPayloadHash)
    || !integer(value.originalPayloadBytes) || !onlyKeys(value, ['format', 'schemaVersion', 'state', 'kind',
      'originalPayloadHash', 'originalPayloadBytes', 'plan', 'retired', 'retained', 'sourceRows', 'retiredRowIds',
      'before', 'after', 'cleared', 'freedTokens'])) throw corruption('invalid terminal manifest')
  if (value.plan !== undefined) {
    const plan = value.plan
    if (!object(plan) || !onlyKeys(plan, ['fileIdentity', 'offset', 'bytes', 'hash', 'prefixHash', 'lineCount'])
      || !text(plan.fileIdentity) || !integer(plan.offset) || !integer(plan.bytes) || !hash(plan.hash)
      || !integer(plan.lineCount) || plan.prefixHash !== undefined && !hash(plan.prefixHash)) throw corruption('invalid terminal plan')
  }
  for (const key of ['retired', 'retained', 'sourceRows', 'retiredRowIds'] as const) {
    const item = value[key]
    if (item !== undefined && (!object(item) || !onlyKeys(item, ['count', 'hash']) || !integer(item.count) || !hash(item.hash)))
      throw corruption('invalid terminal ' + key)
  }
  for (const key of ['before', 'after'] as const) if (value[key] !== undefined && !text(value[key])) throw corruption('invalid terminal ' + key)
  for (const key of ['cleared', 'freedTokens'] as const) if (value[key] !== undefined && !integer(value[key])) throw corruption('invalid terminal ' + key)
  return value as unknown as HistoryMaintenanceTerminalManifest
}

/** No content, encoded rows or arbitrary metadata is copied into a terminal receipt. */
function terminalManifest(json: string, originalHash: string, state: TerminalState): HistoryMaintenanceTerminalManifest {
  const value = readPayload(json, originalHash)
  // A manifest and its audit row are written atomically; either one alone is corruption.
  if (value.format === FORMAT) throw corruption('terminal manifest has no audit row')
  const manifest: HistoryMaintenanceTerminalManifest = { format: FORMAT, schemaVersion: 1, state, kind: value.kind,
    originalPayloadHash: originalHash, originalPayloadBytes: bytes(json) }
  if (value.plan !== undefined) {
    const plan = value.plan
    if (!object(plan) || !text(plan.fileIdentity) || !integer(plan.offset) || !integer(plan.bytes) || !hash(plan.hash)
      || typeof plan.encoded !== 'string' || !plan.encoded.endsWith('\n') || bytes(plan.encoded) !== plan.bytes
      || digest(plan.encoded) !== plan.hash || plan.prefixHash !== undefined && !hash(plan.prefixHash)) throw corruption('invalid recovery plan')
    let lineCount = 0
    for (let index = 0; index < plan.encoded.length; index++) if (plan.encoded.charCodeAt(index) === 10) lineCount++
    manifest.plan = { fileIdentity: plan.fileIdentity, offset: plan.offset, bytes: plan.bytes, hash: plan.hash,
      ...(plan.prefixHash !== undefined ? { prefixHash: plan.prefixHash as string } : {}), lineCount }
  }
  for (const key of ['retired', 'retained', 'sourceRows', 'retiredRowIds'] as const) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key])) throw corruption('invalid ' + key)
    manifest[key] = { count: value[key].length, hash: digest(JSON.stringify(value[key])) }
  }
  for (const key of ['before', 'after'] as const) {
    if (value[key] === undefined) continue
    if (!text(value[key])) throw corruption('invalid ' + key)
    manifest[key] = value[key]
  }
  for (const key of ['cleared', 'freedTokens'] as const) {
    if (value[key] === undefined) continue
    if (!integer(value[key])) throw corruption('invalid ' + key)
    manifest[key] = value[key]
  }
  return manifest
}

async function writeManifest(tx: Transaction, row: Row, state: TerminalState, at: number,
  fromPending = false): Promise<{ original: number; stored: number }> {
  const current = (await tx.execute({ sql: 'SELECT * FROM collaboration_history_maintenance_compactions WHERE maintenance_id=?', args: [row.maintenance_id] })).rows[0]
  if (current) {
    const manifest = readTerminalManifest(String(row.payload_json), String(row.payload_hash), state)
    if (row.state !== state || Number(current.format_version) !== 1 || current.terminal_state !== state || current.manifest_hash !== row.payload_hash
      || current.original_payload_hash !== manifest.originalPayloadHash || Number(current.original_payload_bytes) !== manifest.originalPayloadBytes
      || Number(current.manifest_bytes) !== bytes(String(row.payload_json))) throw corruption('terminal audit mismatch')
    return { original: 0, stored: 0 }
  }
  const manifest = terminalManifest(String(row.payload_json), String(row.payload_hash), state)
  const json = JSON.stringify(manifest), manifestHash = digest(json), manifestBytes = bytes(json)
  // Keep the committed SQL spelling stable for existing transaction ACK fault injection.
  const sql = state === 'committed'
    ? `UPDATE collaboration_history_maintenance SET state='committed',committed_at=COALESCE(committed_at,?),payload_json=?,payload_hash=? WHERE maintenance_id=? AND state=? AND payload_hash=?`
    : `UPDATE collaboration_history_maintenance SET state='invalidated',payload_json=?,payload_hash=? WHERE maintenance_id=? AND state=? AND payload_hash=?`
  const args = [...(state === 'committed' ? [at] : []), json, manifestHash, row.maintenance_id, fromPending ? 'pending' : state, row.payload_hash]
  const changed = await tx.execute({ sql, args })
  if (changed.rowsAffected !== 1) throw new Error('History maintenance terminal state changed during compaction')
  await tx.execute({ sql: `INSERT INTO collaboration_history_maintenance_compactions
    (maintenance_id,format_version,terminal_state,original_payload_hash,original_payload_bytes,manifest_hash,manifest_bytes,compacted_at)
    VALUES(?,1,?,?,?,?,?,?)`, args: [row.maintenance_id, state, manifest.originalPayloadHash, manifest.originalPayloadBytes, manifestHash, manifestBytes, at] })
  return { original: manifest.originalPayloadBytes, stored: manifestBytes }
}

/** Caller owns the same physical transaction as peer retirement, after file fsync and verification. */
export async function finalizeHistoryMaintenance(tx: Transaction, maintenanceId: string, committedAt = Date.now()): Promise<void> {
  if (!integer(committedAt)) throw new RangeError('Invalid maintenance commit time')
  const row = (await tx.execute({ sql: 'SELECT maintenance_id,state,payload_json,payload_hash FROM collaboration_history_maintenance WHERE maintenance_id=?', args: [maintenanceId] })).rows[0]
  if (!row || !['pending', 'committed'].includes(String(row.state))) throw new Error('History maintenance reservation is unavailable')
  await writeManifest(tx, row, 'committed', committedAt, row.state === 'pending')
}

/** The caller has revoked this scope's durable epoch in this same transaction. */
export async function invalidatePendingHistoryMaintenance(tx: Transaction, scope: Scope): Promise<void> {
  const ids = (await tx.execute({ sql: `SELECT maintenance_id FROM collaboration_history_maintenance
    WHERE tenant_id=? AND session_id=? AND backend='jsonl' AND state='pending'`, args: [scope.tenantId, scope.sessionId] })).rows
  for (const id of ids) {
    const row = (await tx.execute({ sql: 'SELECT maintenance_id,state,payload_json,payload_hash FROM collaboration_history_maintenance WHERE maintenance_id=?', args: [id.maintenance_id] })).rows[0]
    if (!row) throw new Error('History maintenance reservation disappeared during invalidation')
    try { await writeManifest(tx, row, 'invalidated', Date.now(), true) }
    catch (error) {
      if (!isCorrupt(error)) throw error
      // Revocation must still succeed, but unverifiable bytes remain available for diagnosis.
      await tx.execute({ sql: `UPDATE collaboration_history_maintenance SET state='invalidated' WHERE maintenance_id=? AND state='pending'`, args: [row.maintenance_id] })
    }
  }
}

const pendingTerminal = `h.state IN ('committed','invalidated') AND NOT EXISTS
  (SELECT 1 FROM collaboration_history_maintenance_compactions c WHERE c.maintenance_id=h.maintenance_id)`

/** Bounded migration; every batch releases SQL ownership. Pending recovery payloads are never selected. */
export async function compactTerminalHistoryMaintenance(db: Client, options: HistoryMaintenanceCompactionOptions = {}): Promise<HistoryMaintenanceCompactionResult> {
  const batchSize = options.batchSize ?? 16, maxRows = options.maxRows ?? 128, maxPayloadBytes = options.maxPayloadBytes ?? 8 * 1024 * 1024
  if (!integer(batchSize) || batchSize < 1 || batchSize > 256 || !integer(maxRows) || maxRows < 1 || maxRows > 100_000
    || !integer(maxPayloadBytes) || maxPayloadBytes < 1 || options.afterId !== undefined && !text(options.afterId)) throw new RangeError('Invalid maintenance compaction budget')
  await ensureHistoryMaintenanceStorageSchema(db)
  const result: HistoryMaintenanceCompactionResult = { scanned: 0, compacted: 0, skippedCorrupt: 0, originalPayloadBytes: 0, storedPayloadBytes: 0, reclaimedPayloadBytes: 0, hasMore: false }
  let after = options.afterId ?? '', processedBytes = 0, exhausted = false
  while (result.scanned < maxRows && processedBytes < maxPayloadBytes && !exhausted && !options.signal?.aborted) {
    const tx = await db.transaction('write')
    const batch = { scanned: 0, compacted: 0, skipped: 0, original: 0, stored: 0, processed: 0, after }
    try {
      const candidates = (await tx.execute({ sql: `SELECT h.maintenance_id,length(CAST(h.payload_json AS BLOB)) AS payload_bytes
        FROM collaboration_history_maintenance h WHERE ${pendingTerminal} AND h.maintenance_id>? ORDER BY h.maintenance_id LIMIT ?`,
        args: [after, Math.min(batchSize, maxRows - result.scanned)] })).rows
      if (!candidates.length) exhausted = true
      for (const candidate of candidates) {
        const rowBytes = Number(candidate.payload_bytes)
        if (result.scanned + batch.scanned > 0 && processedBytes + batch.processed + rowBytes > maxPayloadBytes) { exhausted = true; break }
        const row = (await tx.execute({ sql: 'SELECT maintenance_id,state,payload_json,payload_hash FROM collaboration_history_maintenance WHERE maintenance_id=?', args: [candidate.maintenance_id] })).rows[0]
        if (!row) throw new Error('History maintenance reservation disappeared during compaction')
        batch.scanned++; batch.processed += rowBytes; batch.after = String(candidate.maintenance_id)
        try {
          const changed = await writeManifest(tx, row, row.state as TerminalState, Date.now())
          batch.compacted++; batch.original += changed.original; batch.stored += changed.stored
        } catch (error) { if (!isCorrupt(error)) throw error; batch.skipped++ }
      }
      await tx.commit()
    } catch (error) { if (!tx.closed) await tx.rollback(); throw error }
    finally { tx.close() }
    result.scanned += batch.scanned; result.compacted += batch.compacted; result.skippedCorrupt += batch.skipped
    result.originalPayloadBytes += batch.original; result.storedPayloadBytes += batch.stored
    processedBytes += batch.processed; after = batch.after
  }
  result.reclaimedPayloadBytes = Math.max(0, result.originalPayloadBytes - result.storedPayloadBytes)
  if (after) result.afterId = after
  result.hasMore = Boolean((await db.execute({ sql: `SELECT 1 FROM collaboration_history_maintenance h WHERE ${pendingTerminal} AND h.maintenance_id>? LIMIT 1`, args: [after] })).rows.length)
  return result
}

/** Aggregate diagnostics only. Never initializes a missing table or returns original content. */
export async function getHistoryMaintenanceStorageStats(db: Client): Promise<HistoryMaintenanceStorageStats> {
  const empty: HistoryMaintenanceStorageStats = { pendingRows: 0, pendingPayloadBytes: 0, committedRows: 0, invalidatedRows: 0,
    terminalPayloadBytes: 0, uncompactedTerminalRows: 0, uncompactedTerminalPayloadBytes: 0, compactedRows: 0, originalPayloadBytes: 0, reclaimedPayloadBytes: 0 }
  const tables = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('collaboration_history_maintenance','collaboration_history_maintenance_compactions')")).rows.map(row => row.name))
  if (!tables.has('collaboration_history_maintenance')) return empty
  const compacted = tables.has('collaboration_history_maintenance_compactions')
  const rows = (await db.execute(`SELECT h.state,count(*) AS n,sum(length(CAST(h.payload_json AS BLOB))) AS payload_bytes,
    ${compacted ? 'sum(CASE WHEN c.maintenance_id IS NULL THEN 0 ELSE 1 END)' : '0'} AS compacted,
    ${compacted ? 'sum(CASE WHEN c.maintenance_id IS NULL THEN length(CAST(h.payload_json AS BLOB)) ELSE 0 END)' : 'sum(length(CAST(h.payload_json AS BLOB)))'} AS uncompacted_bytes,
    ${compacted ? 'sum(COALESCE(c.original_payload_bytes,0))' : '0'} AS original_bytes,
    ${compacted ? 'sum(CASE WHEN c.maintenance_id IS NULL THEN 0 ELSE length(CAST(h.payload_json AS BLOB)) END)' : '0'} AS compacted_bytes
    FROM collaboration_history_maintenance h ${compacted ? 'LEFT JOIN collaboration_history_maintenance_compactions c ON c.maintenance_id=h.maintenance_id' : ''} GROUP BY h.state`)).rows
  let compactedPayloadBytes = 0
  for (const row of rows) {
    if (row.state === 'pending') { empty.pendingRows = Number(row.n); empty.pendingPayloadBytes = Number(row.payload_bytes); continue }
    if (row.state === 'committed') empty.committedRows = Number(row.n)
    if (row.state === 'invalidated') empty.invalidatedRows = Number(row.n)
    empty.terminalPayloadBytes += Number(row.payload_bytes); empty.compactedRows += Number(row.compacted)
    empty.uncompactedTerminalRows += Number(row.n) - Number(row.compacted); empty.uncompactedTerminalPayloadBytes += Number(row.uncompacted_bytes)
    empty.originalPayloadBytes += Number(row.original_bytes)
    compactedPayloadBytes += Number(row.compacted_bytes)
  }
  empty.reclaimedPayloadBytes = Math.max(0, empty.originalPayloadBytes - compactedPayloadBytes)
  return empty
}

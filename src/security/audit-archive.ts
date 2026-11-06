import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { Row } from '@libsql/client'
import { auditDigest, hydrateAuditEvidence } from './audit-payloads.js'

export interface AuditArchiveReceipt {
  tenantId: string; archiveId: string; relativePath: string; eventCount: number
  firstId: number; lastId: number; firstAt: number; lastAt: number; compressedBytes: number
}

export function defaultAuditArchiveDirectory(): string {
  return path.resolve(process.env.AUDIT_ARCHIVE_DIR ?? path.join(path.dirname(path.resolve(process.env.DATA_DIR ?? './data/agent.db')), 'audit-archive'))
}

function archivePath(root: string, relativePath: string): string {
  // Receipts contain generated hashes and numeric IDs only; never trust a DB path as arbitrary filesystem authority.
  if (!/^[a-f0-9]{64}[/\\]\d+-\d+-[a-f0-9]{64}\.jsonl\.gz$/.test(relativePath)) throw new Error('Invalid audit archive path')
  const resolved = path.resolve(root, relativePath)
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Audit archive escapes its directory')
  return resolved
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try { handle = await fs.open(directory, 'r'); await handle.sync() }
  catch (error) {
    // Windows does not expose fsync(directory); the archive itself was fsynced before atomic rename.
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EACCES', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally { await handle?.close() }
}

async function syncArchive(file: string, root: string): Promise<void> {
  // FlushFileBuffers on Windows requires a writable handle even though no bytes are changed.
  const handle = await fs.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
  await syncDirectory(path.dirname(file))
  await syncDirectory(path.resolve(root))
  await syncDirectory(path.dirname(path.resolve(root)))
}

export async function readAuditArchive(root: string, receipt: Pick<AuditArchiveReceipt, 'relativePath' | 'archiveId' | 'compressedBytes'>): Promise<Buffer> {
  const file = archivePath(root, receipt.relativePath)
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== receipt.compressedBytes) throw new Error('Audit archive is missing or changed')
  const data = await fs.readFile(file)
  if (auditDigest(data) !== receipt.archiveId) throw new Error('Audit archive checksum mismatch')
  return data
}

/** Durable, self-contained evidence must exist before any online row can be deleted. */
export async function writeAuditArchive(root: string, tenantId: string, rows: Row[]): Promise<AuditArchiveReceipt> {
  if (!rows.length || rows.some(row => row.tenant_id !== tenantId)) throw new Error('An audit archive must contain one tenant')
  const events = rows.map(row => {
    const evidence = hydrateAuditEvidence(row)
    return {
      id: Number(row.id), tenantId, sessionId: row.session_id, category: row.category,
      target: evidence.target, detailsJson: evidence.details, decision: row.decision,
      ruleId: row.rule_id, reason: evidence.reason, createdAt: Number(row.created_at),
    }
  })
  const content = [JSON.stringify({ format: 'aether-security-audit', version: 1, tenantId, eventCount: events.length }),
    ...events.map(event => JSON.stringify(event))].join('\n') + '\n'
  const compressed = gzipSync(Buffer.from(content))
  const archiveId = auditDigest(compressed)
  const ids = events.map(event => event.id), times = events.map(event => event.createdAt)
  const receipt: AuditArchiveReceipt = {
    tenantId, archiveId, relativePath: `${auditDigest(tenantId)}/${Math.min(...ids)}-${Math.max(...ids)}-${archiveId}.jsonl.gz`,
    eventCount: events.length, firstId: Math.min(...ids), lastId: Math.max(...ids),
    firstAt: Math.min(...times), lastAt: Math.max(...times), compressedBytes: compressed.length,
  }
  const file = archivePath(root, receipt.relativePath)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await readAuditArchive(root, receipt)
    // A previous rename may have succeeded while directory fsync failed. Re-establish durability on retries too.
    await syncArchive(file, root)
    return receipt // A previous attempt published the archive before its DB transaction failed.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(compressed); await handle.sync() }
  catch (error) { await handle.close(); await fs.unlink(temporary).catch(() => {}); throw error }
  await handle.close()
  try {
    await fs.rename(temporary, file)
    await syncArchive(file, root)
    await readAuditArchive(root, receipt)
  } finally { await fs.unlink(temporary).catch(() => {}) }
  return receipt
}

/** Used by offline readers and tests without any dependency on the online payload table. */
export function decodeAuditArchive(data: Uint8Array): { header: Record<string, unknown>; events: Record<string, unknown>[] } {
  const lines = gunzipSync(data).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const [header, ...events] = lines
  if (header?.format !== 'aether-security-audit' || header.version !== 1 || header.eventCount !== events.length) throw new Error('Invalid audit archive')
  return { header, events }
}

import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { AgentContext } from '../../core/agent-context/index.js'
import { ChangeStore } from '../../storage/changes/index.js'
import { readFileVersion } from '../../shared/file-version.js'
import { captureCreatedDirectories, missingParentDirectories } from '../../storage/changes/directories.js'
import { describeFileBytes, type FileWriteReceipt } from './write-receipt.js'

/** Snapshot payloads are bounded; hashes always describe the complete file bytes. */
const changeStore = new ChangeStore()
export const MAX_CHANGE_CONTENT_BYTES = 100_000
const BINARY_EXTENSIONS = new Set([
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.zip', '.gz', '.7z', '.rar', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.node',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
])

/** Text edits and reversible snapshots must preserve the complete UTF-8 bytes. */
export function decodeEditableText(filePath: string, content: Buffer): string | null {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || content.includes(0)) return null
  const text = content.toString('utf8')
  return Buffer.from(text, 'utf8').equals(content) ? text : null
}

export interface ChangeSnapshot {
  oldContent: string | null
  oldHash: string
  exists: boolean
  truncated: boolean
  /** Opaque durable byte snapshot for large/binary files. */
  snapshotRef?: string
  missingParents?: string[]
}

/** Capture already-read bytes only when a command observation really changed.
 * This avoids writing durable rollback files for every unchanged workspace file. */
export function snapshotFromBytes(absPath: string, content: Buffer | null): ChangeSnapshot {
  if (content === null) return { oldContent: null, oldHash: 'missing', exists: false, truncated: false }
  const hash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`
  const text = content.byteLength > MAX_CHANGE_CONTENT_BYTES ? null : decodeEditableText(absPath, content)
  const truncated = text === null
  return { oldContent: text, oldHash: hash, exists: true, truncated,
    ...(truncated ? { snapshotRef: writeSnapshot(content, hash) } : {}) }
}

function snapshotRoot(): string {
  const dataDir = process.env.DATA_DIR
    ? path.dirname(path.resolve(process.env.DATA_DIR))
    : path.resolve('data')
  const root = path.join(dataDir, 'change-snapshots')
  fs.mkdirSync(root, { recursive: true })
  return root
}

function writeSnapshot(bytes: Buffer, hash: string): string {
  // Keep references portable across Windows and POSIX filesystems.
  const ref = `${hash.replace(/[^a-zA-Z0-9_-]/g, '_')}-${crypto.randomUUID()}.bin`
  const destination = path.join(snapshotRoot(), ref)
  const temporary = `${destination}.${process.pid}.tmp`
  fs.writeFileSync(temporary, bytes, { flag: 'wx' })
  fs.renameSync(temporary, destination)
  return ref
}

function discardSnapshot(ref: string | undefined): void {
  if (!ref || !/^[a-zA-Z0-9_-]+\.bin$/.test(ref)) return
  try { fs.unlinkSync(path.join(snapshotRoot(), ref)) } catch { /* best effort cleanup */ }
}

/** A rejected conditional write never publishes this rollback record. */
export function discardUnpublishedSnapshot(snapshot: ChangeSnapshot): void { discardSnapshot(snapshot.snapshotRef) }

/** Restore a pre-write snapshot without materializing a large file in JS memory. */
export function restoreSnapshot(absPath: string, snapshot: ChangeSnapshot): void {
  if (snapshot.snapshotRef) {
    if (!/^[a-zA-Z0-9_-]+\.bin$/.test(snapshot.snapshotRef)) throw new Error('Invalid change snapshot reference')
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.copyFileSync(path.join(snapshotRoot(), snapshot.snapshotRef), absPath)
    return
  }
  if (snapshot.oldContent === null) {
    try { fs.unlinkSync(absPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, snapshot.oldContent, 'utf8')
}

/** Call while holding the canonical file lock. Read failures prevent mutation. */
export async function readOldSnapshot(absPath: string): Promise<ChangeSnapshot> {
  const { content, hash } = await readFileVersion(absPath)
  if (content === null) return { oldContent: null, oldHash: hash, exists: false, truncated: false, missingParents: missingParentDirectories(absPath) }
  const text = content.byteLength > MAX_CHANGE_CONTENT_BYTES ? null : decodeEditableText(absPath, content)
  // Invalid UTF-8 cannot be faithfully restored from a SQLite text snapshot.
  const truncated = text === null || !Buffer.from(text, 'utf8').equals(content)
  return { oldContent: truncated ? null : text, oldHash: hash, exists: true, truncated,
    snapshotRef: truncated ? writeSnapshot(content, hash) : undefined }
}

export class ChangeRecordingError extends Error {
  constructor(cause: unknown) {
    super(`文件已变更，但改动记录保存失败，无法从改动面板撤回: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ChangeRecordingError'
  }
}

/** Read the handler's actual output, including formatting and generated formats. */
export async function commitWriteChange(
  ctx: AgentContext,
  displayPath: string,
  absPath: string,
  snapshot: ChangeSnapshot,
): Promise<Record<string, unknown>> {
  return (await recordWriteChange(ctx, displayPath, absPath, snapshot, false)).change
}

/** Facts are returned separately and are never added to the durable change model. */
export async function commitWriteChangeWithReceipt(
  ctx: AgentContext, displayPath: string, absPath: string, snapshot: ChangeSnapshot,
): Promise<{ change: Record<string, unknown>; receipt: FileWriteReceipt }> {
  const result = await recordWriteChange(ctx, displayPath, absPath, snapshot, true)
  return { change: result.change, receipt: result.receipt! }
}

async function recordWriteChange(
  ctx: AgentContext, displayPath: string, absPath: string, snapshot: ChangeSnapshot, includeReceipt: boolean,
): Promise<{ change: Record<string, unknown>; receipt?: FileWriteReceipt }> {
  let afterSnapshotRef: string | undefined
  try {
    // Snapshot, hash and receipt must refer to exactly the same observed bytes.
    // A second read after awaiting SQLite could mix two external file versions.
    const observed = await readFileVersion(absPath)
    const after = snapshotFromBytes(absPath, observed.content)
    afterSnapshotRef = after.snapshotRef
    const receipt = includeReceipt ? describeFileBytes(absPath, observed,
      observed.content === null ? null : decodeEditableText(absPath, observed.content)) : undefined
    const change = await changeStore.record(ctx.tenantId, {
      sessionId: ctx.rootSessionId ?? ctx.sessionId, path: absPath, kind: 'write',
      ...(ctx.parentSessionId && ctx.runId ? { producerChildSessionId: ctx.sessionId, producerRunId: ctx.runId } : {}),
      turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId, runId: ctx.rootRunId,
      oldContent: snapshot.oldContent, newContent: after.oldContent,
      oldHash: snapshot.oldHash, newHash: after.oldHash,
      oldSnapshotRef: snapshot.snapshotRef, newSnapshotRef: after.snapshotRef,
      truncated: snapshot.truncated || after.truncated,
      createdDirectories: captureCreatedDirectories(absPath, snapshot.missingParents ?? []),
    })
    return { change: { ...change, displayPath, isNew: !snapshot.exists }, ...(receipt ? { receipt } : {}) }
  } catch (error) {
    discardSnapshot(snapshot.snapshotRef)
    discardSnapshot(afterSnapshotRef)
    ctx.logger.warn({ err: error }, '[change-recorder] 文件已写入，但记录失败')
    throw new ChangeRecordingError(error)
  }
}

/** Record only after the trash operation succeeds, using its pre-delete snapshot. */
export async function commitDeleteChange(
  ctx: AgentContext,
  displayPath: string,
  absPath: string,
  snapshot: ChangeSnapshot,
): Promise<Record<string, unknown>> {
  let afterSnapshotRef: string | undefined
  try {
    const after = await readOldSnapshot(absPath)
    afterSnapshotRef = after.snapshotRef
    const change = await changeStore.record(ctx.tenantId, {
      sessionId: ctx.rootSessionId ?? ctx.sessionId, path: absPath, kind: 'delete',
      ...(ctx.parentSessionId && ctx.runId ? { producerChildSessionId: ctx.sessionId, producerRunId: ctx.runId } : {}),
      turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId, runId: ctx.rootRunId,
      oldContent: snapshot.oldContent, newContent: after.oldContent,
      oldHash: snapshot.oldHash, newHash: after.oldHash,
      oldSnapshotRef: snapshot.snapshotRef, newSnapshotRef: after.snapshotRef,
      truncated: snapshot.truncated || after.truncated,
    })
    return { ...change, displayPath, isNew: false }
  } catch (error) {
    discardSnapshot(snapshot.snapshotRef)
    discardSnapshot(afterSnapshotRef)
    ctx.logger.warn({ err: error }, '[change-recorder] 文件已删除，但记录失败')
    throw new ChangeRecordingError(error)
  }
}

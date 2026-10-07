import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { AgentContext } from '../../core/agent-context/index.js'
import { ChangeStore } from '../../storage/changes/index.js'
import { readFileVersion } from '../../shared/file-version.js'

/** Snapshot payloads are bounded; hashes always describe the complete file bytes. */
const changeStore = new ChangeStore()
export const MAX_CHANGE_CONTENT_BYTES = 100_000
const BINARY_EXTENSIONS = new Set([
  '.xlsx', '.xls', '.docx', '.doc', '.pdf',
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
  if (content === null) return { oldContent: null, oldHash: hash, exists: false, truncated: false }
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
  let afterSnapshotRef: string | undefined
  try {
    const after = await readOldSnapshot(absPath)
    afterSnapshotRef = after.snapshotRef
    const change = await changeStore.record(ctx.tenantId, {
      sessionId: ctx.rootSessionId ?? ctx.sessionId, path: absPath, kind: 'write',
      turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId, runId: ctx.rootRunId,
      oldContent: snapshot.oldContent, newContent: after.oldContent,
      oldHash: snapshot.oldHash, newHash: after.oldHash,
      oldSnapshotRef: snapshot.snapshotRef, newSnapshotRef: after.snapshotRef,
      truncated: snapshot.truncated || after.truncated,
    })
    return { ...change, displayPath, isNew: !snapshot.exists }
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

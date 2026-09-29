import path from 'node:path'
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
}

/** Call while holding the canonical file lock. Read failures prevent mutation. */
export async function readOldSnapshot(absPath: string): Promise<ChangeSnapshot> {
  const { content, hash } = await readFileVersion(absPath)
  if (content === null) return { oldContent: null, oldHash: hash, exists: false, truncated: false }
  const text = content.byteLength > MAX_CHANGE_CONTENT_BYTES ? null : decodeEditableText(absPath, content)
  // Invalid UTF-8 cannot be faithfully restored from a SQLite text snapshot.
  const truncated = text === null || !Buffer.from(text, 'utf8').equals(content)
  return { oldContent: truncated ? null : text, oldHash: hash, exists: true, truncated }
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
  try {
    const after = await readOldSnapshot(absPath)
    const change = await changeStore.record(ctx.tenantId, {
      sessionId: ctx.rootSessionId ?? ctx.sessionId, path: absPath, kind: 'write',
      turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId, runId: ctx.rootRunId,
      oldContent: snapshot.oldContent, newContent: after.oldContent,
      oldHash: snapshot.oldHash, newHash: after.oldHash,
      truncated: snapshot.truncated || after.truncated,
    })
    return { ...change, displayPath, isNew: !snapshot.exists }
  } catch (error) {
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
  try {
    const after = await readOldSnapshot(absPath)
    const change = await changeStore.record(ctx.tenantId, {
      sessionId: ctx.rootSessionId ?? ctx.sessionId, path: absPath, kind: 'delete',
      turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId, runId: ctx.rootRunId,
      oldContent: snapshot.oldContent, newContent: after.oldContent,
      oldHash: snapshot.oldHash, newHash: after.oldHash,
      truncated: snapshot.truncated || after.truncated,
    })
    return { ...change, displayPath, isNew: false }
  } catch (error) {
    ctx.logger.warn({ err: error }, '[change-recorder] 文件已删除，但记录失败')
    throw new ChangeRecordingError(error)
  }
}

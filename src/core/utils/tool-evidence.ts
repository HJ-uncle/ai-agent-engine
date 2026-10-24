import path from 'node:path'
import type { Message } from '../agent-context/types.js'
import { imageFileVersion, imageToolPayload } from './multimodal-context.js'

export const CLEARED_TOOL_RESULT = '[tool result cleared]'
export const TOOL_FILE_EVIDENCE_KEY = '__aetherFileEvidence'
export const CLEARED_TOOL_EVIDENCE_KEY = '__aetherClearedToolEvidence'
export const MAX_CLEARED_TOOL_CONTENT_CHARS = 2048
const MAX_INDEX_CHARS = 1280

type FileEvidence = { path: string; expectedHash: string }
type ClearedToolEvidence = {
  version: 1
  messageId?: string
  toolCallId?: string
  toolName?: string
  hadNativeImage: boolean
  file?: FileEvidence
}

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : undefined
}

function fileEvidence(value: unknown): FileEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>, filePath = bounded(record.path, 768)
  if (!filePath || !(path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath))
    || typeof record.expectedHash !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(record.expectedHash)) return undefined
  return { path: filePath, expectedHash: record.expectedHash }
}

/** Called only for a successful, registry-authenticated builtin read_file result.
 * Never infer a file hash from arbitrary output text or an image dataURL hash. */
export function captureFileEvidence(metadata: unknown): FileEvidence | undefined {
  return fileEvidence(imageFileVersion(metadata))
}

/** The private receipt is created by settlement and invalidated by content edits.
 * A matching public tool name or fileVersion shape alone carries no provenance. */
export function capturedFileEvidence(message: Message): FileEvidence | undefined {
  return message.role === 'tool' && message.toolName === 'read_file'
    ? fileEvidence(message.metadata?.[TOOL_FILE_EVIDENCE_KEY]) : undefined
}

export function withoutToolEvidence(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata
  const { [TOOL_FILE_EVIDENCE_KEY]: _file, [CLEARED_TOOL_EVIDENCE_KEY]: _cleared, ...rest } = metadata as Record<string, unknown>
  return rest
}

function hasNativeImage(content: Message['content'] | undefined): boolean {
  if (typeof content === 'string') return imageToolPayload(content) !== undefined
  return Array.isArray(content) && content.some(part => part && typeof part === 'object'
    && (part.type === 'image_url' || part.type === 'image'))
}

/** Only storage-owned identities and the explicitly captured builtin file receipt
 * become the index. Arbitrary tool metadata, previews and output never do. */
export function clearedToolEvidence(message: Message): ClearedToolEvidence {
  const evidence: ClearedToolEvidence = {
    version: 1,
    messageId: bounded(message.id, 128),
    toolCallId: bounded(message.toolCallId, 128),
    toolName: typeof message.toolName === 'string' && /^[\w.:-]{1,80}$/.test(message.toolName) ? message.toolName : undefined,
    hadNativeImage: hasNativeImage(message.modelInputContent ?? message.content),
    file: capturedFileEvidence(message),
  }
  if (JSON.stringify(evidence).length > MAX_INDEX_CHARS) delete evidence.file
  return evidence
}

export function isClearedToolMessage(message: Message): boolean {
  return message.role === 'tool' && message.content === CLEARED_TOOL_RESULT
}

/** Revalidate persisted indexes, including their association with this row.
 * A copied/edited metadata object must not redirect recovery to another message. */
function readEvidence(message: Message): ClearedToolEvidence | undefined {
  const stored: unknown = message.metadata?.[CLEARED_TOOL_EVIDENCE_KEY]
  if (!stored || typeof stored !== 'object') return undefined
  const value = stored as Record<string, unknown>
  if (value.version !== 1 || typeof value.hadNativeImage !== 'boolean'
    || value.messageId !== bounded(message.id, 128) || value.toolCallId !== bounded(message.toolCallId, 128)
    || value.toolName !== (typeof message.toolName === 'string' && /^[\w.:-]{1,80}$/.test(message.toolName) ? message.toolName : undefined)) return undefined
  const result: ClearedToolEvidence = { version: 1, messageId: bounded(message.id, 128), toolCallId: bounded(message.toolCallId, 128),
    toolName: value.toolName as string | undefined, hadNativeImage: value.hadNativeImage,
    file: message.toolName === 'read_file' ? fileEvidence(value.file) : undefined }
  if (JSON.stringify(result).length > MAX_INDEX_CHARS) delete result.file
  return result
}

export function clearedToolModelContent(message: Message, searchHistoryAvailable = false): string {
  const evidence = readEvidence(message)
  if (!evidence) return CLEARED_TOOL_RESULT
  const recovery = searchHistoryAvailable && evidence.messageId
    ? { tool: 'search_history', args: { messageId: evidence.messageId, limit: 1 },
      ...(evidence.hadNativeImage ? { imageArgs: { messageId: evidence.messageId, imageIndex: 0 } } : {}) }
    : 'No archive recovery tool is available in this request.'
  const render = () => CLEARED_TOOL_RESULT + '\nEvidence index only; original output/pixels are not in context. '
    + JSON.stringify({ ...evidence, ...(evidence.file ? { hashDomain: 'file-bytes' } : {}), recovery })
  let output = render()
  if (output.length > MAX_CLEARED_TOOL_CONTENT_CHARS) { delete evidence.file; output = render() }
  return output.length <= MAX_CLEARED_TOOL_CONTENT_CHARS ? output : CLEARED_TOOL_RESULT
}

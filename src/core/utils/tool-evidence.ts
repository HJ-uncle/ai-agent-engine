import path from 'node:path'
import type { Message, ToolCall, ToolResult } from '../agent-context/types.js'
import { imageFileVersion, imageToolPayload } from './multimodal-context.js'

export const CLEARED_TOOL_RESULT = '[tool result cleared]'
export const TOOL_FILE_EVIDENCE_KEY = '__aetherFileEvidence'
export const TOOL_FILE_BATCH_EVIDENCE_KEY = '__aetherFileBatchEvidence'
export const TOOL_OFFICE_EVIDENCE_KEY = '__aetherOfficeEvidence'
export const TOOL_SCREENSHOT_EVIDENCE_KEY = '__aetherScreenshotEvidence'
export const CLEARED_TOOL_EVIDENCE_KEY = '__aetherClearedToolEvidence'
export const MAX_CLEARED_TOOL_CONTENT_CHARS = 2048
const MAX_INDEX_CHARS = 1280
const MAX_OFFICE_EVIDENCE_CHARS = 768
const MAX_FILE_BATCH_EVIDENCE_CHARS = 880
const OFFICE_TOOLS = new Set(['office_document', 'office_inspect', 'workbench_render'])
const OFFICE_OPERATIONS = new Set(['create', 'edit', 'append_sheets', 'recalculate', 'inspect', 'render'])
type OfficeItem = Partial<FileEvidence> & {
  success: boolean; requestPath?: string; code?: string; format?: string; sizeBytes?: number
  page?: number; pageCount?: number; unit?: string
  returnedRange?: [number, number]; nextOffset?: number | null; sourceTruncated?: boolean
  summary?: Record<string, number>; warningCount?: number
}
type OfficeEvidence = { operation: string; success: boolean; code?: string; files: OfficeItem[]; omittedFiles?: number; evidenceScope: 'tool-receipt' }

type FileEvidence = { path: string; expectedHash: string }
type FileReadItem = Partial<FileEvidence> & {
  success: boolean; requestPath?: string; code?: string
  startLine?: number; endLine?: number; startColumn?: number; endColumn?: number; columnUnit?: 'utf16'
  hasMore?: boolean; nextStartLine?: number; nextStartColumn?: number
  partialLine?: boolean; rangeIsComplete?: boolean; contentIsComplete?: boolean
}
type FileBatchEvidence = { files: FileReadItem[]; omittedFiles?: number; evidenceScope: 'file-read-receipts' }
type FileBatchReceipt = FileBatchEvidence & { messageId: string; toolCallId: string }
type ScreenshotEvidence = FileEvidence & { width: number; height: number; evidenceScope: 'saved-file-receipt' }
type ScreenshotReceipt = ScreenshotEvidence & { messageId: string; toolCallId: string }
type ClearedToolEvidence = {
  version: 1
  messageId?: string
  toolCallId?: string
  toolName?: string
  hadNativeImage: boolean
  file?: FileEvidence
  fileBatch?: FileBatchEvidence
  office?: OfficeEvidence
  screenshot?: ScreenshotEvidence
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function fileReadItem(value: unknown): FileReadItem | undefined {
  const row = object(value)
  if (typeof row.success !== 'boolean') return undefined
  if (!row.success) {
    const requestPath = bounded(row.requestPath ?? row.path, 512), code = errorCode(row.code)
    return { success: false, ...(requestPath ? { requestPath } : {}), ...(code ? { code } : {}) }
  }
  const file = fileEvidence(row)
  if (!file) return undefined
  const result: FileReadItem = { success: true, ...file }
  if (count(row.startLine) && row.startLine > 0 && count(row.endLine) && row.endLine >= row.startLine) {
    result.startLine = row.startLine; result.endLine = row.endLine
    if (row.columnUnit === 'utf16' && count(row.startColumn) && row.startColumn > 0 && count(row.endColumn)) {
      result.startColumn = row.startColumn; result.endColumn = row.endColumn; result.columnUnit = 'utf16'
    }
  }
  for (const key of ['hasMore', 'partialLine', 'rangeIsComplete', 'contentIsComplete'] as const) {
    if (typeof row[key] === 'boolean') result[key] = row[key]
  }
  if (row.hasMore === true) for (const key of ['nextStartLine', 'nextStartColumn'] as const) {
    if (count(row[key]) && row[key] > 0) result[key] = row[key]
  }
  // Pagination and clipping cannot turn an explicit partial receipt into a
  // complete read. Missing coverage fields remain unknown, never inferred.
  if (row.hasMore === true || row.outputTruncated === true || row.sourceTruncated === true) {
    if (result.contentIsComplete === true) delete result.contentIsComplete
    if (result.rangeIsComplete === true) delete result.rangeIsComplete
  }
  // Starting in the middle of a line can still exhaust the requested range.
  if (row.partialLine === true && result.contentIsComplete === true) delete result.contentIsComplete
  if (result.rangeIsComplete === false && result.contentIsComplete === true) delete result.contentIsComplete
  return result
}

function fileBatchEvidence(value: unknown): FileBatchEvidence | undefined {
  const row = object(value)
  if (!Array.isArray(row.files)) return undefined
  const files = row.files.slice(0, 16).map(fileReadItem).filter((item): item is FileReadItem => !!item)
  let omitted = (count(row.omittedFiles) ? row.omittedFiles : 0) + row.files.length - files.length
  const result: FileBatchEvidence = { files, evidenceScope: 'file-read-receipts' }
  // Omit whole items instead of shortening paths or returning partial JSON.
  while (files.length && JSON.stringify({ ...result, omittedFiles: omitted }).length > MAX_FILE_BATCH_EVIDENCE_CHARS) {
    files.pop(); omitted++
  }
  if (omitted) result.omittedFiles = omitted
  return result
}

/** The authenticated builtin's per-item metadata describes the bytes actually
 * returned. A mixed failure retains successful siblings, not invented ranges. */
export function captureFileBatchEvidence(result: ToolResult, identity: Pick<Message, 'id' | 'toolCallId'>): FileBatchReceipt | undefined {
  const metadata = object(result.metadata), messageId = bounded(identity.id, 128), toolCallId = bounded(identity.toolCallId, 128)
  if (!messageId || !toolCallId || metadata.batch !== true || !Array.isArray(metadata.files)
    || metadata.outputTruncated === true || result.status && !['succeeded', 'failed'].includes(result.status)) return undefined
  const evidence = fileBatchEvidence(metadata)
  return evidence ? { ...evidence, messageId, toolCallId } : undefined
}

function capturedFileBatchEvidence(message: Message): FileBatchEvidence | undefined {
  const receipt = object(message.metadata?.[TOOL_FILE_BATCH_EVIDENCE_KEY])
  if (message.role !== 'tool' || message.toolName !== 'read_file'
    || !bounded(message.id, 128) || !bounded(message.toolCallId, 128)
    || receipt.messageId !== message.id || receipt.toolCallId !== message.toolCallId) return undefined
  return fileBatchEvidence(receipt)
}

function screenshotEvidence(value: unknown): ScreenshotEvidence | undefined {
  const row = object(value), file = fileEvidence(row)
  if (!file || !count(row.width) || row.width === 0 || !count(row.height) || row.height === 0) return undefined
  return { ...file, width: row.width, height: row.height, evidenceScope: 'saved-file-receipt' }
}

/** Only settlement of the authenticated save builtin may create this receipt.
 * These dimensions describe saved bytes, never a visual inspection or approval. */
export function captureScreenshotEvidence(result: ToolResult, identity: Pick<Message, 'id' | 'toolCallId'>): ScreenshotReceipt | undefined {
  const messageId = bounded(identity.id, 128), toolCallId = bounded(identity.toolCallId, 128), metadata = object(result.metadata)
  if (!result.success || (result.status !== undefined && result.status !== 'succeeded') || metadata.screenshotSaved !== true
    || !messageId || !toolCallId) return undefined
  const receipt = screenshotEvidence(metadata)
  return receipt ? { ...receipt, messageId, toolCallId } : undefined
}

function capturedScreenshotEvidence(message: Message): ScreenshotEvidence | undefined {
  const receipt = object(message.metadata?.[TOOL_SCREENSHOT_EVIDENCE_KEY])
  if (message.role !== 'tool' || message.toolName !== 'browser_save_screenshot'
    || !bounded(message.id, 128) || !bounded(message.toolCallId, 128)
    || receipt.messageId !== message.id || receipt.toolCallId !== message.toolCallId) return undefined
  return screenshotEvidence(receipt)
}
function errorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : undefined
}
function officeItem(value: unknown): OfficeItem | undefined {
  const row = object(value)
  if (typeof row.success !== 'boolean') return undefined
  const item: OfficeItem = { success: row.success }
  const file = fileEvidence(row)
  if (row.success && file) Object.assign(item, file)
  // A failed request's path is a label, never proof of an existing file/version.
  else if (!row.success) item.requestPath = bounded(row.requestPath, 512)
  else return undefined
  const code = errorCode(row.code)
  if (code) item.code = code
  if (['docx', 'xlsx', 'pptx', 'pdf'].includes(String(row.format))) item.format = String(row.format)
  for (const key of ['sizeBytes', 'page', 'pageCount', 'warningCount'] as const) if (count(row[key])) item[key] = row[key]
  if (item.page !== undefined && (item.page < 1 || item.page > 100)) delete item.page
  if (item.pageCount !== undefined && (item.pageCount < 1 || item.pageCount > 100)) delete item.pageCount
  if (['page', 'section', 'content-chunk'].includes(String(row.unit))) item.unit = String(row.unit)
  if (Array.isArray(row.returnedRange) && row.returnedRange.length === 2 && row.returnedRange.every(count)
    && row.returnedRange[1] >= row.returnedRange[0]) item.returnedRange = [row.returnedRange[0], row.returnedRange[1]]
  if (row.nextOffset === null || count(row.nextOffset)) item.nextOffset = row.nextOffset
  if (typeof row.sourceTruncated === 'boolean') item.sourceTruncated = row.sourceTruncated
  const summary = object(row.summary), counts: Record<string, number> = {}
  for (const key of ['pages', 'slides', 'sections', 'sheets', 'cells', 'charts', 'images', 'formulas', 'formulaCaches', 'pendingFormulas', 'errorCells']) {
    if (count(summary[key])) counts[key] = summary[key]
  }
  if (Object.keys(counts).length) item.summary = counts
  return item
}
function officeEvidence(value: unknown): OfficeEvidence | undefined {
  const row = object(value)
  if (!OFFICE_OPERATIONS.has(String(row.operation)) || typeof row.success !== 'boolean' || !Array.isArray(row.files)) return undefined
  const files = row.files.slice(0, 16).map(officeItem).filter((item): item is OfficeItem => !!item)
  const result: OfficeEvidence = { operation: String(row.operation), success: row.success, files, evidenceScope: 'tool-receipt' }
  const code = errorCode(row.code)
  if (code) result.code = code
  let omitted = count(row.omittedFiles) ? row.omittedFiles : 0
  omitted += row.files.length - files.length
  for (const item of files) {
    if (JSON.stringify(result).length <= MAX_OFFICE_EVIDENCE_CHARS) break
    delete item.summary
  }
  while (files.length && JSON.stringify({ ...result, omittedFiles: omitted }).length > MAX_OFFICE_EVIDENCE_CHARS) { files.pop(); omitted++ }
  if (omitted) result.omittedFiles = omitted
  return result
}

/** Called at settlement only after registry identity authentication. Whitelisted
 * scalar receipts survive clearing; document prose/pixels and model verdicts do not. */
export function captureOfficeEvidence(call: Pick<ToolCall, 'name' | 'args'>, result: ToolResult): OfficeEvidence | undefined {
  if (!OFFICE_TOOLS.has(call.name)) return undefined
  const args = object(call.args), operation = call.name === 'workbench_render' ? 'render'
    : call.name === 'office_inspect' ? 'inspect' : String(args.operation)
  let receipt: Record<string, unknown> = {}
  // Native render images are already bounded by the bridge. Never parse arbitrary unbounded output.
  if (result.output.length <= 7 * 1024 * 1024) {
    try { receipt = object(JSON.parse(result.output)) } catch { /* Failed render receipts may be plain text. */ }
  }
  const metadata = object(result.metadata)
  const rows = Array.isArray(receipt.files) ? receipt.files.slice(0, 16) : [{ success: result.success, output: receipt }]
  const files = rows.map((value, index) => {
    const row = object(value), data = object(row.output), success = row.success === true
    const requested = object(Array.isArray(args.files) ? args.files[index] : args)
    const meta = object(Array.isArray(metadata.files) ? metadata.files[index] : metadata)
    const identity = fileEvidence(data) ?? fileEvidence(object(data.fileVersion)) ?? fileEvidence(meta)
    const page = object(data.contentPage)
    const renderUnit = ['page', 'section', 'content-chunk'].includes(String(meta.unit)) ? String(meta.unit)
      : (data.format ?? meta.format) === 'docx' ? 'section' : (data.format ?? meta.format) === 'xlsx' ? 'content-chunk' : 'page'
    return { success, ...(success && identity ? identity : { requestPath: requested.path }),
      code: meta.code ?? meta.error ?? row.error ?? result.error, format: data.format ?? meta.format,
      sizeBytes: data.sizeBytes ?? meta.sizeBytes, summary: data.summary,
      warningCount: Array.isArray(data.warnings) ? data.warnings.length : undefined,
      ...(count(page.offset) && count(page.returnedChars) ? { returnedRange: [page.offset, page.offset + page.returnedChars],
        nextOffset: page.nextOffset, sourceTruncated: page.sourceTruncated } : {}),
      ...(operation === 'render' ? { page: data.page ?? meta.page ?? requested.page ?? 1, pageCount: data.pageCount ?? meta.pageCount,
        ...(success ? { unit: renderUnit } : {}) } : {}),
    }
  })
  return officeEvidence({ operation, success: result.success, code: metadata.code ?? result.error, files })
}

export function withoutToolEvidence(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata
  const { [TOOL_FILE_EVIDENCE_KEY]: _file, [TOOL_FILE_BATCH_EVIDENCE_KEY]: _fileBatch, [TOOL_OFFICE_EVIDENCE_KEY]: _office,
    [TOOL_SCREENSHOT_EVIDENCE_KEY]: _screenshot, [CLEARED_TOOL_EVIDENCE_KEY]: _cleared, ...rest } = metadata as Record<string, unknown>
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
    fileBatch: capturedFileBatchEvidence(message),
    office: OFFICE_TOOLS.has(message.toolName ?? '') ? officeEvidence(message.metadata?.[TOOL_OFFICE_EVIDENCE_KEY]) : undefined,
    screenshot: capturedScreenshotEvidence(message),
  }
  if (JSON.stringify(evidence).length > MAX_INDEX_CHARS) delete evidence.file
  if (JSON.stringify(evidence).length > MAX_INDEX_CHARS) delete evidence.screenshot
  if (JSON.stringify(evidence).length > MAX_INDEX_CHARS) delete evidence.fileBatch
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
    file: message.toolName === 'read_file' ? fileEvidence(value.file) : undefined,
    fileBatch: message.toolName === 'read_file' ? fileBatchEvidence(value.fileBatch) : undefined,
    office: OFFICE_TOOLS.has(message.toolName ?? '') ? officeEvidence(value.office) : undefined,
    screenshot: message.toolName === 'browser_save_screenshot' ? screenshotEvidence(value.screenshot) : undefined }
  if (JSON.stringify(result).length > MAX_INDEX_CHARS) delete result.file
  if (JSON.stringify(result).length > MAX_INDEX_CHARS) delete result.screenshot
  if (JSON.stringify(result).length > MAX_INDEX_CHARS) delete result.fileBatch
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
    + JSON.stringify({ ...evidence, ...(evidence.file || evidence.screenshot || evidence.fileBatch?.files.some(file => file.success) ? { hashDomain: 'file-bytes' } : {}), recovery })
  let output = render()
  if (output.length > MAX_CLEARED_TOOL_CONTENT_CHARS) { delete evidence.file; output = render() }
  return output.length <= MAX_CLEARED_TOOL_CONTENT_CHARS ? output : CLEARED_TOOL_RESULT
}

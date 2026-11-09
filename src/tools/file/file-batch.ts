import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext, JSONSchema, Tool, ToolResult } from '../../core/agent-context/index.js'
import { boundedToolContext, getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { imageToolPayload } from '../../core/utils/multimodal-context.js'
import { workspaceManager } from '../../workspace/index.js'
import { canonicalFilePathSync } from '../../shared/file-version.js'
import { normalizeWriteFileArgs } from '../../shared/write-file-args.js'
import { IMAGE_MIME_TYPES } from './constants.js'
import { handlerRegistry } from './handlers/registry.js'
import { TextHandler } from './handlers/text-handler.js'
import { decodeEditableText } from './change-recorder.js'

const MAX_BATCH_FILES = 16
const readScopes = new WeakSet<AgentContext>()
export const isFileBatchReadContext = (ctx: AgentContext): boolean => readScopes.has(ctx)
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
export const hasFileBatch = (args: unknown): boolean => record(args) && Object.hasOwn(args, 'files')

/** Preserve the legacy single-file shape; a batch is exclusively {files:[...]}. */
export function fileBatchSchema(single: JSONSchema): JSONSchema {
  return { type: 'object', properties: { ...single.properties,
    files: { type: 'array', minItems: 1, maxItems: MAX_BATCH_FILES,
      description: 'Independent files in one tool call and one combined receipt. Do not mix with top-level single-file fields. Split batches that exceed the shared output budget.',
      items: { ...single, additionalProperties: false } } },
    oneOf: [
      { required: single.required ?? [], ...(single.oneOf ? { oneOf: single.oneOf } : {}), not: { required: ['files'] } },
      { required: ['files'], not: { anyOf: Object.keys(single.properties ?? {}).map(key => ({ required: [key] })) } },
    ] }
}

export function batchFailure(ctx: AgentContext, code: string, message: string): ToolResult {
  const limit = getToolOutputLimit(ctx.toolProfile, ctx)
  const candidates = [JSON.stringify({ code, message, fileMutationApplied: false }), JSON.stringify({ code }), '{}', '0']
  return { success: false, error: code, output: candidates.find(value => value.length <= limit) ?? '0',
    metadata: { code, batch: true, fileMutationApplied: false } }
}

function batchItems(raw: unknown, ctx: AgentContext): { files: Record<string, unknown>[] } | ToolResult {
  if (!record(raw) || Object.keys(raw).some(key => key !== 'files') || !Array.isArray(raw.files)
    || raw.files.length < 1 || raw.files.length > MAX_BATCH_FILES || raw.files.some(item => !record(item) || Object.hasOwn(item, 'files'))) {
    return batchFailure(ctx, 'FILE_BATCH_INVALID_ARGUMENTS', 'Use only files:[{single-file arguments}], with 1 to 16 independent files; nested batches and mixed top-level arguments are invalid.')
  }
  return { files: raw.files as Record<string, unknown>[] }
}

function invalidRead(item: Record<string, unknown>): boolean {
  return typeof item.path !== 'string' || !item.path.trim() || Object.keys(item).some(key => !['path', 'mode', 'start_line', 'end_line', 'start_column'].includes(key))
    || item.mode !== undefined && !['auto', 'full', 'summary', 'vision', 'ocr', 'exact'].includes(String(item.mode))
    || ['start_line', 'end_line', 'start_column'].some(key => item[key] !== undefined && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 1))
    || item.start_line !== undefined && item.end_line !== undefined && Number(item.end_line) < Number(item.start_line)
}

type BatchRow = { path: string; success: boolean; output: unknown; error?: string; status?: string }
const envelope = (files: BatchRow[]) => JSON.stringify({ batch: true, files })
function allocateReadBudgets(files: Record<string, unknown>[], ctx: AgentContext, available: number): number[] {
  // Only stat known paths: tiny files should not reserve the same output share
  // as large files. Estimates affect allocation only; actual paging enforces it.
  const desired = files.map(item => {
    try {
      const safe = workspaceManager.resolveSafePath(ctx, String(item.path))
      return Math.max(512, 900 + JSON.stringify(safe).length + fs.statSync(safe).size * 2)
    } catch { return 900 }
  })
  const budgets = files.map(() => 512)
  let remaining = available - budgets.reduce((sum, budget) => sum + budget, 0)
  let active = files.map((_, index) => index)
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length))
    for (const index of active) {
      const increment = Math.min(remaining, share, Math.max(0, desired[index] - budgets[index]))
      budgets[index] += increment; remaining -= increment
    }
    active = active.filter(index => budgets[index] < desired[index])
  }
  return budgets
}
function readRow(item: Record<string, unknown>, result: ToolResult): BatchRow {
  let output: unknown = result.output
  try { output = JSON.parse(result.output) } catch { /* legacy format readers return text */ }
  return { path: String(item.path), success: result.success, output,
    ...(!result.success ? { error: result.error ?? 'FILE_READ_FAILED' } : {}), ...(result.status ? { status: result.status } : {}) }
}

/** Expose a waiting decision before ReAct starts any sibling tool in the model
 * response. Single-file calls fall through, so registry preflight cannot recurse. */
export async function preflightFileReadBatch(raw: unknown, ctx: AgentContext): Promise<ToolResult | undefined> {
  if (!hasFileBatch(raw)) return undefined
  const parsed = batchItems(raw, ctx)
  if (!('files' in parsed)) return parsed
  if (parsed.files.some(invalidRead)) return batchFailure(ctx, 'FILE_BATCH_INVALID_ARGUMENTS', 'Each read needs valid single-file arguments. No files were read.')
  for (const item of parsed.files) {
    if (ctx.signal?.aborted) return batchFailure(ctx, 'FILE_BATCH_CANCELLED', 'Cancelled before reading any file.')
    const decision = await ctx.tools?.preflight?.('read_file', item, ctx)
    if (decision) return { ...decision, metadata: { ...decision.metadata, batch: true, fileMutationApplied: false } }
  }
  return undefined
}

export async function readFileBatch(raw: unknown, ctx: AgentContext, single: Tool): Promise<ToolResult> {
  const parsed = batchItems(raw, ctx)
  if (!('files' in parsed)) return parsed
  const { files } = parsed
  if (files.some(invalidRead)) return batchFailure(ctx, 'FILE_BATCH_INVALID_ARGUMENTS', 'Each read needs a nonempty path, a supported mode, and positive integer ranges. No files were read.')
  const limit = getToolOutputLimit(ctx.toolProfile, ctx)
  // Account for each path and wrapper separately; parsed inner JSON is embedded
  // directly, avoiding unbounded double escaping of backslashes and source text.
  const overhead = envelope(files.map(item => ({ path: String(item.path), success: false, output: null,
    error: 'FILE_BATCH_REQUIRES_SINGLE_READ', status: 'cancelled' }))).length + files.length * 16
  const allowance = Math.floor((limit - overhead) / files.length)
  if (allowance < 512) return batchFailure(ctx, 'FILE_BATCH_OUTPUT_BUDGET', 'The shared output budget cannot fit independent file receipts. Use fewer files or increase the output budget; no files were read.')
  const blocked = await preflightFileReadBatch(raw, ctx)
  if (blocked) return blocked
  const budgets = allocateReadBudgets(files, ctx, limit - overhead)
  const results = await Promise.all(files.map(async (item, index) => {
    const itemAllowance = budgets[index]
    const bounded = boundedToolContext(ctx, itemAllowance)
    readScopes.add(bounded)
    if (ctx.signal?.aborted) return batchFailure(bounded, 'FILE_BATCH_CANCELLED', 'Read cancelled before execution.')
    if (item.mode === 'vision' || item.mode === 'ocr' || Object.hasOwn(IMAGE_MIME_TYPES, path.extname(String(item.path)).toLowerCase())) {
      return batchFailure(bounded, 'FILE_BATCH_REQUIRES_SINGLE_READ', 'Images, vision and OCR require a separate single-file read_file call. No pixels or OCR content were read by this batch.')
    }
    let result: ToolResult
    try { result = await ctx.tools?.preflight?.('read_file', item, bounded) ?? await single.execute(item, bounded) }
    catch (error) { result = batchFailure(bounded, 'FILE_READ_FAILED', error instanceof Error ? error.message : String(error)) }
    if (imageToolPayload(result.output)) return batchFailure(bounded, 'FILE_BATCH_REQUIRES_SINGLE_READ', 'Native image output cannot be embedded in a file batch. Read this file separately; no image pixels were sent to the model.')
    const row = readRow(item, result)
    const contentSize = JSON.stringify(row.output).length
    if (contentSize > itemAllowance) {
      return { ...batchFailure(bounded, 'FILE_BATCH_REQUIRES_SINGLE_READ', 'This format/range exceeds its batch allowance. Read a narrower range or use the single-file interface; no content from this item is included.'),
        metadata: { ...result.metadata, batch: true, contentIsComplete: false, fileMutationApplied: false } }
    }
    return result
  }))
  const rows = files.map((item, index) => readRow(item, results[index]))
  const output = envelope(rows)
  // No text slicing: every successful item's page/identity remains valid JSON.
  if (output.length > limit) return batchFailure(ctx, 'FILE_BATCH_OUTPUT_BUDGET', 'File receipts exceed the shared output budget. Retry a smaller batch; no files were modified.')
  const waiting = results.find(result => result.needsConfirmation || result.status === 'waiting')
  return { success: results.every(result => result.success), output,
    ...(waiting ? { needsConfirmation: true, status: 'waiting' as const, pendingAction: waiting.pendingAction } : {}),
    metadata: { batch: true, fileMutationApplied: false,
      files: results.map((result, index) => ({ path: files[index].path, success: result.success, ...result.metadata })) } }
}

interface WriteTarget { args: Record<string, unknown>; path: string; sourcePath?: string; identity: string; sourceIdentity?: string }
const identity = (file: string): string => {
  try { const stat = fs.statSync(file); if (stat.ino) return `${stat.dev}:${stat.ino}` } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return process.platform === 'win32' ? file.toLowerCase() : file
}
const pathKey = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file

/** Only fixed, useful receipt fields go to the model. Complete metadata and
 * change records stay attached to ToolResult for durable/UI consumers. */
function writeRow(target: WriteTarget, result: ToolResult): BatchRow {
  const metadata = result.metadata ?? {}
  const receipt: Record<string, unknown> = {}
  for (const key of ['expectedHash', 'sha256', 'byteLength', 'encoding', 'utf8Bom', 'trailingLineEnding', 'trailingNewlineCount',
    'sourcePath', 'sourceExpectedHash', 'copyVerified', 'actualHash', 'fileMutationApplied', 'rollbackAvailable']) {
    if (metadata[key] !== undefined) receipt[key] = metadata[key]
  }
  // A partial write can carry its measured version on the durable change even
  // if formatting its normal success receipt failed.
  if (receipt.expectedHash === undefined && typeof result.change?.newHash === 'string') receipt.expectedHash = result.change.newHash
  if (typeof result.change?.id === 'string') receipt.changeId = result.change.id
  if (typeof metadata.textPreview === 'string' && metadata.textPreviewIsComplete === true) receipt.textPreviewOmitted = true
  if (!result.success) {
    let message = result.output.slice(0, 160)
    while (JSON.stringify(message).length > 202) message = message.slice(0, -1)
    receipt.message = message
  }
  return { path: target.path, success: result.success, output: receipt,
    ...(!result.success ? { error: (result.error ?? 'FILE_WRITE_FAILED').slice(0, 64) } : {}), ...(result.status ? { status: result.status } : {}) }
}

function maximumWriteRow(target: WriteTarget): BatchRow {
  return { path: target.path, success: false, status: 'interrupted', error: 'E'.repeat(64), output: {
    expectedHash: 'sha256:' + 'f'.repeat(64), sha256: 'f'.repeat(64), byteLength: Number.MAX_SAFE_INTEGER,
    encoding: 'binary-or-non-utf8', utf8Bom: false, trailingLineEnding: 'CRLF', trailingNewlineCount: Number.MAX_SAFE_INTEGER,
    ...(target.sourcePath ? { sourcePath: target.sourcePath, sourceExpectedHash: 'sha256:' + 'f'.repeat(64), copyVerified: false } : {}),
    actualHash: 'sha256:' + 'f'.repeat(64), fileMutationApplied: false, rollbackAvailable: false, message: 'x'.repeat(200),
    changeId: 'x'.repeat(64), textPreviewOmitted: true,
  } }
}

function prepareWrites(raw: unknown, ctx: AgentContext): { targets: WriteTarget[] } | ToolResult {
  const parsed = batchItems(raw, ctx)
  if (!('files' in parsed)) return parsed
  const targets: WriteTarget[] = []
  try {
    for (const args of parsed.files) {
      const normalized = normalizeWriteFileArgs(args)
      if (!normalized.ok) return batchFailure(ctx, normalized.error.code, normalized.error.message)
      if (Object.keys(args).some(key => !['path', 'data', 'content', 'copyFrom', 'expectedHash', 'createOnly', 'trailingNewline'].includes(key))) {
        return batchFailure(ctx, 'WRITE_INVALID_ARGUMENTS', 'Unknown per-file argument; no files were written.')
      }
      const target = canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, normalized.args.path))
      workspaceManager.resolveSafePath(ctx, target)
      const sourcePath = normalized.args.copyFrom ? canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, normalized.args.copyFrom.path)) : undefined
      if (sourcePath) workspaceManager.resolveSafePath(ctx, sourcePath)
      if (normalized.args.trailingNewline && normalized.args.trailingNewline !== 'preserve'
        && (!(handlerRegistry.getHandler(target) instanceof TextHandler) || typeof normalized.args.data !== 'string'
          || decodeEditableText(target, Buffer.from(normalized.args.data, 'utf8')) !== normalized.args.data)) {
        return batchFailure(ctx, 'WRITE_INVALID_ARGUMENTS', 'trailingNewline formatting requires an ordinary UTF-8 text string. No files were written.')
      }
      targets.push({ args, path: target, sourcePath, identity: identity(target), ...(sourcePath ? { sourceIdentity: identity(sourcePath) } : {}) })
    }
    if (targets.some((target, index) => targets.some((other, j) => index !== j && (target.identity === other.identity
      || pathKey(target.path).startsWith(pathKey(other.path) + path.sep))))) {
      return batchFailure(ctx, 'FILE_BATCH_TARGET_CONFLICT', 'Batch destinations must be distinct files without aliases or ancestor/descendant conflicts. No files were written.')
    }
    if (targets.some(target => target.sourceIdentity && targets.some(other => target.sourceIdentity === other.identity))) {
      return batchFailure(ctx, 'FILE_BATCH_COPY_DEPENDENCY', 'copyFrom sources cannot be destinations in the same batch. Finish the source write first and use its actual receipt in a later call. No files were written.')
    }
    // Reserve a worst-case fixed receipt before any mutation, including escaped
    // error text. Paths are known now; successful receipts never include file bodies.
    const budget = envelope(targets.map(maximumWriteRow)).length
    if (budget > getToolOutputLimit(ctx.toolProfile, ctx)) return batchFailure(ctx, 'FILE_BATCH_OUTPUT_BUDGET', 'This write batch cannot fit all on-disk receipts in the shared output budget. Split it or increase the output budget. No files were written.')
    return { targets }
  } catch (error) { return batchFailure(ctx, 'FILE_BATCH_PATH_INVALID', `${error instanceof Error ? error.message : String(error)} No files were written.`) }
}

export async function preflightFileWriteBatch(raw: unknown, ctx: AgentContext): Promise<ToolResult | undefined> {
  if (!hasFileBatch(raw)) return undefined
  const prepared = prepareWrites(raw, ctx)
  if (!('targets' in prepared)) return prepared
  for (const target of prepared.targets) {
    if (ctx.signal?.aborted) return batchFailure(ctx, 'FILE_BATCH_CANCELLED', 'Cancelled before the batch; no files were written.')
    const decision = await ctx.tools?.preflight?.('write_file', target.args, ctx)
    if (decision) return { ...decision, metadata: { ...decision.metadata, batch: true, fileMutationApplied: false } }
  }
  return undefined
}

export async function writeFileBatch(raw: unknown, ctx: AgentContext, single: Tool): Promise<ToolResult> {
  const prepared = prepareWrites(raw, ctx)
  if (!('targets' in prepared)) return prepared
  const blocked = await preflightFileWriteBatch(raw, ctx)
  if (blocked) return blocked
  const results: ToolResult[] = []
  let stop = false
  for (const target of prepared.targets) {
    if (stop || ctx.signal?.aborted) {
      results.push({ ...batchFailure(ctx, 'FILE_BATCH_CANCELLED', 'Not executed: the batch was cancelled or its policy changed.'), status: ctx.signal?.aborted ? 'cancelled' : 'interrupted' })
      continue
    }
    try {
      const decision = await ctx.tools?.preflight?.('write_file', target.args, ctx)
      if (decision) {
        // Do not park a partially-mutated batch as a pending tool: its complete
        // receipts must persist now. The caller may retry remaining files later.
        results.push({ ...decision, needsConfirmation: false, status: 'failed',
          error: decision.error ?? 'FILE_BATCH_POLICY_CHANGED', output: decision.output,
          metadata: { ...decision.metadata, fileMutationApplied: false } })
        stop = true
      } else {
        // Permission hooks may await user/policy state. Recheck aliases after
        // that await, immediately before the single writer acquires its locks.
        if (pathKey(canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, String(target.args.path)))) !== pathKey(target.path)
          || identity(target.path) !== target.identity
          || target.sourcePath && record(target.args.copyFrom)
            && pathKey(canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, String(target.args.copyFrom.path)))) !== pathKey(target.sourcePath)) {
          results.push(batchFailure(ctx, 'FILE_BATCH_PATH_CHANGED', 'File identity changed after batch validation; this item was not written.'))
          continue
        }
        results.push(await single.execute(target.args, ctx))
      }
    } catch (error) { results.push(batchFailure(ctx, 'FILE_WRITE_FAILED', error instanceof Error ? error.message : String(error))) }
  }
  const changes = results.flatMap(result => [...(result.change ? [result.change] : []), ...(result.changes ?? [])])
  const rows = prepared.targets.map((target, index) => writeRow(target, results[index]))
  // Preserve complete small-byte evidence when the batch has room. Never trim
  // a preview and then claim it is complete; hashes/versions take priority.
  for (const [index, result] of results.entries()) {
    const metadata = result.metadata ?? {}, receipt = rows[index].output as Record<string, unknown>
    if (typeof metadata.textPreview !== 'string' || metadata.textPreview.length > 256 || metadata.textPreviewIsComplete !== true) continue
    const candidate: Record<string, unknown> = { ...receipt, textPreview: metadata.textPreview, textPreviewIsComplete: true }
    delete candidate.textPreviewOmitted
    rows[index].output = candidate
    if (envelope(rows).length > getToolOutputLimit(ctx.toolProfile, ctx)) rows[index].output = receipt
  }
  return { success: results.every(result => result.success), output: envelope(rows),
    ...(changes.length ? { changes } : {}), metadata: { batch: true,
      fileMutationApplied: results.some(result => result.metadata?.fileMutationApplied === true || result.change || result.changes?.length),
      files: results.map((result, index) => ({ path: prepared.targets[index].path, success: result.success, ...result.metadata })) } }
}

import { createHash } from 'node:crypto'
import { SUBAGENT_PAYLOAD_MAX_BYTES, type SubagentPayloadReference } from './payload-files.js'

export const SUBAGENT_RESULT_SUMMARY_BYTES = 8192
export const SUBAGENT_RESULT_PAGE_BYTES = 64 * 1024
export const SUBAGENT_RESULT_TRUNCATION_NOTICE = '\n[摘要已截断；完整结果可用 subagent_read_result 分页读取]'

/** Small public locator. Readers resolve it from an owned run, never from caller-supplied hashes. */
export interface SubagentResultMetadata {
  resultRef: string
  resultHash: string
  resultBytes: number
  resultTruncated: boolean
  resultKind: 'final' | 'partial'
}
export interface SubagentResultPage {
  runId: string
  resultRef: string
  resultHash: string
  resultKind: 'final' | 'partial'
  encoding: 'utf8'
  offset: number
  totalBytes: number
  hasMore: boolean
  nextOffset?: number
  text: string
}

export function utf8Prefix(text: string, limitBytes: number): string {
  if (Buffer.byteLength(text) <= limitBytes) return text
  let bytes = 0, length = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > limitBytes) break
    bytes += size; length += character.length
  }
  return text.slice(0, length)
}

/** Reserve the notice inside the same UTF-8 budget used by store and wire projections. */
export function resultPreview(text: string, notice = SUBAGENT_RESULT_TRUNCATION_NOTICE): string {
  if (Buffer.byteLength(text) <= SUBAGENT_RESULT_SUMMARY_BYTES) return text
  return utf8Prefix(text, SUBAGENT_RESULT_SUMMARY_BYTES - Buffer.byteLength(notice)) + notice
}

export function resultMetadata(reference: SubagentPayloadReference, text: string, kind: 'final' | 'partial'): SubagentResultMetadata {
  return { resultRef: `subagent-result:v1:${reference.hash}`, resultHash: reference.hash, resultBytes: reference.bytes,
    resultTruncated: Buffer.byteLength(text) > SUBAGENT_RESULT_SUMMARY_BYTES, resultKind: kind }
}

export function checkedResultMetadata(value: Partial<SubagentResultMetadata>): SubagentResultMetadata | undefined {
  const keys = ['resultRef', 'resultHash', 'resultBytes', 'resultTruncated', 'resultKind'] as const
  if (keys.every(key => value[key] === undefined)) return undefined
  if (typeof value.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultHash)
    || value.resultRef !== `subagent-result:v1:${value.resultHash}`
    || !Number.isSafeInteger(value.resultBytes) || value.resultBytes! < 0 || value.resultBytes! > SUBAGENT_PAYLOAD_MAX_BYTES
    || typeof value.resultTruncated !== 'boolean' || !['final', 'partial'].includes(value.resultKind ?? ''))
    throw new Error('SUBAGENT_RECOVERY_REQUIRED: Invalid subagent result metadata')
  return Object.fromEntries(keys.map(key => [key, value[key]])) as unknown as SubagentResultMetadata
}

export function resultStorageReference(tenantId: string, metadata: SubagentResultMetadata): SubagentPayloadReference {
  checkedResultMetadata(metadata)
  return { format: 'aether-subagent-payload', version: 1, codec: 'gzip',
    tenantHash: createHash('sha256').update(tenantId).digest('hex'), hash: metadata.resultHash, bytes: metadata.resultBytes }
}

/** Keep the complete JSON receipt below ReAct's per-tool cap, including escaped control characters. */
export function fitResultPage(page: SubagentResultPage, maxChars: number): SubagentResultPage {
  if (JSON.stringify(page).length <= maxChars) return page
  const withText = (text: string): SubagentResultPage => {
    const next = page.offset + Buffer.byteLength(text), { nextOffset: _old, text: _text, ...header } = page
    return { ...header, hasMore: next < page.totalBytes, ...(next < page.totalBytes ? { nextOffset: next } : {}), text }
  }
  if (JSON.stringify(withText('')).length + 8 > maxChars) throw new RangeError('Tool output allowance is too small for a result page receipt')
  let low = 0, high = Buffer.byteLength(page.text)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (JSON.stringify(withText(utf8Prefix(page.text, mid))).length <= maxChars) low = mid
    else high = mid - 1
  }
  const fitted = withText(utf8Prefix(page.text, low))
  if (page.text && !fitted.text) throw new RangeError('Tool output allowance cannot carry a UTF-8 result character')
  return fitted
}

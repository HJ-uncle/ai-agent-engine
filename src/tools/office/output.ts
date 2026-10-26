import type { ToolResult } from '../../core/agent-context/index.js'

export interface OfficeInspection {
  format: 'docx' | 'xlsx' | 'pptx' | 'pdf'
  content: string
  summary: Record<string, number | string | boolean>
  warnings: string[]
}

export interface OfficeContentPage {
  offset?: number
  limit?: number
}

type ReceiptResult = { ok: true; output: string; contentTruncated: boolean }
  | { ok: false; code: 'OFFICE_OUTPUT_BUDGET_TOO_SMALL' | 'OFFICE_INVALID_CONTENT_OFFSET'; requiredChars?: number }

/** Offsets count UTF-16 units, as the loop cap does, but never split a surrogate pair. */
function prefix(text: string, length: number): string {
  const end = Math.min(length, text.length)
  return /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end))
    ? text.slice(0, end - 1) : text.slice(0, end)
}

/** Size the serialized receipt, including escaping, before the loop applies its text cap. */
export function officeReceipt(file: string, hash: string, bytes: number, inspection: OfficeInspection,
  maxChars: number, page?: OfficeContentPage, noChange = false): ReceiptResult {
  const offset = page?.offset ?? 0
  const content = inspection.content
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length
    || offset > 0 && /[\uDC00-\uDFFF]/.test(content.charAt(offset)) && /[\uD800-\uDBFF]/.test(content.charAt(offset - 1))) {
    return { ok: false, code: 'OFFICE_INVALID_CONTENT_OFFSET' }
  }
  const sourceTruncated = inspection.summary.previewTruncated === true
  const available = page ? content.slice(offset, offset + (page.limit ?? 32_000)) : ''
  // Apply the safe prefix to the original string too: an explicit page limit can cut an emoji.
  const requested = page ? prefix(content.slice(offset), available.length) : ''
  const encode = (count: number) => {
    const shown = prefix(requested, count)
    const end = offset + shown.length
    const truncated = sourceTruncated || !!page && (offset > 0 || end < content.length)
    return { output: JSON.stringify({ path: file, expectedHash: hash, sizeBytes: bytes,
      format: inspection.format, summary: inspection.summary, warnings: inspection.warnings,
      content: page ? shown : undefined, contentIncluded: !!page, contentTruncated: truncated,
      contentPage: page ? { offset, returnedChars: shown.length, totalPreviewChars: content.length,
        nextOffset: end < content.length ? end : null, hasMore: end < content.length,
        unit: 'utf16', scope: inspection.format === 'xlsx' ? 'stored-cell-text-preview' : 'main-document-text',
        sourceTruncated, documentComplete: false } : undefined,
      validation: 'structure-checked', visualValidation: 'not-performed',
      ...(noChange ? { noChange: true } : {}),
    }), contentTruncated: truncated }
  }
  const full = encode(requested.length)
  if (full.output.length <= maxChars && (!page || offset === content.length || requested.length > 0)) return { ok: true, ...full }
  // Never silently drop warning text or shorten the version/path to manufacture success.
  // Require progress for nonempty pages so retries cannot loop at the same cursor.
  const firstLength = page && offset < content.length ? (content.codePointAt(offset)! > 0xffff ? 2 : 1) : 0
  const minimum = encode(firstLength)
  if (minimum.output.length > maxChars || requested.length < firstLength) {
    return { ok: false, code: 'OFFICE_OUTPUT_BUDGET_TOO_SMALL', requiredChars: minimum.output.length }
  }
  let low = firstLength, high = requested.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encode(middle).output.length <= maxChars) low = middle
    else high = middle - 1
  }
  return { ok: true, ...encode(low) }
}

/** Errors also cross the same channel; long filenames/format errors must remain valid JSON. */
export function officeFailure(code: string, message: string, metadata: Record<string, unknown>, maxChars: number): ToolResult {
  const details = { code, fileMutationApplied: false, ...metadata }
  const encode = (length: number) => JSON.stringify({ message: prefix(message, length), ...details,
    ...(length < message.length ? { messageTruncated: true } : {}) })
  let output = encode(message.length)
  if (output.length > maxChars) {
    let low = 0, high = message.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (encode(middle).length <= maxChars) low = middle
      else high = middle - 1
    }
    output = encode(low)
  }
  if (output.length > maxChars) {
    output = JSON.stringify({ code, fileMutationApplied: details.fileMutationApplied,
      diagnosticsTruncated: true, message: 'Tool output budget cannot hold the complete diagnostic; increase TOOL_OUTPUT_MAX_CHARS.' })
  }
  if (output.length > maxChars) output = JSON.stringify({ code, fileMutationApplied: details.fileMutationApplied, diagnosticsTruncated: true })
  if (output.length > maxChars) output = maxChars >= 2 ? '{}' : '0'
  return { success: false, error: code, output, metadata: { ...details, ...(output !== encode(message.length) ? { diagnosticsTruncated: true } : {}) } }
}

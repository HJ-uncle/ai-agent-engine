import type { FileVersion } from '../../shared/file-version.js'

export interface FileWriteReceipt {
  path: string
  expectedHash: string
  sha256?: string
  byteLength: number | null
  encoding: 'utf-8' | 'binary-or-non-utf8' | 'missing'
  utf8Bom?: boolean
  trailingLineEnding?: 'LF' | 'CRLF' | 'CR' | 'none'
  /** Consecutive line separators at EOF; CRLF is one separator. */
  trailingNewlineCount?: number
  /** Complete raw text only, never a prefix or a trimmed representation. */
  textPreview?: string
  textPreviewIsComplete?: true
}

/** `text` must be decodeEditableText(path, version.content) from this same snapshot. */
export function describeFileBytes(filePath: string, version: FileVersion, text: string | null): FileWriteReceipt {
  const receipt: FileWriteReceipt = { path: filePath, expectedHash: version.hash,
    ...(version.hash.startsWith('sha256:') ? { sha256: version.hash.slice('sha256:'.length) } : {}),
    byteLength: version.content?.byteLength ?? null, encoding: version.content === null ? 'missing' : text === null ? 'binary-or-non-utf8' : 'utf-8' }
  if (version.content === null || text === null) return receipt
  let offset = text.length, trailingNewlineCount = 0
  while (offset > 0) {
    if (text[offset - 1] === '\n') offset -= offset > 1 && text[offset - 2] === '\r' ? 2 : 1
    else if (text[offset - 1] === '\r') offset--
    else break
    trailingNewlineCount++
  }
  return { ...receipt, utf8Bom: text.startsWith('\uFEFF'),
    trailingLineEnding: text.endsWith('\r\n') ? 'CRLF' : text.endsWith('\n') ? 'LF' : text.endsWith('\r') ? 'CR' : 'none',
    trailingNewlineCount, ...(text.length <= 256 ? { textPreview: text, textPreviewIsComplete: true as const } : {}) }
}

/** Preserve the established model-visible hash lines and JSON-escape raw previews. */
export function formatWriteReceipt(receipt: FileWriteReceipt): string {
  const { path: filePath, expectedHash, sha256, ...facts } = receipt
  return `path: ${filePath}\nexpectedHash: ${expectedHash}` + (sha256 ? `\nsha256: ${sha256}` : '') + `\nfileFacts: ${JSON.stringify(facts)}`
}

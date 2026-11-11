import { createHash } from 'node:crypto'
import { browserOutputPresentation } from './browser-output.js'
import { estimateTokens } from './tokens.js'

type ImageIdentity = { url: string; mimeType?: string; lowDetail?: boolean }

// Match the browser screenshot's 12 MiB encoded limit. Image payloads have a
// separate byte budget; a native image must never bypass every transcript cap.
export const MAX_NATIVE_IMAGE_BYTES = 9 * 1024 * 1024
export const MAX_NATIVE_IMAGE_BASE64_CHARS = 12 * 1024 * 1024

export interface ImageDimensions { width: number; height: number }

/** Header facts avoid a second shell read just to size a slide image. This is
 * not pixel decoding or proof that the complete image renders correctly. */
export function imageDimensionsFromHeader(header: Buffer): ImageDimensions | undefined {
  let width = 0, height = 0
  if (header.length >= 33 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && header.readUInt32BE(8) === 13 && header.toString('ascii', 12, 16) === 'IHDR') {
    width = header.readUInt32BE(16); height = header.readUInt32BE(20)
  } else if (header.length >= 13 && /^GIF8[79]a$/.test(header.toString('ascii', 0, 6))) {
    width = header.readUInt16LE(6); height = header.readUInt16LE(8)
  }
  return imageDimensions({ width, height })
}

/** Keep only the bounded numeric pair through text and stream budgets. */
export function imageDimensions(value: unknown): ImageDimensions | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { width, height } = value as Record<string, unknown>
  return typeof width === 'number' && Number.isSafeInteger(width) && width > 0 && width <= 0x7fffffff
    && typeof height === 'number' && Number.isSafeInteger(height) && height > 0 && height <= 0x7fffffff
    ? { width, height } : undefined
}

export function imageDimensionsDescription(value: unknown): string {
  const dimensions = imageDimensions(value)
  return dimensions ? `\nImage dimensions: ${dimensions.width} × ${dimensions.height} px (source header).` : ''
}

export interface ImageFileVersion {
  path: string
  expectedHash: string
  encoding: string
  lineEnding: string
  utf8Bom: boolean
}

/** Only engine-owned version fields survive image text-budget reduction. */
export function imageFileVersion(value: unknown): ImageFileVersion | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path.length > 4096
    || typeof record.expectedHash !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(record.expectedHash)
    || !['binary-or-non-utf8', 'utf-8'].includes(String(record.encoding))
    || !['none', 'LF', 'CRLF', 'CR', 'mixed'].includes(String(record.lineEnding))
    || typeof record.utf8Bom !== 'boolean') return undefined
  return { path: record.path, expectedHash: record.expectedHash, encoding: String(record.encoding),
    lineEnding: String(record.lineEnding), utf8Bom: record.utf8Bom }
}

export function imageVersionDescription(value: unknown): string {
  const version = imageFileVersion(value)
  return version ? '\nFile version: ' + JSON.stringify(version) : ''
}

/** Page identity must survive both text and stream budgets; a display filename
 * cannot safely reconnect screenshots of the same document after replay. */
export function imageDocumentPage(value: unknown): {
  sessionId: string; path: string; sha256: string; page: number; pageCount: number; renderer: string
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const version = imageFileVersion(record.fileVersion)
  if (typeof record.sessionId !== 'string' || !record.sessionId || record.sessionId.length > 128 ||
    typeof record.path !== 'string' || !/^(?:[a-z]:[\\/]|[\\/])/i.test(record.path) || record.path.length > 4096 ||
    record.path.split(/[\\/]/).some(part => part === '.' || part === '..') ||
    typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) ||
    typeof record.page !== 'number' || !Number.isInteger(record.page) || record.page < 1 ||
    typeof record.pageCount !== 'number' || !Number.isInteger(record.pageCount) || record.pageCount < record.page || record.pageCount > 100 ||
    typeof record.renderer !== 'string' || !record.renderer || record.renderer.length > 128 ||
    !version || version.path.replace(/\\/g, '/') !== record.path.replace(/\\/g, '/') || version.expectedHash !== `sha256:${record.sha256}` ||
    record.expectedHash !== undefined && record.expectedHash !== record.sha256 && record.expectedHash !== `sha256:${record.sha256}`) return undefined
  return { sessionId: record.sessionId, path: record.path, sha256: record.sha256,
    page: record.page, pageCount: record.pageCount, renderer: record.renderer }
}

function nativeImage(part: unknown): ImageIdentity | undefined {
  if (!part || typeof part !== 'object') return undefined
  const block = part as Record<string, any>
  if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
    return { url: block.image_url.url, lowDetail: block.image_url.detail === 'low' }
  }
  if (block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
    return { url: `data:${block.source.media_type ?? 'image/png'};base64,${block.source.data}`, mimeType: block.source.media_type }
  }
  if (block.type === 'image' && block.source?.type === 'url' && typeof block.source.url === 'string') return { url: block.source.url }
  return undefined
}

/** Only the top-level tool schema is promoted to an image by the provider adapters. */
export function imageToolPayload(content: unknown): Record<string, any> | undefined {
  if (typeof content !== 'string' || content.length > MAX_NATIVE_IMAGE_BASE64_CHARS + 64 * 1024 || !content.trimStart().startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(content)
    const match = parsed && !Array.isArray(parsed) && typeof parsed.dataUrl === 'string'
      ? /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(parsed.dataUrl) : null
    return match && match[1].length <= MAX_NATIVE_IMAGE_BASE64_CHARS && match[1].length % 4 === 0 ? parsed : undefined
  } catch { return undefined }
}

/** Recent pixels are governed by their byte budget, not the text-only cap. */
export function toolResultTextLength(content: string): number {
  const image = imageToolPayload(content)
  return image ? JSON.stringify({ ...image, dataUrl: '[native image payload]' }).length : content.length
}

/** Call only after the original tool result is durable. The UI receipt may
 * omit pixels to fit publication bytes; provider history keeps the full image. */
export function imageToolFramePayload(frame: Record<string, unknown>, maxBytes: number): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid image frame budget')
  const image = imageToolPayload(frame.output)
  if (!image) return undefined
  const original = JSON.stringify(frame)
  const originalFrameBytes = Buffer.byteLength(original, 'utf8')
  if (originalFrameBytes <= maxBytes) return original
  const metadata = frame.metadata && typeof frame.metadata === 'object' && !Array.isArray(frame.metadata)
    ? frame.metadata as Record<string, unknown> : {}
  const bounded: Record<string, unknown> = { ...frame, output: JSON.stringify({ filename: image.filename, mimeType: image.mimeType, size: image.size,
    description: image.description, ...imageDimensions(image), fileVersion: imageFileVersion(image.fileVersion),
    ...imageDocumentPage(image),
    hasDataUrl: false, dataUrlStripped: true, retainedInHistory: true, omittedFromStream: true }),
    metadata: { ...metadata, imageOutputRecovery: { source: 'durable-history', reason: 'stream-byte-budget', originalFrameBytes } } }
  delete bounded.outputPreview
  const encoded = JSON.stringify(bounded)
  // An image cannot authorize dropping unrelated args or execution evidence.
  return Buffer.byteLength(encoded, 'utf8') <= maxBytes ? encoded : undefined
}

function imageAllowance(image: ImageIdentity): number {
  if (image.lowDetail) return 512
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(image.url)
  if (match) {
    // Header-only decoding never expands the complete image in memory.
    const header = Buffer.from(image.url.slice(match[0].length, match[0].length + 64), 'base64')
    const dimensions = imageDimensionsFromHeader(header)
    if (dimensions) {
      // Conservative image-patch allowance, independent from encoded bytes.
      // Upstream vision models resize large images; reserve more than common
      // 28/32-pixel patch and Claude image-token formulas, up to 16K per image.
      return Math.min(16_384, Math.max(512, Math.ceil(dimensions.width * dimensions.height / 256) + 512))
    }
  }
  // JPEG/WebP/remote images have no cheap universal header/resize contract.
  return 8_192
}

/** Estimate semantic multimodal content; ordinary text/base64 remains text. */
export function estimateMultimodalContent(content: unknown): number {
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content))
  return content.reduce((sum, block) => {
    const image = nativeImage(block)
    if (image) return sum + imageAllowance(image) + 32
    if (block?.type === 'tool_result') {
      return sum + estimateTokens(JSON.stringify({ ...block, content: null })) + estimateMultimodalContent(block.content)
    }
    return sum + estimateTokens(JSON.stringify(block))
  }, 2)
}

/** Accurate observation must not re-count provider image bytes as dense text. */
export function estimateProviderRequestInput(request: { messages?: unknown; tools?: unknown; system?: unknown }): number {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return Math.ceil((estimateTokens(JSON.stringify({ tools: request.tools, system: request.system }))
    + messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify({ ...message, content: null }))
      + estimateMultimodalContent(message.content), 0)) * 1.2)
}

function imageDescription(image: ImageIdentity): string {
  const mime = /^data:([^;,]+)/.exec(image.url)?.[1] ?? image.mimeType ?? 'remote image'
  const hash = createHash('sha256').update(image.url).digest('hex')
  return `[Retained image: mime=${mime}; sha256=${hash}. Original pixels remain in this message's archived model input; use the attachment reference or archive to inspect them. This marker is not a visual description.]`
}

/** Text summaries keep image identity/retrieval evidence, never base64 pixel text. */
export function multimodalSummaryText(content: unknown, toolPayload = false): string {
  const browserPreview = toolPayload ? browserOutputPresentation(content) : undefined
  if (browserPreview) return browserPreview.modelInputContent
  const imageTool = toolPayload ? imageToolPayload(content) : undefined
  if (imageTool) return JSON.stringify({ ...imageTool, dataUrl: imageDescription({ url: imageTool.dataUrl }) })
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content)
  return content.map(block => {
    const image = nativeImage(block)
    if (image) return imageDescription(image)
    if (block?.type === 'text') return String(block.text ?? '')
    if (block?.type === 'tool_result') return multimodalSummaryText(block.content)
    return JSON.stringify(block)
  }).filter(Boolean).join('\n')
}

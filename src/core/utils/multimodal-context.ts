import { createHash } from 'node:crypto'
import { estimateTokens } from './tokens.js'

type ImageIdentity = { url: string; mimeType?: string; lowDetail?: boolean }

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
  if (typeof content !== 'string' || !content.trimStart().startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(content)
    return parsed && !Array.isArray(parsed) && typeof parsed.dataUrl === 'string'
      && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(parsed.dataUrl) ? parsed : undefined
  } catch { return undefined }
}

function imageAllowance(image: ImageIdentity): number {
  if (image.lowDetail) return 512
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(image.url)
  if (match) {
    // Header-only decoding never expands the complete image in memory.
    const header = Buffer.from(image.url.slice(match[0].length, match[0].length + 64), 'base64')
    let width = 0, height = 0
    if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      width = header.readUInt32BE(16); height = header.readUInt32BE(20)
    } else if (header.length >= 10 && /^GIF8[79]a$/.test(header.toString('ascii', 0, 6))) {
      width = header.readUInt16LE(6); height = header.readUInt16LE(8)
    }
    if (width > 0 && height > 0) {
      // Conservative image-patch allowance, independent from encoded bytes.
      // Upstream vision models resize large images; reserve more than common
      // 28/32-pixel patch and Claude image-token formulas, up to 16K per image.
      return Math.min(16_384, Math.max(512, Math.ceil(width * height / 256) + 512))
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

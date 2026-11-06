import { MAX_RESULT_ASSET_BYTES, MAX_RESULT_ITEMS } from '../../core/final-result.js'

export interface ResultToolImage { bytes: Buffer; mimeType: string; name?: string }
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/svg+xml': 'svg' }
export const resultImageExtension = (mimeType: string): string => extensions[mimeType] ?? 'png'

function image(value: string, name?: string): ResultToolImage | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/\s]+={0,2})$/i.exec(value)
  if (!match) return undefined
  const mimeType = match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data = match[2].replace(/\s/g, '')
  if (!Object.hasOwn(extensions, mimeType) || data.length % 4 || data.length > Math.ceil(MAX_RESULT_ASSET_BYTES / 3) * 4) return undefined
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > MAX_RESULT_ASSET_BYTES || bytes.toString('base64') !== data) return undefined
  const prefix = bytes.subarray(0, 256), starts = (...signature: number[]): boolean => signature.every((byte, index) => prefix[index] === byte)
  const valid = mimeType === 'image/png' ? starts(137, 80, 78, 71, 13, 10, 26, 10)
    : mimeType === 'image/jpeg' ? starts(255, 216, 255)
      : mimeType === 'image/gif' ? /^GIF8[79]a/.test(prefix.toString('ascii'))
        : mimeType === 'image/webp' ? prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP'
          : mimeType === 'image/bmp' ? starts(66, 77)
            : mimeType === 'image/avif' ? prefix.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/.test(prefix.toString('ascii', 8, 40))
              : /^(?:\uFEFF)?\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|\/?>)/i.test(bytes.toString('utf8').slice(0, 4096))
  return valid ? { bytes, mimeType, ...(name ? { name } : {}) } : undefined
}

/** Explicit selection reads only this already archived tool receipt; remote URLs are never fetched. */
export function resultToolImages(content: unknown): ResultToolImage[] {
  const result: ResultToolImage[] = [], seen = new Set<string>(), ancestors = new WeakSet<object>()
  let visited = 0
  const add = (value: string, name?: string): void => {
    if (result.length >= MAX_RESULT_ITEMS || seen.has(value)) return
    const parsed = image(value, name)
    if (parsed) { seen.add(value); result.push(parsed) }
  }
  const visit = (value: unknown, depth: number, name?: string): void => {
    if (++visited > 8192 || depth > 24 || result.length >= MAX_RESULT_ITEMS) return
    if (typeof value === 'string') {
      if (value.length > 48 * 1024 * 1024) return
      if (value.startsWith('data:image/')) add(value, name)
      else if (/^\s*[{[\"]/.test(value)) { try { visit(JSON.parse(value), depth + 1, name) } catch { /* Incomplete receipts do not supply deliverable bytes. */ } }
      return
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) return
    ancestors.add(value)
    try {
      if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1, name); return }
      const record = value as Record<string, unknown>
      const label = [record.filename, record.name, record.title].find(candidate => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 255)
      const ownName = typeof label === 'string' ? label : name
      const mime = record.mimeType ?? record.mime_type ?? record.media_type
      if ((record.type === 'image' || typeof mime === 'string' && mime.startsWith('image/')) && typeof mime === 'string') {
        const data = typeof record.data === 'string' ? record.data : typeof record.base64 === 'string' ? record.base64 : undefined
        if (data) add(`data:${mime};base64,${data}`, ownName)
      }
      for (const child of Object.values(record)) visit(child, depth + 1, ownName)
    } finally { ancestors.delete(value) }
  }
  visit(content, 0)
  return result
}

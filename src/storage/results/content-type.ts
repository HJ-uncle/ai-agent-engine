import path from 'node:path'
import { isUtf8 } from 'node:buffer'
import { IMAGE_MIME_TYPES } from '../../tools/file/constants.js'

const MIME: Record<string, string> = {
  ...IMAGE_MIME_TYPES, '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.mdx': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.html': 'text/html', '.htm': 'text/html',
  '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.ts': 'text/plain', '.tsx': 'text/plain', '.mts': 'text/plain', '.cts': 'text/plain',
  '.json': 'application/json', '.jsonc': 'text/plain', '.jsonl': 'text/plain', '.ndjson': 'text/plain',
  '.css': 'text/css', '.scss': 'text/plain', '.less': 'text/plain', '.sass': 'text/plain',
  '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain',
  '.ini': 'text/plain', '.conf': 'text/plain', '.env': 'text/plain', '.log': 'text/plain',
  '.sh': 'text/plain', '.bash': 'text/plain', '.zsh': 'text/plain', '.ps1': 'text/plain',
  '.py': 'text/plain', '.rb': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain', '.sql': 'text/plain',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
}
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.zip', '.jar', '.gz', '.gzip', '.bz2', '.xz', '.7z', '.rar', '.tar', '.zst',
  '.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm', '.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx',
  '.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odt', '.ods', '.odp',
  '.png', '.apng', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif', '.heic', '.heif', '.svg', '.svgz',
  '.mp4', '.m4v', '.webm', '.ogv', '.mov', '.avi', '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.pyc', '.woff', '.woff2', '.ttf', '.otf', '.db', '.sqlite', '.sqlite3'
])

function textBytes(bytes: Uint8Array): boolean {
  // PDF bodies can be entirely printable ASCII. UTF-8 validity alone cannot
  // distinguish those documents from source text when old metadata is generic.
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return false
  if (!isUtf8(bytes)) return false
  // No decoded copy is allocated just to classify a large, already-read asset.
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]
    if (byte === 0x7f || byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) return false
  }
  return true
}

export function resultAssetIsBinary(bytes: Uint8Array, filePath: string, mimeType: string, kind: 'file' | 'image' = 'file'): boolean {
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase()
  if (kind === 'image' || BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true
  // Stored generic MIME is a transport fallback, not evidence of binary data.
  // Keep old manifests byte-for-byte intact while correcting their read hint.
  const textMime = /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-javascript|yaml|x-yaml|toml|sql|graphql)$)/.test(mime)
    || /^application\/[^/]+\+(?:json|xml)$/.test(mime)
  if (mime && mime !== 'application/octet-stream' && !textMime) return true
  return !textBytes(bytes)
}

export function resultAssetMimeType(filePath: string, bytes: Uint8Array): string {
  const mapped = MIME[path.extname(filePath).toLowerCase()]
  if (mapped) return mapped
  return resultAssetIsBinary(bytes, filePath, 'application/octet-stream') ? 'application/octet-stream' : 'text/plain'
}

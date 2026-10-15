import { unzipSync, zipSync } from 'fflate'

// Compressed and expanded limits are independent: small inputs can be ZIP bombs.
export const MAX_OFFICE_FILE_BYTES = 32 * 1024 * 1024
export const MAX_OFFICE_EXPANDED_BYTES = 64 * 1024 * 1024
export const MAX_OFFICE_ENTRIES = 2048

interface Entry { name: string; size: number; compressedSize: number; crc: number; method: number }
const utf8 = new TextDecoder('utf-8', { fatal: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function validPartName(name: string): boolean {
  return name.length > 0 && name.length <= 1024 && !/[\\\u0000:]/.test(name) && !name.startsWith('/') &&
    name !== '__proto__' && !name.split('/').some(part => part === '.' || part === '..')
}
function validatePart(name: string, bytes: Uint8Array): void {
  if (!validPartName(name)) throw new Error('Invalid Office ZIP part name')
  // Editing a signed package would invalidate the signature even when all
  // visible content is preserved; do not silently publish such a package.
  if (/(?:^|\/)_xmlsignatures(?:\/|$)/i.test(name)) throw new Error('Digitally signed Office packages are unsupported')
  if (/\.(?:xml|rels)$/i.test(name)) {
    const xml = utf8.decode(bytes)
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Office XML DTD and entity declarations are unsupported')
    const signatureType = /\b(?:Type|ContentType)\s*=\s*["'][^"']*(?:digital-signature|xmlsignature)[^"']*["']/i
    if ((name === '[Content_Types].xml' || /\.rels$/i.test(name)) && signatureType.test(xml)) throw new Error('Digitally signed Office packages are unsupported')
  }
}

/** Validate central/local boundaries before fflate allocates expanded buffers.
 * ZIP64/multidisk/encryption are unnecessary for the bounded document contract.
 * CRC validation also catches damage that inflate alone does not report. */
export function readOfficeZip(input: Uint8Array): Record<string, Uint8Array> {
  if (input.byteLength < 22 || input.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error('Office ZIP file is empty, invalid or exceeds 32 MiB')
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let end = -1
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65557); cursor--) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) { end = cursor; break }
  }
  if (end < 0) throw new Error('Invalid Office ZIP directory')
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directory = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count ||
    !count || count > MAX_OFFICE_ENTRIES || count === 0xffff || directory + directorySize !== end) throw new Error('Unsupported or oversized Office ZIP directory')
  let cursor = directory, expanded = 0
  const expected = new Map<string, Entry>(), normalizedNames = new Set<string>()
  const intervals: Array<{ start: number; end: number }> = []
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid Office ZIP entry')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32)
    const local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > end || !nameLength || flags & 1 || (method !== 0 && method !== 8) || bytes.readUInt16LE(cursor + 34)) throw new Error('Unsupported Office ZIP entry')
    if (size > MAX_OFFICE_FILE_BYTES || compressedSize > MAX_OFFICE_FILE_BYTES || (method === 0 && size !== compressedSize)) throw new Error('Office ZIP part exceeds its size limit')
    expanded += size
    if (expanded > MAX_OFFICE_EXPANDED_BYTES) throw new Error('Expanded Office ZIP exceeds 64 MiB')
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = utf8.decode(nameBytes)
    if (!validPartName(name) || normalizedNames.has(name.toLowerCase())) throw new Error('Invalid or duplicate Office ZIP part')
    normalizedNames.add(name.toLowerCase())
    if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw new Error('Office ZIP local header does not match its directory')
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28)
    const data = local + 30 + localNameLength + localExtraLength
    if (data + compressedSize > directory || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) throw new Error('Invalid Office ZIP data boundary')
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== size)) throw new Error('Office ZIP size or CRC metadata does not match')
    intervals.push({ start: local, end: data + compressedSize })
    expected.set(name, { name, size, compressedSize, crc, method })
    cursor = next
  }
  if (cursor !== end) throw new Error('Unexpected Office ZIP directory trailer')
  intervals.sort((a, b) => a.start - b.start)
  if (intervals.some((entry, index) => index > 0 && entry.start < intervals[index - 1].end)) throw new Error('Overlapping Office ZIP entries')
  let accepted = 0, declared = 0
  const files = unzipSync(input, { filter: file => {
    const entry = expected.get(file.name)
    if (!entry || entry.size !== file.originalSize || entry.compressedSize !== file.size || entry.method !== file.compression) throw new Error('Office ZIP metadata changed while reading')
    declared += file.originalSize
    if (++accepted > MAX_OFFICE_ENTRIES || file.originalSize > MAX_OFFICE_FILE_BYTES || declared > MAX_OFFICE_EXPANDED_BYTES) throw new Error('Office ZIP exceeds extraction limits')
    return true
  } })
  if (Object.keys(files).length !== count) throw new Error('Office ZIP entry count mismatch')
  for (const [name, content] of Object.entries(files)) {
    const entry = expected.get(name)!
    if (content.byteLength !== entry.size || crc32(content) !== entry.crc) throw new Error('Office ZIP part CRC or length mismatch')
    validatePart(name, content)
  }
  return files
}

export function writeOfficeZip(entries: Record<string, Uint8Array>): Buffer {
  const parts = Object.entries(entries)
  if (!parts.length || parts.length > MAX_OFFICE_ENTRIES) throw new Error('Office ZIP entry limit exceeded')
  let expanded = 0
  const names = new Set<string>()
  for (const [name, bytes] of parts) {
    validatePart(name, bytes)
    if (names.has(name.toLowerCase())) throw new Error('Duplicate Office ZIP part')
    names.add(name.toLowerCase())
    expanded += bytes.byteLength
    if (bytes.byteLength > MAX_OFFICE_FILE_BYTES || expanded > MAX_OFFICE_EXPANDED_BYTES) throw new Error('Expanded Office ZIP exceeds extraction limits')
  }
  const result = Buffer.from(zipSync(entries, { level: 6 }))
  if (result.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error('Office ZIP exceeds 32 MiB')
  return result
}

export function decodeXml(value: string): string {
  return value.replace(/&([^;\s<&]+);/g, (_all, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (Object.hasOwn(named, entity)) return named[entity]
    const point = /^#x[\da-f]+$/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN
    if (!Number.isInteger(point) || point > 0x10ffff || point < 0 || point === 0xfffe || point === 0xffff || (point >= 0xd800 && point <= 0xdfff) || (point < 32 && point !== 9 && point !== 10 && point !== 13)) throw new Error('Invalid XML entity')
    return String.fromCodePoint(point)
  })
}

export function encodeXml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)) throw new Error('Invalid XML text character')
  // A round trip detects isolated UTF-16 surrogate halves without excluding emoji.
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new Error('Invalid Unicode in XML text')
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

import { inflateRawSync } from 'node:zlib'
import { PluginError } from './types.js'

export interface PluginZipEntry { name: string; size: number; compressed: number; method: number; data: number; crc: number; directory: boolean }
export interface PluginZipDirectory { bytes: Buffer; entries: PluginZipEntry[]; expandedBytes: number }
const fail = (message: string): never => { throw new PluginError('invalid-import', message) }
const utf8 = new TextDecoder('utf-8', { fatal: true })

function safeName(name: string): void {
  if (!name || name.length > 512 || /[\\\u0000-\u001f:]/.test(name) || name.startsWith('/')) fail('Invalid plugin ZIP path')
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('Invalid plugin ZIP path')
}

/** Validate every directory entry before any decompression. Ignored entries stay compressed. */
export function inspectPluginZip(input: Uint8Array, maxArchive = 32 * 1024 * 1024, maxExpanded = 64 * 1024 * 1024): PluginZipDirectory {
  if (input.length < 22 || input.length > maxArchive) return fail(`Plugin ZIP is invalid or exceeds ${maxArchive / 1024 / 1024} MiB`)
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0) return fail('Invalid plugin ZIP directory')
  const count = bytes.readUInt16LE(end + 10), directory = bytes.readUInt32LE(end + 16), directorySize = bytes.readUInt32LE(end + 12)
  if (!count || count > 4096 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || directory + directorySize !== end) return fail('Unsupported plugin ZIP directory')
  const entries: PluginZipEntry[] = [], names = new Map<string, boolean>(), ranges: { start: number; end: number }[] = []
  let cursor = directory, expandedBytes = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return fail('Invalid plugin ZIP entry')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32)
    const local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength
    const unixType = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000
    if (next > end || !nameLength || flags & ~0x080e || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34) || ![0, 0x4000, 0x8000].includes(unixType)) return fail('Encrypted, linked or unsupported plugin ZIP entry')
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    let name: string; try { name = utf8.decode(nameBytes) } catch { return fail('Plugin ZIP names must be UTF-8') }
    safeName(name)
    const isDirectory = name.endsWith('/'), key = name.replace(/\/$/, '').toLowerCase()
    if (names.has(key)) return fail('Duplicate plugin ZIP entry')
    names.set(key, isDirectory)
    if ((unixType === 0x4000 && !isDirectory) || (unixType === 0x8000 && isDirectory) || (isDirectory && size !== 0)) return fail('Plugin ZIP entry type mismatch')
    expandedBytes += size
    if (size > maxExpanded || compressed > maxArchive || expandedBytes > maxExpanded || (method === 0 && size !== compressed)) return fail('Plugin ZIP exceeds extraction limits')
    if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) return fail('Plugin ZIP local header mismatch')
    const localNameLength = bytes.readUInt16LE(local + 26), data = local + 30 + localNameLength + bytes.readUInt16LE(local + 28)
    if (data + compressed > directory || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) return fail('Invalid plugin ZIP data boundary')
    let rangeEnd = data + compressed
    if (flags & 8) {
      if (rangeEnd + 12 > directory) return fail('Invalid plugin ZIP descriptor')
      if (bytes.readUInt32LE(rangeEnd) === 0x08074b50) rangeEnd += 4
      if (rangeEnd + 12 > directory || bytes.readUInt32LE(rangeEnd) !== crc || bytes.readUInt32LE(rangeEnd + 4) !== compressed || bytes.readUInt32LE(rangeEnd + 8) !== size) return fail('Plugin ZIP descriptor mismatch')
      rangeEnd += 12
    } else if (bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size || bytes.readUInt32LE(local + 14) !== crc) return fail('Plugin ZIP metadata mismatch')
    ranges.push({ start: local, end: rangeEnd }); entries.push({ name, size, compressed, method, data, crc, directory: isDirectory }); cursor = next
  }
  if (cursor !== end) return fail('Invalid plugin ZIP trailer')
  for (const name of names.keys()) {
    const parts = name.split('/'); parts.pop()
    while (parts.length) { if (names.get(parts.join('/')) === false) return fail('Conflicting plugin ZIP paths'); parts.pop() }
  }
  ranges.sort((a, b) => a.start - b.start)
  if (ranges.some((entry, index) => index > 0 && entry.start < ranges[index - 1].end)) return fail('Overlapping plugin ZIP entries')
  return { bytes, entries, expandedBytes }
}

const crcTable = new Uint32Array(256).map((_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0 })
function crc32(bytes: Uint8Array): number { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0 }

export function extractPluginZipEntry(zip: PluginZipDirectory, entry: PluginZipEntry): Buffer {
  if (!zip.entries.includes(entry) || entry.directory) return fail('Invalid plugin ZIP extraction entry')
  const compressed = zip.bytes.subarray(entry.data, entry.data + entry.compressed)
  let output: Buffer
  try { output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) }) }
  catch { return fail('Plugin ZIP exceeds extraction limits or contains invalid compressed data') }
  if (output.length !== entry.size || crc32(output) !== entry.crc) return fail('Plugin ZIP length or checksum mismatch')
  return output
}

export function readPluginZip(input: Uint8Array): Record<string, Uint8Array> {
  const zip = inspectPluginZip(input), files: Record<string, Uint8Array> = Object.create(null)
  for (const entry of zip.entries) if (!entry.directory) files[entry.name] = extractPluginZipEntry(zip, entry)
  return files
}

import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { CollaborationError } from '../../core/collaboration/types.js'

/** Read a frozen byte range without retaining a whole archive or base64 string.
 * The caller owns the file lease and must compare file/path revisions afterward.
 * Complete lines may be arbitrarily large for compatibility with old archives;
 * their payloads and any retained callback results are not constant-space.
 */
export async function readJSONLBytes(handle: FileHandle, size: number, options: {
  onLine?: (bytes: Buffer, offset: number) => void
  truncatedMessage?: string
} = {}): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0) throw new CollaborationError('conflict', 'JSONL read range is invalid')
  const hash = createHash('sha256')
  let carry: Buffer = Buffer.alloc(0), position = 0, lineOffset = 0, pendingBytes = 0
  let pending: Buffer[] = []
  while (position < size) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position))
    let copied = 0
    while (copied < chunk.length) {
      const next = await handle.read(chunk, copied, chunk.length - copied, position + copied)
      if (!next.bytesRead) throw new CollaborationError('conflict', options.truncatedMessage ?? 'JSONL archive was truncated while reading')
      copied += next.bytesRead
    }
    position += chunk.length

    // SHA256(base64(bytes)) is persisted in maintenance receipts. Emit padding
    // only at EOF, and copy the <=2-byte carry so it cannot pin an old chunk.
    let start = 0
    if (carry.length) {
      const take = Math.min(3 - carry.length, chunk.length)
      const triple = Buffer.concat([carry, chunk.subarray(0, take)])
      start = take
      if (triple.length === 3) { hash.update(triple.toString('base64')); carry = Buffer.alloc(0) }
      else carry = triple
    }
    const end = start + Math.floor((chunk.length - start) / 3) * 3
    if (end > start) hash.update(chunk.subarray(start, end).toString('base64'))
    if (end < chunk.length || !carry.length) carry = Buffer.from(chunk.subarray(end))

    if (!options.onLine) continue
    start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start)
      if (newline < 0) { pending.push(chunk.subarray(start)); pendingBytes += chunk.length - start; break }
      const end = newline + 1, part = chunk.subarray(start, end), bytes = pendingBytes + part.length
      const line = pending.length ? Buffer.concat([...pending, part], bytes) : part
      options.onLine(line, lineOffset)
      lineOffset += bytes; pending = []; pendingBytes = 0; start = end
    }
  }
  if (carry.length) hash.update(carry.toString('base64'))
  // A partial last line participates in the prefix digest, never in receipts.
  return hash.digest('hex')
}

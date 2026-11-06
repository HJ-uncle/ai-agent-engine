import { createHash } from 'node:crypto'
import { isSubagentPayloadReference, SUBAGENT_PAYLOAD_MAX_BYTES, type SubagentPayloadFiles, type SubagentPayloadReference } from './payload-files.js'

/** Private storage metadata. Wire schemaVersion and all SQL authority fields stay unchanged. */
export const SUBAGENT_PAYLOAD_FIELDS = '__aetherSubagentPayloads'
const PLACEHOLDER = '[aether-subagent-payload]'
const FORMAT = 'aether-subagent-payload-fields'
export const SUBAGENT_PAYLOAD_CHUNK_BYTES = 256 * 1024
const MAX_CHUNKS = Math.ceil(SUBAGENT_PAYLOAD_MAX_BYTES / (SUBAGENT_PAYLOAD_CHUNK_BYTES - 3))
const STATE_FIELDS = ['partialOutput', 'resultSummary', 'latestActivity'] as const
const SUMMARY_FIELDS = ['args', 'argsPreview', 'output', 'outputPreview', 'error'] as const
const DETAIL_FIELDS = ['args', 'output', 'error'] as const
type JsonObject = Record<string, unknown>
interface ValueReference {
  format: 'aether-subagent-payload-value'
  version: 1
  bytes: number
  chunks: SubagentPayloadReference[]
}
interface Envelope { format: typeof FORMAT; version: 1; refs: Record<string, ValueReference> }
export interface SubagentDetailChunk {
  encoding: 'json-utf8'
  text: string
  offset: number
  totalBytes: number
  hasMore: boolean
  nextOffset?: number
}

export class SubagentPayloadCodecError extends Error {
  constructor(readonly code: 'INVALID_PAYLOAD' | 'NONCANONICAL_DETAIL', message: string) {
    super(`SUBAGENT_RECOVERY_REQUIRED: ${message}`)
    this.name = 'SubagentPayloadCodecError'
  }
}
function invalid(message: string): never { throw new SubagentPayloadCodecError('INVALID_PAYLOAD', message) }
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function parsed(value: unknown): JsonObject {
  let result: unknown
  try { result = typeof value === 'string' ? JSON.parse(value) : JSON.parse(JSON.stringify(value)) }
  catch { invalid('Invalid serialized subagent payload object') }
  if (!object(result)) invalid('Subagent payload must be a JSON object')
  return result
}
function serialized(value: unknown): string {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') invalid('Subagent payload field is not JSON serializable')
  return text
}
function envelope(tenantId: string, row: JsonObject, fields: readonly string[]): Envelope | undefined {
  if (!Object.hasOwn(row, SUBAGENT_PAYLOAD_FIELDS)) return undefined
  const value = row[SUBAGENT_PAYLOAD_FIELDS]
  if (!object(value) || Object.keys(value).length !== 3 || value.format !== FORMAT || value.version !== 1 || !object(value.refs))
    invalid('Unknown subagent payload envelope')
  const tenantHash = createHash('sha256').update(tenantId).digest('hex')
  for (const [key, ref] of Object.entries(value.refs)) {
    if (!fields.includes(key) || !object(ref) || Object.keys(ref).length !== 4 || ref.format !== 'aether-subagent-payload-value'
      || ref.version !== 1 || !Number.isSafeInteger(ref.bytes) || Number(ref.bytes) < 1 || Number(ref.bytes) > SUBAGENT_PAYLOAD_MAX_BYTES
      || !Array.isArray(ref.chunks) || !ref.chunks.length || ref.chunks.length > MAX_CHUNKS
      || !Object.hasOwn(row, key) || row[key] !== PLACEHOLDER)
      invalid('Invalid subagent payload field reference or placeholder')
    let total = 0
    for (const chunk of ref.chunks) {
      if (!isSubagentPayloadReference(chunk) || chunk.bytes < 1 || chunk.bytes > SUBAGENT_PAYLOAD_CHUNK_BYTES)
        invalid('Invalid subagent payload chunk reference')
      if (chunk.tenantHash !== tenantHash) invalid('Subagent payload reference belongs to another tenant')
      total += chunk.bytes
    }
    if (total !== ref.bytes) invalid('Subagent payload chunks do not match their declared length')
  }
  return value as unknown as Envelope
}
function assertPublic(row: JsonObject): void {
  if (Object.hasOwn(row, SUBAGENT_PAYLOAD_FIELDS)) invalid('Cannot encode an already encoded or forged subagent payload')
}

/**
 * Values are separate JSON fragments so completion/cancellation can patch SQL scalars without
 * loading old arguments. Always hydrate before cleaners remove nulls or public projections clip text.
 */
export class SubagentPayloadCodec {
  private readonly threshold: number
  constructor(readonly files: SubagentPayloadFiles, options: { thresholdBytes?: number } = {}) {
    this.threshold = options.thresholdBytes ?? 1024
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 1) throw new RangeError('Invalid subagent payload threshold')
  }

  private async putValue(tenantId: string, text: string): Promise<ValueReference> {
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > SUBAGENT_PAYLOAD_MAX_BYTES) invalid('Subagent payload field exceeds its storage limit')
    const chunks: SubagentPayloadReference[] = []
    for (let offset = 0; offset < bytes.length;) {
      let end = Math.min(bytes.length, offset + SUBAGENT_PAYLOAD_CHUNK_BYTES)
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
      chunks.push(await this.files.put(tenantId, bytes.subarray(offset, end).toString('utf8')))
      offset = end
    }
    return { format: 'aether-subagent-payload-value', version: 1, bytes: bytes.length, chunks }
  }

  private async encodeFields(tenantId: string, value: unknown, fields: readonly string[], patch = false): Promise<JsonObject> {
    const row = parsed(value)
    assertPublic(row)
    const refs: Record<string, ValueReference | null> = {}
    for (const key of fields) {
      if (!Object.hasOwn(row, key)) continue
      const text = serialized(row[key])
      if (Buffer.byteLength(text) >= this.threshold) {
        refs[key] = await this.putValue(tenantId, text)
        row[key] = PLACEHOLDER
      } else if (patch) {
        // JSON Merge Patch removes this old ref while retaining every omitted field's ref.
        refs[key] = null
      }
    }
    if (Object.keys(refs).length) row[SUBAGENT_PAYLOAD_FIELDS] = { format: FORMAT, version: 1, refs }
    return row
  }

  private async decodeFields<T extends object>(tenantId: string, value: unknown, fields: readonly string[]): Promise<T> {
    const row = parsed(value), stored = envelope(tenantId, row, fields)
    if (stored) {
      for (const [key, ref] of Object.entries(stored.refs)) {
        const fragments: string[] = []
        for (const chunk of ref.chunks) fragments.push(await this.files.read(tenantId, chunk, {
          maxBytes: Math.min(SUBAGENT_PAYLOAD_CHUNK_BYTES, this.files.maxPayloadBytes),
        }))
        const text = fragments.join('')
        try { row[key] = JSON.parse(text) }
        catch { invalid('Subagent payload field contains invalid JSON') }
      }
      delete row[SUBAGENT_PAYLOAD_FIELDS]
    }
    return row as T
  }

  encodeState(tenantId: string, value: object | string): Promise<JsonObject> { return this.encodeFields(tenantId, value, STATE_FIELDS) }
  decodeState<T extends object = JsonObject>(tenantId: string, value: unknown): Promise<T> { return this.decodeFields<T>(tenantId, value, STATE_FIELDS) }
  encodeSummary(tenantId: string, value: object | string): Promise<JsonObject> { return this.encodeFields(tenantId, value, SUMMARY_FIELDS) }
  decodeSummary<T extends object = JsonObject>(tenantId: string, value: unknown): Promise<T> { return this.decodeFields<T>(tenantId, value, SUMMARY_FIELDS) }

  async encodeEvent(tenantId: string, value: object | string): Promise<JsonObject> {
    return this.event(tenantId, value, true)
  }
  async decodeEvent<T extends object = JsonObject>(tenantId: string, value: unknown): Promise<T> {
    return await this.event(tenantId, value, false) as T
  }
  private async event(tenantId: string, value: unknown, encode: boolean): Promise<JsonObject> {
    const row = parsed(value)
    assertPublic(row)
    // Legacy SQL expands snapshot.toolCalls and directly reads snapshot authority fields.
    if (row.schemaVersion === 1) return row
    if (row.schemaVersion !== 2) invalid('Unknown subagent event schema')
    for (const key of ['header', 'headerPatch']) {
      if (!Object.hasOwn(row, key)) continue
      if (!object(row[key])) invalid('Invalid subagent event header')
      row[key] = encode ? await this.encodeState(tenantId, row[key]) : await this.decodeState(tenantId, row[key])
    }
    if (Object.hasOwn(row, 'toolUpsert')) {
      if (!object(row.toolUpsert)) invalid('Invalid subagent event tool summary')
      row.toolUpsert = encode ? await this.encodeSummary(tenantId, row.toolUpsert) : await this.decodeSummary(tenantId, row.toolUpsert)
    }
    if (Object.hasOwn(row, 'view')) {
      if (!object(row.view)) invalid('Invalid subagent snapshot view')
      const view = encode ? await this.encodeState(tenantId, row.view) : await this.decodeState(tenantId, row.view)
      if (!Array.isArray(view.toolCalls)) invalid('Invalid subagent snapshot tools')
      const tools: JsonObject[] = []
      for (const tool of view.toolCalls) {
        if (!object(tool)) invalid('Invalid subagent snapshot tool')
        tools.push(encode ? await this.encodeSummary(tenantId, tool) : await this.decodeSummary(tenantId, tool))
      }
      row.view = { ...view, toolCalls: tools }
    }
    return row
  }

  async encodeDetail(tenantId: string, value: object | string): Promise<JsonObject> {
    const row = parsed(value)
    // Offset-based readers may be midway through this immutable revision during migration.
    // A noncanonical legacy spelling must stay inline rather than silently changing its bytes.
    if (typeof value === 'string' && serialized(row) !== value)
      throw new SubagentPayloadCodecError('NONCANONICAL_DETAIL', 'Noncanonical tool detail must remain inline to preserve byte offsets')
    return this.encodeFields(tenantId, row, DETAIL_FIELDS)
  }
  decodeDetail<T extends object = JsonObject>(tenantId: string, value: unknown): Promise<T> { return this.decodeFields<T>(tenantId, value, DETAIL_FIELDS) }

  /**
   * Use as a JSON Merge Patch, never as a complete stored detail. Its nested refs merge by field.
   * For an explicitly supplied args (including null), callers must json_set the encoded args after
   * json_patch, matching the existing store's JSON-null-preserving argument replacement contract.
   */
  encodeDetailPatch(tenantId: string, value: object | string): Promise<JsonObject> {
    return this.encodeFields(tenantId, value, DETAIL_FIELDS, true)
  }

  async getDetailChunk(tenantId: string, value: unknown, offset: number, limitBytes: number): Promise<SubagentDetailChunk> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limitBytes) || limitBytes < 4 || limitBytes > 128 * 1024)
      throw new RangeError('Invalid detail chunk')
    const row = parsed(value), stored = envelope(tenantId, row, DETAIL_FIELDS)
    type Part = { text: string; bytes: number } | { ref: SubagentPayloadReference; bytes: number }
    const parts: Part[] = []
    const literal = (text: string) => parts.push({ text, bytes: Buffer.byteLength(text) })
    if (!stored) {
      // Preserve even noncanonical inline legacy JSON byte-for-byte.
      literal(typeof value === 'string' ? value : serialized(row))
    } else {
      literal('{')
      let first = true
      for (const [key, item] of Object.entries(row)) {
        if (key === SUBAGENT_PAYLOAD_FIELDS) continue
        literal(`${first ? '' : ','}${JSON.stringify(key)}:`)
        first = false
        const ref = Object.hasOwn(stored.refs, key) ? stored.refs[key] : undefined
        if (ref) for (const chunk of ref.chunks) parts.push({ ref: chunk, bytes: chunk.bytes })
        else literal(serialized(item))
      }
      literal('}')
    }
    const totalBytes = parts.reduce((total, part) => total + part.bytes, 0)
    if (!Number.isSafeInteger(totalBytes)) invalid('Invalid reconstructed detail size')
    if (offset > totalBytes) throw new RangeError('Detail offset exceeds length')
    const endOffset = Math.min(totalBytes, offset + limitBytes)
    const chunks: Buffer[] = []
    let position = 0
    for (const part of parts) {
      const from = Math.max(0, offset - position), to = Math.min(part.bytes, endOffset - position)
      if ('ref' in part && to > from) {
        // Each selected block is independently verified. Reading a page must not decompress
        // an entire multi-megabyte field (or unrelated fields) on every offset request.
        const range = await this.files.readRange(tenantId, part.ref, {
          offsetBytes: from, limitBytes: to - from,
        })
        if (range.totalBytes !== part.bytes || range.offsetBytes !== from || range.chunk.length !== to - from)
          invalid('Subagent detail fragment length changed')
        chunks.push(range.chunk)
      } else if ('text' in part && to > from) chunks.push(Buffer.from(part.text).subarray(from, to))
      position += part.bytes
    }
    const raw = Buffer.concat(chunks)
    if (raw.length && (raw[0] & 0xc0) === 0x80) throw new RangeError('Detail offset must be a UTF-8 boundary')
    let text: string
    try {
      // Streaming decode withholds only an unfinished final code point. The next request
      // starts before those withheld bytes, without reading ahead into another CAS block.
      // Preserve a literal U+FEFF at arbitrary page starts instead of interpreting it as a BOM.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw, { stream: endOffset < totalBytes })
    }
    catch { invalid('Invalid stored UTF-8 tool detail') }
    const nextOffset = offset + Buffer.byteLength(text)
    return { encoding: 'json-utf8', text, offset, totalBytes, hasMore: nextOffset < totalBytes,
      ...(nextOffset < totalBytes ? { nextOffset } : {}) }
  }
}

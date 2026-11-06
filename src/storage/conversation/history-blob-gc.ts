import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGunzip } from 'node:zlib'
import { Transform, Writable, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isSealedHistoryBackup, verifyColdHistoryArchive } from './history-cold.js'

type RecordValue = Record<string, unknown>
/** The caller must hold a stable SQLite read transaction for the entire call (exclusive for apply). */
export interface HistoryBlobGCQueries {
  all(sql: string): RecordValue[]
  iterate(sql: string): Iterable<RecordValue>
}
export interface HistoryBlobGCOptions {
  dataRoot: string
  database: HistoryBlobGCQueries
  coldRoots?: string[]
  apply?: boolean
  engineStopped?: boolean
  minimumAgeMs?: number
  maxLineBytes?: number
  now?: number
}
export interface HistoryBlobGCReport {
  mode: 'dry-run' | 'applied' | 'refused'
  safeToSweep: boolean
  errors: string[]
  scannedJsonlFiles: number
  scannedColdArchives: number
  scannedDatabaseRows: number
  referencedBlobs: number
  blobFiles: number
  retainedYoungBlobs: number
  orphanBytes: number
  orphanFiles: string[]
  deletedFiles: number
  deletedBytes: number
}
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const MAX_BLOB_BYTES = 128 * 1024 * 1024
const hashPattern = /^[a-f0-9]{64}$/
const bodyFields = new Set(['content', 'modelInputContent', 'reasoningContent', 'metadata'])
const updateFields = new Set([...bodyFields, 'archiveContent'])
const rowTypes = new Set(['user', 'assistant', 'tool', 'system', 'summary', 'update', 'tombstone', 'usage'])
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function json(value: string): unknown {
  try { return JSON.parse(value) } catch { throw new Error('Malformed JSON in a history reference source') }
}
const quoted = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const onlyKeys = (value: RecordValue, names: string[]) => Object.keys(value).every(name => names.includes(name))
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.birthtimeMs === b.birthtimeMs

/** Offline, fail-closed mark-and-sweep. No writes occur before every source and blob has been verified. */
export async function collectHistoryBlobGarbage(options: HistoryBlobGCOptions): Promise<HistoryBlobGCReport> {
  if (options.apply && !options.engineStopped) throw new Error('Blob GC apply requires every engine instance stopped and engineStopped=true')
  const age = options.minimumAgeMs ?? SEVEN_DAYS, maxLine = options.maxLineBytes ?? 32 * 1024 * 1024, now = options.now ?? Date.now()
  if (!integer(age) || age < SEVEN_DAYS || !integer(now) || !integer(maxLine) || maxLine < 1024 || maxLine > 256 * 1024 * 1024)
    throw new RangeError('GC requires at least 7 days retention and a valid bounded line size')
  const root = path.resolve(options.dataRoot), sessions = path.join(root, 'sessions'), blobs = path.join(root, 'blobs')
  const coldRoots = [...new Set((options.coldRoots ?? [path.join(root, 'history-cold')]).map(value => path.resolve(value)))]
  const report: HistoryBlobGCReport = { mode: 'dry-run', safeToSweep: false, errors: [], scannedJsonlFiles: 0,
    scannedColdArchives: 0, scannedDatabaseRows: 0, referencedBlobs: 0, blobFiles: 0, retainedYoungBlobs: 0,
    orphanBytes: 0, orphanFiles: [], deletedFiles: 0, deletedBytes: 0 }
  const observed = new Map<string, fs.Stats>(), missing = new Set<string>(), refs = new Map<string, number>()
  const candidates: Array<{ file: string; info: fs.Stats; relative: string }> = []
  const observe = async (file: string, directory = false): Promise<fs.Stats> => {
    const info = await fsp.lstat(file)
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
      throw new Error('Unexpected filesystem object: ' + file)
    observed.set(file, info); return info
  }
  const walk = async (directory: string, optional = false, depth = 0): Promise<string[]> => {
    if (depth > 32 || observed.size > 100_000) throw new Error('GC filesystem inventory limit exceeded')
    try { await observe(directory, true) }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') { missing.add(directory); return [] } throw error }
    const output: string[] = []
    for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name)
      if (item.isSymbolicLink()) throw new Error('GC refuses directory/file links: ' + file)
      if (item.isDirectory()) output.push(...await walk(file, false, depth + 1))
      else { await observe(file); output.push(file) }
    }
    return output
  }
  const markRow = (value: unknown): void => {
    if (!record(value) || typeof value.type !== 'string' || !rowTypes.has(value.type)
      || typeof value.tenantId !== 'string' || typeof value.sessionId !== 'string' || typeof value.uuid !== 'string')
      throw new Error('Unknown or malformed JSONL row format')
    if (value.storageBlobs === undefined) return
    const envelope = value.storageBlobs
    if (!record(envelope) || !onlyKeys(envelope, ['version', 'tenant', 'refs']) || envelope.version !== 1
      || envelope.tenant !== digest(value.tenantId) || typeof envelope.tenant !== 'string'
      || !Array.isArray(envelope.refs) || !envelope.refs.length || envelope.refs.length > 4096) throw new Error('Unknown history blob envelope')
    const seen = new Set<string>(); let total = 0
    for (const ref of envelope.refs) {
      if (!record(ref) || !onlyKeys(ref, ['path', 'hash', 'bytes', 'codec']) || ref.codec !== 'gzip'
        || typeof ref.hash !== 'string' || !hashPattern.test(ref.hash) || !integer(ref.bytes) || ref.bytes > MAX_BLOB_BYTES
        || !Array.isArray(ref.path) || !ref.path.length || ref.path.length > 128
        || ref.path.some(key => !(typeof key === 'string' && !unsafe.has(key) || integer(key)))) throw new Error('Invalid blob reference')
      const location = ref.path as Array<string | number>
      const body = location[0] === 'payload' ? typeof location[1] === 'string' && bodyFields.has(location[1])
        || location[1] === 'toolCall' && location[2] === 'args' : typeof location[0] === 'string' && updateFields.has(location[0])
      if (!body || (total += ref.bytes) > 256 * 1024 * 1024 || seen.has(JSON.stringify(location))) throw new Error('Invalid blob body path')
      seen.add(JSON.stringify(location))
      let parent: unknown = value
      for (const key of location) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)
          || Array.isArray(parent) && (typeof key !== 'number' || key >= parent.length)
          || !Array.isArray(parent) && typeof key !== 'string') throw new Error('Blob reference path is out of bounds')
        parent = (parent as Record<string | number, unknown>)[key]
      }
      if (parent !== null) throw new Error('Blob reference does not target a placeholder')
      const relative = `${envelope.tenant}/${ref.hash.slice(0, 2)}/${ref.hash}.gz`, expected = refs.get(relative)
      if (expected !== undefined && expected !== ref.bytes) throw new Error('Conflicting blob reference lengths')
      refs.set(relative, ref.bytes)
    }
  }
  const parseLines = async (input: AsyncIterable<Uint8Array>): Promise<{ bytes: number; hash: string }> => {
    const decoder = new TextDecoder('utf-8', { fatal: true }), hash = createHash('sha256')
    let pending = '', bytes = 0
    for await (const chunk of input) {
      bytes += chunk.byteLength; hash.update(chunk); pending += decoder.decode(chunk, { stream: true })
      let position: number
      while ((position = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, position); pending = pending.slice(position + 1)
        if (Buffer.byteLength(line) > maxLine) throw new Error('JSONL line exceeds GC scan limit')
        if (line.trim()) markRow(json(line))
      }
      if (Buffer.byteLength(pending) > maxLine) throw new Error('JSONL line exceeds GC scan limit')
    }
    pending += decoder.decode()
    if (pending.length) throw new Error('JSONL has an unfinished final line')
    return { bytes, hash: hash.digest('hex') }
  }
  try {
    await observe(root, true)
    for (const file of await walk(sessions, true)) {
      if (file.endsWith('.jsonl') || isSealedHistoryBackup(file) || file.endsWith('.jsonl.tmp')) {
        await parseLines(fs.createReadStream(file)); report.scannedJsonlFiles++
      } else if (file.endsWith('.migrated')) {
        if (observed.get(file)!.size > 128 || !/^(?:cleared|\d+)\s*$/.test(await fsp.readFile(file, 'utf8'))) throw new Error('Unknown session migration marker')
      } else if (path.basename(file) !== '.gitkeep' || observed.get(file)!.size !== 0) throw new Error('Unknown file in sessions: ' + file)
    }
    for (const cold of coldRoots) {
      const files = await walk(cold, cold === path.join(root, 'history-cold')), archives = new Set(files.filter(file => file.endsWith('.jsonl.gz')))
      for (const file of files) {
        if (file.endsWith('.jsonl.gz.manifest.json')) {
          const manifest = await verifyColdHistoryArchive(cold, file), archive = path.resolve(cold, manifest.archive.relativePath)
          if (!archives.delete(archive)) throw new Error('Cold manifest is missing its archive')
          // A second streaming parse marks references from the exact raw bytes named by the manifest.
          const gunzip = createGunzip(), source = fs.createReadStream(archive)
          const feed = pipeline(source, gunzip)
          let result: { bytes: number; hash: string }
          try { result = await parseLines(gunzip); await feed }
          catch (error) { source.destroy(); gunzip.destroy(); await feed.catch(() => {}); throw error }
          if (result.bytes !== manifest.source.bytes || result.hash !== manifest.source.sha256) throw new Error('Cold archive changed during marking')
          report.scannedColdArchives++
        } else if (!file.endsWith('.jsonl.gz')) throw new Error('Unknown or unfinished cold history file: ' + file)
      }
      if (archives.size) throw new Error('Cold gzip exists without a verified manifest')
    }
    const tables = options.database.all("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'collaboration_%'")
    for (const table of tables) {
      if (typeof table.name !== 'string') throw new Error('Unknown collaboration schema')
      const columns = new Set(options.database.all(`PRAGMA table_info(${quoted(table.name)})`).map(row => row.name))
      if (table.name === 'collaboration_history_maintenance') {
        if (!['payload_json', 'payload_hash', 'state', 'backend'].every(name => columns.has(name))) throw new Error('Unknown maintenance schema')
        for (const row of options.database.iterate(`SELECT payload_json,payload_hash,state,backend FROM ${quoted(table.name)}`)) {
          report.scannedDatabaseRows++
          if (typeof row.payload_json !== 'string' || typeof row.payload_hash !== 'string' || digest(row.payload_json) !== row.payload_hash)
            throw new Error('Maintenance recovery payload hash mismatch')
          const payload = json(row.payload_json)
          if (!record(payload) || !['pending', 'committed', 'invalidated'].includes(String(row.state))) throw new Error('Unknown maintenance payload')
          if (record(payload.plan) && typeof payload.plan.encoded === 'string') {
            if (Buffer.byteLength(payload.plan.encoded) !== payload.plan.bytes || digest(payload.plan.encoded) !== payload.plan.hash)
              throw new Error('Maintenance recovery plan hash mismatch')
            await parseLines(Readable.from([Buffer.from(payload.plan.encoded)]))
          } else if (row.state === 'pending') throw new Error('Pending maintenance lacks a readable recovery plan')
          else if (payload.format === 'aether-history-maintenance-terminal' && payload.schemaVersion === 1
            && payload.state === row.state && typeof payload.kind === 'string' && typeof payload.originalPayloadHash === 'string'
            && hashPattern.test(payload.originalPayloadHash) && integer(payload.originalPayloadBytes)
            && onlyKeys(payload, ['format', 'schemaVersion', 'state', 'kind', 'originalPayloadHash', 'originalPayloadBytes',
              'plan', 'retired', 'retained', 'sourceRows', 'retiredRowIds', 'before', 'after', 'cleared', 'freedTokens'])
            && (payload.plan === undefined || record(payload.plan) && onlyKeys(payload.plan, ['fileIdentity', 'offset', 'bytes', 'hash', 'prefixHash', 'lineCount'])
              && typeof payload.plan.fileIdentity === 'string' && integer(payload.plan.offset) && integer(payload.plan.bytes)
              && typeof payload.plan.hash === 'string' && hashPattern.test(payload.plan.hash) && integer(payload.plan.lineCount))) { /* Known terminal receipts have no encoded body. */ }
          else if (row.backend === 'sqlite' && ['micro', 'summary'].includes(String(payload.kind)) && payload.plan === undefined) { /* Legacy SQLite-only receipts. */ }
          else throw new Error('Unknown terminal maintenance payload format')
        }
      }
      if (columns.has('encoded_row')) {
        const selected = ['encoded_row', ...(columns.has('row_hash') ? ['row_hash'] : []), ...(columns.has('row_bytes') ? ['row_bytes'] : [])]
        for (const row of options.database.iterate(`SELECT ${selected.map(quoted).join(',')} FROM ${quoted(table.name)}`)) {
          report.scannedDatabaseRows++
          if (typeof row.encoded_row !== 'string' || columns.has('row_hash') && digest(row.encoded_row) !== row.row_hash
            || columns.has('row_bytes') && Buffer.byteLength(row.encoded_row) !== Number(row.row_bytes)) throw new Error('Invalid collaboration encoded_row')
          await parseLines(Readable.from([Buffer.from(row.encoded_row)]))
        }
      }
    }
    report.referencedBlobs = refs.size
    const found = new Set<string>()
    for (const file of await walk(blobs, true)) {
      const relative = path.relative(blobs, file).replaceAll('\\', '/')
      const match = /^([a-f0-9]{64})\/([a-f0-9]{2})\/([a-f0-9]{64})\.gz$/.exec(relative)
      if (!match || match[2] !== match[3].slice(0, 2)) {
        if (/^[a-f0-9]{64}\/[a-f0-9]{2}\/[a-f0-9]{64}\.gz\.[a-f0-9-]{36}\.tmp$/.test(relative)) continue
        throw new Error('Unknown blob storage path: ' + relative)
      }
      report.blobFiles++; found.add(relative)
      if (observed.get(file)!.size > MAX_BLOB_BYTES + 65536) throw new Error('Compressed blob exceeds storage limit')
      const expected = refs.get(relative), hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true })
      let decodedBytes = 0
      const validator = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        try {
          decodedBytes += chunk.length
          if (decodedBytes > MAX_BLOB_BYTES) throw new Error('Blob exceeds storage limit')
          hash.update(chunk); decoder.decode(chunk, { stream: true }); callback(null, chunk)
        } catch (error) { callback(error as Error) }
      } })
      await pipeline(fs.createReadStream(file), createGunzip(), validator, new Writable({ write(_chunk, _encoding, callback) { callback() } }))
      decoder.decode()
      if (hash.digest('hex') !== match[3] || expected !== undefined && expected !== decodedBytes) throw new Error('Blob checksum or length mismatch: ' + relative)
      const info = observed.get(file)!
      if (expected === undefined) {
        if (info.mtimeMs > now - age) report.retainedYoungBlobs++
        else { candidates.push({ file, info, relative }); report.orphanFiles.push(relative); report.orphanBytes += info.size }
      }
    }
    for (const reference of refs.keys()) if (!found.has(reference)) throw new Error('Referenced blob is missing: ' + reference)
    // All reads and source verification finish before the first unlink. Includes directory inventories and candidate inodes.
    for (const [file, before] of observed) if (!same(before, await fsp.lstat(file))) throw new Error('Source changed during GC inventory: ' + file)
    for (const directory of missing) {
      try { await fsp.lstat(directory); throw new Error('A source directory appeared during GC inventory: ' + directory) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    report.safeToSweep = true
    if (options.apply) {
      report.mode = 'applied'
      for (const candidate of candidates) {
        // Every candidate inode was checked in the preflight above. No further reads follow the first unlink.
        // Exclusive SQLite ownership plus the mandatory stopped-engine contract excludes concurrent writers.
        await fsp.unlink(candidate.file); report.deletedFiles++; report.deletedBytes += candidate.info.size
      }
    }
  } catch (error) {
    report.mode = 'refused'; report.safeToSweep = false
    report.errors.push(error instanceof Error ? error.message : String(error))
  }
  return report
}

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'

export interface ColdHistoryManifest {
  format: 'aether-history-cold'
  schemaVersion: 1
  hashAlgorithm: 'sha256'
  archivedAt: number
  source: { relativePath: string; bytes: number; sha256: string; mtimeMs: number }
  archive: { relativePath: string; bytes: number; sha256: string }
}
export interface SealedHistoryBackup { relativePath: string; bytes: number; mtimeMs: number }
export interface ColdHistoryReceipt { manifestPath: string; manifest: ColdHistoryManifest; removedSource: boolean }
const hashPattern = /^[a-f0-9]{64}$/
const archivePattern = /^[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.jsonl\.gz$/
const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const sink = () => new Writable({ write(_chunk, _encoding, callback) { callback() } })
function meter(limit = Number.MAX_SAFE_INTEGER) {
  const hash = createHash('sha256'); let bytes = 0
  const stream = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length
    if (bytes > limit) { callback(new Error('History archive exceeds its declared size')); return }
    hash.update(chunk); callback(null, chunk)
  } })
  return { stream, finish: () => ({ bytes, sha256: hash.digest('hex') }) }
}
export function isSealedHistoryBackup(file: string): boolean {
  // Current clear(): session.jsonl.<timestamp>.bak; also accept the older .jsonl.bak[.suffix] spelling.
  return /\.jsonl(?:\.\d+\.bak|\.bak(?:[._-][A-Za-z0-9_-]+)?)$/.test(path.basename(file))
}
function relativeFile(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Invalid relative history path')
  const result = path.resolve(root, relative)
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('History path escapes its directory')
  return result
}
async function regularFile(root: string, file: string): Promise<fs.Stats> {
  const info = await fsp.lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('History input must be a regular non-symlink file')
  const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(file)])
  if (!realFile.startsWith(realRoot + path.sep)) throw new Error('History path escapes through a directory link')
  return info
}
function unchanged(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.birthtimeMs === after.birthtimeMs
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try { handle = await fsp.open(directory, 'r'); await handle.sync() }
  catch (error) {
    // Windows has no portable directory fsync. Every data/manifest file is flushed through a writable handle.
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EACCES', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally { await handle?.close() }
}
async function syncFile(file: string): Promise<void> {
  const handle = await fsp.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}
async function publish(temporary: string, destination: string): Promise<void> {
  try { await fsp.link(temporary, destination) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = await fsp.lstat(destination)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Cold publication target is not a regular file')
  // link() publishes a fully flushed inode atomically without overwriting any existing file.
  await syncFile(destination); await syncDirectory(path.dirname(destination))
}
function validateManifest(value: unknown): ColdHistoryManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid history cold manifest')
  const data = value as ColdHistoryManifest
  if (data.format !== 'aether-history-cold' || data.schemaVersion !== 1 || data.hashAlgorithm !== 'sha256'
    || !safeInteger(data.archivedAt) || !data.source || !data.archive || typeof data.source.relativePath !== 'string'
    || !isSealedHistoryBackup(data.source.relativePath) || !safeInteger(data.source.bytes) || !hashPattern.test(data.source.sha256)
    || typeof data.source.mtimeMs !== 'number' || !Number.isFinite(data.source.mtimeMs)
    || typeof data.archive.relativePath !== 'string' || !archivePattern.test(data.archive.relativePath)
    || !safeInteger(data.archive.bytes) || !hashPattern.test(data.archive.sha256)) throw new Error('Invalid history cold manifest')
  relativeFile(path.resolve('.'), data.source.relativePath)
  return data
}
export async function readColdHistoryManifest(coldRoot: string, manifestPath: string): Promise<ColdHistoryManifest> {
  const file = path.resolve(manifestPath)
  const info = await regularFile(coldRoot, file)
  if (info.size > 64 * 1024 || !file.endsWith('.jsonl.gz.manifest.json')) throw new Error('Invalid history manifest file')
  const manifest = validateManifest(JSON.parse(await fsp.readFile(file, 'utf8')))
  if (relativeFile(coldRoot, manifest.archive.relativePath) + '.manifest.json' !== file) throw new Error('History manifest does not match its archive path')
  return manifest
}
async function verifyArchive(coldRoot: string, manifest: ColdHistoryManifest, output?: string): Promise<void> {
  const file = relativeFile(coldRoot, manifest.archive.relativePath), info = await regularFile(coldRoot, file)
  if (info.size !== manifest.archive.bytes) throw new Error('History archive compressed size mismatch')
  const compressed = meter(manifest.archive.bytes), original = meter(manifest.source.bytes)
  await pipeline(fs.createReadStream(file), compressed.stream, createGunzip(), original.stream,
    output ? fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }) : sink())
  const packed = compressed.finish(), unpacked = original.finish()
  if (packed.sha256 !== manifest.archive.sha256 || packed.bytes !== manifest.archive.bytes
    || unpacked.sha256 !== manifest.source.sha256 || unpacked.bytes !== manifest.source.bytes) throw new Error('History archive checksum mismatch')
  if (!unchanged(info, await regularFile(coldRoot, file))) throw new Error('History archive changed while reading')
}
export async function verifyColdHistoryArchive(coldRoot: string, manifestPath: string): Promise<ColdHistoryManifest> {
  const manifest = await readColdHistoryManifest(coldRoot, manifestPath)
  await verifyArchive(coldRoot, manifest)
  return manifest
}

/** Read-only inventory. Directory links are never traversed; active .jsonl files never qualify. */
export async function listSealedHistoryBackups(sessionsRoot: string, maxFiles = 128): Promise<{ files: SealedHistoryBackup[]; hasMore: boolean }> {
  if (!safeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) throw new RangeError('Invalid backup file limit')
  const root = path.resolve(sessionsRoot), files: SealedHistoryBackup[] = []
  let visited = 0, hasMore = false
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('Unexpected session directory depth')
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (++visited > 100_000) throw new Error('Session inventory limit exceeded')
      if (entry.isSymbolicLink()) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file, depth + 1)
      else if (entry.isFile() && isSealedHistoryBackup(entry.name)) {
        if (files.length === maxFiles) { hasMore = true; return }
        const info = await regularFile(root, file)
        files.push({ relativePath: path.relative(root, file).replaceAll('\\', '/'), bytes: info.size, mtimeMs: info.mtimeMs })
      }
      if (hasMore) return
    }
  }
  await walk(root, 0)
  return { files, hasMore }
}

/** Only sealed backup files are eligible. Source deletion requires a separate explicit option. */
export async function archiveSealedHistoryBackup(sessionsRoot: string, relativePath: string, coldRoot: string,
  options: { removeSource?: boolean } = {}): Promise<ColdHistoryReceipt> {
  if (!isSealedHistoryBackup(relativePath)) throw new Error('Only sealed .jsonl backup files may be cold archived')
  const source = relativeFile(sessionsRoot, relativePath), before = await regularFile(sessionsRoot, source)
  await fsp.mkdir(coldRoot, { recursive: true, mode: 0o700 })
  const temporary = path.join(coldRoot, '.compress-' + randomUUID() + '.tmp')
  let manifestTemporary: string | undefined
  try {
    const input = await fsp.open(source, 'r'), original = meter(), compressed = meter()
    let sourceInfo: fs.Stats
    try {
      sourceInfo = await input.stat()
      if (!unchanged(before, sourceInfo)) throw new Error('Sealed history changed before compression')
      await pipeline(input.createReadStream({ autoClose: false }), original.stream, createGzip(), compressed.stream,
        fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      if (!unchanged(sourceInfo, await input.stat()) || !unchanged(before, await regularFile(sessionsRoot, source)))
        throw new Error('Sealed history changed during compression')
    } finally { await input.close() }
    const raw = original.finish(), packed = compressed.finish()
    if (raw.bytes !== before.size) throw new Error('Sealed history size changed during compression')
    await syncFile(temporary)
    const archiveRelative = `${digest(relativePath)}/${raw.sha256}-${packed.sha256}.jsonl.gz`
    const archiveFile = relativeFile(coldRoot, archiveRelative)
    await fsp.mkdir(path.dirname(archiveFile), { recursive: true, mode: 0o700 })
    // Verify the generated subdirectory resolves inside the requested cold root before publication.
    const [realCold, realParent] = await Promise.all([fsp.realpath(coldRoot), fsp.realpath(path.dirname(archiveFile))])
    if (!realParent.startsWith(realCold + path.sep)) throw new Error('Cold history directory escapes its root')
    let manifest: ColdHistoryManifest = { format: 'aether-history-cold', schemaVersion: 1, hashAlgorithm: 'sha256', archivedAt: Date.now(),
      source: { relativePath, ...raw, mtimeMs: before.mtimeMs }, archive: { relativePath: archiveRelative, ...packed } }
    await publish(temporary, archiveFile)
    await verifyArchive(coldRoot, manifest)
    const manifestPath = archiveFile + '.manifest.json'
    manifestTemporary = manifestPath + '.' + randomUUID() + '.tmp'
    const handle = await fsp.open(manifestTemporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(manifest) + '\n'); await handle.sync() } finally { await handle.close() }
    await publish(manifestTemporary, manifestPath)
    manifest = await verifyColdHistoryArchive(coldRoot, manifestPath)
    if (manifest.source.relativePath !== relativePath || manifest.source.sha256 !== raw.sha256 || manifest.source.bytes !== raw.bytes)
      throw new Error('Existing cold manifest conflicts with source')
    await syncDirectory(coldRoot); await syncDirectory(path.dirname(path.resolve(coldRoot)))
    if (options.removeSource) {
      // Re-read the source immediately before removal; an archive can never authorize deletion of different bytes.
      const current = await regularFile(sessionsRoot, source), check = meter(before.size)
      if (!unchanged(before, current)) throw new Error('Sealed history changed before removal')
      await pipeline(fs.createReadStream(source), check.stream, sink())
      const checked = check.finish()
      if (checked.sha256 !== raw.sha256 || checked.bytes !== raw.bytes || !unchanged(current, await regularFile(sessionsRoot, source)))
        throw new Error('Sealed history changed before removal')
      await fsp.unlink(source); await syncDirectory(path.dirname(source))
    }
    return { manifestPath, manifest, removedSource: options.removeSource === true }
  } finally {
    await fsp.unlink(temporary).catch(() => {})
    if (manifestTemporary) await fsp.unlink(manifestTemporary).catch(() => {})
  }
}

/** Restore exact raw bytes to a new backup/export path. Never overwrite or create an active .jsonl. */
export async function restoreColdHistoryArchive(coldRoot: string, manifestPath: string, destination: string): Promise<ColdHistoryManifest> {
  const output = path.resolve(destination)
  if (/\.jsonl$/i.test(output)) throw new Error('Restore to a backup/export path, not an active .jsonl')
  const manifest = await readColdHistoryManifest(coldRoot, manifestPath)
  await fsp.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
  const temporary = output + '.' + randomUUID() + '.restore.tmp'
  try {
    await verifyArchive(coldRoot, manifest, temporary)
    await syncFile(temporary)
    await fsp.link(temporary, output) // fail if destination already exists, including symlinks
    await syncFile(output); await syncDirectory(path.dirname(output))
    return manifest
  } finally { await fsp.unlink(temporary).catch(() => {}) }
}

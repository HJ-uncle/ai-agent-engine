import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PluginImporter, type PluginImportInput, type PluginImportJob } from './importer.js'
import { inspectPluginZip, extractPluginZipEntry, type PluginZipEntry } from './zip.js'
import { PluginError } from './types.js'

export interface PluginBatchImportItem { fileName: string; import?: Omit<PluginImportJob, 'files'>; error?: string }
export interface PluginBatchImportResult { imports: PluginBatchImportItem[] }
export type PluginBatchImportInput = PluginImportInput & { maxPlugins?: number }
const fail = (message: string): never => { throw new PluginError('invalid-import-batch', message) }
const checkAbort = (signal?: AbortSignal): void => { if (signal?.aborted) throw new PluginError('import-cancelled', 'Plugin import was cancelled', 409) }
const summary = ({ files: _files, ...job }: PluginImportJob): Omit<PluginImportJob, 'files'> => job

async function zipBytes(input: Extract<PluginImportInput, { type: 'zip' }>): Promise<Buffer> {
  if (Boolean(input.path) === Boolean(input.base64)) return fail('Provide exactly one ZIP path or base64 payload')
  if (!input.path) {
    if (typeof input.base64 !== 'string' || input.base64.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(input.base64)) return fail('Invalid ZIP base64 payload')
    const bytes = Buffer.from(input.base64, 'base64')
    return bytes
  }
  if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) return fail('ZIP path must be an absolute regular file')
  for (let current = path.resolve(input.path); ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) return fail('Plugin import paths cannot contain links')
    if (path.dirname(current) === current) break
  }
  const handle = await fs.open(input.path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return fail('Plugin ZIP is not a regular file')
    // Detect mutation while reading without assigning a plugin-specific archive ceiling.
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) { const next = await handle.read(bytes, length, bytes.length - length, null); if (!next.bytesRead) break; length += next.bytesRead }
    if (length !== stat.size) return fail('Plugin ZIP changed while reading')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}

function bundleMetadata(name: string, directory: boolean): boolean {
  if (directory) return /^(?:plugins|evidence|screenshots)(?:\/.*)?\/$/.test(name)
  return /^(?:[^/]+\.(?:md|txt)|manifest\.json)$/i.test(name)
    || /^evidence\/.+\.json$/i.test(name)
    || /^screenshots\/.+\.(?:png|jpe?g|webp)$/i.test(name)
}

/** Preview only. Each job retains the existing tenant-scoped install/cancel lifecycle. */
export async function previewPluginImportBatch(importer: PluginImporter, tenantId: string, input: PluginBatchImportInput, signal?: AbortSignal): Promise<PluginBatchImportResult> {
  if (!input || typeof input !== 'object') return fail('Plugin import input must be an object')
  const maxPlugins = input.maxPlugins
  if (maxPlugins !== undefined && (!Number.isSafeInteger(maxPlugins) || maxPlugins < 1)) return fail('maxPlugins must be a positive integer')
  if (!['local', 'zip', 'github'].includes(input.type) || input.format !== undefined && !['native', 'remark'].includes(input.format)) return fail('Unsupported plugin import source or format')
  checkAbort(signal)
  const prepare = async (fileName: string, source: PluginImportInput): Promise<PluginBatchImportItem> => {
    checkAbort(signal)
    try { return { fileName, import: summary(await importer.previewImport(tenantId, source, signal)) } }
    catch (error) {
      checkAbort(signal)
      const item: PluginBatchImportItem = { fileName, error: error instanceof Error ? error.message : String(error) }
      const jobId = (error as { jobId?: string })?.jobId
      if (jobId) item.import = summary(await importer.getImport(tenantId, jobId))
      return item
    }
  }
  if (input.type !== 'zip') {
    return { imports: [await prepare(input.type === 'local' ? path.basename(input.path || '') || 'plugin' : input.repository || 'plugin', input)] }
  }
  const bytes = await zipBytes(input), outer = inspectPluginZip(bytes)
  const children = outer.entries.filter(entry => !entry.directory && /^plugins\/[^/]+\.zip$/i.test(entry.name))
  // A normal package, explicit subdirectory or adapter keeps the existing single-package semantics.
  if (input.format === 'remark' || input.subdirectory || outer.entries.some(entry => entry.name === 'aether-plugin.json') || !children.length) {
    if (!children.length && !outer.entries.some(entry => /(?:^|\/)aether-plugin\.json$/.test(entry.name) || input.format === 'remark' && /(?:^|\/)package\.json$/.test(entry.name))) return fail('ZIP contains no recognizable plugin')
    return { imports: [await prepare(input.path ? path.basename(input.path) : 'plugin.zip', { ...input, path: undefined, base64: bytes.toString('base64') })] }
  }
  if (maxPlugins !== undefined && children.length > maxPlugins) return fail(`Plugin bundle contains ${children.length} plugins; limit is ${maxPlugins}`)
  if (input.id || input.name) return fail('Plugin bundle cannot override every plugin identity')
  const selected = new Set(children)
  if (outer.entries.some(entry => !selected.has(entry) && !bundleMetadata(entry.name, entry.directory))) return fail('Plugin bundle contains unsupported files; only plugins/*.zip and delivery documentation are accepted')

  // Validate nested package metadata one at a time. Keep only outer-entry
  // references, not another retained copy of every expanded child archive.
  const candidates: { fileName: string; entry?: PluginZipEntry; error?: string }[] = []
  for (const entry of children) {
    checkAbort(signal)
    const candidate: typeof candidates[number] = { fileName: path.posix.basename(entry.name) }
    try {
      const nested = extractPluginZipEntry(outer, entry), directory = inspectPluginZip(nested)
      if (directory.entries.some(item => !item.directory && /^plugins\/[^/]+\.zip$/i.test(item.name)) && !directory.entries.some(item => item.name === 'aether-plugin.json')) throw new PluginError('invalid-import-batch', 'Nested plugin bundles are not supported')
      candidate.entry = entry
    } catch (error) { candidate.error = error instanceof Error ? error.message : String(error) }
    candidates.push(candidate)
  }
  const imports: PluginBatchImportItem[] = []
  try {
    for (const candidate of candidates) {
      checkAbort(signal)
      imports.push(candidate.entry ? await prepare(candidate.fileName, { type: 'zip', format: 'native', base64: extractPluginZipEntry(outer, candidate.entry).toString('base64') }) : { fileName: candidate.fileName, error: candidate.error })
    }
    checkAbort(signal)
    return { imports }
  } catch (error) {
    // A disconnected caller will never receive these jobs. Keep cancelled receipts,
    // remove their staged sources, and never start another child after abort.
    if (signal?.aborted) for (const item of imports) if (item.import) await importer.cancelImport(tenantId, item.import.jobId)
    throw error
  }
}

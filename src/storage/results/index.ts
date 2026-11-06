import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { AgentContext, ConversationHistory } from '../../core/agent-context/types.js'
import { serviceForOwner } from '../../core/collaboration/execution-owner.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { MAX_RESULT_ASSET_BYTES, MAX_RESULT_ITEMS, MAX_RESULT_TOTAL_BYTES, type FinalResult, type FinalResultItem } from '../../core/final-result.js'
import { workspaceManager } from '../../workspace/index.js'
import { getDb } from '../sqlite/db.js'
import { rootRunStore } from '../root-runs/index.js'
import { withHistoryLock } from '../conversation/serialization.js'
import { IMAGE_MIME_TYPES } from '../../tools/file/constants.js'
import { resultImageExtension, resultToolImages } from './tool-images.js'

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const schemas = new WeakMap<Client, Promise<void>>()
const MIME: Record<string, string> = {
  ...IMAGE_MIME_TYPES, '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}

export type ResultFileInput = { path: string; name?: string } | { toolCallId: string; imageIndex?: number; name?: string }
export const TOOL_RESULT_IMAGE_ASSETS = '__aetherResultImageAssets'
interface Scope { tenantId: string; sessionId: string; runId: string; turnId: string; attemptId: string }
type OwnedContext = Pick<AgentContext, 'tenantId' | 'sessionId' | 'rootRunId' | 'turnId' | 'executionOwner' | 'signal'>

/** Model arguments never choose an owner. Child work is explicitly selected by its root. */
function ownedScope(ctx: OwnedContext): Scope {
  throwIfAborted(ctx.signal)
  if (!ctx.executionOwner) throw new Error('Final delivery requires an active root execution')
  const owner = serviceForOwner(ctx.executionOwner)
  owner.assertDispatch(ctx.executionOwner)
  const binding = owner.record(ctx.executionOwner).binding
  if (binding.kind !== 'root' || binding.tenantId !== ctx.tenantId || binding.rootSessionId !== ctx.sessionId
    || binding.rootRunId !== ctx.rootRunId || binding.turnId !== ctx.turnId) throw new Error('Final delivery owner mismatch')
  return { tenantId: ctx.tenantId, sessionId: ctx.sessionId, runId: binding.rootRunId, turnId: binding.turnId, attemptId: binding.rootAttemptId }
}

async function ready(db: Client): Promise<void> {
  let promise = schemas.get(db)
  if (!promise) {
    promise = db.execute(`CREATE TABLE IF NOT EXISTS final_result_manifests (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, items TEXT NOT NULL, final_result TEXT,
      PRIMARY KEY (tenant_id, session_id, run_id))`).then(() => {})
    schemas.set(db, promise)
    promise.catch(() => { if (schemas.get(db) === promise) schemas.delete(db) })
  }
  await promise
}

/** Source files may be replaced or deleted after delivery; only these private bytes are served. */
export class FinalResultStore {
  constructor(private readonly options: { db?: Client; root?: string } = {}) {}
  private get db(): Client { return this.options.db ?? getDb() }
  private get root(): string { return this.options.root ?? path.join(path.dirname(path.resolve(process.env.DATA_DIR ?? './data/agent.db')), 'result-assets') }

  private async assetFile(tenantId: string, hash: string, create = false): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid result asset hash')
    const root = this.root, tenant = digest(tenantId), directory = path.join(root, tenant, hash.slice(0, 2))
    if (create) await fs.mkdir(path.dirname(root), { recursive: true })
    for (const current of [root, path.join(root, tenant), directory]) {
      if (create) await fs.mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid result asset directory')
    }
    return path.join(directory, hash)
  }

  private async readBytes(tenantId: string, item: FinalResultItem): Promise<Buffer> {
    const file = await this.assetFile(tenantId, item.sha256)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size || stat.size > MAX_RESULT_ASSET_BYTES) throw new Error('Result asset integrity check failed')
    const bytes = await fs.readFile(file)
    if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw new Error('Result asset integrity check failed')
    return bytes
  }

  private async saveBytes(tenantId: string, bytes: Buffer, item: FinalResultItem): Promise<void> {
    const file = await this.assetFile(tenantId, item.sha256, true), temporary = `${file}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes); await handle.sync()
    } finally { await handle.close() }
    try {
      // A hard link publishes one complete inode and never overwrites an earlier version.
      await fs.link(temporary, file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      await this.readBytes(tenantId, item)
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(file), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }

  /** Bounded process evidence may outlive text truncation without becoming a deliverable. */
  async retainToolImages(ctx: AgentContext, toolCallId: string, output: string): Promise<FinalResultItem[]> {
    if (!ctx.rootRunId || !ctx.turnId || ctx.parentSessionId || !ctx.executionOwner || ctx.signal?.aborted) return []
    const images = resultToolImages(output)
    if (!images.length) return []
    const scope = ownedScope(ctx), items: FinalResultItem[] = []
    let total = 0
    for (const [index, captured] of images.entries()) {
      total += captured.bytes.length
      if (total > MAX_RESULT_TOTAL_BYTES) throw new Error('Tool image evidence exceeds the result asset limit')
      const assetId = randomUUID(), name = `result-${index + 1}.${resultImageExtension(captured.mimeType)}`
      const item: FinalResultItem = { id: assetId, assetId, name, path: `tool-result/${encodeURIComponent(toolCallId)}/${index}/${name}`,
        mimeType: captured.mimeType, size: captured.bytes.length, sha256: digest(captured.bytes), kind: 'image' }
      ownedScope(ctx)
      await this.saveBytes(scope.tenantId, captured.bytes, item)
      items.push(item)
    }
    ownedScope(ctx)
    return items
  }

  async stage(ctx: AgentContext, files: ResultFileInput[]): Promise<FinalResultItem[]> {
    const scope = ownedScope(ctx), db = this.db
    if (files.length > MAX_RESULT_ITEMS) throw new Error(`At most ${MAX_RESULT_ITEMS} result files may be delivered`)
    await ready(db)
    const items: FinalResultItem[] = [], seen = new Set<string>()
    let total = 0
    for (const input of files) {
      ownedScope(ctx)
      if ('toolCallId' in input) {
        const index = input.imageIndex ?? 0
        const key = `tool:${input.toolCallId}:${index}`
        if (seen.has(key)) throw new Error('A result image may only appear once')
        seen.add(key)
        const receipt = await ctx.history.getMessageById(`tool-result:${scope.runId}:${input.toolCallId}`, scope.tenantId, scope.sessionId)
        if (receipt?.role !== 'tool' || receipt.toolCallId !== input.toolCallId || receipt.metadata?.rootRunId !== scope.runId
          || receipt.metadata?.turnId !== scope.turnId || receipt.metadata?.success !== true) throw new Error('Image source must be a successful tool receipt from this turn')
        const retained = receipt.metadata?.[TOOL_RESULT_IMAGE_ASSETS]
        const retainedItem: FinalResultItem | undefined = Array.isArray(retained) ? retained[index] : undefined
        const captured = retainedItem
          ? { bytes: await this.readBytes(scope.tenantId, retainedItem), mimeType: retainedItem.mimeType }
          : resultToolImages(receipt.content)[index]
        if (!captured) throw new Error('Selected tool image is unavailable; use a retained image file or a new explicit screenshot')
        const name = input.name?.trim() || `result-${index + 1}.${resultImageExtension(captured.mimeType)}`
        if (!name || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid result file name')
        total += captured.bytes.length
        if (total > MAX_RESULT_TOTAL_BYTES) throw new Error('Result files exceed the 128 MiB total limit')
        const assetId = randomUUID()
        const item: FinalResultItem = { id: assetId, assetId, name, path: `tool-result/${encodeURIComponent(input.toolCallId)}/${index}/${name}`,
          mimeType: captured.mimeType, size: captured.bytes.length, sha256: digest(captured.bytes), kind: 'image' }
        ownedScope(ctx)
        await this.saveBytes(scope.tenantId, captured.bytes, item)
        items.push(item)
        continue
      }
      const canonical = await fs.realpath(workspaceManager.resolveSafePath(ctx, input.path))
      workspaceManager.resolveSafePath(ctx, canonical)
      const roots = await Promise.all(workspaceManager.getPaths(ctx).map(root => fs.realpath(root).catch(() => undefined)))
      if (!roots.some(root => {
        if (!root) return false
        const relative = path.relative(root, canonical)
        return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
      })) throw new Error('Final delivery file is outside this session workspace')
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
      if (seen.has(key)) throw new Error('A result file may only appear once')
      seen.add(key)
      const name = input.name?.trim() || path.basename(canonical)
      if (!name || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid result file name')
      const handle = await fs.open(canonical, 'r')
      let bytes: Buffer
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > MAX_RESULT_ASSET_BYTES) throw new Error('Result file must be a regular file no larger than 32 MiB')
        total += before.size
        if (total > MAX_RESULT_TOTAL_BYTES) throw new Error('Result files exceed the 128 MiB total limit')
        // A file that grows during capture cannot allocate unbounded memory.
        const bounded = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < bounded.length) {
          const read = await handle.read(bounded, length, bounded.length - length, length)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        bytes = bounded.subarray(0, length)
        const after = await handle.stat()
        if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Result file changed while being captured; retry after writing finishes')
      } finally { await handle.close() }
      ownedScope(ctx)
      const mimeType = MIME[path.extname(canonical).toLowerCase()] ?? 'application/octet-stream'
      const assetId = randomUUID()
      const item: FinalResultItem = { id: assetId, assetId, name, path: canonical, mimeType, size: bytes.length, sha256: digest(bytes), kind: mimeType.startsWith('image/') ? 'image' : 'file' }
      await this.saveBytes(scope.tenantId, bytes, item)
      items.push(item)
    }
    await withHistoryLock(scope.tenantId, async () => {
      ownedScope(ctx)
      const run = await rootRunStore.get(scope.tenantId, scope.runId)
      ownedScope(ctx)
      if (!run || run.status !== 'running' || run.sessionId !== scope.sessionId || run.turnId !== scope.turnId || run.attemptId !== scope.attemptId) throw new Error('Final delivery attempt is no longer active')
      await db.execute({ sql: `INSERT INTO final_result_manifests(tenant_id,session_id,run_id,turn_id,attempt_id,items,final_result)
        VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(tenant_id,session_id,run_id) DO UPDATE SET
        turn_id=excluded.turn_id,attempt_id=excluded.attempt_id,items=excluded.items,final_result=NULL`,
        args: [scope.tenantId, scope.sessionId, scope.runId, scope.turnId, scope.attemptId, JSON.stringify(items)] })
      ownedScope(ctx)
    })
    return items
  }

  /** This is a candidate until both the assistant archive and root success are durable. */
  async prepare(ctx: AgentContext, text: string, assistantMessageId: string): Promise<FinalResult | undefined> {
    if (!ctx.rootRunId || !ctx.turnId || ctx.parentSessionId || !ctx.executionOwner) return undefined
    const scope = ownedScope(ctx), db = this.db
    await ready(db)
    return withHistoryLock(scope.tenantId, async () => {
      ownedScope(ctx)
      const run = await rootRunStore.get(scope.tenantId, scope.runId)
      if (!run || run.status !== 'running' || run.sessionId !== scope.sessionId || run.turnId !== scope.turnId || run.attemptId !== scope.attemptId) throw new Error('Final result attempt is no longer active')
      const row = await db.execute({ sql: 'SELECT items,turn_id,attempt_id FROM final_result_manifests WHERE tenant_id=? AND session_id=? AND run_id=?', args: [scope.tenantId, scope.sessionId, scope.runId] })
      // A parked run keeps its accepted selection. Only the newly admitted owner
      // may adopt it; stale attempts cannot replace it because stage rechecks ownership.
      const stored = row.rows[0]
      const items: FinalResultItem[] = stored?.turn_id === scope.turnId ? JSON.parse(String(stored.items)) : []
      for (const item of items) await this.readBytes(scope.tenantId, item)
      ownedScope(ctx)
      const result: FinalResult = { schemaVersion: 1, sessionId: scope.sessionId, turnId: scope.turnId, runId: scope.runId, assistantMessageId, text, items, publishedAt: Date.now() }
      await db.execute({ sql: `INSERT INTO final_result_manifests(tenant_id,session_id,run_id,turn_id,attempt_id,items,final_result)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,session_id,run_id) DO UPDATE SET
        turn_id=excluded.turn_id,attempt_id=excluded.attempt_id,items=excluded.items,final_result=excluded.final_result`,
        args: [scope.tenantId, scope.sessionId, scope.runId, scope.turnId, scope.attemptId, JSON.stringify(items), JSON.stringify(result)] })
      ownedScope(ctx)
      return result
    })
  }

  async readAsset(tenantId: string, sessionId: string, runId: string, assetId: string, history: ConversationHistory): Promise<{
    path: string; content: string; isBinary: boolean; totalSize: number; tooLarge: false; truncated: false; mimeType: string; encoding: 'base64'; sha256: string
  }> {
    if (![sessionId, runId, assetId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) throw new Error('Invalid result identity')
    const db = this.db
    await ready(db)
    const authorize = async (): Promise<{ result: FinalResult; item: FinalResultItem }> => {
      const run = await rootRunStore.get(tenantId, runId)
      if (!run || run.sessionId !== sessionId || run.status !== 'succeeded') throw new Error('Final result is not available')
      const rows = await db.execute({ sql: 'SELECT final_result,attempt_id FROM final_result_manifests WHERE tenant_id=? AND session_id=? AND run_id=?', args: [tenantId, sessionId, runId] })
      const row = rows.rows[0]
      if (!row?.final_result || row.attempt_id !== run.attemptId) throw new Error('Final result is not available')
      const result: FinalResult = JSON.parse(String(row.final_result))
      if (result.sessionId !== sessionId || result.runId !== runId || result.turnId !== run.turnId) throw new Error('Final result identity mismatch')
      const message = await history.getMessageById(result.assistantMessageId, tenantId, sessionId)
      if (message?.role !== 'assistant' || JSON.stringify(message.metadata?.finalResult) !== JSON.stringify(result)) throw new Error('Final result is no longer in this conversation')
      const item = result.items.find(candidate => candidate.assetId === assetId)
      if (!item) throw new Error('Result asset does not belong to this final result')
      return { result, item }
    }
    const { item } = await authorize()
    const bytes = await this.readBytes(tenantId, item)
    // A concurrent history deletion or run replacement must not complete an old read.
    const current = await authorize()
    if (current.item.sha256 !== item.sha256) throw new Error('Result asset changed during reading')
    return { path: item.path, content: bytes.toString('base64'), isBinary: item.kind === 'image' || bytes.includes(0) || !/^(?:text\/|application\/json$)/.test(item.mimeType), totalSize: bytes.length, tooLarge: false, truncated: false, mimeType: item.mimeType, encoding: 'base64', sha256: item.sha256 }
  }
}

export const finalResults = new FinalResultStore()

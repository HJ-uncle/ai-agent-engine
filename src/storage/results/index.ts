import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { AgentContext, ConversationHistory, Message } from '../../core/agent-context/types.js'
import { serviceForOwner } from '../../core/collaboration/execution-owner.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { MAX_RESULT_ASSET_BYTES, MAX_RESULT_ITEMS, MAX_RESULT_TOTAL_BYTES, type FinalResult, type FinalResultItem } from '../../core/final-result.js'
import { workspaceManager } from '../../workspace/index.js'
import { getDb } from '../sqlite/db.js'
import { rootRunStore } from '../root-runs/index.js'
import { withHistoryLock } from '../conversation/serialization.js'
import { IMAGE_MIME_TYPES } from '../../tools/file/constants.js'
import { resultImageExtension, resultToolImages } from './tool-images.js'
import { SubagentStore } from '../../core/subagent/store.js'
import type { CollaborationBinding } from '../../core/collaboration/types.js'
import { canonicalFilePathSync } from '../../shared/file-version.js'

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

export type ChildArtifactFileInput = { path: string; name?: string; expectedHash?: string }
export type ChildArtifactInput = { childSessionId: string; runId: string; artifactId: string; name?: string }
export type ResultFileInput = { path: string; name?: string } | { toolCallId: string; imageIndex?: number; name?: string } | ChildArtifactInput
export interface ChildArtifactManifest { childSessionId: string; runId: string; items: FinalResultItem[] }
export const TOOL_RESULT_IMAGE_ASSETS = '__aetherResultImageAssets'
export class StaleFinalDeliveryError extends Error {
  readonly code = 'FINAL_DELIVERY_STALE'
  constructor(readonly paths: string[]) {
    super('Staged final files changed or became unavailable. Validate the intended final versions and replace the full deliver_files list, or clear it with items:[]: ' + paths.join(', '))
    this.name = 'StaleFinalDeliveryError'
  }
}
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
    promise = db.batch([`CREATE TABLE IF NOT EXISTS final_result_manifests (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, items TEXT NOT NULL, final_result TEXT,
      PRIMARY KEY (tenant_id, session_id, run_id))`,
      `CREATE TABLE IF NOT EXISTS child_artifact_manifests (
        tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, child_session_id TEXT NOT NULL,
        run_id TEXT NOT NULL, root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL,
        report_key TEXT NOT NULL, input_hash TEXT NOT NULL, items TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,child_session_id,run_id,report_key))`,
      `CREATE TABLE IF NOT EXISTS result_asset_sources (
        tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, asset_id TEXT NOT NULL, source_change_id TEXT,
        PRIMARY KEY(tenant_id,session_id,asset_id))`], 'write').then(() => {})
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

  private async sourceForFile(ctx: AgentContext, item: FinalResultItem): Promise<string | null> {
    const db = this.db
    if (!(await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_changes'")).rows.length) return null
    const row = (await db.execute({ sql: `SELECT id,new_hash,status FROM file_changes WHERE tenant_id=? AND session_id=?
      AND status!='reverted' AND path${process.platform === 'win32' ? ' COLLATE NOCASE' : ''}=? ORDER BY seq DESC LIMIT 1`,
      args: [ctx.tenantId, ctx.rootSessionId ?? ctx.parentSessionId ?? ctx.sessionId, item.path] })).rows[0]
    // An explicit null also matters: a manually recreated file must not later
    // acquire the provenance of a previously rolled back identical version.
    return row && row.status !== 'reverted' && row.new_hash === `sha256:${item.sha256}` ? String(row.id) : null
  }

  private async rememberSource(tenantId: string, sessionId: string, assetId: string, sourceChangeId: string | null): Promise<void> {
    await ready(this.db)
    await this.db.execute({ sql: `INSERT INTO result_asset_sources(tenant_id,session_id,asset_id,source_change_id) VALUES(?,?,?,?)`,
      args: [tenantId, sessionId, assetId, sourceChangeId] })
  }

  /** A retained copy is not a second publication: a reverted producing version
   * must disappear even when a different file blocks truncating the transcript.
   * Read the durable change status, so a crash between file rollback and an HTTP
   * response cannot leave an independent revocation flag out of sync. */
  private async revokedAssets(tenantId: string, results: Array<Pick<FinalResult, 'sessionId' | 'turnId' | 'runId' | 'publishedAt' | 'items'>>): Promise<Map<string, Set<string>>> {
    const revoked = new Map<string, Set<string>>()
    if (!results.some(result => result.items.length)) return revoked
    const db = this.db
    await ready(db)
    if (!(await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_changes'")).rows.length) return revoked
    const identity = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
    for (const sessionId of new Set(results.map(result => result.sessionId))) {
      const sessionResults = results.filter(result => result.sessionId === sessionId)
      const items = sessionResults.flatMap(result => result.items)
      const sources = new Map((await db.execute({ sql: `SELECT asset_id,source_change_id FROM result_asset_sources
        WHERE tenant_id=? AND session_id=? AND asset_id IN (SELECT value FROM json_each(?))`,
        args: [tenantId, sessionId, JSON.stringify(items.flatMap(item => [item.assetId, ...(item.producerArtifactId ? [item.producerArtifactId] : [])]))] })).rows
        .map(row => [String(row.asset_id), row.source_change_id === null ? null : String(row.source_change_id)]))
      const changes = (await db.execute({ sql: `SELECT id,path,new_hash,status,turn_id,producer_run_id,created_at FROM file_changes
        WHERE tenant_id=? AND session_id=? AND (id IN (SELECT value FROM json_each(?))
          OR new_hash IN (SELECT value FROM json_each(?))) ORDER BY seq DESC`,
        args: [tenantId, sessionId, JSON.stringify([...sources.values()].filter(Boolean)), JSON.stringify(items.map(item => `sha256:${item.sha256}`))] })).rows
      const legacyReports = items.some(item => item.producerArtifactId && !sources.has(item.assetId) && !sources.has(item.producerArtifactId))
        ? (await db.execute({ sql: `SELECT created_at,items FROM child_artifact_manifests WHERE tenant_id=? AND parent_session_id=?
          AND run_id IN (SELECT value FROM json_each(?))`, args: [tenantId, sessionId, JSON.stringify(items.flatMap(item => item.producerRunId ? [item.producerRunId] : []))] })).rows : []
      for (const result of sessionResults) {
        const assets = new Set<string>()
        for (const item of result.items) {
          if (item.path.startsWith('tool-result/')) continue
          const file = identity(item.path)
          const sourceKey = sources.has(item.assetId) ? item.assetId : item.producerArtifactId && sources.has(item.producerArtifactId) ? item.producerArtifactId : undefined
          const sourceId = sourceKey ? sources.get(sourceKey) : undefined
          const report = sourceKey === undefined && item.producerArtifactId ? legacyReports.find(row =>
            (JSON.parse(String(row.items)) as FinalResultItem[]).some(candidate => candidate.assetId === item.producerArtifactId)) : undefined
          // Older manifests lack exact provenance. Infer the producing version
          // across turns, bounded by the child report or root publication time.
          // A later re-delivery does not make the same undone file valid again.
          const producing = sourceKey !== undefined ? sourceId ? changes.find(change => change.id === sourceId) : undefined
            : changes.find(change => Number(change.created_at) <= Number(report?.created_at ?? result.publishedAt)
              && (!item.producerRunId || change.producer_run_id === item.producerRunId)
              && change.new_hash === `sha256:${item.sha256}` && identity(String(change.path)) === file)
          if (producing?.status === 'reverted') assets.add(item.assetId)
        }
        if (assets.size) revoked.set(result.runId, assets)
      }
    }
    return revoked
  }

  /** Keep the original answer as evidence when rollback is partial, while all
   * public projections agree on which attachments are still delivered. */
  async projectHistory(tenantId: string, messages: Message[]): Promise<Message[]> {
    const results = messages.flatMap(message => {
      const result = message.metadata?.finalResult as FinalResult | undefined
      return result?.schemaVersion === 1 && Array.isArray(result.items) ? [result] : []
    })
    const revoked = await this.revokedAssets(tenantId, results)
    if (!revoked.size) return messages
    return messages.map(message => {
      const result = message.metadata?.finalResult as FinalResult | undefined
      const assets = result && revoked.get(result.runId)
      return !result || !assets ? message : { ...message, metadata: { ...message.metadata,
        finalResult: { ...result, items: result.items.filter(item => !assets.has(item.assetId)) } } }
    })
  }

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

  private childScope(ctx: AgentContext): CollaborationBinding {
    throwIfAborted(ctx.signal)
    if (!ctx.executionOwner) throw new Error('Artifact reporting requires an active child execution')
    const service = serviceForOwner(ctx.executionOwner)
    if (service.db !== this.db) throw new Error('Artifact reporting datasource mismatch')
    service.assertDispatch(ctx.executionOwner)
    const binding = service.collaboration.executionBinding(service.producerForExecution(ctx.executionOwner))
    if (binding.kind !== 'child' || binding.tenantId !== ctx.tenantId || binding.sessionId !== ctx.sessionId
      || binding.invocationRunId !== ctx.runId || binding.rootRunId !== ctx.rootRunId || binding.turnId !== ctx.turnId
      || binding.rootSessionId !== ctx.parentSessionId) throw new Error('Artifact reporting owner mismatch')
    return binding
  }

  private async captureFile(ctx: AgentContext, input: ChildArtifactFileInput, trackSource = true): Promise<{ item: FinalResultItem; bytes: Buffer; sourceChangeId: string | null }> {
    const canonical = await fs.realpath(workspaceManager.resolveSafePath(ctx, input.path))
    workspaceManager.resolveSafePath(ctx, canonical)
    const roots = await Promise.all(workspaceManager.getPaths(ctx).map(root => fs.realpath(root).catch(() => undefined)))
    if (!roots.some(root => {
      if (!root) return false
      const relative = path.relative(root, canonical)
      return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
    })) throw new Error('Final delivery file is outside this session workspace')
    const name = input.name?.trim() || path.basename(canonical)
    if (!name || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid result file name')
    const handle = await fs.open(canonical, 'r')
    let bytes: Buffer
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > MAX_RESULT_ASSET_BYTES) throw new Error('Result file must be a regular file no larger than 32 MiB')
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
    const hash = digest(bytes)
    if (input.expectedHash !== undefined && input.expectedHash !== `sha256:${hash}`) throw new Error('Artifact file version changed before reporting')
    const mimeType = MIME[path.extname(canonical).toLowerCase()] ?? 'application/octet-stream'
    const assetId = randomUUID()
    const item: FinalResultItem = { id: assetId, assetId, name, path: canonical, mimeType, size: bytes.length, sha256: hash, kind: mimeType.startsWith('image/') ? 'image' : 'file' }
    return { bytes, item, sourceChangeId: trackSource ? await this.sourceForFile(ctx, item) : null }
  }

  /** A child records immutable candidate bytes; only a root may later adopt them. */
  async report(ctx: AgentContext, files: ChildArtifactFileInput[]): Promise<ChildArtifactManifest> {
    const binding = this.childScope(ctx), db = this.db
    if (!files.length || files.length > MAX_RESULT_ITEMS) throw new Error(`Report 1..${MAX_RESULT_ITEMS} child artifacts`)
    const reportKey = ctx.currentToolCallId
    if (!reportKey || reportKey.length > 512) throw new Error('Artifact reporting requires its actual tool invocation')
    const service = serviceForOwner(ctx.executionOwner!)
    const run = await new SubagentStore(db).getRunHeader(binding.tenantId, binding.invocationRunId, true)
    this.childScope(ctx)
    if (!run?.continuation || run.continuation.readOnly || run.childSessionId !== binding.sessionId
      || run.parentSessionId !== binding.rootSessionId) throw new Error('This child is not allowed to report file artifacts')
    await ready(db)
    const inputHash = digest(JSON.stringify(files))
    const prior = await db.execute({ sql: `SELECT input_hash,items FROM child_artifact_manifests
      WHERE tenant_id=? AND child_session_id=? AND run_id=? AND report_key=?`,
      args: [binding.tenantId, binding.sessionId, binding.invocationRunId, reportKey] })
    this.childScope(ctx)
    if (prior.rows[0]) {
      if (prior.rows[0].input_hash !== inputHash) throw new Error('Artifact report key already belongs to different input')
      return { childSessionId: binding.sessionId, runId: binding.invocationRunId, items: JSON.parse(String(prior.rows[0].items)) }
    }
    // Use the frozen child roots, never caller-provided paths to broaden a report.
    const fileContext = { ...ctx, workspacePaths: run.continuation.workspacePaths,
      projectRoot: run.continuation.projectRoot, cwd: run.continuation.cwd }
    const frozenRoots = await Promise.all([...new Set([...run.continuation.workspacePaths,
      ...(run.continuation.projectRoot ? [run.continuation.projectRoot] : [])])].map(root => fs.realpath(root).catch(() => undefined)))
    const items: FinalResultItem[] = [], seen = new Set<string>()
    let total = 0
    for (const file of files) {
      this.childScope(ctx)
      const { item, bytes, sourceChangeId } = await this.captureFile(fileContext, file)
      if (!frozenRoots.some(root => {
        if (!root) return false
        const relative = path.relative(root, item.path)
        return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
      })) throw new Error('Artifact file is outside the frozen child workspace')
      const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path
      if (seen.has(key)) throw new Error('A child artifact file may only appear once')
      seen.add(key)
      total += item.size
      if (total > MAX_RESULT_TOTAL_BYTES) throw new Error('Result files exceed the 128 MiB total limit')
      Object.assign(item, { producerChildSessionId: binding.sessionId, producerRunId: binding.invocationRunId, producerArtifactId: item.assetId })
      this.childScope(ctx)
      await this.saveBytes(binding.tenantId, bytes, item)
      await this.rememberSource(binding.tenantId, binding.rootSessionId, item.assetId, sourceChangeId)
      items.push(item)
    }
    const tx = await db.transaction('write')
    try {
      this.childScope(ctx)
      await service.collaboration.store.assertProducer(tx, binding)
      await tx.execute({ sql: `INSERT INTO child_artifact_manifests(tenant_id,parent_session_id,child_session_id,run_id,root_run_id,root_attempt_id,report_key,input_hash,items,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,child_session_id,run_id,report_key) DO NOTHING`,
        args: [binding.tenantId, binding.rootSessionId, binding.sessionId, binding.invocationRunId, binding.rootRunId, binding.rootAttemptId,
          reportKey, inputHash, JSON.stringify(items), Date.now()] })
      const accepted = (await tx.execute({ sql: `SELECT input_hash,items FROM child_artifact_manifests
        WHERE tenant_id=? AND child_session_id=? AND run_id=? AND report_key=?`,
        args: [binding.tenantId, binding.sessionId, binding.invocationRunId, reportKey] })).rows[0]
      if (!accepted || accepted.input_hash !== inputHash) throw new Error('Artifact report key already belongs to different input')
      this.childScope(ctx)
      await tx.commit()
      return { childSessionId: binding.sessionId, runId: binding.invocationRunId, items: JSON.parse(String(accepted.items)) }
    } catch (error) { await tx.rollback().catch(() => {}); throw error }
    finally { tx.close() }
  }

  private async childArtifact(ctx: AgentContext, scope: Scope, input: ChildArtifactInput): Promise<FinalResultItem> {
    const child = await new SubagentStore(this.db).getRunHeader(scope.tenantId, input.runId)
    ownedScope(ctx)
    if (!child || child.childSessionId !== input.childSessionId || child.parentSessionId !== scope.sessionId
      || child.rootSessionId !== scope.sessionId) throw new Error('Child artifact does not belong to this parent session')
    const rows = await this.db.execute({ sql: `SELECT j.value AS item,m.created_at FROM child_artifact_manifests m,json_each(m.items) j
      WHERE m.tenant_id=? AND m.parent_session_id=? AND m.child_session_id=? AND m.run_id=? AND json_extract(j.value,'$.assetId')=?`,
      args: [scope.tenantId, scope.sessionId, input.childSessionId, input.runId, input.artifactId] })
    ownedScope(ctx)
    if (rows.rows.length !== 1) throw new Error('Child artifact receipt is unavailable')
    const source: FinalResultItem = JSON.parse(String(rows.rows[0].item))
    if (source.producerChildSessionId !== input.childSessionId || source.producerRunId !== input.runId
      || source.producerArtifactId !== input.artifactId) throw new Error('Child artifact receipt identity mismatch')
    if ((await this.revokedAssets(scope.tenantId, [{ ...scope, items: [source], publishedAt: Date.now() }])).get(scope.runId)?.has(source.assetId))
      throw new Error('Child artifact receipt was withdrawn by file rollback')
    const sourcePath = canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, source.path))
    if (!workspaceManager.getPaths(ctx).some(root => {
      const relative = path.relative(canonicalFilePathSync(root), sourcePath)
      return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
    })) throw new Error('Child artifact is outside the current parent workspace')
    await this.readBytes(scope.tenantId, source)
    const name = input.name?.trim() || source.name
    if (!name || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid result file name')
    const assetId = randomUUID()
    const provenance = (await this.db.execute({ sql: `SELECT source_change_id FROM result_asset_sources WHERE tenant_id=? AND session_id=? AND asset_id=?`,
      args: [scope.tenantId, scope.sessionId, source.assetId] })).rows[0]
    let sourceChangeId = provenance?.source_change_id == null ? null : String(provenance.source_change_id)
    if (!provenance && (await this.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_changes'")).rows.length) {
      const receipt = (await this.db.execute({ sql: `SELECT id FROM file_changes WHERE tenant_id=? AND session_id=? AND producer_run_id=?
        AND path${process.platform === 'win32' ? ' COLLATE NOCASE' : ''}=? AND new_hash=? AND created_at<=? ORDER BY seq DESC LIMIT 1`,
        args: [scope.tenantId, scope.sessionId, source.producerRunId!, source.path, `sha256:${source.sha256}`, rows.rows[0].created_at] })).rows[0]
      sourceChangeId = receipt ? String(receipt.id) : null
    }
    await this.rememberSource(scope.tenantId, scope.sessionId, assetId, sourceChangeId)
    return { ...source, id: assetId, assetId, name }
  }

  async stage(ctx: AgentContext, files: ResultFileInput[]): Promise<FinalResultItem[]> {
    const scope = ownedScope(ctx), db = this.db
    if (files.length > MAX_RESULT_ITEMS) throw new Error(`At most ${MAX_RESULT_ITEMS} result files may be delivered`)
    await ready(db)
    const items: FinalResultItem[] = [], seen = new Set<string>()
    let total = 0
    for (const input of files) {
      ownedScope(ctx)
      if ('artifactId' in input) {
        const key = `child:${input.childSessionId}:${input.runId}:${input.artifactId}`
        if (seen.has(key)) throw new Error('A child artifact may only appear once')
        seen.add(key)
        const item = await this.childArtifact(ctx, scope, input)
        total += item.size
        if (total > MAX_RESULT_TOTAL_BYTES) throw new Error('Result files exceed the 128 MiB total limit')
        items.push(item)
        continue
      }
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
      const { item, bytes, sourceChangeId } = await this.captureFile(ctx, input)
      const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path
      if (seen.has(key)) throw new Error('A result file may only appear once')
      seen.add(key)
      total += item.size
      if (total > MAX_RESULT_TOTAL_BYTES) throw new Error('Result files exceed the 128 MiB total limit')
      ownedScope(ctx)
      await this.saveBytes(scope.tenantId, bytes, item)
      await this.rememberSource(scope.tenantId, scope.sessionId, item.assetId, sourceChangeId)
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

  private async changedSources(ctx: AgentContext, items: FinalResultItem[]): Promise<string[]> {
    const changed: string[] = []
    const revoked = (await this.revokedAssets(ctx.tenantId, [{ sessionId: ctx.sessionId, runId: ctx.rootRunId!, turnId: ctx.turnId!,
      items, publishedAt: Date.now() }])).get(ctx.rootRunId!)
    for (const item of items) {
      if (revoked?.has(item.assetId)) { changed.push(item.path); continue }
      // Explicit child receipts and tool images intentionally select historical
      // immutable bytes. Direct paths select the root's accepted current file.
      if (item.producerArtifactId || item.path.startsWith('tool-result/')) continue
      try {
        const current = await this.captureFile(ctx, { path: item.path }, false)
        if (current.item.sha256 !== item.sha256) changed.push(item.path)
      } catch { changed.push(item.path) }
    }
    return changed
  }

  /** Reopening a changed draft never silently substitutes new, unaccepted bytes. */
  async stalePaths(ctx: AgentContext): Promise<string[]> {
    if (!ctx.rootRunId || !ctx.turnId || ctx.parentSessionId || !ctx.executionOwner) return []
    const scope = ownedScope(ctx), db = this.db
    await ready(db)
    const row = (await db.execute({ sql: 'SELECT items,turn_id FROM final_result_manifests WHERE tenant_id=? AND session_id=? AND run_id=?',
      args: [scope.tenantId, scope.sessionId, scope.runId] })).rows[0]
    if (!row || row.turn_id !== scope.turnId) return []
    const changed = await this.changedSources(ctx, JSON.parse(String(row.items)))
    ownedScope(ctx)
    return changed
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
      const changed = await this.changedSources(ctx, items)
      if (changed.length) throw new StaleFinalDeliveryError(changed)
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
      if ((await this.revokedAssets(tenantId, [result])).get(runId)?.has(assetId)) throw new Error('Result asset was withdrawn by file rollback')
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

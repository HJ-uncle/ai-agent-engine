/**
 * JSONL 会话历史存储（Claude Code 格式）
 *
 * 设计照抄 Claude Code：
 * - 每个会话一个 `<sessionId>.jsonl` 文件，**追加写**，每行一个 JSON；旧行永不物理删除
 * - 行公共字段：type/uuid/parentUuid/timestamp/sessionId/cwd/gitBranch/version/isSidechain
 * - 删除 / 编辑 / 截断：追加 tombstone / update 标记行，读取时折叠（逻辑删，不重写文件）
 * - 压缩：追加 `{type:"summary", summary, leafUuid}` 行，读取时跳到 leafSeq 之后，旧行保留
 *
 * 与 SQLite 实现的语义差异：
 * - deleteMessagesAfterId 的入参从自增 rowid 改为 dbSeq（每行单调递增序号）；
 *   truncate 只删除该墓碑之前 dbSeq > afterSeq 的消息，后续追加不受旧截断影响
 * - 删除是逻辑删（tombstone 行），物理清理只发生在 clear（rename .bak）时
 *
 * 落盘路径：`<DATA_DIR目录>/sessions/<tenantId>/<sessionId>.jsonl`
 * （DATA_DIR 现语义是 db 文件路径，取其 dirname 作根目录）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertCompressionContext, withHistoryLock, withSessionHistoryCompression, awaitCompressionSummary } from './serialization.js'
import { createInterface } from 'node:readline'
import type { AgentContext, CompactionArchiveEvidence, ConversationArchive, ConversationConditionalAppend, ConversationHistory, ConversationToolCallAnchor, HistorySearchOptions, HistorySearchResult, Message } from '../../core/agent-context/types.js'
import { estimateTokens } from '../../core/utils/tokens.js'
import { estimateModelHistoryTokens, estimateModelMessageTokens } from '../../core/utils/model-context.js'
import { toolResultTextLength } from '../../core/utils/multimodal-context.js'
import { CLEARED_TOOL_RESULT, CLEARED_TOOL_EVIDENCE_KEY, clearedToolEvidence, withoutToolEvidence } from '../../core/utils/tool-evidence.js'
import { compressionSplitIndex, type CompressionOptions } from './compression.js'
import { addMessageUsage, emptyBillingUsage } from './usage.js'
import { getDb, getDbEpoch } from '../sqlite/db.js'
import { advanceProjectionEpoch, commitProjectionReceipt, ensureProjectionReceipts, projectionEpoch, readProjectionReceipt, validateProjection } from './projection-receipts.js'
import { acknowledgeAdmissionUser, readAdmissionSeed, validateAdmissionUser, type AdmissionMessageAnchor } from '../root-admission/projection.js'
import { admissionError } from '../root-admission/index.js'
import { registerJSONLHistory, canonicalJSONLMessage, jsonlHistoryEpoch, type JSONLAppendPlan, type JSONLPhysicalSnapshot } from './jsonl-origin.js'
import { readJSONLBytes } from './jsonl-byte-reader.js'
import { cacheJSONLPhysicalSnapshot, getJSONLPhysicalSnapshot, invalidateJSONLPhysicalSnapshot } from './jsonl-physical-cache.js'
import { invalidateJSONLDeliveries } from '../../core/collaboration/jsonl-delivery-schema.js'
import { CollaborationError } from '../../core/collaboration/types.js'
import { currentHistoryMaintenance, maintenancePinnedIds, maintenanceSummaryEvidence, maintenanceDigest, ensureHistoryMaintenanceSchema, reserveHistoryMaintenance,
  type HistoryMaintenanceLease } from '../../core/collaboration/history-maintenance.js'

type Ctx = Pick<AgentContext, 'tenantId' | 'sessionId'>

// Instances share write ordering for the same physical archive; root paths
// isolate tenants with the same ids in different engine data directories.
const sessionWriteQueues = new Map<string, Promise<void>>()

/** 一行 JSONL 的信封（对齐 Claude Code 公共字段 + 引擎扩展） */
interface JsonlRow {
  uuid: string
  parentUuid: string | null
  type: string // user|assistant|tool|system|summary|update|tombstone|usage (migration billing receipt)
  timestamp: string
  sessionId: string
  tenantId: string
  cwd?: string
  version?: string
  isSidechain: boolean
  /** 单调递增行序号，替代 SQLite rowid（deleteMessagesAfterId 的定位基准） */
  dbSeq: number
  /** 消息行的载荷（Message 全部字段） */
  payload?: Record<string, unknown>
  /** 消息所属轮次 id（冗余到顶层，折叠时按 conversation 删除用） */
  conversationId?: string
  // summary 行
  summary?: string
  leafUuid?: string
  leafSeq?: number
  /** Private maintenance keeps the original admitted input and pending dispatches physical. */
  retainedUuids?: string[]
  preTokens?: number
  postTokens?: number
  transcriptPath?: string
  // update 行
  targetUuid?: string
  content?: string | any[]
  modelInputContent?: string | any[] | null
  tokens?: number
  metadata?: unknown
  /** Original tool output retained separately from the compact model content. */
  archiveContent?: Message['content']
  archiveTokens?: number
  // tombstone 行
  scope?: 'message' | 'conversation' | 'truncate' | 'clear'
  afterSeq?: number
}

interface SessionState {
  /** 折叠后的有效消息（已应用 tombstone/update/summary 跳跃） */
  messages: Message[]
  /** messageId → Message（折叠后视图） */
  byId: Map<string, Message>
  /** 最后一条消息 uuid（append 时维护 parentUuid 链） */
  lastUuid: string | null
  /** 下一个 dbSeq */
  nextSeq: number
  /** 折叠后全部消息的 tokens 之和（getRawTokenCount） */
  rawTokens: number
  /** 缓存失效依据 */
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
  dev: number
  /** Fold rules must also apply to newly appended rows, including legacy tombstones. */
  visibleAfterSeq: number
  deletedUuids: Set<string>
  deletedConvIds: Set<string>
  cacheBytes: number
}

function collectUpdate(updates: Map<string, JsonlRow>, row: JsonlRow): void {
  const prior = updates.get(row.targetUuid!)
  // Legacy micro-compaction wrote an ordinary update without an archive
  // payload. Recover the latest edited value (or the original message below)
  // instead of treating the cleared marker as a user edit.
  if (row.content === CLEARED_TOOL_RESULT) {
    updates.set(row.targetUuid!, { ...prior, ...row,
      archiveContent: row.archiveContent ?? prior?.archiveContent
        ?? (prior?.content !== CLEARED_TOOL_RESULT ? prior?.content : undefined),
      archiveTokens: row.archiveTokens ?? prior?.archiveTokens
        ?? (prior?.content !== CLEARED_TOOL_RESULT ? prior?.tokens : undefined),
      metadata: row.metadata ?? prior?.metadata,
    })
  } else {
    updates.set(row.targetUuid!, row)
  }
}

function applyUpdate(message: Message, update: JsonlRow, archive = false): void {
  const compacted = message.role === 'tool' && update.content === CLEARED_TOOL_RESULT
  const originalContent = update.archiveContent ?? message.content
  const originalTokens = update.archiveTokens ?? message.tokens
  if (update.content !== undefined) message.content = compacted && archive ? originalContent : update.content
  if (typeof update.tokens === 'number') message.tokens = compacted && archive ? originalTokens : update.tokens
  if (update.metadata !== undefined) message.metadata = update.metadata
  const carriesClearedEvidence = update.metadata && typeof update.metadata === 'object' && Object.hasOwn(update.metadata, CLEARED_TOOL_EVIDENCE_KEY)
  if (update.content !== undefined && !compacted
    || update.modelInputContent === null && !carriesClearedEvidence) message.metadata = withoutToolEvidence(message.metadata)
  // User edits invalidate the attachment/provider snapshot. Legacy content
  // updates also reset it; micro-compacting tool output does not change input.
  if (typeof update.modelInputContent === 'string' || Array.isArray(update.modelInputContent)) message.modelInputContent = update.modelInputContent
  else if (update.modelInputContent === null || update.content !== undefined && !compacted) delete message.modelInputContent
  if (compacted) {
    const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? message.metadata as Record<string, unknown> : {}
    message.metadata = { ...metadata, outputPreview: typeof originalContent === 'string' ? originalContent : JSON.stringify(originalContent) }
  }
}

/** A truncate deletes older rows only. Suffix minima make repeated cuts O(log N) per row. */
function truncateFilter(cuts: Array<{ ordinal: number; afterSeq: number }>): (seq: number, ordinal: number) => boolean {
  const sorted = cuts.sort((left, right) => left.ordinal - right.ordinal)
  let floor = Infinity
  for (let index = sorted.length - 1; index >= 0; index--) { floor = Math.min(floor, sorted[index].afterSeq); sorted[index].afterSeq = floor }
  return (seq, ordinal) => {
    let left = 0, right = sorted.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (sorted[middle].ordinal <= ordinal) left = middle + 1
      else right = middle
    }
    return left < sorted.length && seq > sorted[left].afterSeq
  }
}

function scopedJsonlRow(line: string, ctx: Ctx): JsonlRow | undefined {
  try {
    const row = JSON.parse(line) as JsonlRow | null
    return row && row.tenantId === ctx.tenantId && row.sessionId === ctx.sessionId ? row : undefined
  } catch { return undefined }
}

async function* forwardScopedRows(handle: Awaited<ReturnType<typeof fs.promises.open>>, size: number, ctx: Ctx) {
  let suffix: Buffer[] = [], offset = 0, position = 0
  while (position < size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position))
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, position + bytesRead)
        if (!read.bytesRead) break
        bytesRead += read.bytesRead
      }
      if (!bytesRead) break
      position += bytesRead
      let start = 0
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start)
        if (newline < 0 || newline >= bytesRead) { suffix.push(buffer.subarray(start, bytesRead)); break }
        const line = Buffer.concat([...suffix, buffer.subarray(start, newline)])
        const row = scopedJsonlRow(line.toString('utf8'), ctx), lineStart = offset
        offset += line.length + 1
        suffix = []
        if (row) yield { row, offset: lineStart }
        start = newline + 1
      }
  }
  if (suffix.length) {
      const row = scopedJsonlRow(Buffer.concat(suffix).toString('utf8'), ctx)
      if (row) yield { row, offset }
  }
}

/** Reverse folding needs only suffix minima, rather than a growing tombstone index. */
async function* reverseScopedRows(handle: Awaited<ReturnType<typeof fs.promises.open>>, size: number, ctx: Ctx) {
  let position = size
  let suffix: Buffer[] = []
  while (position > 0) {
    const start = Math.max(0, position - 64 * 1024)
    const buffer = Buffer.allocUnsafe(position - start)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    position = start
    let end = bytesRead
    while (end > 0) {
      const newline = buffer.lastIndexOf(10, end - 1)
      if (newline < 0) { suffix.unshift(buffer.subarray(0, end)); break }
      const line = Buffer.concat([buffer.subarray(newline + 1, end), ...suffix]).toString('utf8')
      suffix = []
      const row = scopedJsonlRow(line, ctx)
      if (row) yield { row, offset: start + newline + 1 }
      end = newline
    }
  }
  if (suffix.length) {
    const row = scopedJsonlRow(Buffer.concat(suffix).toString('utf8'), ctx)
    if (row) yield { row, offset: 0 }
  }
}

export class JSONLConversationHistory implements ConversationHistory {
  readonly retainsArchive = true
  private readonly rootDir: string
  private readonly dataPath: string
  private readonly maxTokens?: number
  private readonly states = new Map<string, SessionState>()
  private readonly physicalCacheOwner = {}
  private readonly usageCache = new Map<string, {
    sessionKey: string; conversationId?: string; revision: string; usage: Record<string, number>
  }>()
  private cachedBytes = 0
  private readonly maxCachedSessions = 64
  private readonly maxCachedBytes = 64 * 1024 * 1024
  private readonly writeQueues = sessionWriteQueues
  /** 进程内墓碑（对齐 SQLite 实现：clear 后短时间内拒绝写入，防流式回写复活） */
  private readonly tombstones = new Map<string, number>()

  constructor(maxTokens?: number) {
    this.maxTokens = maxTokens
    const dataDir = process.env.DATA_DIR ?? './data/agent.db'
    this.dataPath = path.resolve(dataDir)
    this.rootDir = path.join(path.dirname(this.dataPath), 'sessions')
    registerJSONLHistory(this, {
      db: () => this.projectionDb(),
      withLease: (scope, action) => withHistoryLock(scope.tenantId, () => this.enqueue(this.sessionKey(scope), action)),
      inspect: async scope => { await this.recoverCollaborationMaintenance(scope); return this.inspectCollaborationArchive(scope) },
      assertRevision: async (scope, snapshot) => {
        const stat = await fs.promises.stat(this.filePath(scope))
        if (this.fileRevision(stat) !== snapshot.revision || this.collaborationFileIdentity(stat) !== snapshot.fileIdentity)
          throw new CollaborationError('conflict', 'JSONL archive changed during origin authentication')
      },
      plan: (scope, snapshot, message) => {
        const row: JsonlRow = { uuid: message.id!, parentUuid: snapshot.lastId, type: message.role,
          timestamp: new Date().toISOString(), ...scope, isSidechain: scope.sessionId.startsWith('subagent-'),
          dbSeq: snapshot.nextSequence, payload: this.messageToPayload(message),
          ...((message as Message & { conversationId?: string }).conversationId ? { conversationId: (message as Message & { conversationId?: string }).conversationId } : {}) }
        const encoded = JSON.stringify(row) + '\n'
        return { fileIdentity: snapshot.fileIdentity, offset: snapshot.size, bytes: Buffer.byteLength(encoded),
          hash: crypto.createHash('sha256').update(encoded).digest('hex'), encoded }
      },
      persist: (scope, plan) => this.persistCollaborationRow(scope, plan),
    })
  }

  private collaborationFileIdentity(stat: fs.Stats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` }

  private async assertCollaborationReadRevision(ctx: Ctx, handle: Awaited<ReturnType<typeof fs.promises.open>>, before: fs.Stats): Promise<void> {
    const after = await handle.stat()
    if (this.fileRevision(after) !== this.fileRevision(before) || this.collaborationFileIdentity(after) !== this.collaborationFileIdentity(before))
      throw new CollaborationError('conflict', 'JSONL archive changed while reading')
    // A still-open handle can point at the retired file after pathname replacement.
    let current: fs.Stats
    try { current = await fs.promises.stat(this.filePath(ctx)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CollaborationError('conflict', 'JSONL archive path changed while reading')
      throw error
    }
    if (this.fileRevision(current) !== this.fileRevision(before) || this.collaborationFileIdentity(current) !== this.collaborationFileIdentity(before))
      throw new CollaborationError('conflict', 'JSONL archive path changed while reading')
  }

  /** Physical offsets authenticate receipt rows; folded messages retain every active tool/system field. */
  private async inspectCollaborationArchive(ctx: Ctx): Promise<JSONLPhysicalSnapshot> {
    const state = await this.loadSession(ctx), file = this.filePath(ctx), handle = await fs.promises.open(file, 'r')
    try {
      const stat = await handle.stat()
      if (!this.matchesFile(state, stat)) throw new CollaborationError('conflict', 'JSONL active projection and archive revisions differ')
      const database = this.projectionDb()
      const key = { owner: this.physicalCacheOwner, dataPath: this.dataPath, database, databaseEpoch: getDbEpoch(database),
        tenantId: ctx.tenantId, sessionId: ctx.sessionId,
        fileIdentity: this.collaborationFileIdentity(stat), revision: this.fileRevision(stat) }
      const cached = getJSONLPhysicalSnapshot(key)
      if (cached) {
        // A hit still opens the file and fences both its handle and pathname;
        // receipt/controller/epoch authentication remains outside this cache.
        await this.assertCollaborationReadRevision(ctx, handle, stat)
        return cached
      }
      const rows: JSONLPhysicalSnapshot['rows'] = []
      const contentHash = await readJSONLBytes(handle, stat.size, { onLine: (bytes, offset) => {
        const row = scopedJsonlRow(bytes.toString('utf8'), ctx)
        if (row?.payload && ['system', 'user', 'assistant', 'tool'].includes(row.type)) rows.push({ id: row.uuid, offset,
          bytes: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('hex'), sequence: row.dbSeq, message: this.rowToMessage(row) })
      } })
      await this.assertCollaborationReadRevision(ctx, handle, stat)
      const snapshot = { fileIdentity: key.fileIdentity, revision: key.revision, size: stat.size,
        contentHash, nextSequence: state.nextSeq, lastId: state.lastUuid, rows, active: structuredClone(state.messages) }
      cacheJSONLPhysicalSnapshot(key, snapshot)
      return snapshot
    } finally { await handle.close() }
  }

  /** Reconcile exact reserved bytes, including a failed partial suffix, before a durable receipt can finish. */
  private async persistCollaborationRow(ctx: Ctx, plan: JSONLAppendPlan): Promise<void> {
    if (!Number.isSafeInteger(plan.offset) || plan.offset < 0 || !Number.isSafeInteger(plan.bytes) || plan.bytes < 1
      || Buffer.byteLength(plan.encoded) !== plan.bytes || !plan.encoded.endsWith('\n')
      || crypto.createHash('sha256').update(plan.encoded).digest('hex') !== plan.hash)
      throw new CollaborationError('conflict', 'JSONL reserved envelope is invalid')
    const handle = await fs.promises.open(this.filePath(ctx), 'r+')
    try {
      const stat = await handle.stat()
      if (this.collaborationFileIdentity(stat) !== plan.fileIdentity || stat.size < plan.offset)
        throw new CollaborationError('conflict', 'JSONL reserved archive identity changed')
      const encoded = Buffer.from(plan.encoded), available = Math.min(plan.bytes, stat.size - plan.offset), existing = Buffer.alloc(available)
      if (plan.prefixHash) {
        const prefixHash = await readJSONLBytes(handle, plan.offset, { truncatedMessage: 'JSONL maintenance prefix was truncated' })
        if (prefixHash !== plan.prefixHash) throw new CollaborationError('conflict', 'JSONL maintenance source prefix changed')
        await this.assertCollaborationReadRevision(ctx, handle, stat)
      }
      let read = 0
      while (read < available) { const next = await handle.read(existing, read, available - read, plan.offset + read); if (!next.bytesRead) throw new CollaborationError('conflict', 'JSONL reserved suffix was truncated'); read += next.bytesRead }
      if (!existing.equals(encoded.subarray(0, available)) || available < plan.bytes && stat.size !== plan.offset + available)
        throw new CollaborationError('conflict', 'JSONL reserved suffix was replaced')
      let written = available
      while (written < encoded.length) { const next = await handle.write(encoded, written, encoded.length - written, plan.offset + written); if (!next.bytesWritten) throw new Error('JSONL delivery write made no progress'); written += next.bytesWritten }
      await handle.sync()
      const persisted = Buffer.alloc(encoded.length)
      let verified = 0
      while (verified < persisted.length) { const next = await handle.read(persisted, verified, persisted.length - verified, plan.offset + verified); if (!next.bytesRead) throw new CollaborationError('conflict', 'JSONL synced row disappeared'); verified += next.bytesRead }
      if (!persisted.equals(encoded) || this.collaborationFileIdentity(await handle.stat()) !== plan.fileIdentity)
        throw new CollaborationError('conflict', 'JSONL synced row lost physical identity')
    } finally { this.invalidate(ctx); await handle.close() }
  }

  private sessionKey(ctx: Ctx): string {
    return `${ctx.tenantId}:${ctx.sessionId}`
  }

  private filePath(ctx: Ctx): string {
    const directory = this.tenantPath(ctx.tenantId)
    this.validateSegment(ctx.sessionId)
    const file = path.resolve(directory, `${ctx.sessionId}.jsonl`)
    if (path.dirname(file) !== directory) throw new Error('Conversation path escapes its tenant directory')
    this.assertNotSymbolicLink(file, 'Conversation archive')
    return file
  }

  private migratedPath(ctx: Ctx): string {
    const marker = this.filePath(ctx).replace(/\.jsonl$/, '.migrated')
    this.assertNotSymbolicLink(marker, 'Conversation migration marker')
    return marker
  }

  private assertNotSymbolicLink(file: string, label: string): void {
    try {
      // existsSync follows the target and misses dangling links. lstat checks
      // the entry itself before a read/write could escape the tenant path.
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private validateSegment(value: string): void {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(value)
      || /[. ]$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) {
      throw new Error('Conversation tenant/session identifier must be a safe single path segment')
    }
  }

  private tenantPath(tenantId: string): string {
    this.validateSegment(tenantId)
    const root = path.resolve(this.rootDir), directory = path.resolve(root, tenantId)
    if (path.dirname(directory) !== root) throw new Error('Conversation tenant path escapes the archive root')
    this.assertNotSymbolicLink(directory, 'Conversation tenant directory')
    return directory
  }

  /** 串行化同一会话的写操作，避免并发 append 交错写坏行 */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const queueKey = `${path.resolve(this.rootDir)}\0${key}`
    const prev = this.writeQueues.get(queueKey) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const settled = next.then(() => undefined, () => undefined)
    this.writeQueues.set(queueKey, settled)
    void settled.then(() => { if (this.writeQueues.get(queueKey) === settled) this.writeQueues.delete(queueKey) })
    return next
  }

  private isTombstoned(ctx: Ctx): boolean {
    const at = this.tombstones.get(this.sessionKey(ctx))
    return at !== undefined && Date.now() - at < 5000
  }

  // ─── 读取与折叠 ──────────────────────────────────────────────

  private matchesFile(state: SessionState, stat: fs.Stats): boolean {
    return state.mtimeMs === stat.mtimeMs && state.ctimeMs === stat.ctimeMs && state.size === stat.size && state.ino === stat.ino && state.dev === stat.dev
  }

  private fileRevision(stat: Pick<fs.Stats, 'mtimeMs' | 'ctimeMs' | 'size' | 'ino' | 'dev'>): string {
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${stat.dev}`
  }

  private async usageRevision(ctx: Ctx): Promise<string | undefined> {
    try { return this.fileRevision(await fs.promises.stat(this.filePath(ctx))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
  }

  /** Cache only the active projection; evicting a cache never deletes durable history. */
  private cacheState(key: string, state: SessionState, bytes?: number): void {
    const previous = this.states.get(key)
    if (previous) { this.cachedBytes -= previous.cacheBytes; this.states.delete(key) }
    state.cacheBytes = bytes ?? state.messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 128, 1024)
      + [...state.deletedUuids, ...state.deletedConvIds].reduce((sum, id) => sum + Buffer.byteLength(id) + 64, 0)
    this.states.set(key, state); this.cachedBytes += state.cacheBytes
    while (this.states.size > this.maxCachedSessions || this.cachedBytes > this.maxCachedBytes) {
      const oldest = this.states.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cachedBytes -= this.states.get(oldest)!.cacheBytes; this.states.delete(oldest)
    }
  }

  private async loadSession(ctx: Ctx): Promise<SessionState> {
    const key = this.sessionKey(ctx)
    const file = this.filePath(ctx)
    let stat: fs.Stats | null = null
    try {
      stat = await fs.promises.stat(file)
    } catch {
      stat = null
    }

    const cached = this.states.get(key)
    if (cached && stat && this.matchesFile(cached, stat)) {
      this.states.delete(key); this.states.set(key, cached)
      return cached
    }

    // 懒迁移：jsonl 不存在且未标记迁移 → 从 SQLite 迁移
    if (!stat) {
      await this.migrateFromSqlite(ctx)
      try {
        stat = await fs.promises.stat(file)
      } catch {
        stat = null
      }
    }

    const state: SessionState = {
      messages: [],
      byId: new Map(),
      lastUuid: null,
      nextSeq: 1,
      rawTokens: 0,
      mtimeMs: stat?.mtimeMs ?? 0,
      ctimeMs: stat?.ctimeMs ?? 0,
      size: stat?.size ?? 0,
      ino: stat?.ino ?? 0,
      dev: stat?.dev ?? 0,
      visibleAfterSeq: -1,
      deletedUuids: new Set(),
      deletedConvIds: new Set(),
      cacheBytes: 0,
    }

    if (!stat) {
      this.cacheState(key, state)
      return state
    }

    const raw = await fs.promises.readFile(file, 'utf8')
    const rows: JsonlRow[] = []
    const rowOrdinals = new Map<JsonlRow, number>()
    const tombstoneRows: JsonlRow[] = []
    const updates = new Map<string, JsonlRow>()
    const summaries: JsonlRow[] = []
    let lastSummary: JsonlRow | null = null
    let lastSummaryOrdinal = -1
    let rawOrdinal = 0
    let maxSeq = 0

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row: JsonlRow
      try {
        row = JSON.parse(trimmed) as JsonlRow
      } catch {
        // 坏行跳过（崩溃写一半 / 磁盘损坏的容错）
        console.warn(`[jsonl-history] skip corrupted line in ${file}`)
        continue
      }
      const currentOrdinal = rawOrdinal++
      rowOrdinals.set(row, currentOrdinal)
      if (typeof row.dbSeq === 'number' && row.dbSeq > maxSeq) maxSeq = row.dbSeq
      if (row.type === 'tombstone') tombstoneRows.push(row)
      else if (row.type === 'update' && row.targetUuid) collectUpdate(updates, row)
      else if (row.type === 'summary') summaries.push(row)
      else if (row.type !== 'usage') rows.push(row)
    }

    state.nextSeq = maxSeq + 1

    // 折叠 tombstone
    const truncations: Array<{ ordinal: number; afterSeq: number }> = []
    let clearSeq = -1
    let clearOrdinal = -1
    const deletedUuids = new Set<string>()
    const deletedConvIds = new Set<string>()
    for (const t of tombstoneRows) {
      if (t.scope === 'clear') {
        // clear 视为截断到该行 dbSeq：只保留其后的消息（正常 clear 后文件已 rename，不会走到这）
        clearSeq = Math.max(clearSeq, t.dbSeq ?? 0)
        clearOrdinal = Math.max(clearOrdinal, rowOrdinals.get(t) ?? -1)
      } else if (t.scope === 'truncate' && typeof t.afterSeq === 'number') {
        truncations.push({ ordinal: rowOrdinals.get(t) ?? -1, afterSeq: t.afterSeq })
      } else if (t.scope === 'message' && t.targetUuid) {
        deletedUuids.add(t.targetUuid)
      } else if (t.scope === 'conversation' && t.conversationId) {
        deletedConvIds.add(t.conversationId)
      }
    }
    const isTruncated = truncateFilter(truncations)
    for (const summary of summaries) {
      const ordinal = rowOrdinals.get(summary) ?? -1
      if (ordinal > clearOrdinal && !isTruncated(summary.dbSeq, ordinal)) { lastSummary = summary; lastSummaryOrdinal = ordinal }
    }

    // summary 跳跃：leafSeq 及之前的消息被摘要覆盖. Legacy JSONL rows
    // carried only leafUuid, so derive the durable sequence from the original
    // row instead of letting every pre-summary message reappear after restart.
    const summaryLeaf = lastSummary?.leafUuid ? rows.find(row => row.uuid === lastSummary!.leafUuid) : undefined
    const legacySummaryTail = lastSummary
      ? [...rows, ...tombstoneRows]
        .filter(row => (rowOrdinals.get(row) ?? -1) < lastSummaryOrdinal)
        .reduce<JsonlRow | undefined>((tail, row) => !tail || row.dbSeq > tail.dbSeq ? row : tail, undefined)
      : undefined
    const summaryFloor = lastSummary
      ? (typeof lastSummary.leafSeq === 'number'
        ? lastSummary.leafSeq
        : summaryLeaf?.dbSeq ?? legacySummaryTail?.dbSeq ?? -1)
      : -1
    state.visibleAfterSeq = Math.max(clearSeq, summaryFloor)
    state.deletedUuids = deletedUuids
    state.deletedConvIds = deletedConvIds

    const retainedUuids = new Set(lastSummary?.retainedUuids ?? [])
    let lastUuid: string | null = null
    for (const row of rows) {
      if (row.dbSeq <= clearSeq) continue
      if ((rowOrdinals.get(row) ?? -1) <= clearOrdinal) continue
      if (isTruncated(row.dbSeq, rowOrdinals.get(row) ?? -1)) continue
      if (row.dbSeq <= summaryFloor && !retainedUuids.has(row.uuid)) continue
      if (deletedUuids.has(row.uuid)) continue
      if (row.conversationId && deletedConvIds.has(row.conversationId)) continue
      const msg = this.rowToMessage(row)
      const upd = updates.get(row.uuid)
      if (upd) applyUpdate(msg, upd)
      state.messages.push(msg)
      if (msg.id) state.byId.set(msg.id, msg)
      state.rawTokens += msg.tokens ?? 0
      lastUuid = row.uuid
    }

    // summary 行转成一条 system 消息插到最前（与 SQLite 压缩后形态一致）
    if (lastSummary && lastSummaryOrdinal > clearOrdinal && lastSummary.summary) {
      const summaryMsg: Message = {
        id: lastSummary.uuid,
        role: 'system',
        content: `【历史上下文摘要】${lastSummary.summary}`,
        tokens: estimateTokens(lastSummary.summary),
        metadata: { isCompactSummary: true, transcriptPath: lastSummary.transcriptPath, compactionLeafSeq: summaryFloor },
      }
      state.messages.unshift(summaryMsg)
      state.rawTokens += summaryMsg.tokens ?? 0
    }

    state.lastUuid = lastUuid
    this.cacheState(key, state)
    return state
  }

  private rowToMessage(row: JsonlRow): Message {
    const p = (row.payload ?? {}) as Record<string, unknown>
    const msg: Message = {
      id: (p.id as string) ?? row.uuid,
      role: (p.role as Message['role']) ?? (row.type as Message['role']),
      content: (p.content as Message['content']) ?? '',
    }
    if (typeof p.modelInputContent === 'string' || Array.isArray(p.modelInputContent)) msg.modelInputContent = p.modelInputContent
    if (typeof p.tokens === 'number') msg.tokens = p.tokens
    if (typeof p.reasoningContent === 'string') msg.reasoningContent = p.reasoningContent
    if (p.toolCall !== undefined) msg.toolCall = p.toolCall as Message['toolCall']
    if (typeof p.toolCallId === 'string') msg.toolCallId = p.toolCallId
    if (typeof p.toolName === 'string') msg.toolName = p.toolName
    if (p.usage && typeof p.usage === 'object') msg.usage = p.usage as Record<string, number>
    if (typeof p.createdAt === 'number') msg.createdAt = p.createdAt
    if (typeof p.modelId === 'string') msg.modelId = p.modelId
    if (p.metadata !== undefined) msg.metadata = p.metadata
    if (p.conversationId !== undefined) {
      ;(msg as unknown as Record<string, unknown>).conversationId = p.conversationId
    }
    ;(msg as unknown as Record<string, unknown>).dbId = row.dbSeq
    return msg
  }

  private messageToPayload(msg: Message): Record<string, unknown> {
    const p: Record<string, unknown> = {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      tokens: msg.tokens ?? 0,
    }
    if (msg.modelInputContent !== undefined) p.modelInputContent = msg.modelInputContent
    if (msg.reasoningContent !== undefined) p.reasoningContent = msg.reasoningContent
    if (msg.toolCall !== undefined) p.toolCall = msg.toolCall
    if (msg.toolCallId !== undefined) p.toolCallId = msg.toolCallId
    if (msg.toolName !== undefined) p.toolName = msg.toolName
    if (msg.usage !== undefined) p.usage = msg.usage
    if (msg.createdAt !== undefined) p.createdAt = msg.createdAt
    if (msg.modelId !== undefined) p.modelId = msg.modelId
    if (msg.metadata !== undefined) p.metadata = msg.metadata
    const convId = (msg as unknown as Record<string, unknown>).conversationId
    if (convId !== undefined) p.conversationId = convId
    return p
  }

  // ─── 懒迁移 ──────────────────────────────────────────────────

  private async migrateFromSqlite(ctx: Ctx): Promise<void> {
    const migrated = this.migratedPath(ctx)
    // A JSONL clear is authoritative even when the legacy SQLite source still
    // contains rows.  Without this state, the next startup would see the
    // renamed JSONL file as missing and import those stale rows back into a
    // session the user explicitly deleted.
    try {
      const marker = (await fs.promises.readFile(migrated, 'utf8')).trim()
      if (marker === 'cleared' || marker.length > 0) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // No marker yet; continue with the lazy legacy import below.
    }
    const { SQLiteConversationHistory } = await import('./history.js')
    const sqlite = new SQLiteConversationHistory()
    let rows: Message[] = []
    let receipts: Awaited<ReturnType<typeof sqlite.getArchivedUsage>> = []
    try {
      rows = await sqlite.getFullHistory(ctx)
      receipts = await sqlite.getArchivedUsage(ctx)
    } catch {
      rows = []
    }
    await fs.promises.mkdir(path.dirname(migrated), { recursive: true })
    // An empty SQLite session is not a durable migration decision. The
    // session may be populated later by an importer, recovery tool, or a
    // test/upgrade step; a permanent marker here would make subsequent reads
    // skip those rows forever. Only a non-empty migration writes a durable
    // marker, while an explicit clear writes the separate `cleared` marker.
    if (rows.length === 0 && receipts.length === 0) return
    const file = this.filePath(ctx)
    const tmp = `${file}.tmp`
    this.assertNotSymbolicLink(tmp, 'Conversation migration temporary file')
    let seq = 1
    let parentUuid: string | null = null
    const lines: string[] = []
    // SQLite may already have discarded summarized content. Preserve its
    // billing receipts without inventing recoverable messages or expanding
    // the model context. They still carry exact message/turn deletion keys.
    for (const receipt of receipts) {
      const usage = emptyBillingUsage()
      addMessageUsage(usage, { role: 'assistant', content: '', usage: receipt.usage })
      lines.push(JSON.stringify({ uuid: receipt.messageId, parentUuid: null, type: 'usage',
        timestamp: new Date().toISOString(), ...ctx, isSidechain: ctx.sessionId.startsWith('subagent-'),
        dbSeq: seq++, ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
        payload: { id: receipt.messageId, role: 'assistant', content: '', usage,
          ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}) },
      } satisfies JsonlRow))
    }
    for (const msg of rows) {
      const uuid = msg.id || crypto.randomUUID()
      const convId = (msg as unknown as Record<string, unknown>).conversationId
      const row: JsonlRow = {
        uuid,
        parentUuid,
        type: msg.role,
        timestamp: new Date(msg.createdAt ?? Date.now()).toISOString(),
        sessionId: ctx.sessionId,
        tenantId: ctx.tenantId,
        isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
        dbSeq: seq++,
        payload: this.messageToPayload({ ...msg, id: uuid }),
        ...(typeof convId === 'string' ? { conversationId: convId } : {}),
      }
      lines.push(JSON.stringify(row))
      parentUuid = uuid
    }
    // 原子写入：临时文件 + rename
    await fs.promises.writeFile(tmp, lines.join('\n') + '\n')
    await fs.promises.rename(tmp, file)
    await fs.promises.writeFile(migrated, String(Date.now()))
  }

  // ─── ConversationHistory 接口 ────────────────────────────────

  async append(message: Message & { conversationId?: string }, ctx: Ctx): Promise<string> {
    if (this.isTombstoned(ctx)) return message.id ?? ''
    const key = this.sessionKey(ctx)
    return this.enqueue(key, async () => {
      await this.recoverCollaborationMaintenance(ctx)
      const state = await this.loadSession(ctx)
      const precedingRevision = this.fileRevision(state)
      const uuid = message.id || crypto.randomUUID()
      if (state.messages.some(existing => existing.id === uuid)) return uuid
      const convId = (message as unknown as Record<string, unknown>).conversationId
      const row: JsonlRow = {
        uuid,
        parentUuid: state.lastUuid,
        type: message.role,
        timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId,
        tenantId: ctx.tenantId,
        isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
        dbSeq: state.nextSeq,
        payload: this.messageToPayload({ ...message, id: uuid }),
        ...(typeof convId === 'string' ? { conversationId: convId } : {}),
      }
      const file = this.filePath(ctx)
      const encoded = JSON.stringify(row) + '\n'
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      // Append is durable before advancing sequence/cache. A failed write must
      // never make an unpersisted message visible or consume its dbSeq.
      try { await fs.promises.appendFile(file, encoded) }
      catch (error) { state.mtimeMs = 0; throw error }
      const stat = await fs.promises.stat(file)
      // Other instances/processes may append or replace the file. Rebuild on
      // an unexpected tail/identity rather than hiding their records in cache.
      if (stat.size !== state.size + Buffer.byteLength(encoded)
        || state.size > 0 && (state.ino !== stat.ino || state.dev !== stat.dev)) {
        state.mtimeMs = 0
        return uuid
      }
      const persisted = JSON.parse(encoded) as JsonlRow
      let addedBytes = 0
      let visibleMessage: Message | undefined
      if (row.dbSeq > state.visibleAfterSeq
        && !state.deletedUuids.has(uuid) && !(row.conversationId && state.deletedConvIds.has(row.conversationId))) {
        const stored = this.rowToMessage(persisted)
        visibleMessage = stored
        // Replace the array so callers holding a previous read get a stable
        // snapshot, as they did when append forced a complete rebuild.
        state.messages = [...state.messages, stored]
        state.byId.set(stored.id!, stored)
        state.lastUuid = uuid
        state.rawTokens += stored.tokens ?? 0
        addedBytes = Buffer.byteLength(JSON.stringify(stored)) + 128
      }
      state.nextSeq = row.dbSeq + 1
      state.mtimeMs = stat.mtimeMs; state.ctimeMs = stat.ctimeMs
      state.size = stat.size; state.ino = stat.ino; state.dev = stat.dev
      this.cacheState(key, state, state.cacheBytes + addedBytes)
      // Normal append can advance cached billing incrementally. Maintenance
      // and external writes instead force a revision-checked archive rescan.
      for (const entry of this.usageCache.values()) {
        if (entry.sessionKey !== key || entry.revision !== precedingRevision) continue
        if (visibleMessage && (entry.conversationId === undefined || entry.conversationId === row.conversationId)) {
          addMessageUsage(entry.usage, visibleMessage)
        }
        entry.revision = this.fileRevision(stat)
      }
      return uuid
    })
  }

  async appendAdmissionUser(message: Message, ctx: Ctx, anchor: AdmissionMessageAnchor): Promise<string> {
    return withHistoryLock(ctx.tenantId, async () => {
      const db = this.projectionDb(), seed = await readAdmissionSeed(db, ctx, anchor.rootRunId)
      validateAdmissionUser(message, seed, anchor)
      // Ordinary append owns its own file queue. Nesting enqueue here would
      // wait on itself; the reentrant tenant lock orders delete/append/ACK.
      await this.append(message, ctx)
      const archive = await this.getArchive(ctx)
      const persisted = archive.messages.find(row => row.id === anchor.userMessageId)
      if (!persisted) admissionError('ADMISSION_USER_PROJECTION_UNAVAILABLE', 503)
      validateAdmissionUser(persisted, seed, anchor)
      const file = this.filePath(ctx), handle = await fs.promises.open(file, 'r+')
      try {
        // Read the actual owned file, not only an optimistic append cache.
        const stat = await handle.stat()
        let rawUser: Message | undefined
        for await (const { row } of forwardScopedRows(handle, stat.size, ctx)) {
          if (row.uuid === anchor.userMessageId && row.type === 'user') rawUser = this.rowToMessage(row)
        }
        if (!rawUser) admissionError('ADMISSION_USER_PROJECTION_UNAVAILABLE', 503)
        validateAdmissionUser(rawUser, seed, anchor)
        await handle.sync()
        const current = await fs.promises.stat(file)
        if (stat.dev !== current.dev || stat.ino !== current.ino || stat.size !== current.size) admissionError('ADMISSION_TRANSCRIPT_CHANGED', 503)
      } finally { await handle.close() }
      if (db !== this.projectionDb()) admissionError('ADMISSION_DATASOURCE_CHANGED', 503)
      await acknowledgeAdmissionUser(db, ctx, seed)
      return anchor.userMessageId
    })
  }

  private projectionDb() {
    // This file owner cannot use another data source's replay ledger after rebind.
    if (path.resolve(process.env.DATA_DIR ?? './data/agent.db') !== this.dataPath)
      throw new Error('JSONL projection source changed; use a history instance for the current data source')
    return getDb()
  }

  private async hasPersistedProjection(ctx: Ctx, message: Message, anchor: ConversationToolCallAnchor): Promise<boolean> {
    const messageId = message.id!
    let handle: Awaited<ReturnType<typeof fs.promises.open>>
    try { handle = await fs.promises.open(this.filePath(ctx), 'r') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    try {
      let found = false
      for await (const { row } of forwardScopedRows(handle, (await handle.stat()).size, ctx)) {
        if (row.uuid !== messageId || !row.payload) continue
        // Original rows survive compaction/delete tombstones. Their stable ID,
        // rather than the active projection cache, reconciles an uncertain flush.
        if (row.type !== message.role || row.payload.id !== messageId || row.payload.role !== message.role || row.payload.toolCallId !== message.toolCallId
          || String(row.payload.conversationId ?? row.conversationId ?? '') !== anchor.conversationId)
          throw new Error('History projection result identity collision')
        found = true
      }
      return found
    } finally { await handle.close() }
  }

  async appendIfActiveToolCallAnchor(message: Message, ctx: Ctx,
    anchor: ConversationToolCallAnchor): Promise<ConversationConditionalAppend> {
    const messageId = validateProjection(message, anchor)
    // Validate both scoped path segments even if the receipt avoids file I/O.
    const file = this.filePath(ctx), db = this.projectionDb()
    await ensureProjectionReceipts(db)
    return this.enqueue(this.sessionKey(ctx), async () => {
      await this.recoverCollaborationMaintenance(ctx)
      const prior = await readProjectionReceipt(db, ctx, messageId, anchor)
      if (prior && prior.disposition !== 'pending')
        return { messageId, disposition: prior.disposition === 'appended' ? 'duplicate' : 'suppressed' }
      if (prior && prior.backend !== 'jsonl') throw new Error('Pending projection belongs to another backend')
      const state = await this.loadSession(ctx)
      const epoch = await projectionEpoch(db, ctx)
      if (await this.hasPersistedProjection(ctx, message, anchor)) {
        // A previous append may have succeeded before fsync/receipt ACK failed.
        // Never infer durability solely from bytes visible in the page cache.
        const handle = await fs.promises.open(file, 'r+')
        try { await handle.sync() } finally { await handle.close() }
        await commitProjectionReceipt(db, ctx, messageId, anchor, { backend: 'jsonl', disposition: 'appended',
          epoch: prior?.epoch ?? epoch, anchorSequence: prior?.anchorSequence ?? null })
        return { messageId, disposition: 'duplicate' }
      }
      const active = await this.getActiveToolCallAnchor(ctx, anchor)
      const anchorMessage = state.byId.get(anchor.messageId) as (Message & { dbId?: number }) | undefined
      const anchorSequence = anchorMessage?.dbId ?? null
      // A truncate may later append the same UUID; only the reserved original
      // dispatch sequence can resume an uncertain file write. Clear has a durable
      // epoch because it resets both file identity and sequence numbers.
      if (!active || this.isTombstoned(ctx) || prior && (prior.epoch !== epoch || prior.anchorSequence !== anchorSequence)) {
        await commitProjectionReceipt(db, ctx, messageId, anchor, { backend: 'jsonl', disposition: 'suppressed',
          epoch: prior?.epoch ?? epoch, anchorSequence: prior?.anchorSequence ?? anchorSequence })
        return { messageId, disposition: 'suppressed' }
      }
      if (!prior) await commitProjectionReceipt(db, ctx, messageId, anchor, { backend: 'jsonl', disposition: 'pending', epoch, anchorSequence })
      const row: JsonlRow = {
        uuid: messageId, parentUuid: state.lastUuid, type: message.role, timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId, tenantId: ctx.tenantId,
        isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
        dbSeq: state.nextSeq, payload: this.messageToPayload(message), conversationId: anchor.conversationId,
      }
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const handle = await fs.promises.open(file, 'a+')
      try {
        // A failed prior append may leave a partial final row. Separate it before
        // retrying; never concatenate a valid result into that corrupted line.
        const size = (await handle.stat()).size
        if (size) {
          const last = Buffer.alloc(1)
          await handle.read(last, 0, 1, size - 1)
          if (last[0] !== 10) await handle.writeFile('\n')
        }
        await handle.writeFile(JSON.stringify(row) + '\n')
        await handle.sync()
      } finally { this.invalidate(ctx); await handle.close() }
      await commitProjectionReceipt(db, ctx, messageId, anchor, { backend: 'jsonl', disposition: 'appended', epoch, anchorSequence })
      return { messageId, disposition: 'appended' }
    })
  }

  async getHistory(
    ctx: Pick<AgentContext, 'tenantId' | 'sessionId' | 'inheritContext'>,
  ): Promise<Message[]> {
    const state = await this.loadSession(ctx)
    let messages = state.messages
    if (ctx.inheritContext === false) {
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
      if (lastUserIdx >= 0) messages = messages.slice(lastUserIdx)
    }
    return this.applyTokenWindow(messages)
  }

  async getFullHistory(ctx: Ctx): Promise<Message[]> {
    const state = await this.loadSession(ctx)
    return state.messages
  }

  async getActiveToolCallAnchor(ctx: Ctx, key: ConversationToolCallAnchor): Promise<ConversationToolCallAnchor | null> {
    if (!key.messageId || !key.toolCallId || typeof key.conversationId !== 'string') return null
    const file = this.filePath(ctx)
    let handle: Awaited<ReturnType<typeof fs.promises.open>>
    try { handle = await fs.promises.open(file, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A cleared/migrated JSONL source is authoritative. A legacy-only source
      // can answer the same narrow query without importing its whole session.
      try { if ((await fs.promises.readFile(this.migratedPath(ctx), 'utf8')).trim()) return null }
      catch (markerError) { if ((markerError as NodeJS.ErrnoException).code !== 'ENOENT') throw markerError }
      const { SQLiteConversationHistory } = await import('./history.js')
      return new SQLiteConversationHistory().getActiveToolCallAnchor(ctx, key)
    }
    try {
      const stat = await handle.stat(), size = stat.size
      const rows = () => forwardScopedRows(handle, size, ctx)
      // Deletions are global, including rows appended after their tombstone.
      // Retain only this queried identity's decisions, never all session IDs.
      let deleted = false, clearSeq = -1
      for await (const { row } of rows()) {
        if (row.type !== 'tombstone') continue
        if (row.scope === 'message' && row.targetUuid === key.messageId
          || row.scope === 'conversation' && row.conversationId === key.conversationId) deleted = true
        if (row.scope === 'clear') clearSeq = Math.max(clearSeq, row.dbSeq ?? 0)
      }
      if (deleted) return null
      let truncateFloor = Infinity, anchorSeq = -1
      let selectedSummary: { leafSeq?: number; leafUuid?: string; retainedUuids?: string[]; offset: number } | undefined
      for await (const entry of reverseScopedRows(handle, size, ctx)) {
        const { row } = entry
        if (row.type === 'tombstone') {
          if (row.scope === 'clear') break
          if (row.scope === 'truncate' && typeof row.afterSeq === 'number') truncateFloor = Math.min(truncateFloor, row.afterSeq)
          continue
        }
        if (row.dbSeq > truncateFloor) continue
        if (row.type === 'summary') { selectedSummary ??= { leafSeq: row.leafSeq, leafUuid: row.leafUuid, retainedUuids: row.retainedUuids, offset: entry.offset }; continue }
        if (!['user', 'assistant', 'tool', 'system'].includes(row.type) || row.dbSeq <= clearSeq || row.uuid !== key.messageId) continue
        const payload = row.payload, tool = payload?.toolCall
        if (payload && (payload.id ?? row.uuid) === key.messageId && (payload.conversationId ?? '') === key.conversationId
          && (!row.conversationId || row.conversationId === key.conversationId)
          && tool && typeof tool === 'object' && 'id' in tool && tool.id === key.toolCallId) {
          anchorSeq = Math.max(anchorSeq, row.dbSeq)
        }
      }
      if (anchorSeq < 0) return null
      let summaryFloor = selectedSummary?.leafSeq ?? -1
      if (selectedSummary && typeof selectedSummary.leafSeq !== 'number') {
        let leafSeq: number | undefined, previousSeq = -1
        for await (const { row, offset } of rows()) {
          if (['summary', 'update', 'usage'].includes(row.type)) continue
          if (offset < selectedSummary.offset) previousSeq = Math.max(previousSeq, row.dbSeq)
          if (row.type !== 'tombstone' && leafSeq === undefined && row.uuid === selectedSummary.leafUuid) leafSeq = row.dbSeq
        }
        summaryFloor = leafSeq ?? previousSeq
      }
      // Standalone queries detect replacement. Conditional projection additionally
      // holds the backend write lease through its predicate, append and flush.
      const current = await fs.promises.stat(file)
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size
        || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new Error('Parent history changed while verifying its active tool anchor')
      return anchorSeq > summaryFloor || selectedSummary?.retainedUuids?.includes(key.messageId) ? { ...key } : null
    } finally { await handle.close() }
  }

  /**
   * Read the append-only transcript without applying the latest compaction
   * summary floor.  The normal history projection intentionally hides those
   * rows so they never consume the model context; this method is for an
   * explicit user archive view only.
   */
  async getArchive(ctx: Ctx, page?: { offset: number; limit: number }): Promise<ConversationArchive> {
    if (page) return this.getArchivePage(ctx, page)
    // Trigger lazy migration and use the same cache/clear semantics as the
    // normal read path before opening the transcript directly.
    const current = await this.loadSession(ctx)
    const file = this.filePath(ctx)
    let raw: string
    try {
      raw = await fs.promises.readFile(file, 'utf8')
    } catch {
      return {
        messages: [],
        compressed: false,
        currentMessageCount: current.messages.length,
        backend: 'jsonl',
      }
    }

    const entries: Array<{ row: JsonlRow; ordinal: number }> = []
    let ordinal = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push({ row: JSON.parse(trimmed) as JsonlRow, ordinal: ordinal++ })
      } catch {
        // Match loadSession's crash-tolerant behavior: an incomplete line is
        // not a recoverable message and must not break the archive endpoint.
      }
    }

    const updates = new Map<string, JsonlRow>()
    const deletedUuids = new Set<string>()
    const deletedConvIds = new Set<string>()
    const isTruncated = truncateFilter(entries.filter(({ row }) => row.type === 'tombstone' && row.scope === 'truncate' && typeof row.afterSeq === 'number')
      .map(({ row, ordinal }) => ({ ordinal, afterSeq: row.afterSeq! })))
    let clearAfterOrdinal = -1
    let latestSummary: JsonlRow | undefined

    for (const { row, ordinal: rowOrdinal } of entries) {
      if (row.type === 'update' && row.targetUuid) {
        collectUpdate(updates, row)
      } else if (row.type === 'tombstone') {
        if (row.scope === 'clear') {
          // clear() normally renames the file.  The fallback tombstone uses
          // dbSeq=0, so line order is the only reliable boundary here.
          clearAfterOrdinal = Math.max(clearAfterOrdinal, rowOrdinal)
          latestSummary = undefined
        } else if (row.scope === 'message' && row.targetUuid) {
          deletedUuids.add(row.targetUuid)
        } else if (row.scope === 'conversation' && row.conversationId) {
          deletedConvIds.add(row.conversationId)
        }
      } else if (row.type === 'summary' && rowOrdinal > clearAfterOrdinal && !isTruncated(row.dbSeq, rowOrdinal)) {
        latestSummary = row
      }
    }

    const messages: Message[] = []
    for (const { row, ordinal: rowOrdinal } of entries) {
      if (row.type === 'summary' || row.type === 'update' || row.type === 'tombstone' || row.type === 'usage') continue
      if (rowOrdinal <= clearAfterOrdinal) continue
      if (isTruncated(row.dbSeq, rowOrdinal)) continue
      if (deletedUuids.has(row.uuid)) continue
      if (row.conversationId && deletedConvIds.has(row.conversationId)) continue
      const message = this.rowToMessage(row)
      const update = updates.get(row.uuid)
      if (update) applyUpdate(message, update, true)
      messages.push(message)
    }

    return {
      messages,
      totalMessageCount: messages.length,
      compressed: Boolean(latestSummary),
      ...(latestSummary?.summary ? {
        summary: {
          content: latestSummary.summary,
          ...(typeof latestSummary.leafSeq === 'number' ? { leafSeq: latestSummary.leafSeq } : {}),
          ...(typeof latestSummary.preTokens === 'number' ? { preTokens: latestSummary.preTokens } : {}),
          ...(typeof latestSummary.postTokens === 'number' ? { postTokens: latestSummary.postTokens } : {}),
          ...(latestSummary.transcriptPath ? { transcriptPath: latestSummary.transcriptPath } : {}),
        },
      } : {}),
      currentMessageCount: current.messages.length,
      backend: 'jsonl',
    }
  }

  /** Materialize only the requested page, including on a cold/restarted reader. */
  private async getArchivePage(ctx: Ctx, page: { offset: number; limit: number }): Promise<ConversationArchive> {
    if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1) throw new Error('Invalid archive page')
    const file = this.filePath(ctx)
    let archiveHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined
    try { archiveHandle = await fs.promises.open(file, 'r') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!archiveHandle) {
      await this.migrateFromSqlite(ctx)
      try { archiveHandle = await fs.promises.open(file, 'r') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (!archiveHandle) return { messages: [], totalMessageCount: 0, archiveRevision: 'empty', compressed: false, currentMessageCount: 0, backend: 'jsonl' }

    // Pin both passes to the same file and append-only byte window, even when
    // clear() renames the transcript while a page is being read.
    const handle = archiveHandle
    try {
      const stat = await handle.stat()
      const size = stat.size
      const archiveRevision = crypto.createHash('sha256').update(`${size}:${stat.mtimeMs}`).digest('hex').slice(0, 32)
      const rows = async function* () {
        if (!size) return
        const input = fs.createReadStream(file, { fd: handle.fd, autoClose: false, start: 0, encoding: 'utf8', end: size - 1 })
        const lines = createInterface({ input, crlfDelay: Infinity })
        let ordinal = 0
        try {
          for await (const line of lines) {
            if (!line.trim()) continue
            let row: JsonlRow
            try { row = JSON.parse(line) as JsonlRow } catch { continue }
            yield { row, ordinal: ordinal++ }
          }
        } finally { lines.close() }
      }
      const updates = new Map<string, JsonlRow>(), deleted = new Set<string>(), deletedTurns = new Set<string>()
      const originalSequences = new Map<string, number>()
      const truncations: Array<{ ordinal: number; afterSeq: number }> = []
      const summaries: Array<{ ordinal: number; dbSeq: number; floor: number; hasSummary: boolean; retainedUuids?: string[] }> = []
      let clearAfter = -1, latestSummary: JsonlRow | undefined, previousMessageSeq = -1
      for await (const { row, ordinal } of rows()) {
        if (row.payload && ['user', 'assistant', 'tool', 'system'].includes(row.type)) {
          originalSequences.set(row.uuid, row.dbSeq)
          previousMessageSeq = Math.max(previousMessageSeq, row.dbSeq)
        }
        if (row.type === 'update' && row.targetUuid) collectUpdate(updates, row)
        else if (row.type === 'tombstone') {
          previousMessageSeq = Math.max(previousMessageSeq, row.dbSeq ?? -1)
          if (row.scope === 'clear') { clearAfter = Math.max(clearAfter, ordinal); summaries.length = 0 }
          if (row.scope === 'truncate' && typeof row.afterSeq === 'number') truncations.push({ ordinal, afterSeq: row.afterSeq })
          if (row.scope === 'message' && row.targetUuid) deleted.add(row.targetUuid)
          if (row.scope === 'conversation' && row.conversationId) deletedTurns.add(row.conversationId)
        } else if (row.type === 'summary' && ordinal > clearAfter) {
          summaries.push({ ordinal, dbSeq: row.dbSeq, hasSummary: Boolean(row.summary), retainedUuids: row.retainedUuids, floor: typeof row.leafSeq === 'number' ? row.leafSeq
            : row.leafUuid && originalSequences.has(row.leafUuid) ? originalSequences.get(row.leafUuid)! : previousMessageSeq })
        }
      }
      const isTruncated = truncateFilter(truncations)
      let selectedSummary: typeof summaries[number] | undefined
      for (let index = summaries.length - 1; index >= 0; index--) {
        if (!isTruncated(summaries[index].dbSeq, summaries[index].ordinal)) { selectedSummary = summaries[index]; break }
      }
      const summaryFloor = selectedSummary?.floor ?? -1
      const messages: Message[] = []
      let totalMessageCount = 0, currentMessageCount = selectedSummary?.hasSummary ? 1 : 0
      for await (const { row, ordinal } of rows()) {
        if (ordinal === selectedSummary?.ordinal && row.type === 'summary') latestSummary = row
        if (!row.payload || !['user', 'assistant', 'tool', 'system'].includes(row.type)) continue
        if (ordinal <= clearAfter || isTruncated(row.dbSeq, ordinal) || deleted.has(row.uuid) || row.conversationId && deletedTurns.has(row.conversationId)) continue
        if (row.dbSeq > summaryFloor || selectedSummary?.retainedUuids?.includes(row.uuid)) currentMessageCount++
        if (totalMessageCount >= page.offset && messages.length < page.limit) {
          const message = this.rowToMessage(row), update = updates.get(row.uuid)
          if (update) applyUpdate(message, update, true)
          messages.push(message)
        }
        totalMessageCount++
      }
      return { messages, totalMessageCount, archiveRevision, compressed: Boolean(latestSummary), currentMessageCount, backend: 'jsonl',
        ...(latestSummary?.summary ? { summary: { content: latestSummary.summary,
          ...(typeof latestSummary.leafSeq === 'number' ? { leafSeq: latestSummary.leafSeq } : {}),
          ...(typeof latestSummary.preTokens === 'number' ? { preTokens: latestSummary.preTokens } : {}),
          ...(typeof latestSummary.postTokens === 'number' ? { postTokens: latestSummary.postTokens } : {}),
          ...(latestSummary.transcriptPath ? { transcriptPath: latestSummary.transcriptPath } : {}),
        } } : {}) }
    } finally { await handle.close() }
  }

  async getTokenCount(ctx: Ctx): Promise<number> {
    const windowed = await this.getHistory(ctx)
    return windowed.reduce((sum, m) => sum + (m.tokens ?? 0), 0)
  }

  /** Two bounded-memory passes; apply edits/deletions before returning archive evidence. */
  async searchArchive(ctx: Ctx, options: HistorySearchOptions): Promise<HistorySearchResult> {
    return this.scanArchive(ctx, options)
  }

  private async scanArchive(ctx: Ctx, options: HistorySearchOptions,
    visit?: (message: Message) => void, includeUsageReceipts = false): Promise<HistorySearchResult> {
    const file = this.filePath(ctx)
    // A cold search must not materialize the active projection or the entire
    // transcript. Only consult the legacy source when no JSONL file exists.
    let archiveHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined
    try { archiveHandle = await fs.promises.open(file, 'r') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!archiveHandle) {
      await this.migrateFromSqlite(ctx)
      try { archiveHandle = await fs.promises.open(file, 'r') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (!archiveHandle) return { messages: [], totalMatches: 0, nextOffset: null, backend: 'jsonl' }
    const handle = archiveHandle
    try {
      const size = (await handle.stat()).size
      const rows = async function* () {
        if (!size) return
        const input = fs.createReadStream(file, { fd: handle.fd, autoClose: false, start: 0, encoding: 'utf8', end: size - 1 })
        const lines = createInterface({ input, crlfDelay: Infinity })
        let ordinal = 0
        try {
          for await (const line of lines) {
            if (!line.trim()) continue
            let row: JsonlRow
            try { row = JSON.parse(line) as JsonlRow } catch { continue }
            yield { row, ordinal: ordinal++ }
          }
        } finally { lines.close() }
      }
      const updates = new Map<string, JsonlRow>(), deleted = new Set<string>(), deletedTurns = new Set<string>()
      const truncations: Array<{ ordinal: number; afterSeq: number }> = []
      let clearAfter = -1
      for await (const { row, ordinal } of rows()) {
        if (row.type === 'update' && row.targetUuid) collectUpdate(updates, row)
        if (row.type !== 'tombstone') continue
        if (row.scope === 'clear') clearAfter = Math.max(clearAfter, ordinal)
        if (row.scope === 'truncate' && typeof row.afterSeq === 'number') truncations.push({ ordinal, afterSeq: row.afterSeq })
        if (row.scope === 'message' && row.targetUuid) deleted.add(row.targetUuid)
        if (row.scope === 'conversation' && row.conversationId) deletedTurns.add(row.conversationId)
      }
      const isTruncated = truncateFilter(truncations)
      const query = options.query?.toLocaleLowerCase() ?? ''
      const offset = options.offset ?? 0, limit = options.limit ?? 10
      const messages: Message[] = []
      let totalMatches = 0
      for await (const { row, ordinal } of rows()) {
        if (!row.payload || !['user', 'assistant', 'tool', 'system', ...(includeUsageReceipts ? ['usage'] : [])].includes(row.type)) continue
        if (ordinal <= clearAfter || isTruncated(row.dbSeq, ordinal) || deleted.has(row.uuid) || row.conversationId && deletedTurns.has(row.conversationId)) continue
        if (options.messageId && row.uuid !== options.messageId || options.role && row.type !== options.role) continue
        const message = this.rowToMessage(row), update = updates.get(row.uuid)
        if (update) applyUpdate(message, update, true)
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        const inputText = typeof message.modelInputContent === 'string' ? message.modelInputContent : JSON.stringify(message.modelInputContent ?? '')
        if (query && !text.toLocaleLowerCase().includes(query) && !inputText.toLocaleLowerCase().includes(query)) continue
        visit?.(message)
        if (totalMatches >= offset && messages.length < limit) messages.push(message)
        totalMatches++
      }
      return { messages, totalMatches, nextOffset: offset + messages.length < totalMatches ? offset + messages.length : null, backend: 'jsonl' }
    } finally { await handle.close() }
  }

  async getRawTokenCount(ctx: Ctx): Promise<number> {
    const state = await this.loadSession(ctx)
    return state.rawTokens
  }

  async clear(ctx: Ctx, options?: { tombstone?: boolean }): Promise<void> {
    const key = this.sessionKey(ctx)
    const file = this.filePath(ctx)
    // Validate the marker before renaming history or setting a tombstone.
    this.migratedPath(ctx)
    if (options?.tombstone === false) this.tombstones.delete(key)
    else this.tombstones.set(key, Date.now())
    await this.enqueue(key, async () => {
      // This fence survives rename and a failing clear fallback. A pending
      // projection can never resume into a recreated archive with the same IDs.
      await advanceProjectionEpoch(this.projectionDb(), ctx)
      if (fs.existsSync(this.dataPath)) await invalidateJSONLDeliveries(this.projectionDb(), ctx)
      try {
        if (fs.existsSync(file)) {
          await fs.promises.rename(file, `${file}.${Date.now()}.bak`)
        }
      } catch {
        // Windows 文件锁失败：退化为逻辑 clear tombstone
        // We already own this session's queue; enqueueing again waits on
        // ourselves forever when Windows refuses the rename.
        await this.appendRowWithinLease(ctx, {
          uuid: crypto.randomUUID(),
          parentUuid: null,
          type: 'tombstone',
          timestamp: new Date().toISOString(),
          sessionId: ctx.sessionId,
          tenantId: ctx.tenantId,
          isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
          dbSeq: 0,
          scope: 'clear',
        })
      }
      // Persist the clear decision next to the JSONL session.  The legacy
      // SQLite database can remain populated during a gradual migration, but
      // it must not resurrect a deliberately cleared session on restart.
      await fs.promises.mkdir(path.dirname(this.migratedPath(ctx)), { recursive: true })
      await fs.promises.writeFile(this.migratedPath(ctx), 'cleared')
    })
    const cached = this.states.get(key)
    if (cached) this.cachedBytes -= cached.cacheBytes
    this.states.delete(key)
  }

  async deleteMessage(messageId: string, tenantId: string): Promise<void> {
    const ctx = await this.locateMessage(messageId, tenantId)
    if (!ctx) return
    await this.appendRow(ctx, {
      uuid: crypto.randomUUID(),
      parentUuid: null,
      type: 'tombstone',
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      tenantId,
      isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
      dbSeq: 0,
      scope: 'message',
      targetUuid: messageId,
    })
    this.invalidate(ctx)
  }

  async deleteMessagesAfterId(dbId: number, sessionId: string, tenantId: string): Promise<void> {
    const ctx: Ctx = { tenantId, sessionId }
    await this.appendRow(ctx, {
      uuid: crypto.randomUUID(),
      parentUuid: null,
      type: 'tombstone',
      timestamp: new Date().toISOString(),
      sessionId,
      tenantId,
      isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
      dbSeq: 0,
      scope: 'truncate',
      afterSeq: dbId,
    })
    this.invalidate(ctx)
  }

  async deleteByConversationId(conversationId: string, tenantId: string): Promise<number> {
    const dir = this.tenantPath(tenantId)
    let count = 0
    if (!fs.existsSync(dir)) return 0
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const ctx: Ctx = { tenantId, sessionId: name.slice(0, -'.jsonl'.length) }
      let matchingMessages = 0
      await this.scanArchive(ctx, { limit: 0 }, message => {
        if ((message as Message & { conversationId?: string }).conversationId === conversationId) matchingMessages++
      }, true)
      if (matchingMessages > 0) {
        count += matchingMessages
        await this.appendRow(ctx, {
          uuid: crypto.randomUUID(),
          parentUuid: null,
          type: 'tombstone',
          timestamp: new Date().toISOString(),
          sessionId: ctx.sessionId,
          tenantId,
          isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
          dbSeq: 0,
          scope: 'conversation',
          conversationId,
        })
        this.invalidate(ctx)
      }
    }
    return count
  }

  async updateMessageContent(
    messageId: string,
    tenantId: string,
    content: string | any[],
    tokens: number,
    metadata?: unknown,
  ): Promise<void> {
    const ctx = await this.locateMessage(messageId, tenantId)
    if (!ctx) return
    await this.appendRow(ctx, {
      uuid: crypto.randomUUID(),
      parentUuid: null,
      type: 'update',
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      tenantId,
      isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
      dbSeq: 0,
      targetUuid: messageId,
      content,
      modelInputContent: null,
      tokens,
      metadata: withoutToolEvidence(metadata),
    })
    this.invalidate(ctx)
  }

  /**
   * Micro-compact：把最近 keepRecent 条消息之前的 tool 结果替换为占位符。
   * JSONL 为 append-only：对每条待清理消息追加一行 update 行，loadSession 折叠时
   * 自动覆盖 content/tokens，无需重写文件。与 SQLite 实现语义一致。
   */
  async microCompactToolResults(
    ctx: Ctx,
    opts: { keepRecent?: number; maxChars?: number } = {},
  ): Promise<{ cleared: number; freedTokens: number }> {
    const keepRecent = Number.isFinite(opts.keepRecent) ? Math.max(0, Math.floor(opts.keepRecent!)) : 10
    const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars ?? 0) > 0 ? Math.floor(opts.maxChars!) : undefined
    const placeholder = CLEARED_TOOL_RESULT
    const state = await this.loadSession(ctx)
    const all = state.messages
    const cutoff = all.length - keepRecent
    let cleared = 0
    let freedTokens = 0
    const updates: JsonlRow[] = []
    for (let i = 0; i < all.length; i++) {
      const msg = all[i]
      if (msg.role !== 'tool' || !msg.id) continue
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (!content || content === placeholder) continue
      if (i >= cutoff && (maxChars === undefined || toolResultTextLength(content) <= maxChars)) continue
      const oldTokens = msg.tokens ?? estimateTokens(msg.content)
      const metadata = { ...msg.metadata, [CLEARED_TOOL_EVIDENCE_KEY]: clearedToolEvidence(msg) }
      const placeholderTokens = estimateModelMessageTokens({ ...msg, content: placeholder, metadata })
      updates.push({
        uuid: crypto.randomUUID(),
        parentUuid: null,
        type: 'update',
        timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId,
        tenantId: ctx.tenantId,
        isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
        dbSeq: 0,
        targetUuid: msg.id,
        content: placeholder,
        tokens: placeholderTokens,
        metadata,
        // Keep the compact content in the update row for model replay.  The
        // archive reader deliberately selects this separate field instead.
        archiveContent: content,
        archiveTokens: oldTokens,
      })
      cleared++
      freedTokens += Math.max(0, oldTokens - placeholderTokens)
    }
    if (cleared > 0) {
      // One authenticated append used to rescan/hash the entire archive several
      // times per tool. Group updates under the same exact-byte recovery receipt
      // so large browser histories do not hold the tenant lock for minutes.
      await this.enqueue(this.sessionKey(ctx), async () => {
        const file = this.filePath(ctx)
        const maintenance = fs.existsSync(this.dataPath) ? currentHistoryMaintenance(this.projectionDb(), ctx, 'jsonl') : undefined
        if (!maintenance && fs.existsSync(this.dataPath)) await invalidateJSONLDeliveries(this.projectionDb(), ctx)
        let batch: JsonlRow[] = [], bytes = 0
        const flush = async () => {
          if (!batch.length) return
          if (maintenance) await this.appendMaintenanceRows(ctx, batch, maintenance)
          else await fs.promises.appendFile(file, batch.map(row => JSON.stringify(row) + '\n').join(''))
          batch = []; bytes = 0
        }
        for (const row of updates) {
          const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1
          // A single legacy result may exceed this target. Keep that row intact
          // in its own receipt rather than truncate the archived evidence.
          if (batch.length && (batch.length >= 128 || bytes + rowBytes > 8 * 1024 * 1024)) await flush()
          batch.push(row); bytes += rowBytes
        }
        await flush()
      })
      this.invalidate(ctx)
      console.log(`[jsonl-history] micro-compact: cleared ${cleared} tool results, freed ~${freedTokens} tokens`)
    }
    return { cleared, freedTokens }
  }

  async getMessageById(
    messageId: string,
    tenantId: string,
    sessionId?: string,
  ): Promise<(Message & { conversationId?: string; dbId: number }) | null> {
    // Admission already knows its owning session. A missing reserved assistant
    // must not search unrelated archives or borrow another session's same ID.
    const ctx = sessionId === undefined ? await this.locateMessage(messageId, tenantId) : { tenantId, sessionId }
    if (!ctx) return null
    const state = await this.loadSession(ctx)
    const msg = state.byId.get(messageId)
    if (msg) return msg as Message & { conversationId?: string; dbId: number }
    const archived = await this.searchArchive(ctx, { messageId, limit: 1 })
    return (archived.messages[0] as Message & { conversationId?: string; dbId: number }) ?? null
  }

  async getByConversationId(
    conversationId: string,
    tenantId: string,
  ): Promise<(Message & { conversationId?: string })[]> {
    const dir = this.tenantPath(tenantId)
    if (!fs.existsSync(dir)) return []
    const result: (Message & { conversationId?: string })[] = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      const state = await this.loadSession({ tenantId, sessionId })
      for (const m of state.messages) {
        if ((m as unknown as Record<string, unknown>).conversationId === conversationId) {
          result.push(m as Message & { conversationId?: string })
        }
      }
    }
    return result
  }

  async getSessionUsage(ctx: Ctx, conversationId?: string): Promise<Record<string, number>> {
    const result = await this.readUsageTotals(ctx, conversationId)
    return conversationId === undefined ? result.sessionUsage : result.turnUsage
  }

  async getUsageTotals(ctx: Ctx, conversationId: string): Promise<{
    sessionUsage: Record<string, number>; turnUsage: Record<string, number>
  }> {
    return this.readUsageTotals(ctx, conversationId)
  }

  private async readUsageTotals(ctx: Ctx, conversationId?: string): Promise<{
    sessionUsage: Record<string, number>; turnUsage: Record<string, number>
  }> {
    const sessionKey = this.sessionKey(ctx), sessionCacheKey = `${sessionKey}\0session`
    const turnCacheKey = `${sessionKey}\0turn:${conversationId}`
    const revision = await this.usageRevision(ctx)
    const cachedSession = this.usageCache.get(sessionCacheKey), cachedTurn = this.usageCache.get(turnCacheKey)
    if (revision !== undefined && cachedSession?.revision === revision
      && (conversationId === undefined || cachedTurn?.revision === revision)) {
      this.usageCache.delete(sessionCacheKey); this.usageCache.set(sessionCacheKey, cachedSession)
      if (conversationId !== undefined && cachedTurn) {
        this.usageCache.delete(turnCacheKey); this.usageCache.set(turnCacheKey, cachedTurn)
      }
      return { sessionUsage: { ...cachedSession.usage }, turnUsage: cachedTurn ? { ...cachedTurn.usage } : emptyBillingUsage() }
    }
    const usage = emptyBillingUsage(), turnUsage = emptyBillingUsage()
    // Billing comes from every retained provider call, including rows covered
    // by summaries. Do not load the full transcript or count content estimates
    // as provider usage. Tombstones and edits use the same archive fold rules.
    await this.scanArchive(ctx, { limit: 0 }, message => {
      addMessageUsage(usage, message)
      if (conversationId !== undefined && (message as Message & { conversationId?: string }).conversationId === conversationId) addMessageUsage(turnUsage, message)
    }, true)
    const latestRevision = await this.usageRevision(ctx)
    if (revision !== undefined && revision === latestRevision) {
      this.usageCache.delete(sessionCacheKey)
      this.usageCache.set(sessionCacheKey, { sessionKey, revision, usage: { ...usage } })
      if (conversationId !== undefined) {
        this.usageCache.delete(turnCacheKey)
        this.usageCache.set(turnCacheKey, { sessionKey, conversationId, revision, usage: { ...turnUsage } })
      }
      while (this.usageCache.size > this.maxCachedSessions) this.usageCache.delete(this.usageCache.keys().next().value!)
    }
    return { sessionUsage: usage, turnUsage }
  }

  async compress(
    ctx: Ctx & { signal?: AbortSignal },
    summarizeFn: (messages: Message[], evidence?: CompactionArchiveEvidence) => Promise<string>,
    keepRecentOrOpts?: number | CompressionOptions,
  ): Promise<{ preTokens: number; postTokens: number }> {
    return withSessionHistoryCompression(ctx, async signal => {
    ctx = { ...ctx, signal }
    const prepared = await withHistoryLock(ctx.tenantId, async () => {
      assertCompressionContext(ctx)
      const state = await this.loadSession(ctx)
      const all = structuredClone(state.messages)
      const preTokens = estimateModelHistoryTokens(all)
      const splitIdx = compressionSplitIndex(all, keepRecentOrOpts ?? {})
      const maintenance = fs.existsSync(this.dataPath) ? currentHistoryMaintenance(this.projectionDb(), ctx, 'jsonl') : undefined
      const pinned = maintenance ? maintenancePinnedIds(all, maintenance.anchorId) : new Set<string>()
      const older = all.slice(0, splitIdx).filter(message => !pinned.has(message.id ?? ''))
      const recent = all.filter((message, index) => index >= splitIdx || pinned.has(message.id ?? ''))
      if (!older.length) return { preTokens, older, recent, revision: this.fileRevision(state), nextSeq: state.nextSeq,
        leafUuid: undefined, leafSeq: 0, retainedUuids: [...pinned], systemMessages: [] as Message[] }
      const leaf = older[older.length - 1]
      const leafSeq = ((leaf as unknown as Record<string, unknown>).dbId as number)
        ?? (leaf.metadata?.isCompactSummary ? leaf.metadata.compactionLeafSeq : undefined) ?? 0
      // Archive evidence stays tied to the prepared prefix, not a newer file.
      const archivedSystems = await this.searchArchive(ctx, { role: 'system', limit: Number.MAX_SAFE_INTEGER })
      const systemMessages = structuredClone(archivedSystems.messages.filter(message => message.role === 'system'
        && !message.metadata?.isCompactSummary && (message as Message & { dbId: number }).dbId <= leafSeq))
      return { preTokens, older, recent, revision: this.fileRevision(state), nextSeq: state.nextSeq,
        leafUuid: leaf.id, leafSeq, retainedUuids: [...pinned], systemMessages }
    })
    if (!prepared.older.length) return { preTokens: prepared.preTokens, postTokens: prepared.preTokens }
    const maintenance = fs.existsSync(this.dataPath) ? currentHistoryMaintenance(this.projectionDb(), ctx, 'jsonl') : undefined
    const summary = await awaitCompressionSummary(() => summarizeFn(maintenanceSummaryEvidence(prepared.older, maintenance), { systemMessages: prepared.systemMessages }), ctx.signal)
    return withHistoryLock(ctx.tenantId, async () => {
      assertCompressionContext(ctx)
      const postTokens = estimateModelHistoryTokens([{ role: 'system', content: `【历史上下文摘要】${summary}` }, ...prepared.recent])
      await this.appendRow(ctx, {
        uuid: crypto.randomUUID(), parentUuid: null, type: 'summary', timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId, tenantId: ctx.tenantId,
        isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
        dbSeq: prepared.nextSeq, summary, leafUuid: prepared.leafUuid, leafSeq: prepared.leafSeq,
        ...(prepared.retainedUuids.length ? { retainedUuids: prepared.retainedUuids } : {}),
        preTokens: prepared.preTokens, postTokens, transcriptPath: this.filePath(ctx),
      }, async () => {
        assertCompressionContext(ctx)
        const state = await this.loadSession(ctx)
        if (this.fileRevision(state) !== prepared.revision || state.nextSeq !== prepared.nextSeq)
          throw Object.assign(new Error('History changed during summary generation; original history was preserved'), { code: 'HISTORY_COMPRESSION_CONFLICT' })
        assertCompressionContext(ctx)
      }, () => assertCompressionContext(ctx))
      this.invalidate(ctx)
      return { preTokens: prepared.preTokens, postTokens }
    })
    })
  }

  async summarize(ctx: AgentContext): Promise<void> {
    const messages = await this.getFullHistory(ctx)
    if (messages.length === 0) return
    const text = messages
      .map((m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return `[${m.role}] ${c.slice(0, 200)}`
      })
      .join('\n')
    await this.compress(ctx, async () => text, {})
  }

  async listSessions(tenantId: string): Promise<
    Array<{
      sessionId: string
      lastMessage?: string
      lastAt?: number
      messageCount: number
      title?: string
      lastReply?: string
      totalUsage?: Record<string, number>
    }>
  > {
    const { getSubagentStore } = await import('../../core/subagent/store.js')
    const childSessions = new Set(await getSubagentStore().listChildSessionIds(tenantId))
    const dir = this.tenantPath(tenantId)
    const result: Array<{
      sessionId: string
      lastMessage?: string
      lastAt?: number
      messageCount: number
      title?: string
      lastReply?: string
      totalUsage?: Record<string, number>
    }> = []
    if (!fs.existsSync(dir)) return result
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (sessionId.startsWith('subagent-') || childSessions.has(sessionId)) continue
      const state = await this.loadSession({ tenantId, sessionId })
      const msgs = state.messages
      const firstUser = msgs.find((m) => m.role === 'user')
      const last = msgs[msgs.length - 1]
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
      const asText = (m: Message | undefined): string | undefined => {
        if (!m) return undefined
        return typeof m.content === 'string' ? m.content.slice(0, 100) : undefined
      }
      result.push({
        sessionId,
        title: asText(firstUser),
        lastMessage: asText(last),
        lastReply: asText(lastAssistant),
        messageCount: msgs.length,
        lastAt: state.mtimeMs,
        totalUsage: await this.getSessionUsage({ tenantId, sessionId }),
      })
    }
    result.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    return result
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  private async appendRow(ctx: Ctx, row: JsonlRow, beforeWrite?: () => Promise<void>, beforeAppend?: () => void): Promise<void> {
    const key = this.sessionKey(ctx)
    await this.enqueue(key, async () => {
      await beforeWrite?.()
      await this.appendRowWithinLease(ctx, row, beforeAppend)
    })
  }

  private async appendRowWithinLease(ctx: Ctx, row: JsonlRow, beforeAppend?: () => void): Promise<void> {
    const file = this.filePath(ctx)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    beforeAppend?.()
    const maintenance = fs.existsSync(this.dataPath) ? currentHistoryMaintenance(this.projectionDb(), ctx, 'jsonl') : undefined
    if (maintenance && (row.type === 'summary' || row.type === 'update')) { await this.appendMaintenanceRows(ctx, [row], maintenance); return }
    if (fs.existsSync(this.dataPath) && (row.type === 'tombstone' || row.type === 'update' || row.type === 'summary')) await invalidateJSONLDeliveries(this.projectionDb(), ctx)
    await fs.promises.appendFile(file, JSON.stringify(row) + '\n')
  }

  private maintenanceAnchor(snapshot: JSONLPhysicalSnapshot, anchorId: string): string {
    const rows = snapshot.rows.filter(row => row.id === anchorId), active = snapshot.active.filter(message => message.id === anchorId)
    if (rows.length !== 1 || active.length !== 1 || active[0].role !== 'user') throw new CollaborationError('conflict', 'Maintenance lost its original physical input')
    return JSON.stringify([snapshot.fileIdentity, rows[0].offset, rows[0].bytes, rows[0].hash, canonicalJSONLMessage(active[0])])
  }

  /** File sync and the retirement receipt reconcile by exact reserved bytes after lost ACK or restart. */
  private async recoverCollaborationMaintenance(ctx: Ctx): Promise<void> {
    // Plain JSONL archives have no SQL authority to recover. Starting a receipt
    // datasource here would couple ordinary file appends to engine startup.
    if (!fs.existsSync(this.dataPath)) return
    const db = this.projectionDb()
    await ensureHistoryMaintenanceSchema(db)
    const pending = (await db.execute({ sql: `SELECT maintenance_id,history_epoch,typeof(history_epoch) AS epoch_type,anchor_id,anchor_fingerprint,payload_json,payload_hash
      FROM collaboration_history_maintenance WHERE tenant_id=? AND session_id=? AND backend='jsonl' AND state='pending' ORDER BY rowid`, args: [ctx.tenantId, ctx.sessionId] })).rows
    for (const receipt of pending) {
      if (receipt.epoch_type !== 'integer' || !Number.isSafeInteger(Number(receipt.history_epoch)) || Number(receipt.history_epoch) < 0)
        throw new CollaborationError('conflict', 'JSONL maintenance receipt epoch is invalid')
      const json = String(receipt.payload_json)
      if (maintenanceDigest(json) !== receipt.payload_hash) throw new CollaborationError('conflict', 'JSONL maintenance receipt changed')
      const payload = JSON.parse(json) as { plan: JSONLAppendPlan; retired: string[] }
      if (!payload || !payload.plan || !Array.isArray(payload.retired) || !payload.retired.every(id => typeof id === 'string'))
        throw new CollaborationError('conflict', 'JSONL maintenance reservation is malformed')
      if (await jsonlHistoryEpoch(db, ctx, true) !== Number(receipt.history_epoch)) throw new CollaborationError('conflict', 'JSONL maintenance epoch was revoked')
      let snapshot = await this.inspectCollaborationArchive(ctx)
      if (this.maintenanceAnchor(snapshot, String(receipt.anchor_id)) !== receipt.anchor_fingerprint) throw new CollaborationError('conflict', 'JSONL maintenance input identity changed')
      const deliveries = (await db.execute({ sql: `SELECT history_message_id,file_identity,row_offset,row_bytes,row_hash,history_epoch
        FROM collaboration_jsonl_deliveries WHERE tenant_id=? AND history_session_id=? AND state='integrated'`, args: [ctx.tenantId, ctx.sessionId] })).rows
      const physicalById = new Map<string, typeof snapshot.rows>()
      for (const row of snapshot.rows) { const rows = physicalById.get(row.id) ?? []; rows.push(row); physicalById.set(row.id, rows) }
      for (const delivery of deliveries) {
        const rows = physicalById.get(String(delivery.history_message_id)) ?? [], physical = rows[0]
        if (rows.length !== 1 || delivery.history_epoch !== receipt.history_epoch || delivery.file_identity !== snapshot.fileIdentity
          || Number(delivery.row_offset) !== physical.offset || Number(delivery.row_bytes) !== physical.bytes || delivery.row_hash !== physical.hash)
          throw new CollaborationError('conflict', 'Maintenance cannot retire a peer whose original physical record changed')
      }
      await this.persistCollaborationRow(ctx, payload.plan)
      snapshot = await this.inspectCollaborationArchive(ctx)
      if (this.maintenanceAnchor(snapshot, String(receipt.anchor_id)) !== receipt.anchor_fingerprint) throw new CollaborationError('conflict', 'JSONL maintenance changed its original input')
      const tx = await db.transaction('write')
      try {
        if (await jsonlHistoryEpoch(tx, ctx, true) !== Number(receipt.history_epoch)) throw new CollaborationError('conflict', 'JSONL maintenance epoch changed after sync')
        await tx.execute({ sql: `UPDATE collaboration_jsonl_deliveries SET state='suppressed',reason='history_compacted'
          WHERE tenant_id=? AND history_session_id=? AND state='integrated' AND history_message_id IN (SELECT value FROM json_each(?))`,
          args: [ctx.tenantId, ctx.sessionId, JSON.stringify(payload.retired)] })
        await tx.execute({ sql: `UPDATE collaboration_history_maintenance SET state='committed',committed_at=? WHERE maintenance_id=? AND state='pending'`, args: [Date.now(), receipt.maintenance_id] })
        await tx.commit()
      } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
      finally { tx.close() }
    }
  }

  private async appendMaintenanceRows(ctx: Ctx, rows: JsonlRow[], maintenance: HistoryMaintenanceLease): Promise<void> {
    if (!rows.length) return
    if (rows.length > 1 && rows.some(row => row.type !== 'update')) throw new CollaborationError('forbidden', 'Only tool updates may share a maintenance receipt')
    await maintenance.check()
    const snapshot = await this.inspectCollaborationArchive(ctx)
    if (this.maintenanceAnchor(snapshot, maintenance.anchorId) !== maintenance.anchorFingerprint) throw new CollaborationError('conflict', 'Private maintenance changed its seed')
    const roles = new Map(snapshot.active.map(message => [message.id, message.role]))
    for (const row of rows) if (row.type === 'update' && roles.get(row.targetUuid) !== 'tool')
        throw new CollaborationError('forbidden', 'Private micro maintenance may only reduce tool output')
    const row = rows[0]
    const pins = maintenancePinnedIds(snapshot.active, maintenance.anchorId)
    if (row.type === 'summary' && [...pins].some(id => !row.retainedUuids?.includes(id))) throw new CollaborationError('conflict', 'Summary would remove an admitted input or pending dispatch')
    const encoded = rows.map(item => JSON.stringify(item) + '\n').join('')
    const plan: JSONLAppendPlan = { fileIdentity: snapshot.fileIdentity, offset: snapshot.size, bytes: Buffer.byteLength(encoded),
      hash: maintenanceDigest(encoded), encoded, prefixHash: snapshot.contentHash }
    const retained = new Set(row.retainedUuids ?? [])
    const retired = row.type === 'summary' ? snapshot.rows.filter(item => item.sequence <= (row.leafSeq ?? 0) && !retained.has(item.id)).map(item => item.id) : []
    const db = this.projectionDb(), tx = await db.transaction('write')
    try {
      if (await jsonlHistoryEpoch(tx, ctx, true) !== maintenance.epoch) throw new CollaborationError('conflict', 'JSONL maintenance epoch changed before reservation')
      await reserveHistoryMaintenance(tx, maintenance, { kind: row.type, plan, retired, retained: [...retained], before: snapshot.revision }, false)
      await tx.commit()
    } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
    await this.recoverCollaborationMaintenance(ctx)
  }

  private invalidate(ctx: Ctx): void {
    invalidateJSONLPhysicalSnapshot({ owner: this.physicalCacheOwner, dataPath: this.dataPath, tenantId: ctx.tenantId, sessionId: ctx.sessionId })
    const state = this.states.get(this.sessionKey(ctx))
    if (state) state.mtimeMs = 0
  }

  /** 全局定位消息所在会话：内存索引未命中时扫 tenant 目录 */
  private async locateMessage(messageId: string, tenantId: string): Promise<Ctx | null> {
    const dir = this.tenantPath(tenantId)
    if (!fs.existsSync(dir)) return null
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      const state = await this.loadSession({ tenantId, sessionId })
      if (state.byId.has(messageId)) return { tenantId, sessionId }
      // Compaction hides covered rows only from model replay. Editing,
      // deleting and exact-ID lookup must still locate retained originals.
      if ((await this.scanArchive({ tenantId, sessionId }, { messageId, limit: 1 }, undefined, true)).messages.length) return { tenantId, sessionId }
    }
    return null
  }

  /** token 滑窗（与 SQLite 实现同策略：从尾部回溯直到预算） */
  private applyTokenWindow(messages: Message[]): Message[] {
    if (!this.maxTokens) return messages
    let acc = 0
    let idx = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      acc += messages[i].tokens ?? 0
      if (acc > this.maxTokens) {
        idx = i + 1
        break
      }
    }
    return messages.slice(idx)
  }
}

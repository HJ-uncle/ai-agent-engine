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
import { createInterface } from 'node:readline'
import type { AgentContext, CompactionArchiveEvidence, ConversationArchive, ConversationHistory, HistorySearchOptions, HistorySearchResult, Message } from '../../core/agent-context/types.js'
import { estimateTokens } from '../../core/utils/tokens.js'
import { estimateModelHistoryTokens } from '../../core/utils/model-context.js'
import { compressionSplitIndex, type CompressionOptions } from './compression.js'
import { addMessageUsage, emptyBillingUsage } from './usage.js'

type Ctx = Pick<AgentContext, 'tenantId' | 'sessionId'>

const CLEARED_TOOL_RESULT = '[tool result cleared]'
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

export class JSONLConversationHistory implements ConversationHistory {
  readonly retainsArchive = true
  private readonly rootDir: string
  private readonly maxTokens?: number
  private readonly states = new Map<string, SessionState>()
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
    this.rootDir = path.join(path.dirname(dataDir), 'sessions')
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

    let lastUuid: string | null = null
    for (const row of rows) {
      if (row.dbSeq <= clearSeq) continue
      if ((rowOrdinals.get(row) ?? -1) <= clearOrdinal) continue
      if (isTruncated(row.dbSeq, rowOrdinals.get(row) ?? -1)) continue
      if (row.dbSeq <= summaryFloor) continue
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

  async append(message: Message, ctx: Ctx): Promise<string> {
    if (this.isTombstoned(ctx)) return message.id ?? ''
    const key = this.sessionKey(ctx)
    return this.enqueue(key, async () => {
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
      const summaries: Array<{ ordinal: number; dbSeq: number; floor: number; hasSummary: boolean }> = []
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
          summaries.push({ ordinal, dbSeq: row.dbSeq, hasSummary: Boolean(row.summary), floor: typeof row.leafSeq === 'number' ? row.leafSeq
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
        if (row.dbSeq > summaryFloor) currentMessageCount++
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
    this.tombstones.set(key, Date.now())
    await this.enqueue(key, async () => {
      try {
        if (fs.existsSync(file)) {
          await fs.promises.rename(file, `${file}.${Date.now()}.bak`)
        }
      } catch {
        // Windows 文件锁失败：退化为逻辑 clear tombstone
        await this.appendRow(ctx, {
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
      metadata,
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
    const keepRecent = opts.keepRecent ?? 10
    const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars ?? 0) > 0 ? Math.floor(opts.maxChars!) : undefined
    const placeholder = '[tool result cleared]'
    const placeholderTokens = estimateTokens(placeholder)
    const state = await this.loadSession(ctx)
    const all = state.messages
    const cutoff = all.length - keepRecent
    let cleared = 0
    let freedTokens = 0
    for (let i = 0; i < all.length; i++) {
      const msg = all[i]
      if (msg.role !== 'tool' || !msg.id) continue
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (!content || content === placeholder) continue
      if (i >= cutoff && (maxChars === undefined || content.length <= maxChars)) continue
      const oldTokens = msg.tokens ?? estimateTokens(msg.content)
      await this.appendRow(ctx, {
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
        metadata: msg.metadata,
        // Keep the compact content in the update row for model replay.  The
        // archive reader deliberately selects this separate field instead.
        archiveContent: content,
        archiveTokens: oldTokens,
      })
      cleared++
      freedTokens += Math.max(0, oldTokens - placeholderTokens)
    }
    if (cleared > 0) {
      this.invalidate(ctx)
      console.log(`[jsonl-history] micro-compact: cleared ${cleared} tool results, freed ~${freedTokens} tokens`)
    }
    return { cleared, freedTokens }
  }

  async getMessageById(
    messageId: string,
    tenantId: string,
  ): Promise<(Message & { conversationId?: string; dbId: number }) | null> {
    const ctx = await this.locateMessage(messageId, tenantId)
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
    ctx: Ctx,
    summarizeFn: (messages: Message[], evidence?: CompactionArchiveEvidence) => Promise<string>,
    keepRecentOrOpts?: number | CompressionOptions,
  ): Promise<{ preTokens: number; postTokens: number }> {
    const state = await this.loadSession(ctx)
    const all = state.messages
    const preTokens = estimateModelHistoryTokens(all)
    const splitIdx = compressionSplitIndex(all, keepRecentOrOpts ?? {})

    const older = all.slice(0, splitIdx)
    const recent = all.slice(splitIdx)
    if (older.length === 0) return { preTokens, postTokens: preTokens }

    const leaf = older[older.length - 1]
    const leafSeq = ((leaf as unknown as Record<string, unknown>).dbId as number)
      ?? (leaf.metadata?.isCompactSummary ? leaf.metadata.compactionLeafSeq : undefined) ?? 0
    // Read actual system rows, not the legacy summary's textual role markers.
    // Only rows covered by this summary belong here; recent rows stay verbatim.
    const archivedSystems = await this.searchArchive(ctx, { role: 'system', limit: Number.MAX_SAFE_INTEGER })
    const systemMessages = archivedSystems.messages.filter(message => message.role === 'system'
      && !message.metadata?.isCompactSummary && (message as Message & { dbId: number }).dbId <= leafSeq)
    const summary = await summarizeFn(older, { systemMessages })
    const postTokens = estimateModelHistoryTokens([{ role: 'system', content: `【历史上下文摘要】${summary}` }, ...recent])

    await this.appendRow(ctx, {
      uuid: crypto.randomUUID(),
      parentUuid: null,
      type: 'summary',
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      tenantId: ctx.tenantId,
      isSidechain: ctx.sessionId.startsWith('subagent-') || Boolean((ctx as Partial<AgentContext>).parentSessionId),
      dbSeq: state.nextSeq++,
      summary,
      leafUuid: leaf.id,
      leafSeq,
      preTokens,
      postTokens,
      transcriptPath: this.filePath(ctx),
    })
    this.invalidate(ctx)
    console.log(`[jsonl-history] compressed ${ctx.sessionId}: ${preTokens} → ${postTokens} tokens`)
    return { preTokens, postTokens }
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

  private async appendRow(ctx: Ctx, row: JsonlRow): Promise<void> {
    const key = this.sessionKey(ctx)
    await this.enqueue(key, async () => {
      const file = this.filePath(ctx)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.appendFile(file, JSON.stringify(row) + '\n')
    })
  }

  private invalidate(ctx: Ctx): void {
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

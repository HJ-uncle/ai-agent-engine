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
 *   truncate 取 min(afterSeq)，多次截断以最早的为截止，不会「复活」中间消息
 * - 删除是逻辑删（tombstone 行），物理清理只发生在 clear（rename .bak）时
 *
 * 落盘路径：`<DATA_DIR目录>/sessions/<tenantId>/<sessionId>.jsonl`
 * （DATA_DIR 现语义是 db 文件路径，取其 dirname 作根目录）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AgentContext, ConversationArchive, ConversationHistory, Message } from '../../core/agent-context/types.js'
import { estimateTokens } from '../../core/utils/tokens.js'

type Ctx = Pick<AgentContext, 'tenantId' | 'sessionId'>

/** 一行 JSONL 的信封（对齐 Claude Code 公共字段 + 引擎扩展） */
interface JsonlRow {
  uuid: string
  parentUuid: string | null
  type: string // user|assistant|tool|system|summary|update|tombstone
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
  tokens?: number
  metadata?: unknown
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
  size: number
}

export class JSONLConversationHistory implements ConversationHistory {
  private readonly rootDir: string
  private readonly maxTokens?: number
  private readonly states = new Map<string, SessionState>()
  private readonly writeQueues = new Map<string, Promise<void>>()
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
    return path.join(this.rootDir, ctx.tenantId, `${ctx.sessionId}.jsonl`)
  }

  private migratedPath(ctx: Ctx): string {
    return path.join(this.rootDir, ctx.tenantId, `${ctx.sessionId}.migrated`)
  }

  /** 串行化同一会话的写操作，避免并发 append 交错写坏行 */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.writeQueues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  private isTombstoned(ctx: Ctx): boolean {
    const at = this.tombstones.get(this.sessionKey(ctx))
    return at !== undefined && Date.now() - at < 5000
  }

  // ─── 读取与折叠 ──────────────────────────────────────────────

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
    if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
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
      size: stat?.size ?? 0,
    }

    if (!stat) {
      this.states.set(key, state)
      return state
    }

    const raw = await fs.promises.readFile(file, 'utf8')
    const rows: JsonlRow[] = []
    const rowOrdinals = new Map<JsonlRow, number>()
    const tombstoneRows: JsonlRow[] = []
    const updates = new Map<string, JsonlRow>()
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
      else if (row.type === 'update' && row.targetUuid) updates.set(row.targetUuid, row)
      else if (row.type === 'summary') { lastSummary = row; lastSummaryOrdinal = currentOrdinal }
      else rows.push(row)
    }

    state.nextSeq = maxSeq + 1

    // 折叠 tombstone
    let cutoffSeq = Infinity
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
        cutoffSeq = Math.min(cutoffSeq, t.afterSeq)
      } else if (t.scope === 'message' && t.targetUuid) {
        deletedUuids.add(t.targetUuid)
      } else if (t.scope === 'conversation' && t.conversationId) {
        deletedConvIds.add(t.conversationId)
      }
    }

    // summary 跳跃：leafSeq 及之前的消息被摘要覆盖
    const summaryFloor = lastSummary && typeof lastSummary.leafSeq === 'number' ? lastSummary.leafSeq : -1

    let lastUuid: string | null = null
    for (const row of rows) {
      if (row.dbSeq <= clearSeq) continue
      if ((rowOrdinals.get(row) ?? -1) <= clearOrdinal) continue
      if (row.dbSeq > cutoffSeq) continue
      if (row.dbSeq <= summaryFloor) continue
      if (deletedUuids.has(row.uuid)) continue
      if (row.conversationId && deletedConvIds.has(row.conversationId)) continue
      const msg = this.rowToMessage(row)
      const upd = updates.get(row.uuid)
      if (upd) {
        if (upd.content !== undefined) msg.content = upd.content
        if (typeof upd.tokens === 'number') msg.tokens = upd.tokens
        if (upd.metadata !== undefined) msg.metadata = upd.metadata
      }
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
        metadata: { isCompactSummary: true, transcriptPath: lastSummary.transcriptPath },
      }
      state.messages.unshift(summaryMsg)
      state.rawTokens += summaryMsg.tokens ?? 0
    }

    state.lastUuid = lastUuid
    this.states.set(key, state)
    return state
  }

  private rowToMessage(row: JsonlRow): Message {
    const p = (row.payload ?? {}) as Record<string, unknown>
    const msg: Message = {
      id: (p.id as string) ?? row.uuid,
      role: (p.role as Message['role']) ?? (row.type as Message['role']),
      content: (p.content as Message['content']) ?? '',
    }
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
    } catch {
      // No marker yet; continue with the lazy legacy import below.
    }
    const { SQLiteConversationHistory } = await import('./history.js')
    const sqlite = new SQLiteConversationHistory()
    let rows: Message[] = []
    try {
      rows = await sqlite.getFullHistory(ctx)
    } catch {
      rows = []
    }
    await fs.promises.mkdir(path.dirname(migrated), { recursive: true })
    // An empty SQLite session is not a durable migration decision. The
    // session may be populated later by an importer, recovery tool, or a
    // test/upgrade step; a permanent marker here would make subsequent reads
    // skip those rows forever. Only a non-empty migration writes a durable
    // marker, while an explicit clear writes the separate `cleared` marker.
    if (rows.length === 0) return
    const file = this.filePath(ctx)
    const tmp = `${file}.tmp`
    let seq = 1
    let parentUuid: string | null = null
    const lines: string[] = []
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
        dbSeq: state.nextSeq++,
        payload: this.messageToPayload({ ...message, id: uuid }),
        ...(typeof convId === 'string' ? { conversationId: convId } : {}),
      }
      const file = this.filePath(ctx)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.appendFile(file, JSON.stringify(row) + '\n')
      state.lastUuid = uuid
      state.rawTokens += message.tokens ?? 0
      state.mtimeMs = 0 // 失效缓存，下次 load 重读
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
  async getArchive(ctx: Ctx): Promise<ConversationArchive> {
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
    let truncateAfter = Infinity
    let clearAfterOrdinal = -1
    let latestSummary: JsonlRow | undefined

    for (const { row, ordinal: rowOrdinal } of entries) {
      if (row.type === 'update' && row.targetUuid) {
        updates.set(row.targetUuid, row)
      } else if (row.type === 'tombstone') {
        if (row.scope === 'clear') {
          // clear() normally renames the file.  The fallback tombstone uses
          // dbSeq=0, so line order is the only reliable boundary here.
          clearAfterOrdinal = Math.max(clearAfterOrdinal, rowOrdinal)
        } else if (row.scope === 'truncate' && typeof row.afterSeq === 'number') {
          truncateAfter = Math.min(truncateAfter, row.afterSeq)
        } else if (row.scope === 'message' && row.targetUuid) {
          deletedUuids.add(row.targetUuid)
        } else if (row.scope === 'conversation' && row.conversationId) {
          deletedConvIds.add(row.conversationId)
        }
      } else if (row.type === 'summary' && rowOrdinal > clearAfterOrdinal) {
        latestSummary = row
      }
    }

    const messages: Message[] = []
    for (const { row, ordinal: rowOrdinal } of entries) {
      if (row.type === 'summary' || row.type === 'update' || row.type === 'tombstone') continue
      if (rowOrdinal <= clearAfterOrdinal) continue
      if (typeof row.dbSeq === 'number' && row.dbSeq > truncateAfter) continue
      if (deletedUuids.has(row.uuid)) continue
      if (row.conversationId && deletedConvIds.has(row.conversationId)) continue
      const message = this.rowToMessage(row)
      const update = updates.get(row.uuid)
      if (update) {
        if (update.content !== undefined) message.content = update.content
        if (typeof update.tokens === 'number') message.tokens = update.tokens
        if (update.metadata !== undefined) message.metadata = update.metadata
      }
      messages.push(message)
    }

    return {
      messages,
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

  async getTokenCount(ctx: Ctx): Promise<number> {
    const windowed = await this.getHistory(ctx)
    return windowed.reduce((sum, m) => sum + (m.tokens ?? 0), 0)
  }

  async getRawTokenCount(ctx: Ctx): Promise<number> {
    const state = await this.loadSession(ctx)
    return state.rawTokens
  }

  async clear(ctx: Ctx, options?: { tombstone?: boolean }): Promise<void> {
    const key = this.sessionKey(ctx)
    this.tombstones.set(key, Date.now())
    const file = this.filePath(ctx)
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
    const dir = path.join(this.rootDir, tenantId)
    let count = 0
    if (!fs.existsSync(dir)) return 0
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const ctx: Ctx = { tenantId, sessionId: name.slice(0, -'.jsonl'.length) }
      const state = await this.loadSession(ctx)
      const hit = state.messages.filter(
        (m) => (m as unknown as Record<string, unknown>).conversationId === conversationId,
      )
      if (hit.length > 0) {
        count += hit.length
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
    opts: { keepRecent?: number } = {},
  ): Promise<{ cleared: number; freedTokens: number }> {
    const keepRecent = opts.keepRecent ?? 10
    const placeholder = '[tool result cleared]'
    const placeholderTokens = estimateTokens(placeholder)
    const state = await this.loadSession(ctx)
    const all = state.messages
    if (all.length <= keepRecent) return { cleared: 0, freedTokens: 0 }

    const cutoff = all.length - keepRecent
    let cleared = 0
    let freedTokens = 0
    for (let i = 0; i < cutoff; i++) {
      const msg = all[i]
      if (msg.role !== 'tool' || !msg.id) continue
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (!content || content === placeholder) continue
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
    return (msg as Message & { conversationId?: string; dbId: number }) ?? null
  }

  async getByConversationId(
    conversationId: string,
    tenantId: string,
  ): Promise<(Message & { conversationId?: string })[]> {
    const dir = path.join(this.rootDir, tenantId)
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

  async getSessionUsage(ctx: Ctx): Promise<Record<string, number>> {
    const state = await this.loadSession(ctx)
    let totalTokens = 0
    let messageCount = 0
    let userTokens = 0
    let assistantTokens = 0
    for (const m of state.messages) {
      messageCount++
      const t = m.tokens ?? 0
      totalTokens += t
      if (m.role === 'user') userTokens += t
      else if (m.role === 'assistant') assistantTokens += t
    }
    return { totalTokens, messageCount, userTokens, assistantTokens }
  }

  async compress(
    ctx: Ctx,
    summarizeFn: (messages: Message[]) => Promise<string>,
    keepRecentOrOpts?: number | { keepRecentTokens?: number },
  ): Promise<{ preTokens: number; postTokens: number }> {
    const state = await this.loadSession(ctx)
    const all = state.messages
    const preTokens = state.rawTokens
    if (all.length < 4) return { preTokens, postTokens: preTokens }

    // 保留策略（照抄 Claude Code）：从尾部按 token 预算回溯，保底一半条数。
    // 兼容旧的 keepRecent 数值参数：按条数截。
    let splitIdx: number
    if (typeof keepRecentOrOpts === 'number') {
      splitIdx = Math.max(0, all.length - keepRecentOrOpts)
    } else {
      const budget = keepRecentOrOpts?.keepRecentTokens ?? 20000
      const floor = Math.max(1, Math.floor(all.length / 2))
      let acc = 0
      splitIdx = 0
      for (let i = all.length - 1; i >= 0; i--) {
        acc += all[i].tokens ?? 0
        const kept = all.length - i
        if (acc >= budget && kept >= floor) {
          splitIdx = i
          break
        }
      }
      // 预算内未满足保底条数：至少保留 floor 条
      if (all.length - splitIdx < floor) splitIdx = Math.max(0, all.length - floor)
    }

    const older = all.slice(0, splitIdx)
    const recent = all.slice(splitIdx)
    if (older.length === 0) return { preTokens, postTokens: preTokens }

    const summary = await summarizeFn(older)
    const leaf = older[older.length - 1]
    const leafSeq = ((leaf as unknown as Record<string, unknown>).dbId as number) ?? 0
    const postTokens = estimateTokens(summary) + recent.reduce((s, m) => s + (m.tokens ?? 0), 0)

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
    }>
  > {
    const { getSubagentStore } = await import('../../core/subagent/store.js')
    const childSessions = new Set(await getSubagentStore().listChildSessionIds(tenantId))
    const dir = path.join(this.rootDir, tenantId)
    const result: Array<{
      sessionId: string
      lastMessage?: string
      lastAt?: number
      messageCount: number
      title?: string
      lastReply?: string
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
    const dir = path.join(this.rootDir, tenantId)
    if (!fs.existsSync(dir)) return null
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      const state = await this.loadSession({ tenantId, sessionId })
      if (state.byId.has(messageId)) return { tenantId, sessionId }
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

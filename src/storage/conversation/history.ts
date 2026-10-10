import type { ConversationArchive, ConversationHistory, Message, AgentContext } from '../../core/agent-context/index.js'
import { getDb } from '../sqlite/db.js'
import type { Row } from '@libsql/client'
import { v4 as uuidv4 } from 'uuid'
import { estimateTokens } from '../../core/utils/tokens.js'
import { estimateModelHistoryTokens } from '../../core/utils/model-context.js'
import { compressionSplitIndex, type CompressionOptions } from './compression.js'
import { applyOSMMultiplier } from '../../core/osm.js'
import { serializeMessageMetadata, restoreModelInputContent } from './model-input-content.js'
import { BILLING_USAGE_KEYS } from './usage.js'
import { up as createUsageArchive } from '../sqlite/migrations/025_conversation_usage_archive.js'
import type { Client } from '@libsql/client'

type Ctx = { tenantId: string; sessionId: string }
const usageArchiveReady = new WeakMap<Client, Promise<void>>()
function ensureUsageArchive(db: Client): Promise<void> {
  let pending = usageArchiveReady.get(db)
  if (!pending) {
    pending = createUsageArchive(db).catch(error => { usageArchiveReady.delete(db); throw error })
    usageArchiveReady.set(db, pending)
  }
  return pending
}
function billingCounterSql(key: string): string {
  return key === 'totalTokens'
    ? "COALESCE(json_extract(token_usage, '$.totalTokens'), COALESCE(json_extract(token_usage, '$.promptTokens'), 0) + COALESCE(json_extract(token_usage, '$.completionTokens'), 0))"
    : `json_extract(token_usage, '$.${key}')`
}

// Micro-compaction changes the model projection to a short marker, but the
// original tool output remains part of the user-visible transcript.  Keep the
// payload in message metadata so old SQLite databases need no schema change.
const MICRO_COMPACT_ARCHIVE_KEY = '__aetherMicroCompactArchive'

function restoreMicroCompactedTool(message: Message): Message {
  if (message.role !== 'tool' || message.content !== '[tool result cleared]' || !message.metadata || typeof message.metadata !== 'object') return message
  const metadata = message.metadata as Record<string, unknown>
  const archived = metadata[MICRO_COMPACT_ARCHIVE_KEY]
  if (!archived || typeof archived !== 'object' || typeof (archived as { content?: unknown }).content !== 'string') return message
  const { [MICRO_COMPACT_ARCHIVE_KEY]: _internal, ...visibleMetadata } = metadata
  const original = archived as { content: string; tokens?: number }
  return {
    ...message,
    content: original.content,
    ...(typeof original.tokens === 'number' ? { tokens: original.tokens } : {}),
    metadata: visibleMetadata,
  }
}

function rowToMessage(row: Row): Message & { conversationId?: string } {
  const role = row['role'] as string
  let content: any = row['content'] as string
  // tool 消息的 content 是工具输出字符串，永远保持原始字符串，不自动 JSON.parse
  // （read_file 返回 JSON 文本、read_image 返回 JSON 包装都需要保持字符串形式，
  //   由 openai.ts 等 adapter 自行解析处理）
  // 只对 user / assistant 消息做 JSON.parse（它们可能存储了 multipart array）
  if (role !== 'tool') {
    try {
      if (content.startsWith('[') || content.startsWith('{')) {
        content = JSON.parse(content)
      }
    } catch {
      /* ignore if not JSON */
    }
  }
  const tool_call_id = row['tool_call_id'] as string | null
  const tool_call_name = row['tool_call_name'] as string | null  // assistant 发起调用的工具名
  const tool_name = row['tool_name'] as string | null            // tool 结果消息的工具名（显示用）
  const tool_args = row['tool_args'] as string | null
  const tokens = row['tokens']
  const token_usage = row['token_usage'] as string | null
  const created_at = row['created_at']
  const conversation_id = row['conversation_id'] as string | null
  const message_id = row['message_id'] as string | null
  const reasoning_content = row['reasoning_content'] as string | null
  const model_id = row['model_id'] as string | null
  const metadata_raw = row['metadata'] as string | null

  const msg: Message & { conversationId?: string } = {
    ...(message_id ? { id: message_id } : {}),
    role: role as Message['role'],
    content,
    ...(reasoning_content != null ? { reasoningContent: reasoning_content } : {}),
    tokens: tokens != null ? Number(tokens) : 0,
    createdAt: created_at != null ? Number(created_at) * 1000 : 0,
    ...(conversation_id ? { conversationId: conversation_id } : {}),
    ...(model_id ? { modelId: model_id } : {}),
  }

  if (metadata_raw) {
    try {
      msg.metadata = JSON.parse(metadata_raw)
    } catch {
      /* ignore */
    }
  }
  if (token_usage) {
    try {
      msg.usage = JSON.parse(token_usage)
    } catch {
      /* ignore malformed JSON */
    }
  }
  restoreModelInputContent(msg)
  if (tool_call_id) {
    msg.toolCallId = tool_call_id
    msg.toolName = tool_name ?? undefined
  }
  if (tool_args) {
    try {
      const parsed = JSON.parse(tool_args)
      // Only attach toolCall if we also have a valid name.
      // Records written before the tool_call_name column existed have name=NULL
      // → skip constructing toolCall so the adapter won't emit a broken tool_use block.
      const resolvedName = tool_call_name ?? ''
      if (resolvedName) {
        msg.toolCall = {
          id: tool_call_id ?? '',
          name: resolvedName,
          args: parsed,
        }
      }
    } catch {
      /* ignore malformed JSON */
    }
  }
  return msg
}

// 默认历史窗口：每次实例化时动态读取 env + 应用 OSM 倍率，
// 保证 PUT /settings 热更新（OSM_MODE 切换 / HISTORY_MAX_TOKENS 修改）
// 能在下一个请求立即生效，而不需要重启进程。
// 与 react.ts 的 getToolOutputMaxChars() 策略完全对齐。
//
// 注意：若调用方显式传入 maxTokens（例如单元测试固定 cap），则不走此函数。
function getDefaultHistoryMaxTokens(): number {
  const base = parseInt(process.env.HISTORY_MAX_TOKENS ?? '20000', 10)
  return applyOSMMultiplier('historyMaxTokens', base)
}

// ============================================================================
// 会话级墓碑（Tombstone）
// ----------------------------------------------------------------------------
// 场景：客户端发起 DELETE /sessions/:sessionId 后，正在跑的 SSE 流可能尚未完全
// 终止，strategy.run 内部仍可能 await ctx.history.append(...) 把消息写回 DB，
// 导致下次 listSessions 时该 session "复活"。
//
// 墓碑机制：
//   - clear() 同时设置墓碑（默认 5 秒）
//   - append() 在写入前检查，若命中墓碑则丢弃本次写入
//   - 5 秒后自动失效，新的合法 chat 不受影响
// ============================================================================
const TOMBSTONE_TTL_MS = 5_000
const sessionTombstones = new Map<string, number>()

function tombstoneKey(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`
}

function setTombstone(tenantId: string, sessionId: string, ttlMs: number = TOMBSTONE_TTL_MS): void {
  sessionTombstones.set(tombstoneKey(tenantId, sessionId), Date.now() + ttlMs)
  // 顺手清理过期墓碑，避免 Map 无限增长
  const now = Date.now()
  for (const [k, expireAt] of sessionTombstones) {
    if (expireAt <= now) sessionTombstones.delete(k)
  }
}

function isTombstoned(tenantId: string, sessionId: string): boolean {
  const key = tombstoneKey(tenantId, sessionId)
  const expireAt = sessionTombstones.get(key)
  if (!expireAt) return false
  if (expireAt <= Date.now()) {
    sessionTombstones.delete(key)
    return false
  }
  return true
}

export class SQLiteConversationHistory implements ConversationHistory {
  private readonly maxTokens: number

  /**
   * @param maxTokens 显式传入时原样使用（单元测试固定 cap 的场景）；
   *                  不传时每次实例化都动态读取 env + 应用 Superpower 倍率，
   *                  确保 PUT /settings 热更新能立即生效。
   */
  constructor(maxTokens?: number) {
    this.maxTokens = maxTokens ?? getDefaultHistoryMaxTokens()
  }

  async append(message: Message & { conversationId?: string }, ctx: Ctx): Promise<string> {
    // 墓碑期内丢弃写入：防止已被 DELETE 的会话被尚未终止的流式回写"复活"
    if (isTombstoned(ctx.tenantId, ctx.sessionId)) {
      return message.id ?? uuidv4()
    }
    const db = getDb()
    await ensureUsageArchive(db)
    const messageId = message.id ?? uuidv4()
    await db.execute({
      sql: `INSERT INTO conversations
              (tenant_id, session_id, conversation_id, message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, model_id, metadata)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?)
              AND NOT EXISTS (SELECT 1 FROM conversation_usage_archive WHERE tenant_id=? AND session_id=? AND message_id=?)`,
      args: [
        ctx.tenantId,
        ctx.sessionId,
        (message as { conversationId?: string }).conversationId ?? null,
        messageId,
        message.role,
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        message.reasoningContent ?? null,
        message.toolCallId ?? message.toolCall?.id ?? null,
        message.toolCall?.name ?? null,
        message.toolName ?? null,
        message.toolCall ? JSON.stringify(message.toolCall.args) : null,
        message.tokens ?? 0,
        message.usage ? JSON.stringify(message.usage) : null,
        message.modelId ?? null,
        serializeMessageMetadata(message),
        ctx.tenantId, ctx.sessionId, messageId,
        ctx.tenantId, ctx.sessionId, messageId,
      ],
    })
    return messageId
  }

  async getHistory(ctx: Ctx & { inheritContext?: boolean }): Promise<Message[]> {
    const cleanMessages = await this.getRawMessages(ctx)
    
    // If inheritContext is false, only return the most recent user message (current new message)
    // This ensures the AI doesn't see previous conversation history
    if (ctx.inheritContext === false) {
      // Find the last user message (the current new message)
      for (let i = cleanMessages.length - 1; i >= 0; i--) {
        if (cleanMessages[i].role === 'user') {
          return [cleanMessages[i]]
        }
      }
      return []
    }
    
    return this.applyTokenWindow(cleanMessages)
  }

  async getFullHistory(ctx: Ctx): Promise<Message[]> {
    return this.getRawMessages(ctx)
  }

  /**
   * SQLite compaction is a transactional rebuild, so rows summarized in a
   * previous compaction are no longer recoverable from this backend.  Expose
   * the current durable projection through the same archive contract so the
   * API remains backend-neutral; JSONL can additionally expand its retained
   * append-only transcript.
   */
  async getArchive(ctx: Ctx): Promise<ConversationArchive> {
    // getFullHistory is the compact model projection.  Restore any tool
    // output retained by micro-compaction only for this explicit user archive.
    const messages = (await this.getFullHistory(ctx)).map(restoreMicroCompactedTool)
    const summaryMessage = messages.find((message) => {
      const metadata = message.metadata as Record<string, unknown> | undefined
      return message.role === 'system' && metadata?.isCompactSummary === true
    })
    return {
      messages,
      compressed: Boolean(summaryMessage),
      ...(summaryMessage && typeof summaryMessage.content === 'string'
        ? { summary: { content: summaryMessage.content } }
        : {}),
      currentMessageCount: messages.length,
      backend: 'sqlite',
    }
  }

  private async getRawMessages(ctx: Ctx): Promise<Message[]> {
    const db = getDb()
    await ensureUsageArchive(db)
    const result = await db.execute({
      sql: `SELECT id, message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, created_at, conversation_id, model_id, metadata
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const allRows = result.rows
    const allMessages = allRows.map(rowToMessage)

    // 清理孤立的模型消息，但读取历史不能丢失已产生的调用用量。
    // ⚠️ 注意：绝不能在“找不到 user 消息”时删除整个会话！
    //    压缩（compress）后会话可能只剩 system 摘要 + assistant 反馈，此时没有 user 行；
    //    若在此执行 DELETE 会把整个会话历史永久清空（历史数据丢失事故的根因）。
    //    因此仅当存在 user 消息时，清理 user 之前的孤立 non-user 行；否则保留原样返回。
    const firstUserIdx = allRows.findIndex((r) => r['role'] === 'user')
    if (firstUserIdx === -1) {
      return allMessages
    }
    if (firstUserIdx > 0) {
      // 仅删除 assistant/tool 类型的前缀孤立行；system 摘要合法保留
      const orphanIds = allRows
        .slice(0, firstUserIdx)
        .filter((r) => r['role'] !== 'system')
        .map((r) => r['id'] as number)
      if (orphanIds.length > 0) {
        const firstUser = allRows[firstUserIdx]
        const prefix = `tenant_id=? AND session_id=? AND role<>'system'
          AND (created_at<? OR (created_at=? AND id<?))`
        const args = [ctx.tenantId, ctx.sessionId, firstUser.created_at, firstUser.created_at, firstUser.id]
        // Preserve billing and remove its model row in one transaction; lazy
        // JSONL migration can subsequently carry the hidden usage receipt.
        await db.batch([{
          sql: `INSERT INTO conversation_usage_archive
            (tenant_id, session_id, message_id, conversation_id, row_id, token_usage)
            SELECT tenant_id, session_id, message_id, conversation_id, id, token_usage FROM conversations
            WHERE ${prefix} AND token_usage IS NOT NULL
            ON CONFLICT(tenant_id, session_id, message_id) DO UPDATE SET
              conversation_id=excluded.conversation_id, row_id=excluded.row_id, token_usage=excluded.token_usage`,
          args,
        }, { sql: `DELETE FROM conversations WHERE ${prefix}`, args }], 'write')
      }
    }
    // 过滤掉 firstUserIdx 之前的 assistant/tool 孤立行，保留 system 前缀
    if (firstUserIdx > 0) {
      const systemPrefix = allMessages.slice(0, firstUserIdx).filter((m) => m.role === 'system')
      return [...systemPrefix, ...allMessages.slice(firstUserIdx)]
    }
    return allMessages
  }

  /** 按 conversationId 查询单轮对话的所有消息 */
  async getByConversationId(conversationId: string, tenantId: string): Promise<(Message & { conversationId?: string })[]> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, created_at, conversation_id, metadata
            FROM conversations
            WHERE conversation_id = ? AND tenant_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [conversationId, tenantId],
    })
    return result.rows.map(rowToMessage)
  }

  /** 获取单条消息 */
  async getMessageById(messageId: string, tenantId: string): Promise<(Message & { conversationId?: string; dbId: number }) | null> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT id, message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, created_at, conversation_id, metadata
            FROM conversations
            WHERE message_id = ? AND tenant_id = ?`,
      args: [messageId, tenantId],
    })
    if (result.rows.length === 0) return null
    const row = result.rows[0]
    return { ...rowToMessage(row), dbId: Number(row['id']) }
  }

  /** 硬删除指定消息 */
  async deleteMessage(messageId: string, tenantId: string): Promise<void> {
    const db = getDb()
    await ensureUsageArchive(db)
    await db.batch([{
      sql: `DELETE FROM conversations WHERE message_id = ? AND tenant_id = ?`,
      args: [messageId, tenantId],
    }, { sql: 'DELETE FROM conversation_usage_archive WHERE message_id=? AND tenant_id=?', args: [messageId, tenantId] }], 'write')
  }

  /** 更新消息内容（用于编辑功能） */
  async updateMessageContent(messageId: string, tenantId: string, content: string | any[], tokens: number, metadata?: any): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: `UPDATE conversations SET content = ?, tokens = ?, metadata = ? WHERE message_id = ? AND tenant_id = ?`,
      args: [
        typeof content === 'string' ? content : JSON.stringify(content), 
        tokens, 
        serializeMessageMetadata({ metadata }),
        messageId, 
        tenantId
      ],
    })
  }

  /** 硬删除指定ID之后的消息 */
  async deleteMessagesAfterId(id: number, sessionId: string, tenantId: string): Promise<void> {
    const db = getDb()
    await ensureUsageArchive(db)
    await db.batch([{
      sql: `DELETE FROM conversation_usage_archive WHERE tenant_id=? AND session_id=? AND
        (row_id>? OR message_id IN (SELECT message_id FROM conversations WHERE tenant_id=? AND session_id=? AND id>?))`,
      args: [tenantId, sessionId, id, tenantId, sessionId, id],
    }, {
      sql: `DELETE FROM conversations WHERE tenant_id = ? AND session_id = ? AND id > ?`,
      args: [tenantId, sessionId, id],
    }], 'write')
  }

  /** 硬删除一整轮对话（同一 conversation_id 的所有行） */
  async deleteByConversationId(conversationId: string, tenantId: string): Promise<number> {
    const db = getDb()
    await ensureUsageArchive(db)
    const before = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM conversations WHERE conversation_id = ? AND tenant_id = ?`,
      args: [conversationId, tenantId],
    })
    const count = Number(before.rows[0]?.['cnt'] ?? 0)
    await db.batch([{
      sql: `DELETE FROM conversations WHERE conversation_id = ? AND tenant_id = ?`,
      args: [conversationId, tenantId],
    }, { sql: 'DELETE FROM conversation_usage_archive WHERE conversation_id=? AND tenant_id=?', args: [conversationId, tenantId] }], 'write')
    return count
  }

  /**
   * 滑动窗口裁剪：当历史 tokens 超过 maxTokens 时，
   * 从最旧的消息开始丢弃（保留最近的对话上下文）。
   * system 消息（摘要）始终保留在开头。
   * 所有消息内容保持原文，不做截断（工具输出等大内容靠丢弃旧消息来控制总量）。
   */
  private applyTokenWindow(messages: Message[]): Message[] {
    // 1. 统计所有消息的 token 数
    const total = messages.reduce((sum, m) => sum + (m.tokens ?? estimateTokens(m.content)), 0)
    if (total <= this.maxTokens) return messages

    // 2. 分离开头的 system 消息（摘要），对剩余消息做滑动窗口
    let systemPrefix: Message[] = []
    let rest = messages
    if (messages.length > 0 && messages[0].role === 'system') {
      systemPrefix = [messages[0]]
      rest = messages.slice(1)
    }

    // 3. 从最旧的消息开始丢弃，直到 token 数满足限制（至少保留最后 2 条）
    let windowTokens = total - systemPrefix.reduce((s, m) => s + (m.tokens ?? estimateTokens(m.content)), 0)
    let startIdx = 0
    while (startIdx < rest.length - 2 && windowTokens > this.maxTokens) {
      windowTokens -= (rest[startIdx].tokens ?? estimateTokens(rest[startIdx].content))
      startIdx++
    }

    return [...systemPrefix, ...rest.slice(startIdx)]
  }

  /**
   * Returns the session-wide total usage (sum of all messages' token_usage JSON).
   * This is used by the frontend to show the "lifetime" consumption of the session,
   * even when some messages have been windowed out of the active context.
   */
  async getSessionUsage(ctx: Ctx, conversationId?: string): Promise<Record<string, number>> {
    const totals = await this.getUsageTotals(ctx, conversationId)
    return conversationId === undefined ? totals.sessionUsage : totals.turnUsage
  }

  /** Read session and turn counters from one SQL snapshot. */
  async getUsageTotals(ctx: Ctx, conversationId?: string): Promise<{ sessionUsage: Record<string, number>; turnUsage: Record<string, number> }> {
    const db = getDb()
    await ensureUsageArchive(db)
    const fields = BILLING_USAGE_KEYS.flatMap(key => [
      `COALESCE(SUM(CAST(${billingCounterSql(key)} AS INTEGER)), 0) AS ${key}`,
      `COALESCE(SUM(CASE WHEN same_turn=1 THEN CAST(${billingCounterSql(key)} AS INTEGER) ELSE 0 END), 0) AS turn_${key}`,
    ]).join(', ')
    const rs = await db.execute({
      sql: `SELECT ${fields} FROM (
        SELECT token_usage, CASE WHEN conversation_id=? THEN 1 ELSE 0 END AS same_turn FROM (
          SELECT token_usage, conversation_id FROM conversations WHERE tenant_id=? AND session_id=?
          UNION ALL
          SELECT a.token_usage, a.conversation_id FROM conversation_usage_archive a
          WHERE a.tenant_id=? AND a.session_id=? AND NOT EXISTS (
            SELECT 1 FROM conversations c WHERE c.tenant_id=a.tenant_id AND c.session_id=a.session_id AND c.message_id=a.message_id
          )
        )
      )`,
      args: [conversationId ?? null, ctx.tenantId, ctx.sessionId, ctx.tenantId, ctx.sessionId],
    })
    const row = rs.rows[0]
    return {
      sessionUsage: Object.fromEntries(BILLING_USAGE_KEYS.map(key => [key, Number(row?.[key] ?? 0)])),
      turnUsage: Object.fromEntries(BILLING_USAGE_KEYS.map(key => [key, Number(row?.[`turn_${key}`] ?? 0)])),
    }
  }

  /** Compact SQLite calls migrate as billing-only receipts, never model input. */
  async getArchivedUsage(ctx: Ctx): Promise<Array<{ messageId: string; conversationId?: string; usage: Record<string, number>; dbId: number }>> {
    const db = getDb()
    await ensureUsageArchive(db)
    const rows = await db.execute({ sql: `SELECT a.* FROM conversation_usage_archive a
      WHERE a.tenant_id=? AND a.session_id=? AND NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.tenant_id=a.tenant_id AND c.session_id=a.session_id AND c.message_id=a.message_id)
      ORDER BY a.row_id ASC`, args: [ctx.tenantId, ctx.sessionId] })
    return rows.rows.map(row => ({ messageId: String(row.message_id), dbId: Number(row.row_id),
      ...(row.conversation_id ? { conversationId: String(row.conversation_id) } : {}), usage: JSON.parse(String(row.token_usage)) }))
  }

  async clear(ctx: Ctx, options?: { tombstone?: boolean }): Promise<void> {
    const db = getDb()
    await ensureUsageArchive(db)
    // 默认设置墓碑：阻止后续 N 秒内的 append（防止正在跑的 SSE 流回写"复活"会话）。
    // 调用方若要在删除后立即重建历史（如 compress），应传 { tombstone: false }，
    // 否则紧随其后的 append 会被墓碑静默丢弃，导致重建内容丢失。
    if (options?.tombstone !== false) {
      setTombstone(ctx.tenantId, ctx.sessionId)
    }
    await db.batch([{
      sql: 'DELETE FROM conversations WHERE tenant_id = ? AND session_id = ?',
      args: [ctx.tenantId, ctx.sessionId],
    }, { sql: 'DELETE FROM conversation_usage_archive WHERE tenant_id=? AND session_id=?', args: [ctx.tenantId, ctx.sessionId] }], 'write')
  }

  /** 列出该租户下所有有历史消息的 session，按最新消息时间倒序 */
  async listSessions(tenantId: string): Promise<Array<{
    sessionId: string;
    lastMessage: string;
    lastAt: number;
    messageCount: number;
    /** 首条用户消息原文（可能含附件结构 JSON），前端做纯文本化 + 截断作为标题 */
    title?: string;
    /** 最后一条助手消息原文，前端提取纯文本作为副标题 */
    lastReply?: string;
    agentId?: string | null;
    metadata?: any;
    totalUsage?: Record<string, number>;
  }>> {
    const { getSubagentStore } = await import('../../core/subagent/store.js')
    const childSessions = new Set(await getSubagentStore().listChildSessionIds(tenantId))
    const db = getDb()
    await ensureUsageArchive(db)
    const billed = await db.execute({ sql: `SELECT session_id, ${BILLING_USAGE_KEYS.map(key =>
      `COALESCE(SUM(CAST(${billingCounterSql(key)} AS INTEGER)), 0) AS ${key}`).join(', ')}
      FROM (SELECT session_id, token_usage FROM conversations WHERE tenant_id=?
        UNION ALL SELECT a.session_id, a.token_usage FROM conversation_usage_archive a WHERE a.tenant_id=?
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.tenant_id=a.tenant_id AND c.session_id=a.session_id AND c.message_id=a.message_id))
      GROUP BY session_id`, args: [tenantId, tenantId] })
    const billingBySession = new Map(billed.rows.map(row => [String(row.session_id),
      Object.fromEntries(BILLING_USAGE_KEYS.map(key => [key, Number(row[key] ?? 0)]))]))
    const rs = await db.execute({
      sql: `SELECT c.session_id,
                   s.agent_id,
                   s.metadata,
                   COUNT(*) as cnt,
                   MAX(c.created_at) as last_at,
                   (SELECT content FROM conversations c2
                    WHERE c2.tenant_id = c.tenant_id AND c2.session_id = c.session_id
                      AND c2.role IN ('user','assistant')
                    ORDER BY c2.created_at DESC LIMIT 1) as last_msg,
                   (SELECT content FROM conversations c3
                    WHERE c3.tenant_id = c.tenant_id AND c3.session_id = c.session_id
                      AND c3.role = 'user'
                    ORDER BY c3.created_at ASC LIMIT 1) as first_user_msg,
                   (SELECT content FROM conversations c4
                    WHERE c4.tenant_id = c.tenant_id AND c4.session_id = c.session_id
                      AND c4.role = 'assistant'
                    ORDER BY c4.created_at DESC LIMIT 1) as last_assistant_msg
            FROM conversations c
            LEFT JOIN sessions s ON s.session_id = c.session_id AND s.tenant_id = c.tenant_id
            WHERE c.tenant_id = ? AND c.role IN ('user','assistant') AND c.session_id NOT LIKE 'subagent-%'
            GROUP BY c.session_id
            ORDER BY last_at DESC`,
      args: [tenantId],
    })
    return rs.rows.filter(row => !childSessions.has(String(row['session_id']))).map((row) => {
      let metadata = undefined
      if (row['metadata']) {
        try {
          metadata = JSON.parse(String(row['metadata']))
        } catch { /* ignore */ }
      }

      return {
        sessionId:    String(row['session_id']),
        agentId:      row['agent_id'] ? String(row['agent_id']) : null,
        metadata:     metadata,
        lastMessage:  String(row['last_msg'] ?? '').slice(0, 50),
        title:        row['first_user_msg'] ? String(row['first_user_msg']) : undefined,
        lastReply:    row['last_assistant_msg'] ? String(row['last_assistant_msg']) : undefined,
        lastAt:       Number(row['last_at']) * 1000,
        messageCount: Number(row['cnt']),
        totalUsage: billingBySession.get(String(row.session_id))
      }
    })
  }

  /**
   * Returns the windowed token count — i.e. the sum of tokens for the messages
   * that getHistory() would actually return after the sliding-window cap.
   * This is what the agent loop should use for budget checks.
   */
  async getTokenCount(ctx: Ctx): Promise<number> {
    const windowed = await this.getHistory(ctx)
    return windowed.reduce((sum, m) => sum + (m.tokens ?? estimateTokens(m.content)), 0)
  }

  /**
   * Returns the raw total token count across ALL stored messages before any
   * windowing is applied. Used to decide when to compress.
   */
  async getRawTokenCount(ctx: Ctx): Promise<number> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT COALESCE(SUM(tokens), 0) as total
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const row = result.rows[0]
    return row ? Number(row['total']) : 0
  }

  /**
   * Compress stored history by LLM-summarising older messages.
   *
   * 保留策略（对齐 Claude Code）：
   * - 数值参数 `keepRecent`（旧）：按条数保留最近 N 条原文
   * - `{ keepRecentTokens }`：按模型输入预算保留完整工具交换
   *
   * 重建包在事务里：clear + append 任一失败整体回滚，不留「历史已删摘要未写」的半重建状态。
   */
  async compress(
    ctx: Ctx,
    summarizeFn: (messages: Message[]) => Promise<string>,
    keepRecent: number | CompressionOptions = 6,
  ): Promise<{ preTokens: number; postTokens: number }> {
    const db = getDb()
    await ensureUsageArchive(db)
    const result = await db.execute({
      sql: `SELECT message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, created_at, conversation_id, model_id, metadata
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const allMessages = result.rows.map(rowToMessage)

    const tokensBefore = estimateModelHistoryTokens(allMessages)
    const splitIdx = compressionSplitIndex(allMessages, keepRecent)

    const olderMessages = allMessages.slice(0, splitIdx)
    const recentMessages = allMessages.slice(splitIdx)
    if (olderMessages.length === 0) return { preTokens: tokensBefore, postTokens: tokensBefore }

    const summaryContent = await summarizeFn(olderMessages)
    const summaryTokens = estimateTokens(summaryContent)

    // 事务化重建：clear + summary + recent，任一失败整体回滚。
    // ⚠️ 不经 this.clear()：它是独立连接的非事务删除，失败时已无法回滚。
    // Keep the summary before the retained rows while preserving their original timestamps.
    const summaryMsg: Message = { role: 'system', content: summaryContent, tokens: summaryTokens,
      metadata: { isCompactSummary: true },
      createdAt: olderMessages.at(-1)?.createdAt ?? Date.now() }
    const rebuilt: Message[] = [summaryMsg, ...recentMessages]
    const tx = await db.transaction('write')
    try {
      await tx.execute({ sql: `INSERT INTO conversation_usage_archive
        (tenant_id, session_id, message_id, conversation_id, row_id, token_usage)
        SELECT tenant_id, session_id, message_id, conversation_id, id, token_usage FROM conversations
        WHERE tenant_id=? AND session_id=? AND message_id IS NOT NULL AND token_usage IS NOT NULL
        ON CONFLICT(tenant_id, session_id, message_id) DO UPDATE SET
          conversation_id=excluded.conversation_id, row_id=excluded.row_id, token_usage=excluded.token_usage`,
        args: [ctx.tenantId, ctx.sessionId] })
      await tx.execute({
        sql: `DELETE FROM conversations WHERE tenant_id = ? AND session_id = ?`,
        args: [ctx.tenantId, ctx.sessionId],
      })
      for (const msg of rebuilt) {
        await tx.execute({
          sql: `INSERT INTO conversations
                (tenant_id, session_id, conversation_id, message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, model_id, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            ctx.tenantId,
            ctx.sessionId,
            (msg as { conversationId?: string }).conversationId ?? null,
            msg.id ?? uuidv4(),
            msg.role,
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            msg.reasoningContent ?? null,
            msg.toolCallId ?? msg.toolCall?.id ?? null,
            msg.toolCall?.name ?? null,
            msg.toolName ?? null,
            msg.toolCall ? JSON.stringify(msg.toolCall.args) : null,
            msg.tokens ?? 0,
            msg.usage ? JSON.stringify(msg.usage) : null,
            msg.modelId ?? null,
            serializeMessageMetadata(msg),
            (msg.createdAt ?? Date.now()) / 1000,
          ],
        })
      }
      await tx.commit()
    } catch (e) {
      await tx.rollback()
      throw e
    }

    const tokensAfter = estimateModelHistoryTokens(rebuilt)
    console.log(`[history] compress: ${tokensBefore} → ${tokensAfter} tokens (freed ${tokensBefore - tokensAfter})`)
    return { preTokens: tokensBefore, postTokens: tokensAfter }
  }

  /**
   * Micro-compact：把最近 keepRecent 条消息之前的 tool 结果替换为占位符。
   *
   * 长会话里历史工具结果（读文件/命令输出）是上下文大头，而这些结果对后续推理
   * 通常已无用。不调 LLM、不动对话结构，只改 content + tokens，全量压缩前先跑
   * 一次往往能省下大量空间（对齐 Claude Code 的 micro-compact 思路）。
   */
  async microCompactToolResults(
    ctx: Ctx,
    opts: { keepRecent?: number; maxChars?: number } = {},
  ): Promise<{ cleared: number; freedTokens: number }> {
    const keepRecent = opts.keepRecent ?? 10
    const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars ?? 0) > 0 ? Math.floor(opts.maxChars!) : undefined
    const placeholder = '[tool result cleared]'
    const placeholderTokens = estimateTokens(placeholder)
    const db = getDb()

    // 取该会话全部消息（按写入顺序），排除最近 keepRecent 条消息范围内的
    const all = await db.execute({
      sql: `SELECT id, role, content, tokens, metadata FROM conversations
            WHERE tenant_id = ? AND session_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const rows = all.rows
    // When the session is shorter than the retention window there is no
    // "old" row to compact.  Infinity used to make `id >= cutoffId` false
    // for every row, so even a short conversation lost all of its tool
    // evidence during the first micro-compact pass.
    const cutoffId = rows.length > keepRecent
      ? Number(rows[rows.length - keepRecent]['id'])
      : Number.NEGATIVE_INFINITY

    const tx = await db.transaction('write')
    let cleared = 0
    let freedTokens = 0
    try {
      for (const row of rows) {
        const id = Number(row['id'])
        if (row['role'] !== 'tool') continue
        const content = row['content'] as string | null
        if (!content || content === placeholder) continue
        if (id >= cutoffId && (maxChars === undefined || content.length <= maxChars)) continue
        const oldTokens = Number(row['tokens'] ?? 0) || estimateTokens(content)
        let metadata: Record<string, unknown>
        try {
          const parsed = row['metadata'] ? JSON.parse(String(row['metadata'])) : {}
          metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
        } catch {
          metadata = {}
        }
        // Cleared rows were skipped above. If the message was explicitly edited
        // since a prior pass, its current output supersedes the old archive.
        metadata[MICRO_COMPACT_ARCHIVE_KEY] = { content, tokens: oldTokens }
        metadata.outputPreview = content
        await tx.execute({
          sql: `UPDATE conversations SET content = ?, tokens = ?, metadata = ? WHERE id = ?`,
          args: [placeholder, placeholderTokens, JSON.stringify(metadata), id],
        })
        cleared++
        freedTokens += Math.max(0, oldTokens - placeholderTokens)
      }
      await tx.commit()
    } catch (e) {
      await tx.rollback()
      throw e
    }
    if (cleared > 0) {
      console.log(`[history] micro-compact: cleared ${cleared} tool results, freed ~${freedTokens} tokens`)
    }
    return { cleared, freedTokens }
  }

  async summarize(ctx: AgentContext): Promise<void> {
    const allMessages = await this.getHistory(ctx)

    if (allMessages.length <= 4) return // Nothing to summarize

    const toSummarize = allMessages.slice(0, -4)

    // Build a simple extractive summary without requiring an LLM instance.
    // Callers that want a proper LLM-based summary should override this method.
    const summaryContent = `[Previous conversation summary: ${toSummarize.length} messages exchanged covering: ${toSummarize.map((m) => m.content.slice(0, 50)).join('; ')}]`

    await this.compress(ctx, async () => summaryContent, 4)
  }
}

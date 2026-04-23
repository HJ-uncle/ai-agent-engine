import type { ConversationHistory, Message, AgentContext } from '../../core/agent-context/index.js'
import { getDb } from '../sqlite/db.js'
import type { Row } from '@libsql/client'
import { v4 as uuidv4 } from 'uuid'

type Ctx = { tenantId: string; sessionId: string }

function rowToMessage(row: Row): Message & { conversationId?: string } {
  const role = row['role'] as string
  const content = row['content'] as string
  const tool_call_id = row['tool_call_id'] as string | null
  const tool_call_name = row['tool_call_name'] as string | null  // assistant 发起调用的工具名
  const tool_name = row['tool_name'] as string | null            // tool 结果消息的工具名（显示用）
  const tool_args = row['tool_args'] as string | null
  const tokens = row['tokens']
  const created_at = row['created_at']
  const conversation_id = row['conversation_id'] as string | null
  const message_id = row['message_id'] as string | null

  const msg: Message & { conversationId?: string } = {
    ...(message_id ? { id: message_id } : {}),
    role: role as Message['role'],
    content,
    tokens: tokens != null ? Number(tokens) : 0,
    createdAt: created_at != null ? Number(created_at) * 1000 : 0,
    ...(conversation_id ? { conversationId: conversation_id } : {}),
  }
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

// 默认历史窗口：保留最多 40000 tokens（约 3 万字），超出时裁剪最旧的普通消息
const DEFAULT_HISTORY_MAX_TOKENS = parseInt(process.env.HISTORY_MAX_TOKENS ?? '40000', 10)

export class SQLiteConversationHistory implements ConversationHistory {
  constructor(private readonly maxTokens: number = DEFAULT_HISTORY_MAX_TOKENS) {}

  async append(message: Message & { conversationId?: string }, ctx: Ctx): Promise<void> {
    const db = getDb()
    const messageId = message.id ?? uuidv4()
    await db.execute({
      sql: `INSERT INTO conversations
              (tenant_id, session_id, conversation_id, message_id, role, content, tool_call_id, tool_call_name, tool_name, tool_args, tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ctx.tenantId,
        ctx.sessionId,
        (message as { conversationId?: string }).conversationId ?? null,
        messageId,
        message.role,
        message.content,
        message.toolCallId ?? null,
        message.toolCall?.name ?? null,
        message.toolName ?? null,
        message.toolCall ? JSON.stringify(message.toolCall.args) : null,
        message.tokens ?? 0,
      ],
    })
  }

  async getHistory(ctx: Ctx): Promise<Message[]> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT message_id, role, content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, created_at, conversation_id
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const allMessages = result.rows.map(rowToMessage)
    return this.applyTokenWindow(allMessages)
  }

  /** 按 conversationId 查询单轮对话的所有消息 */
  async getByConversationId(conversationId: string, tenantId: string): Promise<(Message & { conversationId?: string })[]> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT message_id, role, content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, created_at, conversation_id
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
      sql: `SELECT id, message_id, role, content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, created_at, conversation_id
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
    await db.execute({
      sql: `DELETE FROM conversations WHERE message_id = ? AND tenant_id = ?`,
      args: [messageId, tenantId],
    })
  }

  /** 更新消息内容和 token */
  async updateMessageContent(messageId: string, tenantId: string, content: string, tokens: number): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: `UPDATE conversations SET content = ?, tokens = ? WHERE message_id = ? AND tenant_id = ?`,
      args: [content, tokens, messageId, tenantId],
    })
  }

  /** 硬删除指定ID之后的消息 */
  async deleteMessagesAfterId(id: number, sessionId: string, tenantId: string): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: `DELETE FROM conversations WHERE tenant_id = ? AND session_id = ? AND id > ?`,
      args: [tenantId, sessionId, id],
    })
  }

  /**
   * 滑动窗口裁剪：当历史 tokens 超过 maxTokens 时，
   * 从最旧的消息开始丢弃（保留最近的对话上下文）。
   * system 消息（摘要）始终保留在开头。
   */
  private applyTokenWindow(messages: Message[]): Message[] {
    // 统计所有消息的 token 数
    const estimateTokens = (m: Message) => m.tokens ?? Math.ceil(m.content.length / 4)
    const total = messages.reduce((sum, m) => sum + estimateTokens(m), 0)
    if (total <= this.maxTokens) return messages

    // 分离开头的 system 消息（摘要），对剩余消息做截断
    let systemPrefix: Message[] = []
    let rest = messages
    if (messages.length > 0 && messages[0].role === 'system') {
      systemPrefix = [messages[0]]
      rest = messages.slice(1)
    }

    // 从最旧的消息开始丢弃，直到 token 数满足限制
    let windowTokens = total - systemPrefix.reduce((s, m) => s + estimateTokens(m), 0)
    let startIdx = 0
    while (startIdx < rest.length - 2 && windowTokens > this.maxTokens) {
      windowTokens -= estimateTokens(rest[startIdx])
      startIdx++
    }

    return [...systemPrefix, ...rest.slice(startIdx)]
  }

  async clear(ctx: Ctx): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: 'DELETE FROM conversations WHERE tenant_id = ? AND session_id = ?',
      args: [ctx.tenantId, ctx.sessionId],
    })
  }

  /** 列出该租户下所有有历史消息的 session，按最新消息时间倒序 */
  async listSessions(tenantId: string): Promise<Array<{ sessionId: string; lastMessage: string; lastAt: number; messageCount: number }>> {
    const db = getDb()
    const rs = await db.execute({
      sql: `SELECT session_id,
                   COUNT(*) as cnt,
                   MAX(created_at) as last_at,
                   (SELECT content FROM conversations c2
                    WHERE c2.tenant_id = c.tenant_id AND c2.session_id = c.session_id
                      AND c2.role IN ('user','assistant')
                    ORDER BY c2.created_at DESC LIMIT 1) as last_msg
            FROM conversations c
            WHERE tenant_id = ? AND role IN ('user','assistant')
            GROUP BY session_id
            ORDER BY last_at DESC
            LIMIT 100`,
      args: [tenantId],
    })
    return rs.rows.map((row) => ({
      sessionId:    String(row['session_id']),
      lastMessage:  String(row['last_msg'] ?? '').slice(0, 50),
      lastAt:       Number(row['last_at']) * 1000,
      messageCount: Number(row['cnt']),
    }))
  }

  /**
   * Returns the windowed token count — i.e. the sum of tokens for the messages
   * that getHistory() would actually return after the sliding-window cap.
   * This is what the agent loop should use for budget checks.
   */
  async getTokenCount(ctx: Ctx): Promise<number> {
    const windowed = await this.getHistory(ctx)
    const estimateTokens = (m: Message) => m.tokens ?? Math.ceil(m.content.length / 4)
    return windowed.reduce((sum, m) => sum + estimateTokens(m), 0)
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
   * Compress stored history by LLM-summarising older messages and keeping only
   * the `keepRecent` most-recent messages verbatim.
   * Skips compression when there are not enough messages to bother (≤ keepRecent).
   */
  async compress(
    ctx: Ctx,
    summarizeFn: (messages: Message[]) => Promise<string>,
    keepRecent = 6,
  ): Promise<void> {
    const db = getDb()
    // Fetch ALL raw messages (no window)
    const result = await db.execute({
      sql: `SELECT message_id, role, content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, created_at
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const allMessages = result.rows.map(rowToMessage)

    if (allMessages.length <= keepRecent) return // nothing meaningful to compress

    const olderMessages = allMessages.slice(0, allMessages.length - keepRecent)
    const recentMessages = allMessages.slice(allMessages.length - keepRecent)

    const estimateTokens = (m: Message) => m.tokens ?? Math.ceil(m.content.length / 4)
    const tokensBefore = allMessages.reduce((s, m) => s + estimateTokens(m), 0)

    // Build summary via the provided LLM function
    const summaryContent = await summarizeFn(olderMessages)
    const summaryTokens = Math.ceil(summaryContent.length / 4)

    // Replace DB contents: clear → summary system msg → recent msgs
    await this.clear(ctx)

    await this.append(
      { role: 'system', content: summaryContent, tokens: summaryTokens },
      ctx,
    )

    for (const msg of recentMessages) {
      await this.append(msg, ctx)
    }

    const tokensAfter = summaryTokens + recentMessages.reduce((s, m) => s + estimateTokens(m), 0)
    const freed = tokensBefore - tokensAfter
    // Caller (react.ts) owns the logger; log a simple console message here.
    console.log(`[history] compress: ${tokensBefore} → ${tokensAfter} tokens (freed ${freed})`)
  }

  async summarize(ctx: AgentContext): Promise<void> {
    const allMessages = await this.getHistory(ctx)

    if (allMessages.length <= 4) return // Nothing to summarize

    const toSummarize = allMessages.slice(0, -4)
    const toKeep = allMessages.slice(-4)

    // Build a simple extractive summary without requiring an LLM instance.
    // Callers that want a proper LLM-based summary should override this method.
    const summaryContent = `[Previous conversation summary: ${toSummarize.length} messages exchanged covering: ${toSummarize.map((m) => m.content.slice(0, 50)).join('; ')}]`

    await this.clear(ctx)

    await this.append({
      role: 'system',
      content: summaryContent,
      tokens: Math.ceil(summaryContent.length / 4),
    }, ctx)

    for (const msg of toKeep) {
      await this.append(msg, ctx)
    }
  }
}

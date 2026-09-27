import type { ConversationHistory, Message, AgentContext } from '../../core/agent-context/index.js'
import { getDb } from '../sqlite/db.js'
import type { Row } from '@libsql/client'
import { v4 as uuidv4 } from 'uuid'
import { estimateTokens } from '../../core/utils/tokens.js'
import { applyOSMMultiplier } from '../../core/osm.js'

type Ctx = { tenantId: string; sessionId: string }

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
    const messageId = message.id ?? uuidv4()
    await db.execute({
      sql: `INSERT INTO conversations
              (tenant_id, session_id, conversation_id, message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, model_id, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ctx.tenantId,
        ctx.sessionId,
        (message as { conversationId?: string }).conversationId ?? null,
        messageId,
        message.role,
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        message.reasoningContent ?? null,
        message.toolCallId ?? null,
        message.toolCall?.name ?? null,
        message.toolName ?? null,
        message.toolCall ? JSON.stringify(message.toolCall.args) : null,
        message.tokens ?? 0,
        message.usage ? JSON.stringify(message.usage) : null,
        message.modelId ?? null,
        message.metadata ? JSON.stringify(message.metadata) : null,
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

  private async getRawMessages(ctx: Ctx): Promise<Message[]> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT id, message_id, role, content, reasoning_content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, created_at, conversation_id, model_id, metadata
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const allRows = result.rows
    const allMessages = allRows.map(rowToMessage)

    // ── 清理孤立数据：找第一条 user 消息，其之前的所有 non-user 行直接删除 ────
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
        Promise.all(
          orphanIds.map((id) =>
            db.execute({
              sql: `DELETE FROM conversations WHERE id = ? AND tenant_id = ?`,
              args: [id, ctx.tenantId],
            }).catch(() => {})
          )
        ).catch(() => {})
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
    await db.execute({
      sql: `DELETE FROM conversations WHERE message_id = ? AND tenant_id = ?`,
      args: [messageId, tenantId],
    })
  }

  /** 更新消息内容（用于编辑功能） */
  async updateMessageContent(messageId: string, tenantId: string, content: string | any[], tokens: number, metadata?: any): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: `UPDATE conversations SET content = ?, tokens = ?, metadata = ? WHERE message_id = ? AND tenant_id = ?`,
      args: [
        typeof content === 'string' ? content : JSON.stringify(content), 
        tokens, 
        metadata ? JSON.stringify(metadata) : null,
        messageId, 
        tenantId
      ],
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
  async getSessionUsage(ctx: Ctx): Promise<Record<string, number>> {
    const db = getDb()
    const rs = await db.execute({
      sql: `SELECT SUM(CAST(json_extract(token_usage, '$.systemPromptTokens') AS INTEGER)) as system_prompt_tokens,
                   SUM(CAST(json_extract(token_usage, '$.systemToolsTokens') AS INTEGER)) as system_tools_tokens,
                   SUM(CAST(json_extract(token_usage, '$.messagesTokens') AS INTEGER)) as messages_tokens,
                   SUM(CAST(json_extract(token_usage, '$.skillTokens') AS INTEGER)) as skill_tokens,
                   SUM(CAST(json_extract(token_usage, '$.promptTokens') AS INTEGER)) as prompt_tokens,
                   SUM(CAST(json_extract(token_usage, '$.completionTokens') AS INTEGER)) as completion_tokens,
                   SUM(CAST(json_extract(token_usage, '$.totalTokens') AS INTEGER)) as total_tokens,
                   SUM(CAST(json_extract(token_usage, '$.ragTokens') AS INTEGER)) as rag_tokens,
                   SUM(CAST(json_extract(token_usage, '$.builtinToolsTokens') AS INTEGER)) as builtin_tools_tokens,
                   SUM(CAST(json_extract(token_usage, '$.mcpToolsTokens') AS INTEGER)) as mcp_tools_tokens,
                   SUM(CAST(json_extract(token_usage, '$.toolResultsTokens') AS INTEGER)) as tool_results_tokens,
                   SUM(CAST(json_extract(token_usage, '$.userInputTokens') AS INTEGER)) as user_input_tokens,
                   SUM(CAST(json_extract(token_usage, '$.cacheHitTokens') AS INTEGER)) as cache_hit_tokens,
                   SUM(CAST(json_extract(token_usage, '$.cacheMissTokens') AS INTEGER)) as cache_miss_tokens,
                   SUM(CAST(json_extract(token_usage, '$.reasoningTokens') AS INTEGER)) as reasoning_tokens
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const row = rs.rows[0]
    return {
      systemPromptTokens: Number(row['system_prompt_tokens'] ?? 0),
      systemToolsTokens: Number(row['system_tools_tokens'] ?? 0),
      messagesTokens: Number(row['messages_tokens'] ?? 0),
      skillTokens: Number(row['skill_tokens'] ?? 0),
      promptTokens: Number(row['prompt_tokens'] ?? 0),
      completionTokens: Number(row['completion_tokens'] ?? 0),
      totalTokens: Number(row['total_tokens'] ?? 0),
      ragTokens: Number(row['rag_tokens'] ?? 0),
      builtinToolsTokens: Number(row['builtin_tools_tokens'] ?? 0),
      mcpToolsTokens: Number(row['mcp_tools_tokens'] ?? 0),
      toolResultsTokens: Number(row['tool_results_tokens'] ?? 0),
      userInputTokens: Number(row['user_input_tokens'] ?? 0),
      cacheHitTokens: Number(row['cache_hit_tokens'] ?? 0),
      cacheMissTokens: Number(row['cache_miss_tokens'] ?? 0),
      reasoningTokens: Number(row['reasoning_tokens'] ?? 0),
    }
  }

  async clear(ctx: Ctx, options?: { tombstone?: boolean }): Promise<void> {
    const db = getDb()
    // 默认设置墓碑：阻止后续 N 秒内的 append（防止正在跑的 SSE 流回写"复活"会话）。
    // 调用方若要在删除后立即重建历史（如 compress），应传 { tombstone: false }，
    // 否则紧随其后的 append 会被墓碑静默丢弃，导致重建内容丢失。
    if (options?.tombstone !== false) {
      setTombstone(ctx.tenantId, ctx.sessionId)
    }
    await db.execute({
      sql: 'DELETE FROM conversations WHERE tenant_id = ? AND session_id = ?',
      args: [ctx.tenantId, ctx.sessionId],
    })
  }

  /** 列出该租户下所有有历史消息的 session，按最新消息时间倒序 */
  async listSessions(tenantId: string): Promise<Array<{ 
    sessionId: string; 
    lastMessage: string; 
    lastAt: number; 
    messageCount: number;
    agentId?: string | null;
    metadata?: any;
    totalUsage?: Record<string, number>;
  }>> {
    const db = getDb()
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
                   SUM(CAST(json_extract(token_usage, '$.systemPromptTokens') AS INTEGER)) as system_prompt_tokens,
                   SUM(CAST(json_extract(token_usage, '$.systemToolsTokens') AS INTEGER)) as system_tools_tokens,
                   SUM(CAST(json_extract(token_usage, '$.messagesTokens') AS INTEGER)) as messages_tokens,
                   SUM(CAST(json_extract(token_usage, '$.skillTokens') AS INTEGER)) as skill_tokens,
                   SUM(CAST(json_extract(token_usage, '$.promptTokens') AS INTEGER)) as prompt_tokens,
                   SUM(CAST(json_extract(token_usage, '$.completionTokens') AS INTEGER)) as completion_tokens,
                   SUM(CAST(json_extract(token_usage, '$.totalTokens') AS INTEGER)) as total_tokens,
                   SUM(CAST(json_extract(token_usage, '$.ragTokens') AS INTEGER)) as rag_tokens,
                   SUM(CAST(json_extract(token_usage, '$.builtinToolsTokens') AS INTEGER)) as builtin_tools_tokens,
                   SUM(CAST(json_extract(token_usage, '$.mcpToolsTokens') AS INTEGER)) as mcp_tools_tokens,
                   SUM(CAST(json_extract(token_usage, '$.toolResultsTokens') AS INTEGER)) as tool_results_tokens,
                   SUM(CAST(json_extract(token_usage, '$.userInputTokens') AS INTEGER)) as user_input_tokens,
                   SUM(CAST(json_extract(token_usage, '$.cacheHitTokens') AS INTEGER)) as cache_hit_tokens,
                   SUM(CAST(json_extract(token_usage, '$.cacheMissTokens') AS INTEGER)) as cache_miss_tokens,
                   SUM(CAST(json_extract(token_usage, '$.reasoningTokens') AS INTEGER)) as reasoning_tokens
            FROM conversations c
            LEFT JOIN sessions s ON s.session_id = c.session_id AND s.tenant_id = c.tenant_id
            WHERE c.tenant_id = ? AND c.role IN ('user','assistant')
            GROUP BY c.session_id
            ORDER BY last_at DESC`,
      args: [tenantId],
    })
    return rs.rows.map((row) => {
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
        lastAt:       Number(row['last_at']) * 1000,
        messageCount: Number(row['cnt']),
        totalUsage: {
          systemPromptTokens: Number(row['system_prompt_tokens'] ?? 0),
          systemToolsTokens: Number(row['system_tools_tokens'] ?? 0),
          messagesTokens: Number(row['messages_tokens'] ?? 0),
          skillTokens: Number(row['skill_tokens'] ?? 0),
          promptTokens: Number(row['prompt_tokens'] ?? 0),
          completionTokens: Number(row['completion_tokens'] ?? 0),
          totalTokens: Number(row['total_tokens'] ?? 0),
          ragTokens: Number(row['rag_tokens'] ?? 0),
          builtinToolsTokens: Number(row['builtin_tools_tokens'] ?? 0),
          mcpToolsTokens: Number(row['mcp_tools_tokens'] ?? 0),
          toolResultsTokens: Number(row['tool_results_tokens'] ?? 0),
          userInputTokens: Number(row['user_input_tokens'] ?? 0),
          cacheHitTokens: Number(row['cache_hit_tokens'] ?? 0),
          cacheMissTokens: Number(row['cache_miss_tokens'] ?? 0),
          reasoningTokens: Number(row['reasoning_tokens'] ?? 0),
        }
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
      sql: `SELECT message_id, role, content, tool_call_id, tool_call_name, tool_name, tool_args, tokens, token_usage, created_at
            FROM conversations
            WHERE tenant_id = ? AND session_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [ctx.tenantId, ctx.sessionId],
    })
    const allMessages = result.rows.map(rowToMessage)

    if (allMessages.length <= keepRecent) return // nothing meaningful to compress

    const olderMessages = allMessages.slice(0, allMessages.length - keepRecent)
    const recentMessages = allMessages.slice(allMessages.length - keepRecent)

    const tokensBefore = allMessages.reduce((s, m) => s + (m.tokens ?? estimateTokens(m.content)), 0)

    // Build summary via the provided LLM function
    const summaryContent = await summarizeFn(olderMessages)
    const summaryTokens = estimateTokens(summaryContent)

    // Replace DB contents: clear → summary system msg → recent msgs
    // ⚠️ tombstone: false —— 此处是"主动重建"，不是"删除后防复活"。
    //    若使用默认墓碑，紧随其后的 append 会在墓碑期内被静默丢弃，
    //    导致压缩后 session 历史被清空（user/system 全丢，历史丢失事故的根因）。
    await this.clear(ctx, { tombstone: false })

    await this.append(
      { role: 'system', content: summaryContent, tokens: summaryTokens },
      ctx,
    )

    for (const msg of recentMessages) {
      await this.append(msg, ctx)
    }

    const tokensAfter = summaryTokens + recentMessages.reduce((s, m) => s + (m.tokens ?? estimateTokens(m.content)), 0)
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

    // 同 compress：主动重建历史，不使用墓碑（否则紧随的 append 会被静默丢弃）
    await this.clear(ctx, { tombstone: false })

    await this.append({
      role: 'system',
      content: summaryContent,
      tokens: estimateTokens(summaryContent),
    }, ctx)

    for (const msg of toKeep) {
      await this.append(msg, ctx)
    }
  }
}

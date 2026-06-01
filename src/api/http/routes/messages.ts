import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { ReActStrategy } from '../../../core/agent-loop/index.js'
import { createPipeline, sseStream } from '../../../core/stream-pipeline/index.js'
import { createAgentContext } from '../../../core/agent-context/index.js'
import { createLLMAdapterWithDbConfig } from '../../../core/llm-adapter/index.js'
import { createRequestLogger } from '../../../observability/index.js'
import { buildSkillsSystemPrompt } from '../../../skills/index.js'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { resolveOSMMode } from '../../../core/osm.js'
import { prependBootstrapToSystemPrompt } from '../../../core/osm-bootstrap.js'
import { estimateTokens } from '../../../core/utils/tokens.js'
import { v4 as uuidv4 } from 'uuid'
import { success, fail } from '../response.js'
import { registerActiveChat, unregisterActiveChat } from './chat.js'
import { z } from 'zod'

// ── Validation Schemas ──────────────────────────────────────────────────────
const UpdateMessageSchema = z.object({
  content: z.string().min(1, '内容不能为空'),
  systemPrompt: z.string().optional(),
  maxAskUserCount: z.number().optional(),
  thinkingMode: z.boolean().optional(),
  metadata: z.any().optional(),
})

const RegenerateSchema = z.object({
  systemPrompt: z.string().optional(),
  maxAskUserCount: z.number().optional(),
  thinkingMode: z.boolean().optional(),
  metadata: z.any().optional(),
})

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

import { StreamBus, activeStreams, busToIterable } from '../../../core/stream-pipeline/stream-bus.js'

export async function messagesRoutes(fastify: FastifyInstance) {
  const history = new SQLiteConversationHistory()

  // 1. 查询消息的 token 消耗量
  fastify.get<{ Params: { messageId: string } }>('/messages/:messageId/tokens', async (request, reply) => {
    const { messageId } = request.params
    const tenantId = getTenantId(request)

    const message = await history.getMessageById(messageId, tenantId)

    if (!message) {
      return reply.code(200).send(fail(40400, 'Message not found'))
    }

    return reply.code(200).send(success({ messageId, tokens: message.tokens }))
  })

  // 查询会话的 token 总和
  fastify.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/tokens', async (request, reply) => {
    const { sessionId } = request.params
    const tenantId = getTenantId(request)

    const totalTokens = await history.getRawTokenCount({ tenantId, sessionId })
    return reply.code(200).send(success({ sessionId, totalTokens }))
  })

  // 2. 硬删除消息（幂等：找不到也返回 success，避免前端 store 与 DB 双向卡死）
  //    删除策略（按优先级）：
  //    a. 先按 message_id 找到消息 → 若有 conversation_id 删整轮，否则删单条
  //    b. 若 message_id 未命中，尝试把参数当 conversation_id 删整轮（幽灵块兜底）
  //    c. 以上均未命中 → 视为已删，幂等返回 success
  fastify.delete<{ Params: { messageId: string } }>('/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params
    const tenantId = getTenantId(request)
    const db = (await import('../../../storage/sqlite/db.js')).getDb()

    const message = await history.getMessageById(messageId, tenantId)

    if (message) {
      // ── a. 按 message_id 找到了 ──────────────────────────────────────
      const sessionResult = await db.execute({
        sql: 'SELECT session_id FROM conversations WHERE message_id = ? AND tenant_id = ?',
        args: [messageId, tenantId],
      })
      const sessionId = sessionResult.rows[0]?.session_id as string | undefined
      const convId = (message as any).conversationId as string | undefined

      if (convId && sessionId) {
        // 删整轮非 user 行（tool_call 中间行 + tool 结果行 + 最终 assistant 行）
        await db.execute({
          sql: `DELETE FROM conversations
                WHERE tenant_id = ? AND session_id = ? AND conversation_id = ? AND role != 'user'`,
          args: [tenantId, sessionId, convId],
        })
        // user 消息本身无论如何也要删掉（这是调用方明确要删的那条）
        await history.deleteMessage(messageId, tenantId)
      } else {
        await history.deleteMessage(messageId, tenantId)
      }
      return reply.code(200).send(success({ success: true, messageId }))
    }

    // ── b. 尝试当作 conversation_id 删整轮（前端幽灵块只有 conversationId）
    const byConv = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM conversations WHERE conversation_id = ? AND tenant_id = ?`,
      args: [messageId, tenantId],
    })
    console.log(`[DELETE /messages/${messageId}] branch-b count=${byConv.rows[0]?.c}`)
    if (Number(byConv.rows[0]?.c ?? 0) > 0) {
      await db.execute({
        sql: `DELETE FROM conversations WHERE conversation_id = ? AND tenant_id = ?`,
        args: [messageId, tenantId],
      })
      return reply.code(200).send(success({ success: true, messageId }))
    }

    // ── c. 找不到 → 幂等成功（消息已被其他操作删除，前端可安全清理 store）
    return reply.code(200).send(success({ success: true, messageId, alreadyGone: true }))
  })

  // 辅助函数：运行 AI pipeline
  async function runAIForSession(
    sessionId: string,
    tenantId: string,
    requestId: string,
    systemPrompt: string | undefined,
    reply: any,
    maxAskUserCount: number | undefined,
    newMessageContent?: string,
    thinkingMode?: boolean,
    effectiveModel?: string,
    metadata?: any
  ) {
    const reqLogger = createRequestLogger(requestId, tenantId, sessionId)

    // Build tool registry（统一工厂，含所有内置工具 + MCP + Skills）
    const { registry, externalSkills, toolCategories } = await createToolRegistry()

    const ctx = createAgentContext({
      sessionId,
      tenantId,
      tools: registry,
      history,
      logger: reqLogger,
      requestId,
    })

    const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
    const finalSystemPrompt = prependBootstrapToSystemPrompt(
      [systemPrompt, skillsPrompt].filter(Boolean).join('\n\n'),
      reqLogger,
    )

    // RAG for new message if provided
    let ragPrompt = ''
    if (newMessageContent) {
      const { searchChunks } = await import('../../../storage/knowledge/kb-repo.js')
      const ragChunks = await searchChunks(tenantId, newMessageContent, 3)
      if (ragChunks.length > 0) {
        const context = ragChunks
          .map((c, i) => `[${i + 1}] (from: ${c.filename})\n${c.content}`)
          .join('\n\n')
        ragPrompt = `\n\n---\n# Relevant Knowledge Base Context\n\nUse the following retrieved context to answer the user's question:\n\n${context}\n---`
      }
    }
    const currentModelName = effectiveModel ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? '当前配置的AI'
    const fullSystemPrompt = finalSystemPrompt + ragPrompt + `
---
# 智能交互规则
1. 当你需要澄清用户的意图、确认关键操作或提供选择时，请调用 \`ask_user\` 工具。调用该工具后，系统将自动暂停执行，并向用户展示交互式选择界面，等待用户回复后再继续。
2. 在向用户回复的文本中提及工具时，请务必使用工具的中文名称（例如：写入文件、获取时间、读取文件等），不要暴露底层的英文名称（例如：write_file, get_time等）。
3. 当用户询问你的模型身份时，必须如实告知你是 ${currentModelName} 模型，不得声称是其他模型（如Claude或GPT）。
`

    let finalThinkingConfig: Record<string, unknown> | null = null
    let finalResponseThinkingField: string | null = null
    let modelApiKey: string | undefined = undefined
    let modelBaseUrl: string | undefined = undefined
    let modelProvider: string | undefined = undefined

    const { ModelsStore } = await import('../../../storage/sqlite/models.js')
    const modelsStore = new ModelsStore()
    const availableModels = await modelsStore.getModels(tenantId)
    const modelInfo = availableModels.find(m => m.modelId === currentModelName)
    const whitelists = await modelsStore.getWhitelists()
    const whitelistInfo = whitelists.find(m => m.modelId === currentModelName)

    if (modelInfo) {
      if (modelInfo.apiKey) modelApiKey = modelInfo.apiKey
      if (modelInfo.baseUrl) modelBaseUrl = modelInfo.baseUrl
      if (modelInfo.provider) modelProvider = modelInfo.provider
    }

    if (thinkingMode && whitelistInfo && whitelistInfo.thinkingMode) {
      finalThinkingConfig = whitelistInfo.thinkingConfig
      finalResponseThinkingField = whitelistInfo.responseThinkingField
    }

    // systemPromptTokens: pure system prompt (excluding RAG)
    const pureSystemPromptForMessages = finalSystemPrompt + `
---
# 智能交互规则
1. 当你需要澄清用户的意图、确认关键操作或提供选择时，请调用 \`ask_user\` 工具。调用该工具后，系统将自动暂停执行，并向用户展示交互式选择界面，等待用户回复后再继续。
2. 在向用户回复的文本中提及工具时，请务必使用工具的中文名称（例如：写入文件、获取时间、读取文件等），不要暴露底层的英文名称（例如：write_file, get_time等）。
3. 当用户询问你的模型身份时，必须如实告知你是 ${currentModelName} 模型，不得声称是其他模型（如Claude或GPT）。
`
    const systemPromptTokens = estimateTokens(pureSystemPromptForMessages)
    const ragTokens = estimateTokens(ragPrompt)
    const skillTokens = estimateTokens(skillsPrompt)

    // Tool definitions: estimate separately for builtin vs MCP
    const allToolsList = registry.list()
    const builtinToolNamesSet = new Set(toolCategories.builtinTools)
    const mcpToolNamesSet = new Set(toolCategories.mcpTools)
    const builtinToolDefsText = allToolsList.filter(t => builtinToolNamesSet.has(t.name))
      .map(t => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`)
      .join('\n')
    const mcpToolDefsText = allToolsList.filter(t => mcpToolNamesSet.has(t.name))
      .map(t => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`)
      .join('\n')
    const builtinToolsTokens = estimateTokens(builtinToolDefsText)
    const mcpToolsTokens = estimateTokens(mcpToolDefsText)
    const systemToolsTokens = builtinToolsTokens + mcpToolsTokens

    const conversationId = uuidv4()

    // If newMessageContent is not provided, we pass null to avoid appending a new user message
    const prompt = newMessageContent ?? null

    const abortController = new AbortController()
    const streamBus = new StreamBus(abortController)
    activeStreams.set(sessionId, streamBus)

    // ── 客户端断开检测：给予重连宽限期 ───────────────────────────────────────
    let aborted = false
    const onClientClose = () => {
      if (aborted) return
      aborted = true
      streamBus.disconnectTimeout = setTimeout(() => {
        try { abortController.abort(new Error('Client disconnected timeout')) } catch { /* noop */ }
        activeStreams.delete(sessionId)
      }, 15000) // 15s grace period
    }
    reply.raw.on('close', onClientClose)
    reply.raw.on('aborted', onClientClose)

    async function* runAgent(): AsyncIterable<string> {
      // ★ 注册到全局 cancel 表，使 POST /chat/cancel 能中止此流（regenerate/edit 场景）
      registerActiveChat(tenantId, sessionId, abortController)
      try {
        const llm = await createLLMAdapterWithDbConfig({
          model: effectiveModel,
          apiKey: modelApiKey,
          baseUrl: modelBaseUrl,
          provider: modelProvider
        })
        const strategy = new ReActStrategy(llm, {
          systemPrompt: fullSystemPrompt || undefined,
          maxAskUserCount,
          conversationId,
          promptBreakdown: { systemPromptTokens, systemToolsTokens, skillTokens, ragTokens, builtinToolsTokens, mcpToolsTokens },
          thinkingConfig: finalThinkingConfig,
          responseThinkingField: finalResponseThinkingField,
          metadata: metadata,
        })
        const pipeline = createPipeline([])
        // ★ 把 ctx 的 signal 替换为受 cancel 控制的 abortController.signal
        ctx.signal = abortController.signal

        yield* pipeline.pipe(strategy.run(prompt, ctx))
      } catch (err: any) {
        if (abortController.signal.aborted) {
          // 被 cancel 中止，静默退出，不输出错误信息
          return
        }
        reqLogger.error({ err }, 'Agent execution error')
        yield `\n\n[System Error: ${err.message || String(err)}]`
      } finally {
        unregisterActiveChat(tenantId, sessionId, abortController)
      }
    }

    // 后台运行 Agent
    ;(async () => {
      try {
        for await (const chunk of runAgent()) {
          streamBus.push(chunk)
        }
        streamBus.end()
      } catch (err) {
        streamBus.error(err)
      } finally {
        setTimeout(() => activeStreams.delete(sessionId), 60000)
      }
    })()

    await sseStream(busToIterable(streamBus), reply)
  }

  // 3. 编辑用户消息并重新生成响应
  fastify.put<{ Params: { messageId: string } }>('/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params
    const tenantId = getTenantId(request)

    const result = UpdateMessageSchema.safeParse(request.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const { content, systemPrompt, maxAskUserCount, thinkingMode, metadata } = result.data

    const message = await history.getMessageById(messageId, tenantId)
    if (!message) {
      return reply.code(200).send(fail(40400, 'Message not found'))
    }
    if (message.role !== 'user') {
      return reply.code(200).send(fail(40000, 'Only user messages can be edited'))
    }

    // 获取 session_id
    const db = (await import('../../../storage/sqlite/db.js')).getDb()
    const dbResult = await db.execute({
      sql: 'SELECT session_id FROM conversations WHERE message_id = ? AND tenant_id = ?',
      args: [messageId, tenantId]
    })
    const sessionId = dbResult.rows[0]?.session_id as string

    if (!sessionId) {
      return reply.code(200).send(fail(50000, 'Session not found for message'))
    }

    // 更新消息内容，重置 tokens，更新 metadata（如果有）
    const estimatedTokens = estimateTokens(content)
    await history.updateMessageContent(messageId, tenantId, content, estimatedTokens, metadata ?? message.metadata)

    // 硬删除该消息之后的所有消息
    await history.deleteMessagesAfterId(message.dbId, sessionId, tenantId)

    // Then run AI to generate a response for the updated history
    const requestId = uuidv4()
    await runAIForSession(sessionId, tenantId, requestId, systemPrompt, reply, maxAskUserCount, content, thinkingMode, undefined, metadata ?? message.metadata)
  })

  // 4. 重新生成最后一条 AI 回复
  fastify.post<{ Params: { messageId: string } }>('/messages/:messageId/regenerate', async (request, reply) => {
    const { messageId } = request.params
    const tenantId = getTenantId(request)

    const result = RegenerateSchema.safeParse(request.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const { systemPrompt, maxAskUserCount, thinkingMode, metadata } = result.data

    const message = await history.getMessageById(messageId, tenantId)
    if (!message) {
      return reply.code(200).send(fail(40400, 'Message not found'))
    }
    if (message.role !== 'assistant') {
      return reply.code(200).send(fail(40000, 'Only assistant messages can be regenerated'))
    }

    const db = (await import('../../../storage/sqlite/db.js')).getDb()
    const dbResult = await db.execute({
      sql: 'SELECT session_id FROM conversations WHERE message_id = ? AND tenant_id = ?',
      args: [messageId, tenantId]
    })
    const sessionId = dbResult.rows[0]?.session_id as string

    if (!sessionId) {
      return reply.code(200).send(fail(50000, 'Session not found for message'))
    }

    if (message.conversationId) {
      // 删除该轮对话产生的所有非用户消息（包含中间的 tool calls）
      await db.execute({
        sql: `DELETE FROM conversations WHERE tenant_id = ? AND session_id = ? AND conversation_id = ? AND role != 'user'`,
        args: [tenantId, sessionId, message.conversationId]
      })
    } else {
      await history.deleteMessage(messageId, tenantId)
    }
    
    await history.deleteMessagesAfterId(message.dbId, sessionId, tenantId)

    const requestId = uuidv4()
    
    await runAIForSession(sessionId, tenantId, requestId, systemPrompt, reply, maxAskUserCount, undefined, thinkingMode, undefined, metadata)
    return reply
  })
}

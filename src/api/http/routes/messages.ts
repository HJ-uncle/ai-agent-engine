import type { FastifyInstance } from 'fastify'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { ReActStrategy } from '../../../core/agent-loop/index.js'
import { createPipeline, sseStream } from '../../../core/stream-pipeline/index.js'
import { createAgentContext } from '../../../core/agent-context/index.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { SQLiteMemoryStore } from '../../../storage/memory-store/index.js'
import { createLLMAdapter } from '../../../core/llm-adapter/index.js'
import { createRequestLogger } from '../../../observability/index.js'
import { registerBuiltinSkills, buildSkillsSystemPrompt, skillsRegistry } from '../../../skills/index.js'
import { fileTools } from '../../../tools/file/index.js'
import { cmdTool } from '../../../tools/cmd/index.js'
import { askUserTool } from '../../../tools/ask-user/index.js'
import { createMemoryTools } from '../../../tools/memory/index.js'
import { registerMCPTools } from '../../../tools/mcp/loader.js'
import { createSkillTools, runSkillScriptTool } from '../../../tools/skill/index.js'
import { v4 as uuidv4 } from 'uuid'
import { success, fail } from '../response.js'

interface RegenerateBody {
  messageId: string
  systemPrompt?: string
  maxIterations?: number
}

export async function messagesRoutes(fastify: FastifyInstance) {
  const history = new SQLiteConversationHistory()

  // 1. 查询消息的 token 消耗量
  fastify.get<{ Params: { messageId: string } }>('/messages/:messageId/tokens', async (request, reply) => {
    const { messageId } = request.params
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    const message = await history.getMessageById(messageId, tenantId)
    if (!message) {
      return reply.code(200).send(fail(40400, 'Message not found'))
    }

    return reply.code(200).send(success({ messageId, tokens: message.tokens }))
  })

  // 查询会话的 token 总和
  fastify.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/tokens', async (request, reply) => {
    const { sessionId } = request.params
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    const totalTokens = await history.getRawTokenCount({ tenantId, sessionId })
    return reply.code(200).send(success({ sessionId, totalTokens }))
  })

  // 2. 硬删除消息
  fastify.delete<{ Params: { messageId: string } }>('/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    const message = await history.getMessageById(messageId, tenantId)
    if (!message) {
      return reply.code(200).send(fail(40400, 'Message not found'))
    }

    await history.deleteMessage(messageId, tenantId)
    return reply.code(200).send(success({ success: true, messageId }))
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
    effectiveModel?: string
  ) {
    const reqLogger = createRequestLogger(requestId, tenantId, sessionId)
    const registry = new ToolRegistry()
    const memory = new SQLiteMemoryStore()
    registerBuiltinSkills(registry)
    fileTools.forEach((t) => registry.register(t))
    registry.register(cmdTool)
    registry.register(askUserTool)
    createMemoryTools(memory).forEach((t) => registry.register(t))
    await registerMCPTools(registry)

    const ctx = createAgentContext({
      sessionId,
      tenantId,
      tools: registry,
      memory,
      history,
      logger: reqLogger,
      requestId,
    })

    const externalSkills = skillsRegistry.getSkills()
    createSkillTools(externalSkills).forEach((t) => registry.register(t))
    registry.register(runSkillScriptTool)

    const skillsPrompt = buildSkillsSystemPrompt(externalSkills)
    const finalSystemPrompt = [systemPrompt, skillsPrompt].filter(Boolean).join('\n\n')

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

    const estimateTokens = (text: string) => Math.ceil(text.length / 4)
    const baseSystemPrompt = [systemPrompt ?? '', ragPrompt].filter(Boolean).join('\n\n')
    const systemPromptTokens = estimateTokens(baseSystemPrompt)
    const skillTokens = estimateTokens(skillsPrompt)
    const toolDefsText = registry.list()
      .map((t) => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`)
      .join('\n')
    const systemToolsTokens = estimateTokens(toolDefsText)

    const conversationId = uuidv4()

    // If newMessageContent is not provided, we pass null to avoid appending a new user message
    const prompt = newMessageContent ?? null

    async function* runAgent(): AsyncIterable<string> {
      try {
        const llm = createLLMAdapter({
          model: effectiveModel,
          apiKey: modelApiKey,
          baseUrl: modelBaseUrl,
          provider: modelProvider
        })
        const strategy = new ReActStrategy(llm, {
          systemPrompt: fullSystemPrompt || undefined,
          maxAskUserCount,
          conversationId,
          promptBreakdown: { systemPromptTokens, systemToolsTokens, skillTokens },
          thinkingConfig: finalThinkingConfig,
          responseThinkingField: finalResponseThinkingField,
        })
        const pipeline = createPipeline([])

        yield* pipeline.pipe(strategy.run(prompt, ctx))
      } catch (err: any) {
        reqLogger.error({ err }, 'Agent execution error')
        yield `\n\n[System Error: ${err.message || String(err)}]`
      }
    }

    await sseStream(runAgent(), reply)
  }

  // 3. 编辑用户消息并重新生成响应
  fastify.put<{ Params: { messageId: string }; Body: { content: string; systemPrompt?: string; maxAskUserCount?: number; thinkingMode?: boolean } }>('/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params
    const { content, systemPrompt, maxAskUserCount, thinkingMode } = request.body
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    if (!content) {
      return reply.code(200).send(fail(40001, 'content is required'))
    }

    const message = await history.getMessageById(messageId, tenantId)
    if (!message) {
      return reply.code(200).send(fail(40400, 'Message not found'))
    }
    if (message.role !== 'user') {
      return reply.code(200).send(fail(40000, 'Only user messages can be edited'))
    }

    // 获取 session_id
    const db = (await import('../../../storage/sqlite/db.js')).getDb()
    const result = await db.execute({
      sql: 'SELECT session_id FROM conversations WHERE message_id = ? AND tenant_id = ?',
      args: [messageId, tenantId]
    })
    const sessionId = result.rows[0]?.session_id as string

    if (!sessionId) {
      return reply.code(200).send(fail(50000, 'Session not found for message'))
    }

    // 更新消息内容，重置 tokens（此处简单估算，或后续被精确更新）
    const estimatedTokens = Math.ceil(content.length / 4)
    await history.updateMessageContent(messageId, tenantId, content, estimatedTokens)

    // 硬删除该消息之后的所有消息
    await history.deleteMessagesAfterId(message.dbId, sessionId, tenantId)

    // Then run AI to generate a response for the updated history
    const requestId = uuidv4()
    await runAIForSession(sessionId, tenantId, requestId, systemPrompt, reply, maxAskUserCount, content, thinkingMode)
  })

  // 4. 重新生成最后一条 AI 回复
  fastify.post<{ Params: { messageId: string }; Body: { systemPrompt?: string; maxAskUserCount?: number; thinkingMode?: boolean } }>('/messages/:messageId/regenerate', async (request, reply) => {
    const { messageId } = request.params
    const { systemPrompt, maxAskUserCount, thinkingMode } = request.body
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    const message = await history.getMessageById(messageId, tenantId)
    if (!message) {
      return reply.code(200).send(fail(40400, 'Message not found'))
    }
    if (message.role !== 'assistant') {
      return reply.code(200).send(fail(40000, 'Only assistant messages can be regenerated'))
    }

    const db = (await import('../../../storage/sqlite/db.js')).getDb()
    const result = await db.execute({
      sql: 'SELECT session_id FROM conversations WHERE message_id = ? AND tenant_id = ?',
      args: [messageId, tenantId]
    })
    const sessionId = result.rows[0]?.session_id as string

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
    
    await runAIForSession(sessionId, tenantId, requestId, systemPrompt, reply, maxAskUserCount, undefined, thinkingMode)
    return reply
  })
}

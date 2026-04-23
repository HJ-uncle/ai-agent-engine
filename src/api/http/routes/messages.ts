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
import { createMemoryTools } from '../../../tools/memory/index.js'
import { registerMCPTools } from '../../../tools/mcp/loader.js'
import { createSkillTools, runSkillScriptTool } from '../../../tools/skill/index.js'
import { v4 as uuidv4 } from 'uuid'
import { success, fail } from '../response.js'

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
    maxIterations: number | undefined,
    newMessageContent?: string
  ) {
    const reqLogger = createRequestLogger(requestId, tenantId, sessionId)
    const registry = new ToolRegistry()
    const memory = new SQLiteMemoryStore()
    registerBuiltinSkills(registry)
    fileTools.forEach((t) => registry.register(t))
    registry.register(cmdTool)
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
    const fullSystemPrompt = finalSystemPrompt + ragPrompt

    const estimateTokens = (text: string) => Math.ceil(text.length / 4)
    const baseSystemPrompt = [systemPrompt ?? '', ragPrompt].filter(Boolean).join('\n\n')
    const systemPromptTokens = estimateTokens(baseSystemPrompt)
    const skillTokens = estimateTokens(skillsPrompt)
    const toolDefsText = registry.list()
      .map((t) => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`)
      .join('\n')
    const systemToolsTokens = estimateTokens(toolDefsText)

    const conversationId = uuidv4()
    const llm = createLLMAdapter()
    const strategy = new ReActStrategy(llm, {
      systemPrompt: fullSystemPrompt || undefined,
      maxIterations,
      conversationId,
      promptBreakdown: { systemPromptTokens, systemToolsTokens, skillTokens },
    })
    const pipeline = createPipeline([])

    // If newMessageContent is not provided, we pass null to avoid appending a new user message
    const prompt = newMessageContent ?? null

    async function* runAgent(): AsyncIterable<string> {
      yield* pipeline.pipe(strategy.run(prompt, ctx))
    }

    await sseStream(runAgent(), reply)
  }

  // 3. 编辑用户消息并重新生成响应
  fastify.put<{ Params: { messageId: string }; Body: { content: string; systemPrompt?: string; maxIterations?: number } }>('/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params
    const { content, systemPrompt, maxIterations } = request.body
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
    await runAIForSession(sessionId, tenantId, requestId, systemPrompt, reply, maxIterations, undefined)
    return reply
  })

  // 4. AI 消息重新生成
  fastify.post<{ Params: { messageId: string }; Body: { systemPrompt?: string; maxIterations?: number } }>('/messages/:messageId/regenerate', async (request, reply) => {
    const { messageId } = request.params
    const { systemPrompt, maxIterations } = request.body
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

    // 硬删除该 AI 消息及其之后的所有消息
    // 注意：这里需要包含该 AI 消息自身
    await history.deleteMessage(messageId, tenantId)
    await history.deleteMessagesAfterId(message.dbId, sessionId, tenantId)

    const requestId = uuidv4()
    await runAIForSession(sessionId, tenantId, requestId, systemPrompt, reply, maxIterations, undefined)
    return reply
  })
}

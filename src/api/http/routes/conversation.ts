import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { SessionStore } from '../../../storage/session/index.js'
import { success, fail, paginateArray } from '../response.js'
import { workspaceManager } from '../../../workspace/index.js'
import { abortActiveChat } from './chat.js'
import fs from 'node:fs'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function conversationRoutes(fastify: FastifyInstance) {
  const history = new SQLiteConversationHistory()

  // GET /conversation/sessions  — 列出该租户下所有有对话记录的 session
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/conversation/sessions', async (request, reply) => {
    const tenantId = getTenantId(request)
    const { current, pageSize } = request.query
    const sessions = await history.listSessions(tenantId)
    return reply.code(200).send(paginateArray(sessions, current, pageSize))
  })

  // GET /conversation/history?sessionId=xxx  — 查询 session 的所有历史消息
  fastify.get<{ Querystring: { sessionId: string; current?: number; pageSize?: number } }>('/conversation/history', async (request, reply) => {
    const { sessionId, current, pageSize } = request.query
    const tenantId = getTenantId(request)
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }
    const messages = await history.getHistory({ tenantId, sessionId })
    const sessionUsage = await history.getSessionUsage({ tenantId, sessionId })
    
    const response = paginateArray(messages, current, pageSize)
    response.metadata = { sessionUsage }
    
    return reply.code(200).send(response)
  })

  // DELETE /conversation/history?sessionId=xxx  — 清空 session 历史
  fastify.delete<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = getTenantId(request)
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }
    await history.clear({ tenantId, sessionId })
    // 注意：Agent 绑定不随历史清空而解除，绑定与会话生命周期一致（仅硬删除 session 时清除）
    return reply.code(200).send(success({ success: true }))
  })

  // DELETE /sessions/:sessionId  — 删除整个 session (硬删除)
  fastify.delete<{ Params: { sessionId: string }, Querystring: { keepWorkspace?: string } }>('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params
    const { keepWorkspace } = request.query
    const tenantId = getTenantId(request)
    
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }

    // 0. 先 abort 该 session 上正在跑的 SSE 流（如果有），防止流式 append 与 clear 竞态
    //    history.clear() 会同步设置 5s 墓碑，期间任何 append 都被丢弃，再加这一步是双保险。
    try { abortActiveChat(tenantId, sessionId, 'Session deleted by user') } catch { /* noop */ }

    // 1. Delete DB history（内部会先设置墓碑，再 DELETE FROM conversations）
    await history.clear({ tenantId, sessionId })

    // 2. 同步清除会话 Agent 绑定，允许重新选择 Agent
    const sessionStore = new SessionStore()
    await sessionStore.clearBinding(sessionId, tenantId)

    // 3. Delete physical workspace directory if keepWorkspace is not true
    if (keepWorkspace !== 'true') {
      try {
        const dir = workspaceManager.getPath({ tenantId, sessionId })
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      } catch (e: any) {
        request.log.error(`Failed to cleanup workspace for session ${sessionId}: ${e.message}`)
      }
    }

    return reply.code(200).send(success({ success: true, sessionId }))
  })

  // GET /conversations/:conversationId  — 按 conversationId 查询单轮对话消息
  fastify.get<{ Params: { conversationId: string }, Querystring: { current?: number; pageSize?: number } }>('/conversations/:conversationId', async (request, reply) => {
    const { conversationId } = request.params
    const { current, pageSize } = request.query
    const tenantId = getTenantId(request)

    if (!conversationId) {
      return reply.code(200).send(fail(40001, '参数验证失败：conversationId 不能为空'))
    }

    const messages = await history.getByConversationId(conversationId, tenantId)

    if (messages.length === 0) {
      return reply.code(200).send(fail(40400, `Conversation "${conversationId}" not found`))
    }

    return reply.code(200).send(paginateArray(messages, current, pageSize))
  })

  // POST /conversation/compress  — 压缩当前会话历史
  fastify.post<{ Querystring: { sessionId: string } }>('/conversation/compress', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }

    const messages = await history.getHistory({ tenantId, sessionId })
    if (messages.length <= 1) {
      return reply.code(200).send(success({ success: true, message: '消息数量过少，无需压缩' }))
    }

    const originalTokens = messages.reduce((sum, m) => sum + (m.tokens || 0) + (m.usage?.totalTokens || 0), 0)

    // 动态导入 createLLMAdapter 避免循环依赖
    const { createLLMAdapter } = await import('../../../core/llm-adapter/factory.js')
    const llm = createLLMAdapter()

    const prompt = `请你将以下对话历史进行智能压缩和提炼，提取出核心上下文、已确认的结论、关键事实、未完成的任务等关键信息，形成一份精简的上下文摘要。这会作为后续对话的唯一背景信息，因此请务必保证信息准确。
以下是对话历史：
${messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')}`

    try {
      const response = await llm.complete([{ role: 'user', content: prompt, tokens: 0, createdAt: Date.now() }], {
        model: llm.model,
        systemPrompt: '你是一个专业的上下文压缩和摘要助手，擅长在保留核心语义和关键信息的前提下极大地缩减文本长度。',
      })

      // 覆盖历史
      await history.clear({ tenantId, sessionId })
      const summaryMsg = {
        role: 'system' as const,
        content: `【历史上下文摘要】\n${response.content}`,
        tokens: response.completionTokens,
        usage: {
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          totalTokens: response.promptTokens + response.completionTokens,
        }
      }
      await history.append(summaryMsg, { tenantId, sessionId })
      
      // 增加一条 assistant 消息作为反馈
      await history.append({
        role: 'assistant' as const,
        content: '我已经为您完成了上下文压缩，并保留了核心摘要信息。您可以继续与我对话。',
        reasoningContent: '',
        tokens: 20
      }, { tenantId, sessionId })

      return reply.code(200).send(success({ 
        success: true, 
        message: '压缩成功',
        stats: {
          originalTokens,
          compressedTokens: response.completionTokens,
          ratio: originalTokens > 0 ? (response.completionTokens / originalTokens * 100).toFixed(1) + '%' : '0%'
        },
        usage: {
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          totalTokens: response.promptTokens + response.completionTokens,
          systemPromptTokens: 0,
          messagesTokens: 0,
          skillTokens: 0,
          systemToolsTokens: 0,
        }
      }))
    } catch (e: any) {
      request.log.error(`压缩会话 ${sessionId} 失败: ${e.message}`)
      return reply.code(200).send(fail(50000, `压缩失败: ${e.message}`))
    }
  })
}

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { SessionStore } from '../../../storage/session/index.js'
import { success, fail, paginateArray } from '../response.js'
import { workspaceManager } from '../../../workspace/index.js'
import { abortActiveChat } from './chat.js'
import fs from 'node:fs'
import { getSubagentStore } from '../../../core/subagent/store.js'
import { getSubagentRunner } from '../../../core/subagent/runner.js'
import { projectPendingSubagents } from '../../../core/subagent/projection.js'
import { subagentRoutes } from './subagent.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function autoCompactSession(tenantId: string, sessionId: string, logger: any) {
  const history = createConversationHistory()
  const messages = await history.getHistory({ tenantId, sessionId })
  if (messages.length <= 1) return

  // 专职模型路由：如果配置了 LLM_SUMMARIZE_MODEL，优先使用它
  const { createLLMAdapterWithDbConfig } = await import('../../../core/llm-adapter/index.js')
  const { buildCompactSummarizeFn } = await import('../../../core/agent-loop/compact-prompt.js')
  const summarizeModel = process.env.LLM_SUMMARIZE_MODEL || undefined
  const llm = await createLLMAdapterWithDbConfig({ model: summarizeModel })

  logger.info({ model: llm.model }, 'Starting background auto-compaction')

  // 与手动端点同一条路：history.compress 统一落地与保留策略；后台压缩同样按条数保留
  const stats = await history.compress(
    { tenantId, sessionId },
    buildCompactSummarizeFn(llm),
    6,
  )

  await history.append({
    role: 'assistant' as const,
    content: '（上下文已触发智能压缩以释放空间）',
    tokens: 15,
    metadata: { compressedFrom: stats.preTokens, compressedTo: stats.postTokens },
  }, { tenantId, sessionId })

  logger.info({ originalTokens: stats.preTokens, compressedTokens: stats.postTokens }, 'Auto-compaction finished')
}

export async function conversationRoutes(fastify: FastifyInstance) {
  const history = createConversationHistory()
  await subagentRoutes(fastify)

  async function removeChildRuns(tenantId: string, sessionId: string, parentMessageIds: Set<string>): Promise<void> {
    await getSubagentRunner().cancelRunsForParent(tenantId, sessionId)
    const runs = (await getSubagentStore().listRunsForParent(tenantId, sessionId)).filter(run => parentMessageIds.has(run.parentMessageId))
    for (const run of runs) await history.clear({ tenantId, sessionId: run.childSessionId })
    await getSubagentStore().deleteRuns(tenantId, runs.map(run => run.runId))
  }

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
    await projectPendingSubagents(history, tenantId)
    const messages = await history.getFullHistory({ tenantId, sessionId })
    const subagentRuns = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    for (const message of messages) {
      const run = subagentRuns.find(item => item.parentToolCallId === message.toolCallId)
      if (run) message.metadata = { ...message.metadata, subagent: run, success: run.status === 'succeeded', error: run.error?.message }
    }
    const sessionUsage = await history.getSessionUsage({ tenantId, sessionId })
    
    const response = paginateArray(messages, current, pageSize)
    response.metadata = { sessionUsage, subagentRuns }
    
    return reply.code(200).send(response)
  })

  // DELETE /conversation/history?sessionId=xxx  — 清空 session 历史
  fastify.delete<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = getTenantId(request)
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }
    abortActiveChat(tenantId, sessionId, 'History cleared by user')
    await getSubagentRunner().cancelRunsForParent(tenantId, sessionId)
    const childRuns = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    for (const run of childRuns) await history.clear({ tenantId, sessionId: run.childSessionId })
    await getSubagentStore().deleteRunsForParent(tenantId, sessionId)
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
    await getSubagentRunner().cancelRunsForParent(tenantId, sessionId)
    const childRuns = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    for (const run of childRuns) await history.clear({ tenantId, sessionId: run.childSessionId })
    await getSubagentStore().deleteRunsForParent(tenantId, sessionId)
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

  // DELETE /conversation/turns/:conversationId — 删除一整轮（该 conversation_id 的所有行）
  fastify.delete<{ Params: { conversationId: string }, Querystring: { sessionId?: string } }>('/conversation/turns/:conversationId', async (request, reply) => {
    const { conversationId } = request.params
    const tenantId = getTenantId(request)
    if (!conversationId) {
      return reply.code(200).send(fail(40001, '参数验证失败：conversationId 不能为空'))
    }
    try { abortActiveChat(tenantId, request.query.sessionId ?? '', 'Turn deleted by user') } catch { /* noop */ }
    if (request.query.sessionId) {
      const messages = await history.getByConversationId(conversationId, tenantId)
      await removeChildRuns(tenantId, request.query.sessionId, new Set(messages.flatMap(message => message.id ? [message.id] : [])))
    }
    const removed = await history.deleteByConversationId(conversationId, tenantId)
    if (removed === 0) {
      return reply.code(200).send(fail(40400, '该轮对话不存在'))
    }
    return reply.code(200).send(success({ success: true, removed }))
  })

  // DELETE /conversation/messages/:messageId — 删除单条消息
  // 配套约定：前端按「轮」操作（用户消息 + 其后的助手回复一起删），
  // 引擎只提供单行删除；删除 assistant/tool 行时前端应连同配对行一起删。
  fastify.delete<{ Params: { messageId: string }, Querystring: { sessionId?: string } }>('/conversation/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params
    const tenantId = getTenantId(request)
    if (!messageId) {
      return reply.code(200).send(fail(40001, '参数验证失败：messageId 不能为空'))
    }
    try { abortActiveChat(tenantId, request.query.sessionId ?? '', 'Message deleted by user') } catch { /* noop */ }
    const target = await history.getMessageById(messageId, tenantId)
    if (!target) {
      return reply.code(200).send(fail(40400, '消息不存在'))
    }
    if (request.query.sessionId) await removeChildRuns(tenantId, request.query.sessionId, new Set([messageId]))
    await history.deleteMessage(messageId, tenantId)
    return reply.code(200).send(success({ success: true }))
  })

  // POST /conversation/truncate — 截断历史：删除指定消息及其之后的所有消息
  // （回退到此处 / 重新发送 / 重新生成的底座）。前端传该消息的 message_id，
  // 引擎先解析出 dbId，再按自增 id > dbId 删除。
  fastify.post<{ Body: { sessionId: string; messageId: string } }>('/conversation/truncate', async (request, reply) => {
    const { sessionId, messageId } = request.body ?? {}
    const tenantId = getTenantId(request)
    if (!sessionId || !messageId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 与 messageId 不能为空'))
    }
    try { abortActiveChat(tenantId, sessionId, 'History truncated by user') } catch { /* noop */ }
    const target = await history.getMessageById(messageId, tenantId)
    if (!target) {
      return reply.code(200).send(fail(40400, '消息不存在'))
    }
    const messages = await history.getFullHistory({ tenantId, sessionId })
    const from = messages.findIndex(message => message.id === messageId)
    if (from >= 0) await removeChildRuns(tenantId, sessionId, new Set(messages.slice(from).flatMap(message => message.id ? [message.id] : [])))
    await history.deleteMessagesAfterId(target.dbId, sessionId, tenantId)
    await history.deleteMessage(messageId, tenantId)
    return reply.code(200).send(success({ success: true, removedFrom: messageId }))
  })

  // POST /conversation/compress  — 压缩当前会话历史
  fastify.post<{ Querystring: { sessionId: string } }>('/conversation/compress', async (request, reply) => {    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }

    const messages = await history.getHistory({ tenantId, sessionId })
    if (messages.length <= 4) {
      return reply.code(200).send(success({ success: true, message: '消息数量过少，无需压缩' }))
    }

    const originalTokens = messages.reduce((sum, m) => sum + (m.tokens || 0) + (m.usage?.totalTokens || 0), 0)

    // 动态导入避免循环依赖；摘要 prompt 与自动压缩（react.ts）共用同一份 6 段式模板
    const { createLLMAdapter } = await import('../../../core/llm-adapter/factory.js')
    const { buildCompactSummarizeFn } = await import('../../../core/agent-loop/compact-prompt.js')
    const llm = createLLMAdapter()

    try {
      // 经 history.compress 统一处理：两套后端各自落地（SQLite 事务重建 / JSONL 追加 summary 行）。
      // 手动压缩按条数保留（保底一半），保证「点了就一定压缩」——token 预算回溯只用于
      // 自动压缩（react.ts），那里上下文大、预算回溯才有意义。
      const stats = await history.compress(
        { tenantId, sessionId },
        buildCompactSummarizeFn(llm),
        6,
      )

      // 增加一条 assistant 消息作为反馈
      await history.append({
        role: 'assistant' as const,
        content: '我已经为您完成了上下文压缩，并保留了核心摘要信息。您可以继续与我对话。',
        tokens: 20,
        metadata: { compressedFrom: stats.preTokens, compressedTo: stats.postTokens },
      }, { tenantId, sessionId })

      return reply.code(200).send(success({
        success: true,
        message: '压缩成功',
        stats: {
          originalTokens: stats.preTokens || originalTokens,
          compressedTokens: stats.postTokens,
          ratio: stats.preTokens > 0 ? ((stats.preTokens - stats.postTokens) / stats.preTokens * 100).toFixed(1) + '%' : '0%'
        }
      }))
    } catch (e: any) {
      request.log.error(`压缩会话 ${sessionId} 失败: ${e.message}`)
      return reply.code(200).send(fail(50000, `压缩失败: ${e.message}`))
    }
  })
}

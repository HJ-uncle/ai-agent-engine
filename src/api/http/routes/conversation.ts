import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { SessionStore } from '../../../storage/session/index.js'
import { success, fail, paginateArray, successWithPagination } from '../response.js'
import { workspaceManager } from '../../../workspace/index.js'
import { abortActiveChat } from './chat.js'
import fs from 'node:fs'
import { getSubagentStore } from '../../../core/subagent/store.js'
import { getSubagentRunner } from '../../../core/subagent/runner.js'
import { projectPendingSubagents } from '../../../core/subagent/projection.js'
import { subagentRoutes } from './subagent.js'
import { rootRunStore } from '../../../storage/root-runs/index.js'
import { withHistoryLock, invalidateSessionHistory, withSessionHistoryMutation, bindHistoryGeneration } from '../../../storage/conversation/serialization.js'
import type { Message } from '../../../core/agent-context/types.js'
import { commandJobs } from '../../../core/command-jobs/index.js'
import { publicHistoryMessages } from '../history-projection.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function autoCompactSession(tenantId: string, sessionId: string, logger: any) {
  const history = bindHistoryGeneration(createConversationHistory(), tenantId, sessionId)
  const messages = await history.getHistory({ tenantId, sessionId })
  if (messages.length <= 1) return

  // 专职模型路由：如果配置了 LLM_SUMMARIZE_MODEL，优先使用它
  const { createLLMAdapterWithDbConfig } = await import('../../../core/llm-adapter/index.js')
  const { buildCompactSummarizeFn } = await import('../../../core/agent-loop/compact-prompt.js')
  const summarizeModel = process.env.LLM_SUMMARIZE_MODEL || undefined
  const llm = await createLLMAdapterWithDbConfig({ model: summarizeModel })

  logger.info({ model: llm.model }, 'Starting background auto-compaction')

  // 与手动端点同一条路：history.compress 统一落地与保留策略；后台压缩同样按条数保留
  const stats = await withHistoryLock(tenantId, async () => {
    // A new turn may already be running when this detached post-turn job gets
    // its lock. Leave that turn's context alone; its loop owns compaction.
    if ((await rootRunStore.list(tenantId, sessionId)).some(run => run.status === 'running' || run.status === 'waiting')) return null
    const result = await history.compress({ tenantId, sessionId }, buildCompactSummarizeFn(llm, { archiveAvailable: history.retainsArchive === true }), 6)
    return result
  })

  if (!stats) return
  logger.info({ originalTokens: stats.preTokens, compressedTokens: stats.postTokens }, 'Auto-compaction finished')
}

export async function conversationRoutes(fastify: FastifyInstance) {
  const history = createConversationHistory()
  await subagentRoutes(fastify)

  async function removeChildRuns(tenantId: string, sessionId: string, parentMessageIds?: Set<string>): Promise<void> {
    const runs = (await getSubagentStore().listRunsForParent(tenantId, sessionId)).filter(run => !parentMessageIds || parentMessageIds.has(run.parentMessageId))
    for (const run of runs) {
      invalidateSessionHistory(tenantId, run.childSessionId)
      await history.clear({ tenantId, sessionId: run.childSessionId })
    }
    if (parentMessageIds) await getSubagentStore().deleteRuns(tenantId, runs.map(run => run.runId))
    else await getSubagentStore().deleteRunsForParent(tenantId, sessionId)
  }

  type TurnMessage = Message & { conversationId?: string }
  const messageIds = (messages: Message[]) => new Set(messages.flatMap(message => message.id ? [message.id] : []))

  async function interruptSession(tenantId: string, sessionId: string, reason: string): Promise<string[]> {
    invalidateSessionHistory(tenantId, sessionId)
    abortActiveChat(tenantId, sessionId, reason)
    const active = (await rootRunStore.list(tenantId, sessionId)).filter(run => run.status === 'running' || run.status === 'waiting')
    for (const run of active) await rootRunStore.update(tenantId, run.runId, { status: 'cancelled', stopReason: reason })
    return active.map(run => run.turnId)
  }

  /** The lease prevents new roots; child completion must run outside the history lock. */
  async function mutateHistory<T>(tenantId: string, sessionId: string, reason: string,
    select: () => Promise<TurnMessage[] | null>, apply: (messages: TurnMessage[], interruptedTurns: string[]) => Promise<T>): Promise<T | null> {
    return withSessionHistoryMutation(tenantId, sessionId, async () => {
      const initial = await withHistoryLock(tenantId, async () => {
        if (await select() === null) return null
        return interruptSession(tenantId, sessionId, reason)
      })
      if (initial === null) return null
      await getSubagentRunner().cancelRunsForParent(tenantId, sessionId)
      await commandJobs.cancelScope({ tenantId, sessionId }, reason)
      return withHistoryLock(tenantId, async () => {
        // Re-read after child settlement: no stale message/turn snapshot may drive deletion.
        const messages = await select()
        if (messages === null) return null
        const interrupted = await interruptSession(tenantId, sessionId, reason)
        return apply(messages, [...new Set([...initial, ...interrupted])])
      })
    })
  }

  async function selectMessages(tenantId: string, sessionId: string, messageId: string, truncate = false): Promise<TurnMessage[] | null> {
    const messages = await history.getFullHistory({ tenantId, sessionId }) as TurnMessage[]
    const from = messages.findIndex(message => message.id === messageId)
    return from < 0 ? null : truncate ? messages.slice(from) : [messages[from]]
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
    const jobs = await commandJobs.list({ tenantId, sessionId })
    for (const message of messages) {
      const run = subagentRuns.find(item => item.parentToolCallId === message.toolCallId)
      if (run) message.metadata = { ...message.metadata, subagent: run, success: run.status === 'succeeded', error: run.error?.message }
      const job = jobs.find(item => item.toolCallId && item.toolCallId === message.toolCallId && item.ownerSessionId === sessionId)
      if (job) message.metadata = { ...message.metadata, commandJob: job }
    }
    const sessionUsage = await history.getSessionUsage({ tenantId, sessionId })
    
    const response = paginateArray(publicHistoryMessages(messages), current, pageSize)
    response.metadata = { sessionUsage, subagentRuns, runs: await rootRunStore.list(tenantId, sessionId), commandJobs: jobs }
    
    return reply.code(200).send(response)
  })

  // GET /conversation/archive?sessionId=xxx — 显式读取压缩前的 JSONL 归档。
  //
  // /conversation/history 保持为模型/快速恢复使用的紧凑投影；归档必须由
  // 用户主动请求，避免把所有旧工具输出重新灌进上下文窗口。SQLite 后端
  // 只能返回其当前事务重建后的可用消息，JSONL 会在这里展开 summary 之前
  // 仍保留在 append-only 文件中的消息。
  fastify.get<{ Querystring: { sessionId: string; current?: number; pageSize?: number } }>('/conversation/archive', async (request, reply) => {
    const { sessionId, current, pageSize } = request.query
    const tenantId = getTenantId(request)
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }
    const getArchive = history.getArchive
    if (typeof getArchive !== 'function') {
      return reply.code(501).send(fail(50101, '当前历史后端不支持归档读取'))
    }
    let page: { offset: number; limit: number } | undefined
    let normalizedCurrent = 1
    if (current != null && pageSize != null) {
      const validation = paginateArray([], current, pageSize)
      if (validation.code !== 200) return reply.code(200).send(validation)
      normalizedCurrent = validation.pagination!.current
      page = { offset: (normalizedCurrent - 1) * validation.pagination!.pageSize, limit: validation.pagination!.pageSize }
    }
    // Keep archive replay as rich as the compact history endpoint: tool rows
    // need their persisted child-run/job metadata for the UI cards to render.
    await projectPendingSubagents(history, tenantId)
    const archive = await getArchive.call(history, { tenantId, sessionId }, page)
    const subagentRuns = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    const jobs = await commandJobs.list({ tenantId, sessionId })
    for (const message of archive.messages) {
      const run = subagentRuns.find(item => item.parentToolCallId === message.toolCallId)
      if (run) message.metadata = { ...message.metadata, subagent: run, success: run.status === 'succeeded', error: run.error?.message }
      const job = jobs.find(item => item.toolCallId && item.toolCallId === message.toolCallId && item.ownerSessionId === sessionId)
      if (job) message.metadata = { ...message.metadata, commandJob: job }
    }
    const total = archive.totalMessageCount ?? archive.messages.length
    const response = page && archive.totalMessageCount !== undefined
      ? successWithPagination(publicHistoryMessages(archive.messages), { current: normalizedCurrent, pageSize: page.limit, total, totalPages: Math.ceil(total / page.limit) })
      : paginateArray(publicHistoryMessages(archive.messages), current, pageSize)
    response.metadata = {
      compressed: archive.compressed,
      currentMessageCount: archive.currentMessageCount,
      archiveMessageCount: total,
      ...(archive.archiveRevision ? { archiveRevision: archive.archiveRevision } : {}),
      backend: archive.backend,
      ...(archive.summary ? {
        summary: {
          content: archive.summary.content,
          ...(archive.summary.leafSeq !== undefined ? { leafSeq: archive.summary.leafSeq } : {}),
          ...(archive.summary.preTokens !== undefined ? { preTokens: archive.summary.preTokens } : {}),
          ...(archive.summary.postTokens !== undefined ? { postTokens: archive.summary.postTokens } : {}),
        },
      } : {}),
    }
    return reply.code(200).send(response)
  })

  // DELETE /conversation/history?sessionId=xxx  — 清空 session 历史
  fastify.delete<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = getTenantId(request)
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }
    await mutateHistory(tenantId, sessionId, 'History cleared by user',
      () => history.getFullHistory({ tenantId, sessionId }), async () => {
        await removeChildRuns(tenantId, sessionId)
        await history.clear({ tenantId, sessionId })
        await rootRunStore.deleteTurns(tenantId, sessionId)
      })
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

    await mutateHistory(tenantId, sessionId, 'Session deleted by user',
      () => history.getFullHistory({ tenantId, sessionId }), async () => {
        await removeChildRuns(tenantId, sessionId)
        await history.clear({ tenantId, sessionId })
        await rootRunStore.deleteTurns(tenantId, sessionId)
        await new SessionStore().clearBinding(sessionId, tenantId)

        // Keep the lease through workspace removal so a new root cannot use it mid-delete.
        if (keepWorkspace !== 'true') {
          try {
            const dir = workspaceManager.getPath({ tenantId, sessionId })
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
          } catch (e: any) {
            request.log.error(`Failed to cleanup workspace for session ${sessionId}: ${e.message}`)
          }
        }
      })

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
    const { sessionId } = request.query
    const tenantId = getTenantId(request)
    if (!conversationId || !sessionId) return reply.code(400).send(fail(40001, 'conversationId and sessionId are required'))
    const removed = await mutateHistory(tenantId, sessionId, 'Turn deleted by user', async () => {
      const messages = (await history.getFullHistory({ tenantId, sessionId }) as TurnMessage[]).filter(message => message.conversationId === conversationId)
      return messages.length ? messages : null
    }, async messages => {
      await removeChildRuns(tenantId, sessionId, messageIds(messages))
      await rootRunStore.deleteTurns(tenantId, sessionId, [conversationId])
      // Delete only the verified session's messages, even if a legacy turn ID was reused.
      for (const message of messages) if (message.id) await history.deleteMessage(message.id, tenantId)
      return messages.length
    })
    if (removed === null) return reply.code(404).send(fail(40400, 'Turn not found in this session'))
    return reply.code(200).send(success({ success: true, removed }))
  })

  // DELETE /conversation/messages/:messageId — 删除单条消息
  // 配套约定：前端按「轮」操作（用户消息 + 其后的助手回复一起删），
  // 引擎只提供单行删除；删除 assistant/tool 行时前端应连同配对行一起删。
  fastify.delete<{ Params: { messageId: string }, Querystring: { sessionId?: string } }>('/conversation/messages/:messageId', async (request, reply) => {
    const { messageId } = request.params
    const { sessionId } = request.query
    const tenantId = getTenantId(request)
    if (!messageId || !sessionId) return reply.code(400).send(fail(40001, 'messageId and sessionId are required'))
    const removed = await mutateHistory(tenantId, sessionId, 'Message deleted by user',
      () => selectMessages(tenantId, sessionId, messageId), async messages => {
        await removeChildRuns(tenantId, sessionId, messageIds(messages))
        if (messages[0].conversationId) await rootRunStore.deleteTurns(tenantId, sessionId, [messages[0].conversationId])
        await history.deleteMessage(messageId, tenantId)
        return true
      })
    if (removed === null) return reply.code(404).send(fail(40400, 'Message not found in this session'))
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
    const removed = await mutateHistory(tenantId, sessionId, 'History truncated by user',
      () => selectMessages(tenantId, sessionId, messageId, true), async (messages, interruptedTurns) => {
        const target = await history.getMessageById(messageId, tenantId)
        if (!target) return null
        const turnIds = new Set([...interruptedTurns, ...messages.flatMap(message => message.conversationId ? [message.conversationId] : [])])
        // A root may have claimed its identity before its first message was appended.
        const runs = await rootRunStore.list(tenantId, sessionId)
        const targetRun = runs.find(run => run.turnId === messages[0].conversationId)
        if (targetRun) for (const run of runs) if (run.seq >= targetRun.seq) turnIds.add(run.turnId)
        await removeChildRuns(tenantId, sessionId, messageIds(messages))
        await history.deleteMessagesAfterId(target.dbId, sessionId, tenantId)
        await history.deleteMessage(messageId, tenantId)
        await rootRunStore.deleteTurns(tenantId, sessionId, [...turnIds])
        return true
      })
    if (removed === null) return reply.code(404).send(fail(40400, 'Message not found in this session'))
    return reply.code(200).send(success({ success: true, removedFrom: messageId }))
  })

  // POST /conversation/compress  — 压缩当前会话历史
  fastify.post<{ Querystring: { sessionId: string } }>('/conversation/compress', async (request, reply) => {    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }

    const compactHistory = bindHistoryGeneration(history, tenantId, sessionId)
    const messages = await compactHistory.getHistory({ tenantId, sessionId })
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
      const stats = await withHistoryLock(tenantId, async () => {
        // Manual maintenance must not mutate the context under an executing
        // or approval-waiting root. It never cancels the task on the user's behalf.
        if ((await rootRunStore.list(tenantId, sessionId)).some(run => run.status === 'running' || run.status === 'waiting')) return null
        const result = await compactHistory.compress({ tenantId, sessionId }, buildCompactSummarizeFn(llm, { archiveAvailable: compactHistory.retainsArchive === true }), 6)
        return result
      })

      if (!stats) return reply.code(409).send(fail(40900, '当前任务仍在运行或等待应答，请在任务结束后压缩上下文'))
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

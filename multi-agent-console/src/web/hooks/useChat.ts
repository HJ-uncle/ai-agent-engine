import { useCallback, useRef } from 'react'
import { message as antMessage } from 'antd'
import { chatStream, regenerateStream, editMessageStream, conversationApi, cancelChat, messagesApi } from '@core/api'
import { useSessionStore } from '@core/store/session'
import type { Message, ThinkingStep, TokenUsage } from '@core/types'
import { processHistoryMessages } from '@core/utils/processHistory'

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** 解析 content 中的 DeepSeek 错误标记并弹出分级提示 */
function handleDeepSeekErrorInContent(content: string): string {
  const DS_ERR_MARKER = '__DS_ERR__'
  const idx = content.indexOf(DS_ERR_MARKER)
  if (idx === -1) return content

  try {
    const jsonStr = content.slice(idx + DS_ERR_MARKER.length)
    const err = JSON.parse(jsonStr)
    const rechargeUrl = err.rechargeUrl ?? 'https://platform.deepseek.com/top_up'
    switch (err.errorType) {
      case 'DeepSeekInsufficientBalanceError':
        antMessage.error({
          content: `🐋 DeepSeek 余额不足 — ${err.message}。点击充值: ${rechargeUrl}`,
          duration: 8,
        })
        break
      case 'DeepSeekRateLimitError':
        antMessage.warning('🐋 DeepSeek 请求过于频繁，请稍后重试')
        break
      case 'DeepSeekServiceUnavailableError':
        antMessage.error('🐋 DeepSeek 服务暂时不可用，请稍后重试')
        break
      case 'DeepSeekInvalidParamError':
        antMessage.error(`🐋 DeepSeek 参数错误：${err.message}`)
        break
      default:
        break
    }
  } catch { /* 解析失败不影响主流程 */ }

  // 从内容中移除 __DS_ERR__ 标记及其 JSON，保留 [System Error: ...] 部分
  return content.slice(0, idx).trimEnd()
}

/** 从 SSE 事件流中驱动一条 AI 消息 */
function driveAiMessage(
  sid: string,
  aiMsgId: string,
  updateMessage: (sid: string, id: string, updates: Partial<Message>) => void,
  updateUsage: (sid: string, usage: TokenUsage) => void,
  startTime: number,
  initialContent: string = '',
  initialSteps: ThinkingStep[] = [],
  onDone?: () => void,
  onError?: (err: Error) => void,
  /** 之前已经累积的 usage（ask_user 恢复时从消息中传入） */
  previousUsage?: TokenUsage | null
) {
  let finalContent = initialContent
  const thinkingSteps: ThinkingStep[] = [...initialSteps]
  // 恢复之前的累积值（ask_user 恢复场景）
  let accumulatedUsage: TokenUsage | null = previousUsage ? { ...previousUsage } : null
  /** 跟踪上一次提交给 store 的累积值，用于计算增量 */
  let lastReportedUsage: TokenUsage | null = previousUsage ? { ...previousUsage } : null

  const onEvent = (event: any) => {
    if (event.type === 'text_delta') {
      finalContent += event.content ?? ''
      updateMessage(sid, aiMsgId, { content: finalContent, status: 'streaming' })
    } else if (event.type === 'thinking') {
      // ── Bug Fix: 支持思考过程流式输出 ──────────────────────────────────
      const lastStep = thinkingSteps[thinkingSteps.length - 1]
      if (lastStep && lastStep.type === 'thinking') {
        // 如果上一个步骤也是 thinking，则追加内容而不是创建新步骤
        lastStep.text += event.text ?? ''
      } else {
        thinkingSteps.push({ type: 'thinking', text: event.text ?? '' })
      }
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'tool_start') {
      const existingIdx = event.toolCallId ? thinkingSteps.findIndex(s => s.type === 'tool_start' && s.toolCallId === event.toolCallId) : -1
      if (existingIdx !== -1) {
        thinkingSteps[existingIdx] = {
          ...thinkingSteps[existingIdx],
          toolName: event.toolName || event.name,
          toolArgs: event.toolArgs || event.args || (thinkingSteps[existingIdx] as any).toolArgs,
        }
      } else {
        thinkingSteps.push({
          type: 'tool_start',
          toolName: event.toolName || event.name,
          toolArgs: event.toolArgs || event.args,
          toolCallId: event.toolCallId,
        })
      }
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'tool_args') {
      // ── Bug Fix: 支持工具参数流式输出 ──────────────────────────────────
      const existingIdx = event.toolCallId ? thinkingSteps.findIndex(s => s.type === 'tool_start' && s.toolCallId === event.toolCallId) : -1
      if (existingIdx !== -1) {
        const step = thinkingSteps[existingIdx] as any
        if (typeof event.args === 'string') {
          // 如果是字符串 delta，追加到原来的参数字符串上（或者初始化）
          step.toolArgs = (typeof step.toolArgs === 'string' ? step.toolArgs : '') + event.args
        } else if (event.args) {
          // 如果是对象，直接覆盖（兜底逻辑）
          step.toolArgs = event.args
        }
        updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
      }
    } else if (event.type === 'tool_end') {
      // 尝试合并到最近的一个正在运行的 tool_start 步骤中
      const lastToolIdx = [...thinkingSteps].reverse().findIndex(s => s.type === 'tool_start' && s.success === undefined && (event.toolCallId ? s.toolCallId === event.toolCallId : true))
      if (lastToolIdx !== -1) {
        const idx = thinkingSteps.length - 1 - lastToolIdx
        thinkingSteps[idx] = {
          ...thinkingSteps[idx],
          success: event.success,
          outputPreview: event.outputPreview ?? (event.output ?? '').slice(0, 500),
        }
      } else {
        // Fallback: 如果没找到对应的 start，才作为独立步骤（兼容性）
        thinkingSteps.push({
          type: 'tool_end',
          toolCallId: event.toolCallId,
          success: event.success,
          outputPreview: event.outputPreview ?? (event.output ?? '').slice(0, 500),
        })
      }
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'ask_user') {
      const tid = event.data?.toolCallId
      const existingIdx = tid ? thinkingSteps.findIndex(s => s.type === 'tool_start' && s.toolCallId === tid) : -1
      
      if (existingIdx !== -1) {
        // 更新已有的 tool_start 步骤为最终的交互数据
        thinkingSteps[existingIdx] = {
          ...thinkingSteps[existingIdx],
          toolName: 'ask_user',
          toolArgs: event.data,
        }
      } else {
        // 如果不存在（可能是非流式或者之前的 start 帧丢失），则新增
        thinkingSteps.push({
          type: 'tool_start',
          toolName: 'ask_user',
          toolArgs: event.data,
          toolCallId: tid,
        })
      }
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'usage' || event.type === 'token_usage') {
      if (event.usage) {
        const durationMs = Date.now() - startTime
        const u = event.usage as TokenUsage
        
        // ── Bug Fix: 解决 Token 叠加导致的显示虚高问题 ──────────────────────
        // 后端发送的 u (cumulativeUsage) 已经是当前 Turn (一轮对话) 的全量累积值。
        // 前端只需将其与 Turn 之前的全量 (previousUsage) 相加即可，不能直接累加 u 自身，
        // 否则在 ReAct 多轮迭代中会导致 System Prompt 等固定分项被成倍计算。
        accumulatedUsage = {
          promptTokens: (previousUsage?.promptTokens ?? 0) + (u.promptTokens ?? 0),
          completionTokens: (previousUsage?.completionTokens ?? 0) + (u.completionTokens ?? 0),
          totalTokens: (previousUsage?.totalTokens ?? 0) + (u.totalTokens ?? 0),
          systemPromptTokens: (previousUsage?.systemPromptTokens ?? 0) + (u.systemPromptTokens ?? 0),
          messagesTokens: (previousUsage?.messagesTokens ?? 0) + (u.messagesTokens ?? 0),
          skillTokens: (previousUsage?.skillTokens ?? 0) + (u.skillTokens ?? 0),
          systemToolsTokens: (previousUsage?.systemToolsTokens ?? 0) + (u.systemToolsTokens ?? 0),
          ragTokens: (previousUsage?.ragTokens ?? 0) + (u.ragTokens ?? 0),
          builtinToolsTokens: (previousUsage?.builtinToolsTokens ?? 0) + (u.builtinToolsTokens ?? 0),
          mcpToolsTokens: (previousUsage?.mcpToolsTokens ?? 0) + (u.mcpToolsTokens ?? 0),
          toolResultsTokens: (previousUsage?.toolResultsTokens ?? 0) + (u.toolResultsTokens ?? 0),
          userInputTokens: (previousUsage?.userInputTokens ?? 0) + (u.userInputTokens ?? 0),
          cacheHitTokens: (previousUsage?.cacheHitTokens ?? 0) + (u.cacheHitTokens ?? 0),
          cacheMissTokens: (previousUsage?.cacheMissTokens ?? 0) + (u.cacheMissTokens ?? 0),
          reasoningTokens: (previousUsage?.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0),
        }

        updateMessage(sid, aiMsgId, {
          usage: accumulatedUsage,
          durationMs,
          backendMessageId: event.conversationId ?? null,
          modelId: event.modelId || event.model, // Capture modelId
        })
        // 向 store 提交增量而非全量，避免 ask_user 恢复时重复累加固定部分
        const delta: TokenUsage = {
          promptTokens: (accumulatedUsage.promptTokens ?? 0) - (lastReportedUsage?.promptTokens ?? 0),
          completionTokens: (accumulatedUsage.completionTokens ?? 0) - (lastReportedUsage?.completionTokens ?? 0),
          totalTokens: (accumulatedUsage.totalTokens ?? 0) - (lastReportedUsage?.totalTokens ?? 0),
          systemPromptTokens: (accumulatedUsage.systemPromptTokens ?? 0) - (lastReportedUsage?.systemPromptTokens ?? 0),
          messagesTokens: (accumulatedUsage.messagesTokens ?? 0) - (lastReportedUsage?.messagesTokens ?? 0),
          skillTokens: (accumulatedUsage.skillTokens ?? 0) - (lastReportedUsage?.skillTokens ?? 0),
          systemToolsTokens: (accumulatedUsage.systemToolsTokens ?? 0) - (lastReportedUsage?.systemToolsTokens ?? 0),
          ragTokens: (accumulatedUsage.ragTokens ?? 0) - (lastReportedUsage?.ragTokens ?? 0),
          builtinToolsTokens: (accumulatedUsage.builtinToolsTokens ?? 0) - (lastReportedUsage?.builtinToolsTokens ?? 0),
          mcpToolsTokens: (accumulatedUsage.mcpToolsTokens ?? 0) - (lastReportedUsage?.mcpToolsTokens ?? 0),
          toolResultsTokens: (accumulatedUsage.toolResultsTokens ?? 0) - (lastReportedUsage?.toolResultsTokens ?? 0),
          userInputTokens: (accumulatedUsage.userInputTokens ?? 0) - (lastReportedUsage?.userInputTokens ?? 0),
          // ── DeepSeek 专有 delta ──────────────────────────────────────
          cacheHitTokens: (accumulatedUsage.cacheHitTokens ?? 0) - (lastReportedUsage?.cacheHitTokens ?? 0),
          cacheMissTokens: (accumulatedUsage.cacheMissTokens ?? 0) - (lastReportedUsage?.cacheMissTokens ?? 0),
          reasoningTokens: (accumulatedUsage.reasoningTokens ?? 0) - (lastReportedUsage?.reasoningTokens ?? 0),
        }
        lastReportedUsage = { ...accumulatedUsage }
        updateUsage(sid, delta)
      }
    } else if (event.type === 'done') {
      const durationMs = Date.now() - startTime
      updateMessage(sid, aiMsgId, {
        status: 'done',
        content: finalContent,
        thinkingSteps: [...thinkingSteps],
        durationMs,
        // 保留已累积的 usage，不能丢失
        ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
      })
    } else if (event.type === 'error') {
      const durationMs = Date.now() - startTime
      updateMessage(sid, aiMsgId, {
        status: 'error',
        content: `❌ ${event.content ?? 'An error occurred'}`,
        durationMs,
        // 即使报错也保留已累积的 usage
        ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
      })
    }
  }

  const handleDone = () => {
    const durationMs = Date.now() - startTime
    // 检查是否包含 DeepSeek 特有错误标记，触发分级提示
    const cleanedContent = handleDeepSeekErrorInContent(finalContent)
    updateMessage(sid, aiMsgId, {
      status: 'done',
      content: cleanedContent,
      thinkingSteps: [...thinkingSteps],
      durationMs,
      // 保留已累积的 usage
      ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
    })
    onDone?.()
    // 触发待办任务刷新（AI 操作完成后可能创建/修改了待办）
    useSessionStore.getState().triggerTodosRefresh()
  }

  const handleError = (err: Error) => {
    const durationMs = Date.now() - startTime
    updateMessage(sid, aiMsgId, {
      status: 'error',
      content: `❌ ${err.message}`,
      durationMs,
      // 即使报错也保留已累积的 usage
      ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
    })
    onError?.(err)
  }

  return { onEvent, handleDone, handleError }
}

export function useChat() {
  const {
    activeSessionId,
    addMessage,
    setMessages,
    updateMessage,
    updateUsage,
    updateSessionTitle,
  } = useSessionStore()

  /**
   * 每个会话独立的 AbortController。
   * 修复 Bug：之前 abortRef 是单例，多会话切换/并发时会互相覆盖；
   * 现在按 sessionId 隔离，cancel(sid) 只终止指定会话。
   */
  const abortMapRef = useRef<Map<string, AbortController>>(new Map())

  const startStream = useCallback((sid: string): AbortController => {
    // 同会话已有运行中的流：先 abort 旧的
    const prev = abortMapRef.current.get(sid)
    if (prev && !prev.signal.aborted) {
      try { prev.abort() } catch { /* noop */ }
    }
    const ctrl = new AbortController()
    abortMapRef.current.set(sid, ctrl)
    useSessionStore.getState().markSessionRunning(sid)
    return ctrl
  }, [])

  const finishStream = useCallback((sid: string, ctrl: AbortController) => {
    // 仅当注册的还是同一个 controller 时才清理（避免误删后续新流）
    if (abortMapRef.current.get(sid) === ctrl) {
      abortMapRef.current.delete(sid)
    }
    useSessionStore.getState().markSessionDone(sid)
  }, [])

  /** 获取历史消息 */
  const fetchHistory = useCallback(
    async (sessionId?: string, options?: { force?: boolean }) => {
      const sid = sessionId ?? activeSessionId
      if (!sid) return

      // ── Bug 4 修复 ─────────────────────────────────────────────────────
      // 如果该会话正在流式生成中，跳过 fetchHistory，避免覆盖正在流式的消息。
      // 切换走→切换回时常见此问题：fetchHistory 会用 backend 数据替换 messageMap[sid]，
      // 把还没入库的流式 AI 消息（含已收到的 token）抹掉，导致前端「断流」假象。
      // 用户主动刷新（如点击重新加载）可传 { force: true } 强制覆盖。
      if (!options?.force) {
        const isRunning = useSessionStore.getState().runningSessions[sid]
        if (isRunning) {
          // 仍然存在的流仍在写 messageMap[sid]，无需重新拉历史
          return
        }
      }

      try {
        const { list, metadata } = await conversationApi.getHistory(sid)
  
        // ★ 使用共用的 processHistoryMessages 工具函数解析历史消息
        //    合并 reasoningContent / toolCall / tool_role → thinkingSteps[]
        //    与移动端保持完全一致
        const { messages: msgs, totalUsage } = processHistoryMessages(list, metadata?.sessionUsage)
  
        setMessages(sid, msgs)
        useSessionStore.setState((state) => ({
          usageMap: { ...state.usageMap, [sid]: totalUsage }
        }))
      } catch (err) {
        console.error('Fetch history failed:', err)
      }
    },
    [activeSessionId, setMessages],
  )

  /** 新消息发送 */
  const send = useCallback(
    async (content: string | any[], sessionId?: string, attachments?: Array<{ name: string; content: string; type: string; encoding?: 'utf-8' | 'base64' }>) => {
      const sid = sessionId ?? activeSessionId
      const session = useSessionStore.getState().sessions.find((s) => s.id === sid)
      const agentId = session?.agentId
      const maxAskUserCount = useSessionStore.getState().maxAskUserCount
      const thinkingMode = useSessionStore.getState().thinkingMode
      const inheritContext = session?.inheritContext ?? true
      const workspacePaths = session?.workspacePaths

      // 1. 添加用户消息（前端本地，仅用于显示）
      const userMsg: Message = {
        id: genId(),
        role: 'user',
        content,
        status: 'done',
        createdAt: Date.now(),
      }
      addMessage(sid, userMsg)

      // 获取文本内容（处理多模态数组情况）
      const getTextForTitle = (c: any): string => {
        if (typeof c === 'string') return c
        if (Array.isArray(c)) {
          return c
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('')
        }
        return String(c)
      }
      
      // 自动标题（仅第一条消息）
      const currentMsgs = useSessionStore.getState().messageMap[sid] ?? []
      const userMsgs = currentMsgs.filter((m) => m.role === 'user')
      if (userMsgs.length <= 1) {
        const titleText = getTextForTitle(content)
        updateSessionTitle(sid, titleText.slice(0, 30) + (titleText.length > 30 ? '...' : ''))
      }

      // 2. 添加占位 AI 消息
      const aiMsgId = genId()
      const aiMsg: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now(),
        thinkingSteps: [],
      }
      addMessage(sid, aiMsg)

      const ctrl = startStream(sid)
      const startTime = Date.now()

      const { onEvent: onAiEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, startTime, '', [],
        () => finishStream(sid, ctrl),
        () => finishStream(sid, ctrl),
      )

      // 包裹 onEvent：拦截 user_msg_id 帧，其余事件转发给 driveAiMessage
      const onEvent = (event: any) => {
        if (event.type === 'user_msg_id' && event.userMsgId) {
          // ★ 将后端落库后的 message_id 写回 userMsg，用于后续删除/重发时的精确定位
          updateMessage(sid, userMsg.id, { backendMessageId: event.userMsgId })
          return
        }
        onAiEvent(event)
      }

      try {
        await chatStream({
          message: content,
          sessionId: sid,
          agentId,
          maxAskUserCount,
          thinkingMode,
          inheritContext,
          workspacePaths,
          attachments,
          signal: ctrl.signal,
          onEvent,
          onDone: handleDone,
          onError: handleError,
        })
      } finally {
        finishStream(sid, ctrl)
      }
    },
    [activeSessionId, addMessage, updateMessage, updateUsage, updateSessionTitle, startStream, finishStream],
  )

  /** 重新生成（调用后端 /messages/:id/regenerate SSE 接口）*/
  const regenerate = useCallback(
    async (sessionId?: string) => {
      const sid = sessionId ?? activeSessionId
      const msgs = useSessionStore.getState().messageMap[sid] ?? []

      // ★ Fix: backendMessageId 是 SSE 完成后写入的实际后端 ID，conversationId 是兼容旧字段。
      //        两者都要查，取到任何一个都视为"有后端 ID"。
      const getBackendId = (m: Message) => m.backendMessageId || m.conversationId || null

      const lastAi = [...msgs].reverse().find(
        (m) => m.role === 'assistant' && !!getBackendId(m),
      )
      const backendAiId = lastAi ? getBackendId(lastAi) : null

      if (!backendAiId) {
        // ── CASE 2: 消息尚未落库（如刚发送中断），退回到删前端 + 重发 ──────────
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
        if (lastUser) {
          // ★ Fix: 顺带删后端残留（若有 backendMessageId 就调一次 DELETE）
          const msgsToClean = msgs.slice(msgs.findIndex((m) => m.id === lastUser.id))
          for (const m of msgsToClean) {
            const bid = getBackendId(m)
            if (bid) await messagesApi.delete(bid).catch(() => {})
          }
          useSessionStore.getState().deleteMessagesAfter(sid, lastUser.id)
          useSessionStore.getState().deleteMessage(sid, lastUser.id)
          await send(lastUser.content as string | any[], sid)
        }
        return
      }

      // ── CASE 1: 有后端 ID，交由后端 /regenerate 删旧数据并重新生成 ─────────
      // 先清前端 store 中 lastAi 及其之后的消息
      const aiIdx = msgs.findIndex((m) => m.id === lastAi!.id)
      if (aiIdx >= 0) {
        msgs.slice(aiIdx + 1).forEach((m) => useSessionStore.getState().deleteMessage(sid, m.id))
      }
      useSessionStore.getState().deleteMessage(sid, lastAi!.id)

      const aiMsgId = genId()
      addMessage(sid, {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now(),
        thinkingSteps: [],
      })

      const ctrl = startStream(sid)
      const thinkingMode = useSessionStore.getState().thinkingMode
      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, Date.now(), '', [],
        () => finishStream(sid, ctrl),
        () => finishStream(sid, ctrl),
      )

      try {
        await regenerateStream({
          messageId: backendAiId,   // ← 用真实后端 ID
          thinkingMode,
          signal: ctrl.signal,
          onEvent,
          onDone: handleDone,
          onError: handleError,
        })
      } finally {
        finishStream(sid, ctrl)
      }
    },
    [activeSessionId, addMessage, updateMessage, updateUsage, send, startStream, finishStream],
  )

  /** 编辑用户消息并重新生成（调用后端 PUT /messages/:id SSE 接口）*/
  const editAndResend = useCallback(
    async (msgId: string, newContent: string, sessionId?: string) => {
      const sid = sessionId ?? activeSessionId
      const msgs = useSessionStore.getState().messageMap[sid] ?? []
      const msg = msgs.find((m) => m.id === msgId)

      // ★ Fix: 同 regenerate，统一使用 backendMessageId || conversationId
      const backendMsgId = msg?.backendMessageId || msg?.conversationId || null

      if (!backendMsgId) {
        // ── CASE 2: 消息未落库，清后端残留 + 重发 ───────────────────────────
        const msgIdx = msgs.findIndex((m) => m.id === msgId)
        if (msgIdx >= 0) {
          const msgsToClean = msgs.slice(msgIdx)
          for (const m of msgsToClean) {
            const bid = m.backendMessageId || m.conversationId
            if (bid) await messagesApi.delete(bid).catch(() => {})
          }
        }
        useSessionStore.getState().deleteMessagesAfter(sid, msgId)
        useSessionStore.getState().deleteMessage(sid, msgId)
        await send(newContent, sid)
        return
      }

      // ── CASE 1: 有后端 ID，由 PUT /messages/:id 更新内容 + 删后续 + 重生成 ─
      useSessionStore.getState().editUserMessage(sid, msgId, newContent)
      useSessionStore.getState().deleteMessagesAfter(sid, msgId)

      const aiMsgId = genId()
      addMessage(sid, {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now(),
        thinkingSteps: [],
      })

      const ctrl = startStream(sid)
      const thinkingMode = useSessionStore.getState().thinkingMode
      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, Date.now(), '', [],
        () => finishStream(sid, ctrl),
        () => finishStream(sid, ctrl),
      )

      try {
        await editMessageStream({
          messageId: backendMsgId,   // ← 用真实后端 ID
          content: newContent,
          thinkingMode,
          signal: ctrl.signal,
          onEvent,
          onDone: handleDone,
          onError: handleError,
        })
      } finally {
        finishStream(sid, ctrl)
      }
    },
    [activeSessionId, addMessage, updateMessage, updateUsage, send, startStream, finishStream],
  )

  /** 工具栏交互提交：无需创建新的用户消息，而是直接继续当前会话的流式生成 */
  const sendToolResponse = useCallback(
    async (msgId: string, toolCallId: string, toolName: string, output: string, sessionId?: string) => {
      const sid = sessionId ?? activeSessionId
      const session = useSessionStore.getState().sessions.find((s) => s.id === sid)
      const agentId = session?.agentId
      const maxAskUserCount = useSessionStore.getState().maxAskUserCount
      const thinkingMode = useSessionStore.getState().thinkingMode
      const msgs = useSessionStore.getState().messageMap[sid] ?? []
      const aiMsg = msgs.find((m) => m.id === msgId)
      if (!aiMsg) return

      const updatedSteps = [...(aiMsg.thinkingSteps || [])]
      const lastToolIdx = [...updatedSteps].reverse().findIndex(s => s.type === 'tool_start' && s.success === undefined && s.toolName === toolName && (s.toolCallId ? s.toolCallId === toolCallId : true))
      if (lastToolIdx !== -1) {
        const idx = updatedSteps.length - 1 - lastToolIdx
        updatedSteps[idx] = {
          ...updatedSteps[idx],
          success: true,
          outputPreview: output.slice(0, 500)
        }
      }

      updateMessage(sid, msgId, {
        status: 'streaming',
        thinkingSteps: updatedSteps,
      })

      const ctrl = startStream(sid)
      const startTime = Date.now() - (aiMsg.durationMs ?? 0)

      // 传入之前已累积的 usage，避免 ask_user 恢复后 token 重新从零计算
      const prevUsage = (aiMsg.usage as TokenUsage) ?? null
      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, msgId, updateMessage, updateUsage, startTime, typeof aiMsg.content === 'string' ? aiMsg.content : '', updatedSteps,
        () => finishStream(sid, ctrl),
        () => finishStream(sid, ctrl),
        prevUsage
      )

      try {
        await chatStream({
          message: '',
          sessionId: sid,
          agentId,
          maxAskUserCount,
          thinkingMode,
          toolResponse: { toolCallId, name: toolName, output },
          signal: ctrl.signal,
          onEvent,
          onDone: handleDone,
          onError: handleError,
        })
      } finally {
        finishStream(sid, ctrl)
      }
    },
    [activeSessionId, updateMessage, updateUsage, startStream, finishStream]
  )

  /**
   * 取消会话流式生成。
   * 1. 前端 abort fetch（释放本地连接）
   * 2. 调用后端 /chat/cancel（兜底，确保后端 agent 立即停）
   * 3. 标记会话为 done
   * @param sessionId 不传则取消当前激活的会话
   */
  const cancel = useCallback(async (sessionId?: string) => {
    const sid = sessionId ?? activeSessionId
    if (!sid) return
    const ctrl = abortMapRef.current.get(sid)
    if (ctrl && !ctrl.signal.aborted) {
      try { ctrl.abort() } catch { /* noop */ }
    }
    abortMapRef.current.delete(sid)
    useSessionStore.getState().markSessionDone(sid)
    // 兜底：通知后端立即停止（即使前端 fetch 已 abort，后端可能还没感知到）
    try {
      await cancelChat(sid)
    } catch {
      // 忽略：cancel 仅作兜底，失败不影响前端体验
    }
    // 把还在 streaming 的占位 AI 消息标记为已完成
    const msgs = useSessionStore.getState().messageMap[sid] ?? []
    const streamingMsg = [...msgs].reverse().find((m) => m.status === 'streaming')
    if (streamingMsg) {
      useSessionStore.getState().updateMessage(sid, streamingMsg.id, {
        status: 'done',
        content: typeof streamingMsg.content === 'string' && streamingMsg.content
          ? streamingMsg.content + '\n\n[已停止]'
          : '[已停止]',
      })
    }
  }, [activeSessionId])

  /**
   * 删除一条消息并同步到后端 DB（幂等，前后端同步删除）。
   *
   * 规则：
   * - 删除「用户消息」→ 级联删除其后所有属于同一轮次的消息
   *   （tool_call 中间行、tool 结果行、assistant 最终行，直到下一条 user 消息或末尾）
   * - 删除「AI/tool 消息」→ 只删该条（后端会通过 conversation_id 清整轮 non-user 行）
   *
   * 修复 Bug: 之前只删前端 store，刷新后从后端拉回历史 → 消息复活。
   */
  const deleteMessageAndPersist = useCallback(
    async (sessionId: string, messageId: string) => {
      const msgs = useSessionStore.getState().messageMap[sessionId] ?? []
      const msgIdx = msgs.findIndex((m) => m.id === messageId)
      const msg = msgs[msgIdx]
      if (!msg) return

      // ── Step 0: 先 cancel 正在运行的流，防止后端继续写 DB ────────────
      // 根因：agent loop 仍在运行时，用户删除消息，DELETE 执行完后 loop 继续 append → DB 复活
      const isRunning = useSessionStore.getState().runningSessions[sessionId]
      if (isRunning) {
        // 通知后端停止 agent loop（兜底，即使前端 fetch 已经关闭了也要确保后端停止写 DB）
        cancelChat(sessionId).catch(() => {})
        // 标记 session 为 done，防止 UI 继续显示 streaming 状态
        useSessionStore.getState().markSessionDone(sessionId)
        // 等待后端处理 cancel 指令，避免 race condition（cancel 后立即 DELETE，DB 还在被写）
        await new Promise((resolve) => setTimeout(resolve, 400))
      }

      // ── 收集需要从前端 store 清除的消息 ─────────────────────────────
      // 规则：删除一轮对话中的任意一条消息，都视为删除整轮（User + AI + Tools）
      const toDeleteFromStore: typeof msgs = []
      let startIdx = msgIdx

      // 往回找，找到这轮对话的起点（最近的一个 user 消息）
      while (startIdx > 0 && msgs[startIdx].role !== 'user') {
        startIdx--
      }

      // 从起点开始，收集到下一个 user 消息之前的所有消息
      toDeleteFromStore.push(msgs[startIdx])
      for (let i = startIdx + 1; i < msgs.length; i++) {
        if (msgs[i].role === 'user') break
        toDeleteFromStore.push(msgs[i])
      }

      // ── 先调后端删除（幂等，失败容错） ───────────────────────────────
      // 对 user 消息：user 本身 + 同一轮次所有 AI/tool 行（含多个 conversation_id）
      //   → 对每一个有 backendId 的消息都单独调一次 DELETE，后端会按 conversation_id 级联清轮
      // 对 ai/tool 消息：只删这一条（后端会级联删同 conversation_id 的整轮）

      // 收集所有需要通知后端删除的 backendId（去重，避免同 conversation_id 重复调用）
      const deletedConvIds = new Set<string>()
      const backendDeleteTasks: string[] = []

      for (const m of toDeleteFromStore) {
        const bid = m.backendMessageId || m.conversationId
        if (!bid) continue

        // 以 conversationId 去重（同一轮次只调一次，避免后端重复删）
        const dedupeKey = m.conversationId || bid
        if (deletedConvIds.has(dedupeKey)) continue
        deletedConvIds.add(dedupeKey)
        backendDeleteTasks.push(bid)
      }

      console.log('[deleteMessage] toDelete store ids:', toDeleteFromStore.map(m => ({ id: m.id, role: m.role, backendMessageId: m.backendMessageId, conversationId: m.conversationId })))
      console.log('[deleteMessage] backend delete tasks:', backendDeleteTasks)

      // 并发删除，互不依赖
      const doBackendDelete = () => Promise.all(
        backendDeleteTasks.map((bid) =>
          messagesApi.delete(bid).catch((e) => {
            console.warn('[deleteMessage] backend delete warn:', bid, e)
          }),
        ),
      )

      await doBackendDelete()

      // ── 若之前有流在跑，cancel 后再做一次二次删除 ──────────────────────
      // 原因：cancel 信号到达后端 → agent loop 停止 → 可能最后一次 append 已在 cancel 前写入
      // 二次删除（在等待后）可清理这部分残留
      if (isRunning) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        await doBackendDelete()
      }

      // ── 再清前端 store ────────────────────────────────────────────────
      for (const m of toDeleteFromStore) {
        useSessionStore.getState().deleteMessage(sessionId, m.id)
      }
    },
    [],
  )

  return { send, regenerate, editAndResend, fetchHistory, cancel, sendToolResponse, deleteMessage: deleteMessageAndPersist }
}
import { useCallback, useRef } from 'react'
import { chatStream, regenerateStream, editMessageStream, conversationApi } from '../api'
import { useSessionStore } from '../store/session'
import type { Message, ThinkingStep, TokenUsage } from '../types'

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
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
      thinkingSteps.push({ type: 'thinking', text: event.text ?? '' })
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'tool_start') {
      thinkingSteps.push({
        type: 'tool_start',
        toolName: event.toolName || event.name,
        toolArgs: event.toolArgs || event.args,
        toolCallId: event.toolCallId,
      })
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
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
    } else if (event.type === 'usage' || event.type === 'token_usage') {
      if (event.usage) {
        const durationMs = Date.now() - startTime
        const u = event.usage as TokenUsage
        // Accumulate usage across multiple rounds (e.g. tool-call loops)
        if (!accumulatedUsage) {
          accumulatedUsage = { ...u }
        } else {
          accumulatedUsage = {
            promptTokens: (accumulatedUsage.promptTokens ?? 0) + (u.promptTokens ?? 0),
            completionTokens: (accumulatedUsage.completionTokens ?? 0) + (u.completionTokens ?? 0),
            totalTokens: (accumulatedUsage.totalTokens ?? 0) + (u.totalTokens ?? 0),
            systemPromptTokens: (accumulatedUsage.systemPromptTokens ?? 0) + (u.systemPromptTokens ?? 0),
            messagesTokens: (accumulatedUsage.messagesTokens ?? 0) + (u.messagesTokens ?? 0),
            skillTokens: (accumulatedUsage.skillTokens ?? 0) + (u.skillTokens ?? 0),
            systemToolsTokens: (accumulatedUsage.systemToolsTokens ?? 0) + (u.systemToolsTokens ?? 0),
            ragTokens: (accumulatedUsage.ragTokens ?? 0) + (u.ragTokens ?? 0),
            builtinToolsTokens: (accumulatedUsage.builtinToolsTokens ?? 0) + (u.builtinToolsTokens ?? 0),
            mcpToolsTokens: (accumulatedUsage.mcpToolsTokens ?? 0) + (u.mcpToolsTokens ?? 0),
            toolResultsTokens: (accumulatedUsage.toolResultsTokens ?? 0) + (u.toolResultsTokens ?? 0),
          }
        }
        updateMessage(sid, aiMsgId, {
          usage: accumulatedUsage,
          durationMs,
          backendMessageId: event.conversationId ?? null,
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
    updateMessage(sid, aiMsgId, {
      status: 'done',
      content: finalContent,
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

  const abortRef = useRef<AbortController | null>(null)

  /** 获取历史消息 */
  const fetchHistory = useCallback(
    async (sessionId?: string) => {
      const sid = sessionId ?? activeSessionId
      if (!sid) return
      
      try {
        const { list } = await conversationApi.getHistory(sid)
        const msgs: Message[] = []
        let currentThinkingSteps: ThinkingStep[] = []
        // Accumulate usage across tool-call rounds for a single assistant turn
        let currentRoundUsage: TokenUsage | null = null

        const accumulateUsage = (usage: TokenUsage | undefined | null) => {
          if (!usage) return
          if (!currentRoundUsage) {
            currentRoundUsage = { ...usage }
          } else {
            currentRoundUsage.promptTokens = (currentRoundUsage.promptTokens ?? 0) + (usage.promptTokens ?? 0)
            currentRoundUsage.completionTokens = (currentRoundUsage.completionTokens ?? 0) + (usage.completionTokens ?? 0)
            currentRoundUsage.totalTokens = (currentRoundUsage.totalTokens ?? 0) + (usage.totalTokens ?? 0)
            currentRoundUsage.systemPromptTokens = (currentRoundUsage.systemPromptTokens ?? 0) + (usage.systemPromptTokens ?? 0)
            currentRoundUsage.messagesTokens = (currentRoundUsage.messagesTokens ?? 0) + (usage.messagesTokens ?? 0)
            currentRoundUsage.skillTokens = (currentRoundUsage.skillTokens ?? 0) + (usage.skillTokens ?? 0)
            currentRoundUsage.systemToolsTokens = (currentRoundUsage.systemToolsTokens ?? 0) + (usage.systemToolsTokens ?? 0)
            currentRoundUsage.ragTokens = (currentRoundUsage.ragTokens ?? 0) + (usage.ragTokens ?? 0)
            currentRoundUsage.builtinToolsTokens = (currentRoundUsage.builtinToolsTokens ?? 0) + (usage.builtinToolsTokens ?? 0)
            currentRoundUsage.mcpToolsTokens = (currentRoundUsage.mcpToolsTokens ?? 0) + (usage.mcpToolsTokens ?? 0)
            currentRoundUsage.toolResultsTokens = (currentRoundUsage.toolResultsTokens ?? 0) + (usage.toolResultsTokens ?? 0)
          }
        }

        for (const m of list) {
          if (m.role === 'user') {
            msgs.push({
              id: m.id || `hist-u-${m.createdAt}-${Math.random()}`,
              role: 'user',
              content: m.content,
              status: 'done',
              createdAt: m.createdAt || Date.now(),
              backendMessageId: m.id, // Backend message_id for regenerate/edit
            })
            currentThinkingSteps = []
            currentRoundUsage = null
          } else if (m.role === 'assistant') {
            // Accumulate usage from every assistant message in this round (including tool-call intermediates)
            accumulateUsage(m.usage)
            if (m.reasoningContent?.trim()) {
              currentThinkingSteps.push({ type: 'thinking', text: m.reasoningContent })
            }
            if (m.toolCall) {
              // 只有在没有 reasoningContent 的情况下，才把 content 当作旧模型的思考过程
              // 如果已经有 reasoningContent，那么 content 只是工具调用前的一些闲聊文本，不应作为思考过程展示
              if (m.content?.trim() && !m.reasoningContent?.trim()) {
                currentThinkingSteps.push({ type: 'thinking', text: m.content })
              }
              currentThinkingSteps.push({
                type: 'tool_start',
                toolName: m.toolCall.name,
                toolArgs: m.toolCall.args,
                toolCallId: m.toolCallId,
              })
            } else {
              msgs.push({
                id: m.id || `hist-a-${m.createdAt}-${Math.random()}`,
                role: 'assistant',
                content: m.content,
                status: 'done',
                createdAt: m.createdAt || Date.now(),
                backendMessageId: m.id, // Backend message_id for regenerate/edit
                usage: currentRoundUsage || m.usage || null,
                thinkingSteps: [...currentThinkingSteps],
              })
              currentThinkingSteps = []
              currentRoundUsage = null
            }
          } else if (m.role === 'tool') {
            const contentStr = String(m.content || '')
            const isError = contentStr.startsWith('Tool error:') ||
                        contentStr.startsWith('Command timed out') ||
                        contentStr.startsWith('Failed to execute command') ||
                        (contentStr.includes('exited with code') && !contentStr.includes('exited with code 0'))
        
            const lastToolIdx = [...currentThinkingSteps].reverse().findIndex(s => s.type === 'tool_start' && s.success === undefined && (m.toolCallId ? s.toolCallId === m.toolCallId : true))
            if (lastToolIdx !== -1) {
              const idx = currentThinkingSteps.length - 1 - lastToolIdx
              currentThinkingSteps[idx] = {
                ...currentThinkingSteps[idx],
                success: !isError,
                outputPreview: contentStr.slice(0, 500),
              }
            } else {
              // If we can't find a matching start, check if it's the ask_user tool response
              if (m.toolName === 'ask_user') {
                const askUserStepIdx = currentThinkingSteps.findIndex(s => s.type === 'tool_start' && s.toolName === 'ask_user' && s.success === undefined)
                if (askUserStepIdx !== -1) {
                  currentThinkingSteps[askUserStepIdx].success = true
                  currentThinkingSteps[askUserStepIdx].outputPreview = contentStr.slice(0, 500)
                }
              } else {
                currentThinkingSteps.push({
                  type: 'tool_end',
                  toolCallId: m.toolCallId,
                  success: !isError,
                  outputPreview: contentStr.slice(0, 500),
                })
              }
            }
          }
        }

        if (currentThinkingSteps.length > 0) {
          msgs.push({
            id: `hist-a-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: Date.now(),
            thinkingSteps: currentThinkingSteps,
            usage: currentRoundUsage || null,
          })
          currentRoundUsage = null
        }

        const totalUsage: TokenUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          systemPromptTokens: 0,
          messagesTokens: 0,
          skillTokens: 0,
          systemToolsTokens: 0,
          ragTokens: 0,
          builtinToolsTokens: 0,
          mcpToolsTokens: 0,
          toolResultsTokens: 0,
        }
        
        // Sum usage from the raw backend list so we include intermediate tool calls
        for (const m of list) {
          if (m.usage) {
            totalUsage.promptTokens! += m.usage.promptTokens || 0
            totalUsage.completionTokens! += m.usage.completionTokens || 0
            totalUsage.totalTokens += m.usage.totalTokens || 0
            totalUsage.systemPromptTokens! += m.usage.systemPromptTokens || 0
            totalUsage.messagesTokens! += m.usage.messagesTokens || 0
            totalUsage.skillTokens! += m.usage.skillTokens || 0
            totalUsage.systemToolsTokens! += m.usage.systemToolsTokens || 0
            totalUsage.ragTokens! += m.usage.ragTokens || 0
            totalUsage.builtinToolsTokens! += m.usage.builtinToolsTokens || 0
            totalUsage.mcpToolsTokens! += m.usage.mcpToolsTokens || 0
            totalUsage.toolResultsTokens! += m.usage.toolResultsTokens || 0
          }
          if (m.role === 'system') {
            msgs.push({
              id: m.id || `hist-s-${m.createdAt}-${Math.random()}`,
              role: 'system',
              content: m.content,
              status: 'done',
              createdAt: m.createdAt || Date.now(),
              backendMessageId: m.id,
              usage: m.usage || null,
            })
          }
        }

        // Add sorting by createdAt to ensure correct order
        msgs.sort((a, b) => a.createdAt - b.createdAt)

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

      const ctrl = new AbortController()
      abortRef.current = ctrl
      const startTime = Date.now()

      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, startTime, '', []
      )

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
    },
    [activeSessionId, addMessage, updateMessage, updateUsage, updateSessionTitle],
  )

  /** 重新生成（调用后端 /messages/:id/regenerate SSE 接口）*/
  const regenerate = useCallback(
    async (sessionId?: string) => {
      const sid = sessionId ?? activeSessionId
      const msgs = useSessionStore.getState().messageMap[sid] ?? []
      const lastAi = [...msgs].reverse().find((m) => m.role === 'assistant' && m.conversationId)

      if (!lastAi?.conversationId) {
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
        if (lastUser) {
          // 删除 lastUser 及其之后的所有消息（包括 AI 消息），再由 send() 重新添加 user 消息
          useSessionStore.getState().deleteMessagesAfter(sid, lastUser.id)
          useSessionStore.getState().deleteMessage(sid, lastUser.id)
          // 直接传原始 content（string 或 array），不能 JSON.stringify，否则数组会变成 JSON 文本
          await send(lastUser.content as string | any[], sid)
        }
        return
      }

      const aiIdx = msgs.findIndex((m) => m.id === lastAi.id)
      if (aiIdx >= 0) {
        const msgsAfterAi = msgs.slice(aiIdx + 1)
        msgsAfterAi.forEach((m) => useSessionStore.getState().deleteMessage(sid, m.id))
      }
      useSessionStore.getState().deleteMessage(sid, lastAi.id)

      const aiMsgId = genId()
      const placeholder: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now(),
        thinkingSteps: [],
      }
      addMessage(sid, placeholder)

      const ctrl = new AbortController()
      abortRef.current = ctrl
      const startTime = Date.now()

      const thinkingMode = useSessionStore.getState().thinkingMode

      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, startTime, '', []
      )

      await regenerateStream({
        messageId: lastAi.conversationId!,
        thinkingMode,
        signal: ctrl.signal,
        onEvent,
        onDone: handleDone,
        onError: handleError,
      })
    },
    [activeSessionId, addMessage, updateMessage, updateUsage, send],
  )

  /** 编辑用户消息并重新生成（调用后端 PUT /messages/:id SSE 接口）*/
  const editAndResend = useCallback(
    async (msgId: string, newContent: string, sessionId?: string) => {
      const sid = sessionId ?? activeSessionId
      const msgs = useSessionStore.getState().messageMap[sid] ?? []
      const msg = msgs.find((m) => m.id === msgId)

      if (!msg?.conversationId) {
        // 删除原始 user 消息及其后续，send() 会重新添加新的 user 消息
        useSessionStore.getState().deleteMessagesAfter(sid, msgId)
        useSessionStore.getState().deleteMessage(sid, msgId)
        await send(newContent, sid)
        return
      }

      useSessionStore.getState().editUserMessage(sid, msgId, newContent)
      useSessionStore.getState().deleteMessagesAfter(sid, msgId)

      const aiMsgId = genId()
      const placeholder: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now(),
        thinkingSteps: [],
      }
      addMessage(sid, placeholder)

      const ctrl = new AbortController()
      abortRef.current = ctrl
      const startTime = Date.now()
      const thinkingMode = useSessionStore.getState().thinkingMode

      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, startTime, '', []
      )

      await editMessageStream({
        messageId: msg.conversationId!,
        content: newContent,
        thinkingMode,
        signal: ctrl.signal,
        onEvent,
        onDone: handleDone,
        onError: handleError,
      })
    },
    [activeSessionId, addMessage, updateMessage, updateUsage, send],
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

      const ctrl = new AbortController()
      abortRef.current = ctrl
      const startTime = Date.now() - (aiMsg.durationMs ?? 0)

      // 传入之前已累积的 usage，避免 ask_user 恢复后 token 重新从零计算
      const prevUsage = (aiMsg.usage as TokenUsage) ?? null
      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, msgId, updateMessage, updateUsage, startTime, typeof aiMsg.content === 'string' ? aiMsg.content : '', updatedSteps,
        undefined, undefined, prevUsage
      )

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
    },
    [activeSessionId, updateMessage, updateUsage]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  return { send, regenerate, editAndResend, fetchHistory, cancel, sendToolResponse }
}
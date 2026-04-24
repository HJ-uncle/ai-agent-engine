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
  onDone?: () => void,
  onError?: (err: Error) => void
) {
  let finalContent = ''
  const thinkingSteps: ThinkingStep[] = []

  const onEvent = (event: any) => {
    if (event.type === 'text_delta') {
      finalContent += event.content ?? ''
      updateMessage(sid, aiMsgId, { content: finalContent, status: 'streaming' })
    } else if (event.type === 'thinking') {
      thinkingSteps.push({ type: 'thinking', text: event.text ?? '' })
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'tool_start') {
      thinkingSteps.push({ type: 'tool_start', toolName: event.toolName, toolArgs: event.toolArgs })
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'tool_end') {
      // 尝试合并到最近的一个正在运行的 tool_start 步骤中
      const lastToolIdx = [...thinkingSteps].reverse().findIndex(s => s.type === 'tool_start' && s.success === undefined)
      if (lastToolIdx !== -1) {
        const idx = thinkingSteps.length - 1 - lastToolIdx
        thinkingSteps[idx] = {
          ...thinkingSteps[idx],
          success: event.success,
          outputPreview: (event.output ?? '').slice(0, 200),
        }
      } else {
        // Fallback: 如果没找到对应的 start，才作为独立步骤（兼容性）
        thinkingSteps.push({
          type: 'tool_end',
          success: event.success,
          outputPreview: (event.output ?? '').slice(0, 200),
        })
      }
      updateMessage(sid, aiMsgId, { thinkingSteps: [...thinkingSteps] })
    } else if (event.type === 'usage' || event.type === 'token_usage') {
      if (event.usage) {
        const durationMs = Date.now() - startTime
        updateMessage(sid, aiMsgId, {
          usage: event.usage,
          durationMs,
          conversationId: event.conversationId ?? null,
        })
        updateUsage(sid, event.usage as TokenUsage)
      }
    } else if (event.type === 'done') {
      const durationMs = Date.now() - startTime
      updateMessage(sid, aiMsgId, {
        status: 'done',
        content: finalContent,
        thinkingSteps: [...thinkingSteps],
        durationMs,
      })
    } else if (event.type === 'error') {
      updateMessage(sid, aiMsgId, {
        status: 'error',
        content: `❌ ${event.content ?? 'An error occurred'}`,
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
    })
    onDone?.()
  }

  const handleError = (err: Error) => {
    updateMessage(sid, aiMsgId, { status: 'error', content: `❌ ${err.message}` })
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

        for (const m of list) {
          if (m.role === 'user') {
            msgs.push({
              id: m.id || `hist-u-${m.createdAt}-${Math.random()}`,
              role: 'user',
              content: m.content,
              status: 'done',
              createdAt: m.createdAt || Date.now(),
              conversationId: m.id, // Backend message_id for regenerate/edit
            })
            currentThinkingSteps = []
          } else if (m.role === 'assistant') {
            if (m.toolCall) {
              if (m.content?.trim()) {
                currentThinkingSteps.push({ type: 'thinking', text: m.content })
              }
              currentThinkingSteps.push({
                type: 'tool_start',
                toolName: m.toolCall.name,
                toolArgs: m.toolCall.args,
              })
            } else {
              msgs.push({
                id: m.id || `hist-a-${m.createdAt}-${Math.random()}`,
                role: 'assistant',
                content: m.content,
                status: 'done',
                createdAt: m.createdAt || Date.now(),
                conversationId: m.id, // Backend message_id for regenerate/edit
                usage: m.usage || null,
                thinkingSteps: [...currentThinkingSteps],
              })
              currentThinkingSteps = []
            }
          } else if (m.role === 'tool') {
            const isError = typeof m.content === 'string' && m.content.startsWith('Tool error:')
            currentThinkingSteps.push({
              type: 'tool_end',
              success: !isError,
              outputPreview: String(m.content).slice(0, 200),
            })
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
          })
        }

        const totalUsage: TokenUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          systemPromptTokens: 0,
          messagesTokens: 0,
          skillTokens: 0,
          systemToolsTokens: 0,
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
          }
        }

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
    async (content: string, sessionId?: string) => {
      const sid = sessionId ?? activeSessionId
      const session = useSessionStore.getState().sessions.find((s) => s.id === sid)
      const agentId = session?.agentId

      // 1. 添加用户消息（前端本地，仅用于显示）
      const userMsg: Message = {
        id: genId(),
        role: 'user',
        content,
        status: 'done',
        createdAt: Date.now(),
      }
      addMessage(sid, userMsg)

      // 自动标题（仅第一条消息）
      const currentMsgs = useSessionStore.getState().messageMap[sid] ?? []
      const userMsgs = currentMsgs.filter((m) => m.role === 'user')
      if (userMsgs.length <= 1) {
        updateSessionTitle(sid, content.slice(0, 30) + (content.length > 30 ? '...' : ''))
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
        sid, aiMsgId, updateMessage, updateUsage, startTime
      )

      await chatStream({
        message: content,
        sessionId: sid,
        agentId,
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
      // 找最后一条 assistant 消息（有后端 conversationId 的）
      const lastAi = [...msgs].reverse().find((m) => m.role === 'assistant' && m.conversationId)

      if (!lastAi?.conversationId) {
        // 如果没有持久化的 messageId，fallback 到前端本地重发逻辑
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
        if (lastUser) {
          // 删除最后一条 AI 消息并重新 send
          useSessionStore.getState().deleteMessage(lastAi?.id ?? '')
          await send(lastUser.content, sid)
        }
        return
      }

      // 有 conversationId - 先删前端显示的 AI 消息，再调接口
      useSessionStore.getState().deleteMessage(lastAi.id)

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

      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, startTime
      )

      await regenerateStream({
        messageId: lastAi.conversationId!,
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
        // fallback：前端本地编辑重发
        useSessionStore.getState().editUserMessage(msgId, newContent)
        const idx = msgs.findIndex((m) => m.id === msgId)
        if (idx >= 0) {
          msgs.slice(idx + 1).forEach((m) => useSessionStore.getState().deleteMessage(m.id))
        }
        await send(newContent, sid)
        return
      }

      // 更新前端显示的用户消息
      useSessionStore.getState().editUserMessage(msgId, newContent)
      // 删除该消息之后的所有前端消息
      const idx = msgs.findIndex((m) => m.id === msgId)
      if (idx >= 0) {
        msgs.slice(idx + 1).forEach((m) => useSessionStore.getState().deleteMessage(m.id))
      }

      // 添加占位 AI 消息
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

      const { onEvent, handleDone, handleError } = driveAiMessage(
        sid, aiMsgId, updateMessage, updateUsage, startTime
      )

      await editMessageStream({
        messageId: msg.conversationId!,
        content: newContent,
        signal: ctrl.signal,
        onEvent,
        onDone: handleDone,
        onError: handleError,
      })
    },
    [activeSessionId, addMessage, updateMessage, updateUsage, send],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  return { send, regenerate, editAndResend, fetchHistory, cancel }
}
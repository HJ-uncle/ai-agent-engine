import { useCallback, useRef } from 'react'
import { chatStream, regenerateStream, editMessageStream } from '../api'
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
      thinkingSteps.push({
        type: 'tool_end', success: event.success,
        outputPreview: (event.output ?? '').slice(0, 200),
      })
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
    updateMessage,
    updateUsage,
    updateSessionTitle,
  } = useSessionStore()

  const abortRef = useRef<AbortController | null>(null)

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

  return { send, regenerate, editAndResend, cancel }
}
import { useCallback } from 'react'
import { useSessionStore } from '../store/session'
import type { TokenUsage } from '../types'

// 开发模式下通过 Vite proxy 转发，生产模式可配置环境变量
const BASE_URL = import.meta.env.VITE_API_URL ?? ''

export function useChat() {
  const {
    activeSessionId,
    isStreaming,
    appendUserMessage,
    startStreaming,
    appendStreamChunk,
    finishStreaming,
  } = useSessionStore()

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isStreaming) return

    appendUserMessage(content)
    startStreaming()

    try {
      const res = await fetch(`${BASE_URL}/api/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message: content, sessionId: activeSessionId }),
      })

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let lastUsage: TokenUsage | null = null
      let lastConvId: string | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') break

          try {
            const parsed = JSON.parse(data) as {
              content?: string
              usage?: TokenUsage
            }
            if (parsed.content) {
              appendStreamChunk(parsed.content)
            }
            if (parsed.usage) {
              lastUsage = parsed.usage
              lastConvId = parsed.usage.conversationId
            }
          } catch {
            // ignore
          }
        }
      }

      reader.releaseLock()
      finishStreaming(lastConvId, lastUsage)
    } catch (err) {
      const errMsg = `[错误: ${err instanceof Error ? err.message : '连接失败，请确认 Agent Engine 已启动'}]`
      appendStreamChunk(errMsg)
      finishStreaming(null, null)
    }
  }, [activeSessionId, isStreaming, appendUserMessage, startStreaming, appendStreamChunk, finishStreaming])

  return { sendMessage, isStreaming }
}

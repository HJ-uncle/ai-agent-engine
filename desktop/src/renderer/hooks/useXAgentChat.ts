/**
 * useXAgentChat
 *
 * 使用 @ant-design/x-sdk 的 XRequest + XStream 封装对话流管理。
 * 对外接口与原有 sendMessage 兼容，内部将所有 SSE 帧写入 Zustand store。
 */
import { useRef, useCallback } from 'react'
import { XStream } from '@ant-design/x-sdk'
import { useSessionStore } from '../store/session'
import type { TokenUsage } from '../types'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

export interface XCardData {
  type: 'info' | 'table' | 'list' | 'skill-result' | string
  title?: string
  fields?: Array<{ label: string; value: string }>
  columns?: Array<{ key: string; title: string }>
  dataSource?: Array<Record<string, unknown>>
  items?: Array<{ icon?: string; title: string; description?: string }>
  skillName?: string
  summary?: string
  details?: { format?: 'text' | 'code'; lang?: string; content: string }
  actions?: Array<{ label: string; value: string; variant?: string }>
  [key: string]: unknown
}

export type ParsedFrame =
  | { type: 'content'; content: string }
  | { type: 'card'; card: XCardData }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'thinking'; text: string }
  | { type: 'toolStart'; name: string; args: unknown }
  | { type: 'toolEnd'; name: string; success: boolean; outputPreview: string }

function parseFrame(data: string): ParsedFrame | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    if (parsed['content'])   return { type: 'content',   content: parsed['content'] as string }
    if (parsed['card'])      return { type: 'card',      card: parsed['card'] as XCardData }
    if (parsed['usage'])     return { type: 'usage',     usage: parsed['usage'] as TokenUsage }
    if (parsed['thinking'])  return { type: 'thinking',  text: parsed['thinking'] as string }
    if (parsed['toolStart']) return { type: 'toolStart', name: (parsed['toolStart'] as any).name, args: (parsed['toolStart'] as any).args }
    if (parsed['toolEnd'])   return { type: 'toolEnd',   name: (parsed['toolEnd'] as any).name, success: (parsed['toolEnd'] as any).success, outputPreview: (parsed['toolEnd'] as any).outputPreview }
  } catch { /* ignore */ }
  return null
}

export function useXAgentChat() {
  const abortRef    = useRef<AbortController | null>(null)
  const startedRef  = useRef<number>(0)

  const {
    appendUserMessage, startStreaming, appendStreamChunk, appendStreamCard,
    appendThinkingStep, finishStreaming,
  } = useSessionStore()

  const send = useCallback(async (content: string, sessionId: string): Promise<void> => {
    appendUserMessage(content)
    startStreaming()
    startedRef.current = Date.now()
    abortRef.current   = new AbortController()

    let lastUsage: TokenUsage | null = null
    let lastConvId: string | null    = null

    try {
      // 直接使用 fetch + XStream 管道，完全控制帧解析
      const response = await fetch(`${BASE_URL}/api/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message: content, sessionId }),
        signal: abortRef.current.signal,
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

      // ── 使用 XStream 处理 SSE 管道 ────────────────────────────────────
      const stream = XStream({
        readableStream: response.body,
      })

      for await (const sseEvent of stream) {
        // sseEvent 是 { event?: string; data?: string; id?: string }
        const dataStr = sseEvent.data?.trim()
        if (!dataStr || dataStr === '[DONE]') break

        const frame = parseFrame(dataStr)
        if (!frame) continue

        switch (frame.type) {
          case 'content':
            appendStreamChunk(frame.content)
            break
          case 'card':
            appendStreamCard(frame.card)
            break
          case 'usage':
            lastUsage  = frame.usage
            lastConvId = (frame.usage as any).conversationId ?? null
            break
          case 'thinking':
            appendThinkingStep({ type: 'thinking', text: frame.text, timestamp: Date.now() })
            break
          case 'toolStart':
            appendThinkingStep({ type: 'tool_start', toolName: frame.name, toolArgs: frame.args, timestamp: Date.now() })
            break
          case 'toolEnd':
            appendThinkingStep({ type: 'tool_end', toolName: frame.name, success: frame.success, outputPreview: frame.outputPreview, timestamp: Date.now() })
            break
        }
      }

      finishStreaming(lastConvId, lastUsage, startedRef.current)
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        appendStreamChunk(`\n\n> ⚠️ 错误：${err instanceof Error ? err.message : '连接失败'}`)
        finishStreaming(null, null)
      }
    } finally {
      abortRef.current = null
    }
  }, [appendUserMessage, startStreaming, appendStreamChunk, appendStreamCard, appendThinkingStep, finishStreaming])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    finishStreaming(null, null)
  }, [finishStreaming])

  return { send, cancel }
}

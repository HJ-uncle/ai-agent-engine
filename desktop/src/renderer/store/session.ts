import { create } from 'zustand'
import type { TokenUsage } from '../types'
import type { XCardData } from '../hooks/useXAgentChat'

export interface SessionItem {
  id: string
  title: string
  label?: string        // Conversations 组件用的显示名
  createdAt: number
  lastMessage?: string
}

/** 一次工具调用的思考步骤 */
export interface ThinkingStep {
  type: 'thinking' | 'tool_start' | 'tool_end'
  text?: string          // thinking 文字
  toolName?: string      // 工具名称
  toolArgs?: unknown     // 工具入参
  success?: boolean      // 工具执行结果
  outputPreview?: string // 结果摘要
  timestamp: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  conversationId?: string | null
  status?: 'loading' | 'done' | 'error'
  createdAt: number
  completionTokens?: number
  /** 每条 AI 消息独立的 token 详情，来自当次 SSE 流的 usage 帧 */
  usage?: TokenUsage | null
  /** AI 推理过程中的思考步骤（工具调用链路） */
  thinkingSteps?: ThinkingStep[]
  /** AI 完成本条消息的耗时（毫秒） */
  durationMs?: number
  /** 消息开始生成的时间戳 */
  startedAt?: number
  /** A2UI 动态卡片数据（来自 SSE card 帧） */
  card?: XCardData | null
}

export interface SessionState {
  sessions: SessionItem[]
  activeSessionId: string
  messageMap: Record<string, ChatMessage[]>
  usageMap: Record<string, TokenUsage | null>
  streamingContent: string
  isStreaming: boolean

  addSession: () => string
  switchSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  appendUserMessage: (content: string) => string
  startStreaming: () => void
  appendStreamChunk: (chunk: string) => void
  appendStreamCard: (card: XCardData) => void
  appendThinkingStep: (step: ThinkingStep) => void
  finishStreaming: (conversationId: string | null, usage: TokenUsage | null, startedAt?: number) => void
  deleteMessage: (msgId: string) => void
  editUserMessage: (msgId: string, newContent: string) => void
  clearMessages: () => void
}

const uid = () => Math.random().toString(36).slice(2, 10)

function makeSession(): SessionItem {
  return {
    id: uid(),
    title: `新对话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
    createdAt: Date.now(),
  }
}

const initialSession = makeSession()

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [initialSession],
  activeSessionId: initialSession.id,
  messageMap: { [initialSession.id]: [] },
  usageMap: { [initialSession.id]: null },
  streamingContent: '',
  isStreaming: false,

  addSession: () => {
    const s = makeSession()
    set((state) => ({
      sessions: [s, ...state.sessions],
      activeSessionId: s.id,
      messageMap: { ...state.messageMap, [s.id]: [] },
      usageMap: { ...state.usageMap, [s.id]: null },
      streamingContent: '',
      isStreaming: false,
    }))
    return s.id
  },

  switchSession: (id) => {
    set((state) => ({
      activeSessionId: id,
      messageMap: state.messageMap[id] !== undefined
        ? state.messageMap
        : { ...state.messageMap, [id]: [] },
      usageMap: state.usageMap[id] !== undefined
        ? state.usageMap
        : { ...state.usageMap, [id]: null },
      streamingContent: '',
      isStreaming: false,
    }))
  },

  deleteSession: (id) => {
    const { sessions, activeSessionId, addSession } = get()
    const remaining = sessions.filter((s) => s.id !== id)
    if (remaining.length === 0) {
      addSession()
      return
    }
    const nextActive = id === activeSessionId ? remaining[0].id : activeSessionId
    set((state) => {
      const { [id]: _m, ...restMsg } = state.messageMap
      const { [id]: _u, ...restUsage } = state.usageMap
      return { sessions: remaining, activeSessionId: nextActive, messageMap: restMsg, usageMap: restUsage }
    })
  },

  renameSession: (id, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    }))
  },

  appendUserMessage: (content) => {
    const msg: ChatMessage = { id: uid(), role: 'user', content, status: 'done', createdAt: Date.now() }
    set((state) => {
      const sid = state.activeSessionId
      return {
        messageMap: { ...state.messageMap, [sid]: [...(state.messageMap[sid] ?? []), msg] },
        sessions: state.sessions.map((s) =>
          s.id === sid ? { ...s, lastMessage: content.slice(0, 30) } : s,
        ),
      }
    })
    return msg.id
  },

  startStreaming: () => {
    const msg: ChatMessage = { id: uid(), role: 'assistant', content: '', status: 'loading', createdAt: Date.now() }
    set((state) => {
      const sid = state.activeSessionId
      return {
        messageMap: { ...state.messageMap, [sid]: [...(state.messageMap[sid] ?? []), msg] },
        streamingContent: '',
        isStreaming: true,
      }
    })
  },

  appendStreamChunk: (chunk) => {
    set((state) => {
      const sid = state.activeSessionId
      const msgs = [...(state.messageMap[sid] ?? [])]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + chunk }
      }
      return {
        messageMap: { ...state.messageMap, [sid]: msgs },
        streamingContent: state.streamingContent + chunk,
      }
    })
  },

  appendStreamCard: (card) => {
    set((state) => {
      const sid = state.activeSessionId
      const msgs = [...(state.messageMap[sid] ?? [])]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, card }
      }
      return { messageMap: { ...state.messageMap, [sid]: msgs } }
    })
  },

  appendThinkingStep: (step) => {
    set((state) => {
      const sid = state.activeSessionId
      const msgs = [...(state.messageMap[sid] ?? [])]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        const prev = last.thinkingSteps ?? []
        msgs[msgs.length - 1] = { ...last, thinkingSteps: [...prev, step] }
      }
      return { messageMap: { ...state.messageMap, [sid]: msgs } }
    })
  },

  finishStreaming: (conversationId, usage, startedAt) => {
    set((state) => {
      const sid = state.activeSessionId
      const msgs = [...(state.messageMap[sid] ?? [])]
      const last = msgs[msgs.length - 1]
      const durationMs = startedAt ? Date.now() - startedAt : undefined
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          status: 'done',
          conversationId,
          completionTokens: usage?.completionTokens,
          usage,
          durationMs,
        }
      }
      // usageMap 存「本会话累计」：把所有 AI 消息的 usage 累加
      const allMsgs = msgs
      const totals = allMsgs
        .filter((m) => m.role === 'assistant' && m.usage)
        .reduce<TokenUsage>(
          (acc, m) => {
            const u = m.usage!
            return {
              systemPromptTokens:  (acc.systemPromptTokens  ?? 0) + (u.systemPromptTokens  ?? 0),
              messagesTokens:      (acc.messagesTokens      ?? 0) + (u.messagesTokens      ?? 0),
              skillTokens:         (acc.skillTokens         ?? 0) + (u.skillTokens         ?? 0),
              systemToolsTokens:   (acc.systemToolsTokens   ?? 0) + (u.systemToolsTokens   ?? 0),
              promptTokens:        (acc.promptTokens        ?? 0) + (u.promptTokens        ?? 0),
              completionTokens:    (acc.completionTokens    ?? 0) + (u.completionTokens    ?? 0),
              totalTokens:         (acc.totalTokens         ?? 0) + (u.totalTokens         ?? 0),
              conversationId:      u.conversationId ?? acc.conversationId,
            }
          },
          { systemPromptTokens: 0, messagesTokens: 0, skillTokens: 0, systemToolsTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, conversationId: null as any },
        )
      return {
        messageMap: { ...state.messageMap, [sid]: msgs },
        usageMap: { ...state.usageMap, [sid]: usage ? totals : state.usageMap[sid] },
        isStreaming: false,
        streamingContent: '',
      }
    })
  },

  deleteMessage: (msgId) => {
    set((state) => {
      const sid = state.activeSessionId
      const msgs = (state.messageMap[sid] ?? []).filter((m) => m.id !== msgId)
      return { messageMap: { ...state.messageMap, [sid]: msgs } }
    })
  },

  editUserMessage: (msgId, newContent) => {
    set((state) => {
      const sid = state.activeSessionId
      const msgs = (state.messageMap[sid] ?? []).map((m) =>
        m.id === msgId && m.role === 'user' ? { ...m, content: newContent } : m,
      )
      return { messageMap: { ...state.messageMap, [sid]: msgs } }
    })
  },

  clearMessages: () => {
    set((state) => ({
      messageMap: { ...state.messageMap, [state.activeSessionId]: [] },
      usageMap: { ...state.usageMap, [state.activeSessionId]: null },
    }))
  },
}))

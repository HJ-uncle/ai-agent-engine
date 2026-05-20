import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Session, Message, TokenUsage } from '@core/types'

interface SessionState {
  sessions: Session[]
  activeSessionId: string
  activeFile: string | null // Current file opened in Explorer
  files: string[] // List of all file paths in current workspace
  lastFilesUpdate: number // Timestamp to trigger file list refresh
  lastTodosUpdate: number // Timestamp to trigger todo list refresh
  messageMap: Record<string, Message[]>
  usageMap: Record<string, TokenUsage | null>

  /**
   * DeepSeek 动态价格配置（从服务端拉取，用于 ChatArea 成本估算）
   * key: modelId（如 deepseek-chat），value: 包含有效价和原价的对象
   */
  deepseekEffectivePrices: Record<string, {
    effective: { input: number; output: number; cacheHit: number; isDiscounted: boolean }
    normal: { input: number; output: number; cacheHit: number }
  } | null>

  /**
   * 当前正在流式生成中的会话 ID 集合（不持久化）。
   * 用于：
   *  - 切换会话回到运行中会话时，跳过 fetchHistory 避免覆盖流式消息
   *  - UI 显示「会话运行中」状态指示
   *  - 避免重复 send 同一会话
   */
  runningSessions: Record<string, boolean>

  // UI State
  isSettingsOpen: boolean
  settingsTab: string
  maxAskUserCount: number
  thinkingMode: boolean
  superpowerMode: 'off' | 'balanced' | 'methodology' | 'max'
  chatInputValues: Record<string, string> // New: map of sessionId to its chat input value

  // Actions
  setMaxAskUserCount: (max: number) => void
  setThinkingMode: (enabled: boolean) => void
  setSuperpowerMode: (mode: 'off' | 'balanced' | 'methodology' | 'max') => void
  setChatInputValue: (sessionId: string, value: string) => void
  addSession: (agentId?: string) => string
  switchSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSessionId: (oldId: string, newId: string) => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionAgent: (id: string, agentId: string | undefined) => void
  setInheritContext: (id: string, enabled: boolean) => void
  updateSession: (id: string, updates: Partial<Session>) => void

  addMessage: (sessionId: string, message: Message) => void
  setMessages: (sessionId: string, messages: Message[]) => void
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void
  deleteMessage: (sessionId: string, messageId: string) => void
  editUserMessage: (sessionId: string, messageId: string, newContent: string) => void
  deleteMessagesAfter: (sessionId: string, messageId: string) => void
  clearMessages: (sessionId: string) => void

  updateUsage: (sessionId: string, usage: TokenUsage) => void

  /** 标记会话进入流式运行状态（开始 chat 前调用） */
  markSessionRunning: (sessionId: string) => void
  /** 标记会话结束流式运行（流完成/错误/cancel 时调用） */
  markSessionDone: (sessionId: string) => void
  /** 查询会话是否正在流式运行 */
  isSessionRunning: (sessionId: string) => boolean

  openSettings: (tab?: string) => void
  closeSettings: () => void
  setFiles: (files: string[]) => void
  setActiveFile: (file: string | null) => void
  triggerFilesRefresh: () => void
  triggerTodosRefresh: () => void
  /** 更新 DeepSeek 有效价格（供 ChatArea 使用） */
  setDeepSeekPrices: (prices: SessionState['deepseekEffectivePrices']) => void
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function defaultSession(): Session {
  return {
    id: genId(),
    title: '新对话',
    createdAt: Date.now(),
    inheritContext: true, // 默认开启继承上下文（独立对话为 false）
  }
}

function getMessageText(content: string | any[]): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
  }
  return ''
}

const initial = defaultSession()

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      sessions: [initial],
      activeSessionId: initial.id,
      activeFile: null,
      files: [],
      lastFilesUpdate: 0,
      lastTodosUpdate: 0,
      messageMap: { [initial.id]: [] },
      usageMap: { [initial.id]: null },
      chatInputValues: { [initial.id]: '' },
      runningSessions: {},
      deepseekEffectivePrices: {},
      isSettingsOpen: false,
      settingsTab: 'general',
      maxAskUserCount: 5,
      thinkingMode: false,
      superpowerMode: 'off',

      setMaxAskUserCount: (max) => set({ maxAskUserCount: max }),
      setThinkingMode: (enabled) => set({ thinkingMode: enabled }),
      setSuperpowerMode: (mode) => set({ superpowerMode: mode }),
      setChatInputValue: (sessionId, value) => set((state) => ({
        chatInputValues: { ...(state.chatInputValues || {}), [sessionId]: value }
      })),
      setFiles: (files) => set({ files }),
      setActiveFile: (file) => set({ activeFile: file }),
      triggerFilesRefresh: () => set({ lastFilesUpdate: Date.now() }),
      triggerTodosRefresh: () => set({ lastTodosUpdate: Date.now() }),
      setDeepSeekPrices: (prices) => set({ deepseekEffectivePrices: prices }),
      addSession: (agentId?: string) => {
        const s = { ...defaultSession(), agentId }
        set((state) => ({
          sessions: [s, ...state.sessions],
          activeSessionId: s.id,
          activeFile: null,
          files: [],
          messageMap: { ...state.messageMap, [s.id]: [] },
          usageMap: { ...state.usageMap, [s.id]: null },
          chatInputValues: { ...(state.chatInputValues || {}), [s.id]: '' },
        }))
        return s.id
      },

      switchSession: (id) => set({ activeSessionId: id, activeFile: null, files: [] }),

      deleteSession: (id) => {
        set((state) => {
          const remaining = state.sessions.filter((s) => s.id !== id)
          const newActive =
            state.activeSessionId === id
              ? (remaining[0]?.id ?? '')
              : state.activeSessionId

          // If no sessions remain, create one
          if (remaining.length === 0) {
            const fresh = defaultSession()
            const msgMap = { [fresh.id]: [] }
            const usageMap = { [fresh.id]: null }
            return {
              sessions: [fresh],
              activeSessionId: fresh.id,
              messageMap: msgMap,
              usageMap,
            }
          }

          const { [id]: _m, ...msgMap } = state.messageMap
          const { [id]: _u, ...usageMap } = state.usageMap
          const { [id]: _c, ...chatInputValues } = (state.chatInputValues || {})
          return {
            sessions: remaining,
            activeSessionId: newActive,
            messageMap: msgMap,
            usageMap,
            chatInputValues,
          }
        })
      },

      renameSessionId: (oldId, newId) => {
        set((state) => {
          const sessions = state.sessions.map(s => s.id === oldId ? { ...s, id: newId } : s)
          const activeSessionId = state.activeSessionId === oldId ? newId : state.activeSessionId
          const activeFile = state.activeFile
          
          const messageMap = { ...state.messageMap }
          if (messageMap[oldId]) {
            messageMap[newId] = messageMap[oldId]
            delete messageMap[oldId]
          }
          
          const usageMap = { ...state.usageMap }
          if (usageMap[oldId]) {
            usageMap[newId] = usageMap[oldId]
            delete usageMap[oldId]
          }

          const chatInputValues = { ...(state.chatInputValues || {}) }
          if (chatInputValues[oldId]) {
            chatInputValues[newId] = chatInputValues[oldId]
            delete chatInputValues[oldId]
          }
          
          return { sessions, activeSessionId, activeFile, messageMap, usageMap, chatInputValues }
        })
      },

      updateSessionTitle: (id, title) =>
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
        })),

      updateSessionAgent: (id, agentId) =>
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, agentId } : s)),
        })),

      setInheritContext: (id, enabled) =>
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, inheritContext: enabled } : s)),
        })),

      updateSession: (id, updates) =>
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),

      addMessage: (sessionId, message) =>
        set((state) => ({
          messageMap: {
            ...state.messageMap,
            [sessionId]: [...(state.messageMap[sessionId] ?? []), message],
          },
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, lastMessage: getMessageText(message.content).slice(0, 60) }
              : s,
          ),
        })),

      setMessages: (sessionId, messages) =>
        set((state) => ({
          messageMap: {
            ...state.messageMap,
            [sessionId]: messages,
          },
        })),

      updateMessage: (sessionId, messageId, updates) =>
        set((state) => ({
          messageMap: {
            ...state.messageMap,
            [sessionId]: (state.messageMap[sessionId] ?? []).map((m) =>
              m.id === messageId ? { ...m, ...updates } : m,
            ),
          },
        })),

      deleteMessage: (sessionId, messageId) =>
        set((state) => {
          const msgs = (state.messageMap[sessionId] ?? []).filter((m) => m.id !== messageId)
          return { messageMap: { ...state.messageMap, [sessionId]: msgs } }
        }),

      editUserMessage: (sessionId, messageId, newContent) =>
        set((state) => {
          const msgs = (state.messageMap[sessionId] ?? []).map((m) =>
            m.id === messageId && m.role === 'user' ? { ...m, content: newContent } : m,
          )
          return { messageMap: { ...state.messageMap, [sessionId]: msgs } }
        }),

      deleteMessagesAfter: (sessionId, messageId) =>
        set((state) => {
          const msgs = state.messageMap[sessionId] ?? []
          const idx = msgs.findIndex((m) => m.id === messageId)
          if (idx < 0) return { messageMap: state.messageMap }
          const kept = msgs.slice(0, idx + 1)
          return { messageMap: { ...state.messageMap, [sessionId]: kept } }
        }),

      clearMessages: (sessionId) =>
        set((state) => ({
          messageMap: { ...state.messageMap, [sessionId]: [] },
          usageMap: { ...state.usageMap, [sessionId]: null },
        })),

      updateUsage: (sessionId, usage) =>
        set((state) => {
          const prev = state.usageMap[sessionId]
          const merged: TokenUsage = {
            promptTokens: (prev?.promptTokens ?? 0) + (usage.promptTokens ?? 0),
            completionTokens: (prev?.completionTokens ?? 0) + (usage.completionTokens ?? 0),
            totalTokens: (prev?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
            systemPromptTokens: (prev?.systemPromptTokens ?? 0) + (usage.systemPromptTokens ?? 0),
            messagesTokens: (prev?.messagesTokens ?? 0) + (usage.messagesTokens ?? 0),
            skillTokens: (prev?.skillTokens ?? 0) + (usage.skillTokens ?? 0),
            systemToolsTokens: (prev?.systemToolsTokens ?? 0) + (usage.systemToolsTokens ?? 0),
            ragTokens: (prev?.ragTokens ?? 0) + (usage.ragTokens ?? 0),
            builtinToolsTokens: (prev?.builtinToolsTokens ?? 0) + (usage.builtinToolsTokens ?? 0),
            mcpToolsTokens: (prev?.mcpToolsTokens ?? 0) + (usage.mcpToolsTokens ?? 0),
            toolResultsTokens: (prev?.toolResultsTokens ?? 0) + (usage.toolResultsTokens ?? 0),
            userInputTokens: (prev?.userInputTokens ?? 0) + (usage.userInputTokens ?? 0),
            // ── DeepSeek 专有累加 ────────────────────────────────────
            cacheHitTokens: (prev?.cacheHitTokens ?? 0) + (usage.cacheHitTokens ?? 0),
            cacheMissTokens: (prev?.cacheMissTokens ?? 0) + (usage.cacheMissTokens ?? 0),
            reasoningTokens: (prev?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
          }
          return { usageMap: { ...state.usageMap, [sessionId]: merged } }
        }),

      openSettings: (tab = 'general') => set({ isSettingsOpen: true, settingsTab: tab }),
      closeSettings: () => set({ isSettingsOpen: false }),

      // ── 流式运行状态管理 ──────────────────────────────────────────────────
      markSessionRunning: (sessionId) =>
        set((state) => ({
          runningSessions: { ...state.runningSessions, [sessionId]: true },
        })),
      markSessionDone: (sessionId) =>
        set((state) => {
          if (!state.runningSessions[sessionId]) return state
          const next = { ...state.runningSessions }
          delete next[sessionId]
          return { runningSessions: next }
        }),
      isSessionRunning: (sessionId: string): boolean => {
        // 通过 get() 或外部 getState 访问可能在 zustand 类型推断中出现循环引用，
        // 这里直接通过模块顶层的 useSessionStore.getState() 访问
        // 注意：useSessionStore 在文件末尾导出，此处函数仅在调用时执行，不会立即解析
        return Boolean((useSessionStore as any).getState().runningSessions[sessionId])
      },
    }),
    {
      name: 'mac-session-store',
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        messageMap: state.messageMap,
        usageMap: state.usageMap,
        maxAskUserCount: state.maxAskUserCount,
        thinkingMode: state.thinkingMode,
        superpowerMode: state.superpowerMode,
        // 注意：runningSessions 不持久化（页面刷新后所有运行视为终止）
      }),
    },
  ),
)

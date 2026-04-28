import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Session, Message, TokenUsage } from '../types'

interface SessionState {
  sessions: Session[]
  activeSessionId: string
  activeFile: string | null // Current file opened in Explorer
  files: string[] // List of all file paths in current workspace
  lastFilesUpdate: number // Timestamp to trigger file list refresh
  lastTodosUpdate: number // Timestamp to trigger todo list refresh
  messageMap: Record<string, Message[]>
  usageMap: Record<string, TokenUsage | null>

  // UI State
  isSettingsOpen: boolean
  settingsTab: string
  maxAskUserCount: number
  thinkingMode: boolean

  // Actions
  setMaxAskUserCount: (max: number) => void
  setThinkingMode: (enabled: boolean) => void
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

  openSettings: (tab?: string) => void
  closeSettings: () => void
  setFiles: (files: string[]) => void
  setActiveFile: (file: string | null) => void
  triggerFilesRefresh: () => void
  triggerTodosRefresh: () => void
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
      isSettingsOpen: false,
      settingsTab: 'general',
      maxAskUserCount: 5,
      thinkingMode: false,

      setMaxAskUserCount: (max) => set({ maxAskUserCount: max }),
      setThinkingMode: (enabled) => set({ thinkingMode: enabled }),
      setFiles: (files) => set({ files }),
      setActiveFile: (file) => set({ activeFile: file }),
      triggerFilesRefresh: () => set({ lastFilesUpdate: Date.now() }),
      triggerTodosRefresh: () => set({ lastTodosUpdate: Date.now() }),
      addSession: (agentId?: string) => {
        const s = { ...defaultSession(), agentId }
        set((state) => ({
          sessions: [s, ...state.sessions],
          activeSessionId: s.id,
          activeFile: null,
          files: [],
          messageMap: { ...state.messageMap, [s.id]: [] },
          usageMap: { ...state.usageMap, [s.id]: null },
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
          return {
            sessions: remaining,
            activeSessionId: newActive,
            messageMap: msgMap,
            usageMap,
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
          
          return { sessions, activeSessionId, activeFile, messageMap, usageMap }
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
          }
          return { usageMap: { ...state.usageMap, [sessionId]: merged } }
        }),

      openSettings: (tab = 'general') => set({ isSettingsOpen: true, settingsTab: tab }),
      closeSettings: () => set({ isSettingsOpen: false }),
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
      }),
    },
  ),
)

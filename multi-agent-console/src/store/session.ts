import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Session, Message, TokenUsage } from '../types'

interface SessionState {
  sessions: Session[]
  activeSessionId: string
  activeFile: string | null // Current file opened in Explorer
  messageMap: Record<string, Message[]>
  usageMap: Record<string, TokenUsage | null>

  // UI State
  isSettingsOpen: boolean
  settingsTab: string

  // Actions
  addSession: (agentId?: string) => string
  switchSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSessionId: (oldId: string, newId: string) => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionAgent: (id: string, agentId: string | undefined) => void

  addMessage: (sessionId: string, message: Message) => void
  setMessages: (sessionId: string, messages: Message[]) => void
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void
  deleteMessage: (messageId: string) => void
  editUserMessage: (messageId: string, newContent: string) => void
  clearMessages: (sessionId: string) => void

  updateUsage: (sessionId: string, usage: TokenUsage) => void

  openSettings: (tab?: string) => void
  closeSettings: () => void
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function defaultSession(): Session {
  return {
    id: genId(),
    title: '新对话',
    createdAt: Date.now(),
  }
}

const initial = defaultSession()

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      sessions: [initial],
      activeSessionId: initial.id,
      activeFile: null,
      messageMap: { [initial.id]: [] },
      usageMap: { [initial.id]: null },
      isSettingsOpen: false,
      settingsTab: 'general',

      addSession: (agentId?: string) => {
        const s = { ...defaultSession(), agentId }
        set((state) => ({
          sessions: [s, ...state.sessions],
          activeSessionId: s.id,
          activeFile: null,
          messageMap: { ...state.messageMap, [s.id]: [] },
          usageMap: { ...state.usageMap, [s.id]: null },
        }))
        return s.id
      },

      switchSession: (id) => set({ activeSessionId: id, activeFile: null }),

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

      addMessage: (sessionId, message) =>
        set((state) => ({
          messageMap: {
            ...state.messageMap,
            [sessionId]: [...(state.messageMap[sessionId] ?? []), message],
          },
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, lastMessage: message.content.slice(0, 60) }
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

      deleteMessage: (messageId) =>
        set((state) => {
          const newMap = { ...state.messageMap }
          for (const sid of Object.keys(newMap)) {
            newMap[sid] = (newMap[sid] ?? []).filter((m) => m.id !== messageId)
          }
          return { messageMap: newMap }
        }),

      editUserMessage: (messageId, newContent) =>
        set((state) => {
          const newMap = { ...state.messageMap }
          for (const sid of Object.keys(newMap)) {
            newMap[sid] = (newMap[sid] ?? []).map((m) =>
              m.id === messageId ? { ...m, content: newContent } : m,
            )
          }
          return { messageMap: newMap }
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
      }),
    },
  ),
)

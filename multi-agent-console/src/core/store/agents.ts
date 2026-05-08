import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Agent } from '@core/types'

interface AgentState {
  agents: Agent[]
  loading: boolean
  error: string | null
  setAgents: (agents: Agent[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  upsertAgent: (agent: Agent) => void
  removeAgent: (id: string) => void
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set) => ({
      agents: [],
      loading: false,
      error: null,
      setAgents: (agents) => set({ agents }),
      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),
      upsertAgent: (agent) =>
        set((state) => {
          const exists = state.agents.find((a) => a.id === agent.id)
          if (exists) {
            return { agents: state.agents.map((a) => (a.id === agent.id ? agent : a)) }
          }
          return { agents: [agent, ...state.agents] }
        }),
      removeAgent: (id) =>
        set((state) => ({ agents: state.agents.filter((a) => a.id !== id) })),
    }),
    {
      name: 'mac-agent-store',
      partialize: (state) => ({ agents: state.agents }),
    },
  ),
)

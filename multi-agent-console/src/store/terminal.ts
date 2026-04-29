/**
 * terminalStore — 管理前端多 Tab 终端状态
 */
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export interface TerminalTab {
  /** 由后端返回的 PTY 会话 ID */
  terminalId: string
  /** Tab 显示标题 */
  title: string
  /** 工作目录 */
  cwd: string
  /** 进程是否仍在运行 */
  alive: boolean
}

interface TerminalState {
  tabs: TerminalTab[]
  activeTerminalId: string | null
  /** 终端面板是否可见 */
  panelVisible: boolean
  /** 面板高度（px） */
  panelHeight: number

  addTab: (tab: TerminalTab) => void
  removeTab: (terminalId: string) => void
  setActiveTerminal: (terminalId: string) => void
  setTabTitle: (terminalId: string, title: string) => void
  setTabAlive: (terminalId: string, alive: boolean) => void
  setPanelVisible: (visible: boolean) => void
  setPanelHeight: (height: number) => void
}

export const useTerminalStore = create<TerminalState>()(
  devtools(
    (set, get) => ({
      tabs: [],
      activeTerminalId: null,
      panelVisible: false,
      panelHeight: 260,

      addTab(tab) {
        set(state => ({
          tabs: [...state.tabs, tab],
          activeTerminalId: tab.terminalId,
          panelVisible: true,
        }), false, 'addTab')
      },

      removeTab(terminalId) {
        set(state => {
          const newTabs = state.tabs.filter(t => t.terminalId !== terminalId)
          let activeTerminalId = state.activeTerminalId
          if (activeTerminalId === terminalId) {
            activeTerminalId = newTabs[newTabs.length - 1]?.terminalId ?? null
          }
          return {
            tabs: newTabs,
            activeTerminalId,
            // 没有 tab 时自动隐藏面板
            panelVisible: newTabs.length > 0 ? state.panelVisible : false,
          }
        }, false, 'removeTab')
      },

      setActiveTerminal(terminalId) {
        set({ activeTerminalId: terminalId, panelVisible: true }, false, 'setActiveTerminal')
      },

      setTabTitle(terminalId, title) {
        // 只在标题实际变化时才更新（避免频繁重渲）
        const current = get().tabs.find(t => t.terminalId === terminalId)
        if (!current || current.title === title) return
        set(state => ({
          tabs: state.tabs.map(t =>
            t.terminalId === terminalId ? { ...t, title } : t,
          ),
        }), false, 'setTabTitle')
      },

      setTabAlive(terminalId, alive) {
        set(state => ({
          tabs: state.tabs.map(t =>
            t.terminalId === terminalId ? { ...t, alive } : t,
          ),
        }), false, 'setTabAlive')
      },

      setPanelVisible(visible) {
        set({ panelVisible: visible }, false, 'setPanelVisible')
      },

      setPanelHeight(height) {
        // 限制最小 120px，最大 80vh（用具体数值 800px 代替，运行时再约束）
        const clamped = Math.max(120, Math.min(height, 800))
        set({ panelHeight: clamped }, false, 'setPanelHeight')
      },
    }),
    { name: 'TerminalStore' },
  ),
)

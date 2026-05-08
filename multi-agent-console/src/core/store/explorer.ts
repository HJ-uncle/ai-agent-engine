import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

// ─── Non-reactive dirty content cache (不放入 Zustand state，避免每键重渲) ────
// 直接用模块级 Map，saveCurrentFile 通过 getState() 或这个 Map 读取最新内容
export const dirtyContentCache = new Map<string, string>()

// ─── Types ────────────────────────────────────────────────────────────────────


export interface TabItem {
  path: string        // absolute / normalized path (always '/' separator)
  name: string        // display name
  isDirty: boolean    // unsaved changes
  type: 'text' | 'image' | 'video' | 'binary'
  /** Monaco model content snapshot for undo stack preservation */
  savedContent?: string
}

export type UndoOpType = 'delete' | 'rename'

export interface UndoLogEntry {
  type: UndoOpType
  timestamp: number
  /** For delete: original path. For rename: path after rename */
  path: string
  /** For rename: path before rename (originalName) */
  prevPath?: string
}

// ─── Store Interface ───────────────────────────────────────────────────────────

interface ExplorerState {
  // ── Tabs ──────────────────────────────────────────────────────────────────
  tabs: TabItem[]
  activeTabPath: string | null

  openTab: (tab: Omit<TabItem, 'isDirty'>) => void
  closeTab: (path: string) => void
  setActiveTab: (path: string) => void
  markDirty: (path: string) => void
  markSaved: (path: string, content?: string) => void
  updateTabContent: (path: string, content: string) => void
  /** 编辑器内容变化时，仅更新 savedContent 快照，不触发 isDirty 变化（避免循环） */
  updateDirtyContent: (path: string, content: string) => void

  // ── Undo Log ──────────────────────────────────────────────────────────────
  undoLog: UndoLogEntry[]
  pushLog: (entry: Omit<UndoLogEntry, 'timestamp'>) => void
  popLog: () => UndoLogEntry | undefined

  // ── Quick Open ────────────────────────────────────────────────────────────
  quickOpenVisible: boolean
  setQuickOpenVisible: (visible: boolean) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MAX_UNDO_LOG = 50

function detectFileType(name: string): TabItem['type'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'ogg'].includes(ext)) return 'video'
  // Treat known text extensions as text, everything else as binary
  const textExts = [
    'ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'scss', 'less',
    'md', 'markdown', 'txt', 'xml', 'yaml', 'yml', 'toml', 'ini',
    'py', 'rb', 'go', 'rs', 'java', 'cs', 'cpp', 'c', 'h', 'hpp',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'proto',
    'dockerfile', 'gitignore', 'env', 'lock', 'log', 'csv',
  ]
  if (textExts.includes(ext) || ext === '') return 'text'
  return 'binary'
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useExplorerStore = create<ExplorerState>()(
  devtools(
    persist(
      (set, get) => ({
        // ── Tabs ────────────────────────────────────────────────────────────
        tabs: [],
        activeTabPath: null,

        openTab(tab) {
          const existing = get().tabs.find(t => t.path === tab.path)
          if (existing) {
            set({ activeTabPath: tab.path }, false, 'openTab/activate')
            return
          }
          const newTab: TabItem = {
            ...tab,
            isDirty: false,
            type: tab.type ?? detectFileType(tab.name),
          }
          set(
            state => ({ tabs: [...state.tabs, newTab], activeTabPath: tab.path }),
            false,
            'openTab/new',
          )
        },

        closeTab(path) {
          set(state => {
            const idx = state.tabs.findIndex(t => t.path === path)
            if (idx === -1) return state
            const newTabs = state.tabs.filter(t => t.path !== path)
            let activeTabPath = state.activeTabPath
            if (activeTabPath === path) {
              activeTabPath =
                newTabs[Math.min(idx, newTabs.length - 1)]?.path ?? null
            }
            return { tabs: newTabs, activeTabPath }
          }, false, 'closeTab')
        },

        setActiveTab(path) {
          set({ activeTabPath: path }, false, 'setActiveTab')
        },

        markDirty(path) {
          // 如果已经是 dirty，不重复 set（避免每键都触发重渲染）
          const already = get().tabs.find(t => t.path === path)?.isDirty
          if (already) return
          set(state => ({
            tabs: state.tabs.map(t => t.path === path ? { ...t, isDirty: true } : t),
          }), false, 'markDirty')
        },

        markSaved(path, content) {
          set(state => ({
            tabs: state.tabs.map(t =>
              t.path === path ? { ...t, isDirty: false, savedContent: content ?? t.savedContent } : t,
            ),
          }), false, 'markSaved')
        },

        updateTabContent(path, content) {
          set(state => ({
            tabs: state.tabs.map(t =>
              t.path === path ? { ...t, savedContent: content } : t,
            ),
          }), false, 'updateTabContent')
        },

        updateDirtyContent(path, content) {
          // 写入模块级 Map，完全绕开 Zustand reactive set，不触发任何重渲染
          // saveCurrentFile 通过 dirtyContentCache.get(path) 读取最新内容
          dirtyContentCache.set(path, content)
        },

        // ── Undo Log ────────────────────────────────────────────────────────
        undoLog: [],

        pushLog(entry) {
          set(state => {
            const log: UndoLogEntry = { ...entry, timestamp: Date.now() }
            const trimmed = state.undoLog.length >= MAX_UNDO_LOG
              ? state.undoLog.slice(1)
              : state.undoLog
            return { undoLog: [...trimmed, log] }
          }, false, 'pushLog')
        },

        popLog() {
          const log = get().undoLog
          if (log.length === 0) return undefined
          const last = log[log.length - 1]
          set({ undoLog: log.slice(0, -1) }, false, 'popLog')
          return last
        },

        // ── Quick Open ──────────────────────────────────────────────────────
        quickOpenVisible: false,
        setQuickOpenVisible(visible) {
          set({ quickOpenVisible: visible }, false, 'setQuickOpenVisible')
        },
      }),
      {
        name: 'explorer-undo-log',
        // Persist only undo log (tabs are transient)
        partialize: state => ({ undoLog: state.undoLog }),
      },
    ),
    { name: 'ExplorerStore' },
  ),
)

// ─── Selector Helpers ──────────────────────────────────────────────────────────

export const selectActiveTab = (s: ExplorerState) =>
  s.tabs.find(t => t.path === s.activeTabPath) ?? null

export const selectDirtyTabs = (s: ExplorerState) =>
  s.tabs.filter(t => t.isDirty)

// Stable selector: returns same reference if activeTabPath & tabs haven't changed
export const selectActiveTabStable = (s: ExplorerState) =>
  s.activeTabPath ? (s.tabs.find(t => t.path === s.activeTabPath) ?? null) : null

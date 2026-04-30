import React, { useState, useEffect, useRef, useCallback } from 'react'
import { ConfigProvider, theme, App as AntdApp, message as antMsg } from 'antd'
import {
  MessageOutlined, RobotOutlined, SettingOutlined,
  ApiOutlined, DatabaseOutlined,
  FolderOutlined, ThunderboltOutlined, ToolOutlined,
  ColumnWidthOutlined, SplitCellsOutlined, CommentOutlined,
  CheckSquareOutlined, ReloadOutlined, DeleteOutlined,
  FunctionOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import SessionList from './components/SessionList'
import ChatArea from './components/ChatArea'
import AgentPanel from './components/AgentPanel'
import McpPanel from './components/McpPanel'
import KnowledgePanel from './components/KnowledgePanel'
import OldExplorerPanel from './components/ExplorerPanel'
import NewExplorerPanel from './components/explorer'
import SettingsModal from './components/SettingsModal'
import { useSessionStore } from './store/session'
import { conversationApi, toolsApi, memoryApi, todoApi } from './api'
import type { Tool, MemoryEntry } from './types'
import type { Todo } from './api'
import 'highlight.js/styles/vs2015.css'
import EditorArea from './components/EditorArea'
import { useTheme } from './hooks/useTheme'
import Card from './components/ui/Card/Card'
import Button from './components/ui/Button/Button'

const ExplorerPanel = process.env.REACT_APP_NEW_EXPLORER === '0' ? OldExplorerPanel : NewExplorerPanel

/* ── 页面专属样式（注入一次） ─────────────────────────────────────────── */
const APP_STYLES = `
/* ── 布局根 ── */
.age-root {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--color-bg-primary);
  font-family: var(--font-sans);
  color: var(--color-label);
}

/* ── Activity Bar ── */
.age-activity-bar {
  width: 48px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: var(--material-chrome);
  backdrop-filter: saturate(var(--vibrancy-saturation)) blur(var(--blur-md));
  -webkit-backdrop-filter: saturate(var(--vibrancy-saturation)) blur(var(--blur-md));
  border-right: var(--border-hairline);
  padding: var(--spacing-2) 0;
  z-index: 20;
}
.age-activity-bar-top,
.age-activity-bar-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-1);
}
.age-activity-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--color-label-tertiary);
  font-size: 16px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--easing-ease),
              color     var(--duration-fast) var(--easing-ease),
              transform var(--duration-fast) var(--easing-spring);
  position: relative;
}
.age-activity-btn:hover {
  background: var(--color-fill-secondary);
  color: var(--color-label);
  transform: scale(1.08);
}
.age-activity-btn:active {
  transform: scale(0.94);
}
.age-activity-btn.active {
  background: var(--color-accent-subtle);
  color: var(--color-accent);
}

/* ── Sidebar Panel ── */
.age-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--material-regular);
  backdrop-filter: saturate(var(--vibrancy-saturation)) blur(var(--blur-md));
  -webkit-backdrop-filter: saturate(var(--vibrancy-saturation)) blur(var(--blur-md));
  border-right: var(--border-hairline);
  transition: width var(--duration-normal) var(--easing-smooth);
  position: relative;
  z-index: 15;
}
.age-sidebar-resizer {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 16;
  transition: background var(--duration-fast);
}
.age-sidebar-resizer::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-separator);
  transition: background var(--duration-fast);
}
.age-sidebar-resizer:hover::after,
.age-sidebar-resizer.dragging::after {
  background: var(--color-accent);
  box-shadow: 0 0 4px var(--color-accent);
}

/* ── Main content ── */
.age-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-primary);
}

/* ── Panel inner ── */
.age-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.age-panel-header {
  padding: var(--spacing-3) var(--spacing-4) var(--spacing-2);
  flex-shrink: 0;
  border-bottom: var(--border-hairline);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: transparent;
}
.age-panel-title {
  font-size: var(--text-caption1-size);
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--color-label-secondary);
}
.age-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-2);
  scrollbar-width: thin;
  scrollbar-color: var(--color-gray-4) transparent;
}
.age-panel-body::-webkit-scrollbar { width: 4px; }
.age-panel-body::-webkit-scrollbar-track { background: transparent; }
.age-panel-body::-webkit-scrollbar-thumb { background: var(--color-gray-4); border-radius: var(--radius-full); }

/* ── Icon button ── */
.age-icon-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-label-tertiary);
  font-size: 13px;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--easing-ease-out),
    color      var(--duration-fast) var(--easing-ease-out),
    transform  var(--duration-fast) var(--easing-spring);
}
.age-icon-btn:hover {
  background: var(--color-fill);
  color: var(--color-label);
}
.age-icon-btn:active {
  transform: scale(0.94);
}
.age-icon-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus-ring);
}
.age-icon-btn.danger:hover {
  background: var(--color-red-subtle);
  color: var(--color-red);
}

/* ── Empty state ── */
.age-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: var(--spacing-2);
  color: var(--color-label-quaternary);
  font-size: var(--text-footnote-size);
}
.age-empty-icon {
  font-size: 32px;
  opacity: 0.3;
}

/* ── Split toolbar ── */
.age-split-toolbar {
  display: flex;
  gap: var(--spacing-1);
  padding: var(--spacing-1) var(--spacing-3);
  background: var(--material-chrome);
  backdrop-filter: var(--backdrop-regular);
  -webkit-backdrop-filter: var(--backdrop-regular);
  border-bottom: var(--border-hairline);
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
}
.age-split-btn {
  width: 28px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-label-quaternary);
  transition: var(--transition-interactive);
}
.age-split-btn:hover { color: var(--color-label-secondary); background: var(--color-fill); }
.age-split-btn.active {
  background: var(--color-accent-subtle);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* ── Split divider ── */
.age-split-divider {
  flex-shrink: 0;
  position: relative;
  z-index: 10;
  background: var(--color-separator-opaque);
  transition: background var(--duration-fast);
}
.age-split-divider:hover, .age-split-divider.dragging {
  background: var(--color-accent);
}
.age-split-divider-dots {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  pointer-events: none;
}

/* ── Card entry animation ── */
@keyframes age-card-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.age-card-animate {
  animation: age-card-in var(--duration-normal) var(--easing-ease-out) both;
}

/* ── Fade crossover ── */
.age-fade { transition: opacity var(--duration-normal) var(--easing-ease); }
.age-fade-hidden { opacity: 0; pointer-events: none; }

/* ── Source badge ── */
.age-source-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-weight: 500;
}

/* ── Tool row ── */
.age-tool-row {
  margin-bottom: 3px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: var(--border-default);
  background: transparent;
  cursor: pointer;
  transition: background var(--duration-fast), border-color var(--duration-fast);
  width: 100%;
  text-align: left;
}
.age-tool-row:hover, .age-tool-row.open {
  background: var(--color-fill-quaternary);
  border-color: var(--color-gray-4);
}

/* ── Memory / History list item ── */
.age-list-item {
  border-radius: var(--radius-sm);
  border: var(--border-default);
  background: transparent;
  margin-bottom: var(--spacing-1);
  overflow: hidden;
  transition: background var(--duration-fast), border-color var(--duration-fast);
  cursor: pointer;
}
.age-list-item:hover { background: var(--color-fill-quaternary); }
.age-list-item.active {
  background: var(--color-accent-subtle);
  border-color: var(--color-accent);
}

/* ── Form row ── */
.age-form-row {
  padding: var(--spacing-3);
  border-bottom: var(--border-hairline);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

/* ── Filter tabs ── */
.age-filter-tabs {
  display: flex;
  gap: 2px;
  padding: var(--spacing-1) var(--spacing-2);
  border-bottom: var(--border-hairline);
  flex-shrink: 0;
  background: var(--color-bg-secondary);
}
.age-filter-tab {
  padding: 2px 8px;
  font-size: var(--text-caption2-size);
  border-radius: var(--radius-xs);
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-label-tertiary);
  transition: all var(--duration-fast);
}
.age-filter-tab:hover { color: var(--color-label-secondary); }
.age-filter-tab.active {
  background: var(--color-accent-subtle);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* ── Search box ── */
.age-search {
  width: 100%;
  background: var(--color-fill-secondary);
  border: var(--border-default);
  border-radius: var(--radius-sm);
  padding: 5px 10px 5px 28px;
  color: var(--color-label);
  font-size: var(--text-footnote-size);
  font-family: var(--font-sans);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--duration-fast);
}
.age-search:focus { border-color: var(--color-accent); }
.age-search::placeholder { color: var(--color-label-tertiary); }
.age-search-wrap { position: relative; }
.age-search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-label-tertiary);
  font-size: 12px;
  pointer-events: none;
}

/* ── Settings modal ── */
.age-settings-section {
  margin-bottom: var(--spacing-6);
}
.age-settings-label {
  font-size: var(--text-footnote-size);
  font-weight: 600;
  color: var(--color-label-secondary);
  margin-bottom: var(--spacing-2);
}
`

function injectStyles() {
  if (document.getElementById('age-styles')) return
  const el = document.createElement('style')
  el.id = 'age-styles'
  el.textContent = APP_STYLES
  document.head.appendChild(el)
}

/* ── localStorage 持久化 ─────────────────────────────────────────────────── */
function usePersist<T>(key: string, defaultVal: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [val, setVal] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : defaultVal } catch { return defaultVal }
  })
  const set: React.Dispatch<React.SetStateAction<T>> = useCallback((action) => {
    setVal(prev => {
      const next = typeof action === 'function' ? (action as (p: T) => T)(prev) : action
      try { localStorage.setItem(key, JSON.stringify(next)) } catch {}
      return next
    })
  }, [key])
  return [val, set]
}

/* ── Split layout ────────────────────────────────────────────────────────── */
type SplitMode = 'chat-only' | 'horizontal' | 'vertical'

function ChatOnly() {
  return <ChatArea />
}

function MainArea() {
  const [splitMode, setSplitMode] = usePersist<SplitMode>('ui.splitMode', 'vertical')
  const [splitRatio, setSplitRatio] = usePersist<number>('ui.splitRatio', 0.5)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef  = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    draggingRef.current = true
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const ratio = splitMode === 'horizontal'
        ? (ev.clientY - rect.top)  / rect.height
        : (ev.clientX - rect.left) / rect.width
      setSplitRatio(Math.max(0.15, Math.min(0.85, ratio)))
    }
    const onUp = () => {
      draggingRef.current = false
      setIsDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [splitMode, setSplitRatio])

  const modeIcons: Record<SplitMode, React.ReactNode> = {
    'chat-only': <CommentOutlined />,
    horizontal:  <SplitCellsOutlined style={{ transform: 'rotate(90deg)' }} />,
    vertical:    <ColumnWidthOutlined />,
  }
  const modeTips: Record<SplitMode, string> = {
    'chat-only': '仅聊天',
    horizontal:  '上下分割',
    vertical:    '左右分割',
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* 布局切换工具栏 */}
      <div className="age-split-toolbar">
        {(['chat-only', 'horizontal', 'vertical'] as SplitMode[]).map(mode => (
          <button
            key={mode}
            title={modeTips[mode]}
            className={`age-split-btn${splitMode === mode ? ' active' : ''}`}
            onClick={() => setSplitMode(mode)}
          >
            {modeIcons[mode]}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div
        ref={containerRef}
        style={{
          flex: 1, overflow: 'hidden', display: 'flex',
          flexDirection: splitMode === 'horizontal' ? 'column' : 'row',
        }}
      >
        {splitMode === 'chat-only' ? (
          <ChatOnly />
        ) : (
          <>
            {/* 第一块：文件管理 / 编辑器 */}
            <div style={{
              ...(splitMode === 'horizontal'
                ? { height: `${splitRatio * 100}%`, flexShrink: 0 }
                : { width:  `${splitRatio * 100}%`, flexShrink: 0 }),
              overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}>
              <EditorArea />
            </div>

            {/* 分隔线 */}
            <div
              className={`age-split-divider${isDragging ? ' dragging' : ''}`}
              onMouseDown={onDividerMouseDown}
              style={splitMode === 'horizontal'
                ? { height: 5, cursor: 'row-resize', width: '100%' }
                : { width:  5, cursor: 'col-resize', height: '100%' }}
            >
              <div className="age-split-divider-dots" style={splitMode === 'horizontal'
                ? { left: '50%', top: '50%', transform: 'translate(-50%,-50%)', flexDirection: 'row' }
                : { top: '50%', left: '50%', transform: 'translate(-50%,-50%)', flexDirection: 'column' }}
              >
                {[0, 1, 2].map(i => (
                  <div key={i} style={{
                    width: 3, height: 3, borderRadius: '50%',
                    background: 'var(--color-label-quaternary)',
                  }} />
                ))}
              </div>
            </div>

            {/* 第二块：聊天 */}
            <div style={{
              flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
              minWidth: splitMode === 'vertical'   ? 420 : undefined,
              minHeight: splitMode === 'horizontal' ? 420 : undefined,
            }}>
              <ChatArea />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Activity bar nav ────────────────────────────────────────────────────── */
type PanelKey = 'chat' | 'agents' | 'mcp' | 'knowledge' | 'tools' | 'memory' | 'tasks' | 'history' | 'explorer'

const ACTIVITIES: { key: PanelKey; icon: React.ReactNode; label: string }[] = [
  { key: 'explorer',  icon: <FolderOutlined />,     label: '资源管理器' },
  { key: 'chat',      icon: <MessageOutlined />,    label: '对话' },
  { key: 'agents',    icon: <RobotOutlined />,      label: 'Agents' },
  { key: 'mcp',       icon: <ApiOutlined />,        label: 'MCP Servers' },
  { key: 'knowledge', icon: <DatabaseOutlined />,   label: '知识库' },
  { key: 'tools',     icon: <ToolOutlined />,       label: '工具列表' },
  { key: 'memory',    icon: <ThunderboltOutlined />,label: '记忆存储' },
  { key: 'tasks',     icon: <CheckSquareOutlined />,label: '任务' },
]

/* ── Shared helpers ─────────────────────────────────────────────────────── */
const PanelHeader: React.FC<{
  title: string
  count?: number
  action?: React.ReactNode
}> = ({ title, count, action }) => (
  <div className="age-panel-header">
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span className="age-panel-title">{title}</span>
      {count !== undefined && count > 0 && (
        <span style={{
          fontSize: 10, color: 'var(--color-label-tertiary)',
          background: 'var(--color-fill)',
          padding: '1px 7px', borderRadius: 'var(--radius-full)',
        }}>{count}</span>
      )}
    </div>
    {action && <div style={{ display: 'flex', gap: 4 }}>{action}</div>}
  </div>
)

const IconBtn: React.FC<{
  title: string
  icon: React.ReactNode
  onClick: () => void
  danger?: boolean
}> = ({ title, icon, onClick, danger = false }) => (
  <button
    title={title}
    className={`age-icon-btn${danger ? ' danger' : ''}`}
    onClick={onClick}
  >
    {icon}
  </button>
)

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <div className="age-empty">
    <div className="age-empty-icon">◌</div>
    <div>{text}</div>
  </div>
)

/* ── History Panel ───────────────────────────────────────────────────────── */
function HistoryPanel() {
  const { sessions, switchSession, activeSessionId } = useSessionStore()
  return (
    <div className="age-panel">
      <PanelHeader title="历史记录" count={sessions.length} />
      <div className="age-panel-body">
        {sessions.length === 0
          ? <EmptyState text="暂无历史对话" />
          : sessions.map((s) => {
              const isActive = s.id === activeSessionId
              return (
                <div
                  key={s.id}
                  className={`age-list-item${isActive ? ' active' : ''}`}
                  onClick={() => switchSession(s.id)}
                  style={{ padding: '9px 12px', marginBottom: 2 }}
                >
                  <div style={{
                    fontSize: 'var(--text-footnote-size)',
                    color: isActive ? 'var(--color-label)' : 'var(--color-label-secondary)',
                    fontWeight: isActive ? 500 : 400,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    marginBottom: 3,
                  }}>{s.title}</div>
                  <div style={{ fontSize: 'var(--text-caption2-size)', color: 'var(--color-label-tertiary)' }}>
                    {new Date(s.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                </div>
              )
            })}
      </div>
    </div>
  )
}

/* ── Tools Panel ─────────────────────────────────────────────────────────── */
const SOURCE_META: Record<string, { label: string; color: string; bg: string }> = {
  builtin: { label: 'builtin', color: 'var(--color-green)',   bg: 'var(--color-green-subtle)'  },
  skill:   { label: 'skill',   color: 'var(--color-purple)',  bg: 'var(--color-fill-tertiary)'  },
  mcp:     { label: 'MCP',     color: 'var(--color-teal)',    bg: 'var(--color-fill-tertiary)'  },
}

function ToolsPanel() {
  const [tools, setTools]       = useState<Tool[]>([])
  const [loading, setLoading]   = useState(false)
  const [search, setSearch]     = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    setLoading(true)
    toolsApi.list().then(res => setTools(res.list)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const filtered = search
    ? tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.description ?? '').toLowerCase().includes(search.toLowerCase()))
    : tools

  const toggleExpand = (name: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })

  return (
    <div className="age-panel">
      {/* Header with search */}
      <div style={{
        padding: 'var(--spacing-3) var(--spacing-4) var(--spacing-2)',
        flexShrink: 0,
        borderBottom: 'var(--border-hairline)',
        background: 'var(--color-bg-secondary)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span className="age-panel-title">工具列表</span>
          {tools.length > 0 && (
            <span style={{
              fontSize: 10, color: 'var(--color-label-tertiary)',
              background: 'var(--color-fill)', padding: '1px 7px',
              borderRadius: 'var(--radius-full)',
            }}>
              {filtered.length}{search ? `/${tools.length}` : ''}
            </span>
          )}
        </div>
        <div className="age-search-wrap">
          <input
            className="age-search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索工具名称或描述..."
          />
          <span className="age-search-icon">🔍</span>
        </div>
      </div>

      <div className="age-panel-body">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 0', color: 'var(--color-label-tertiary)' }}>
            <ReloadOutlined spin style={{ fontSize: 20 }} />
            <span style={{ fontSize: 12 }}>加载中...</span>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState text="暂无匹配工具" />
        ) : filtered.map((t, i) => {
          const src   = SOURCE_META[t.source ?? '']
          const isOpen = expanded.has(t.name)
          return (
            <button
              key={t.name}
              className={`age-tool-row${isOpen ? ' open' : ''}`}
              onClick={() => toggleExpand(t.name)}
              style={{ animationDelay: `${i * 0.03}s` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                <FunctionOutlined style={{ color: 'var(--color-label-tertiary)', fontSize: 12, flexShrink: 0 }} />
                <span style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--color-label)',
                  fontFamily: 'var(--font-mono)', flex: 1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {t.name}
                </span>
                {t.displayName && (
                  <span style={{
                    fontSize: 10, color: 'var(--color-label-tertiary)', flexShrink: 0,
                    maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{t.displayName}</span>
                )}
                {src && (
                  <span className="age-source-badge" style={{ color: src.color, background: src.bg }}>
                    {src.label}
                  </span>
                )}
                <span style={{
                  color: 'var(--color-label-tertiary)', fontSize: 10, flexShrink: 0,
                  transition: `transform var(--duration-fast)`,
                  transform: isOpen ? 'rotate(180deg)' : 'none',
                  display: 'inline-block',
                }}>▼</span>
              </div>
              {isOpen && t.description && (
                <div style={{
                  padding: '0 10px 10px 30px',
                  fontSize: 'var(--text-caption1-size)',
                  color: 'var(--color-label-secondary)',
                  lineHeight: 1.6,
                  borderTop: 'var(--border-hairline)',
                  textAlign: 'left',
                }}>
                  <div style={{ paddingTop: 8 }}>{t.description}</div>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ── Memory Panel ────────────────────────────────────────────────────────── */
function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [key,    setKey]      = useState('')
  const [value,  setValue]    = useState('')
  const [saving, setSaving]   = useState(false)

  const fetchData = () => {
    setLoading(true)
    memoryApi.list().then(r => setEntries(r.list)).catch(() => {}).finally(() => setLoading(false))
  }
  useEffect(() => { fetchData() }, [])

  const handleSave = async () => {
    if (!key.trim() || !value.trim()) return
    setSaving(true)
    try {
      const entry = await memoryApi.remember(key.trim(), value.trim())
      setEntries(e => [entry, ...e.filter(x => x.key !== entry.key)])
      setKey(''); setValue('')
      antMsg.success('已记忆')
    } catch (err: any) { antMsg.error(err.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    try { await memoryApi.delete(id); setEntries(e => e.filter(x => x.id !== id)) }
    catch (err: any) { antMsg.error(err.message) }
  }

  return (
    <div className="age-panel">
      <PanelHeader
        title="记忆存储"
        count={entries.length}
        action={<IconBtn title="刷新" icon={<ReloadOutlined />} onClick={fetchData} />}
      />

      {/* 新增表单 */}
      <div className="age-form-row">
        <input
          className="age-search"
          style={{ paddingLeft: 10 }}
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="Key（标识符）"
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="age-search"
            style={{ flex: 1, paddingLeft: 10 }}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder="Value（内容）"
          />
          <Button
            variant="primary"
            size="compact"
            onClick={handleSave}
            disabled={saving || !key.trim() || !value.trim()}
            loading={saving}
          >
            存入
          </Button>
        </div>
      </div>

      <div className="age-panel-body">
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
            <ReloadOutlined spin style={{ color: 'var(--color-label-tertiary)', fontSize: 18 }} />
          </div>
        ) : entries.length === 0 ? <EmptyState text="暂无记忆条目" /> : entries.map((e, i) => (
          <Card
            key={e.id}
            variant="default"
            className="age-card-animate"
            style={{
              marginBottom: 4,
              animationDelay: `${i * 0.05}s`,
              background: 'var(--color-bg-tertiary)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: 'var(--spacing-2) var(--spacing-3) var(--spacing-1)', gap: 8 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--color-accent)', flexShrink: 0,
              }} />
              <span style={{
                flex: 1, fontSize: 'var(--text-caption2-size)',
                fontWeight: 600, color: 'var(--color-accent)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{e.key}</span>
              <IconBtn title="删除" icon={<DeleteOutlined />} onClick={() => handleDelete(e.id)} danger />
            </div>
            <div style={{
              padding: '0 var(--spacing-3) var(--spacing-2) var(--spacing-5)',
              fontSize: 'var(--text-caption1-size)',
              color: 'var(--color-label-secondary)',
              lineHeight: 1.6, wordBreak: 'break-all',
            }}>{e.value}</div>
          </Card>
        ))}
      </div>
    </div>
  )
}

/* ── Tasks Panel ─────────────────────────────────────────────────────────── */
const TODO_STATUS_CFG: Record<string, { color: string; bg: string; label: string }> = {
  pending:     { color: 'var(--color-orange)',  bg: 'var(--color-orange-subtle)',  label: '待办'   },
  in_progress: { color: 'var(--color-teal)',    bg: 'var(--color-fill-tertiary)',   label: '进行中' },
  done:        { color: 'var(--color-green)',   bg: 'var(--color-green-subtle)',   label: '完成'   },
  cancelled:   { color: 'var(--color-gray-1)',  bg: 'var(--color-fill)',            label: '已取消' },
}
const PRIORITY_CFG: Record<string, { color: string; label: string }> = {
  high:   { color: 'var(--color-red)',    label: '高' },
  medium: { color: 'var(--color-orange)', label: '中' },
  low:    { color: 'var(--color-green)',  label: '低' },
}

function TasksPanel() {
  const [todos,    setTodos]    = useState<Todo[]>([])
  const [loading,  setLoading]  = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [filter,   setFilter]   = useState<string>('all')
  const activeSessionId  = useSessionStore(s => s.activeSessionId)
  const lastTodosUpdate  = useSessionStore(s => s.lastTodosUpdate)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try { setTodos(await todoApi.list({ sessionId: activeSessionId ?? undefined })) }
    catch {} finally { setLoading(false) }
  }, [activeSessionId])

  useEffect(() => { fetchData() }, [fetchData, lastTodosUpdate])

  const handleAdd = async () => {
    const t = addTitle.trim(); if (!t) return
    await todoApi.create({ title: t, priority: 'medium', sessionId: activeSessionId ?? undefined })
    setAddTitle(''); fetchData()
  }

  const handleToggle = async (todo: Todo) => {
    await todoApi.update(todo.id, { status: todo.status === 'done' ? 'pending' : 'done' })
    fetchData()
  }

  const handleDelete = async (id: string) => { await todoApi.delete(id); fetchData() }

  const filtered = filter === 'all' ? todos : todos.filter(t => t.status === filter)
  const counts = {
    all: todos.length,
    pending:     todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    done:        todos.filter(t => t.status === 'done').length,
  }

  return (
    <div className="age-panel">
      <PanelHeader
        title="待办任务"
        count={todos.length}
        action={<IconBtn title="刷新" icon={<ReloadOutlined />} onClick={fetchData} />}
      />

      {/* 快速添加 */}
      <div style={{ padding: 'var(--spacing-2) var(--spacing-3)', borderBottom: 'var(--border-hairline)', display: 'flex', gap: 6, flexShrink: 0 }}>
        <input
          className="age-search"
          style={{ flex: 1, paddingLeft: 10 }}
          value={addTitle}
          onChange={e => setAddTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="添加待办任务..."
        />
        <button
          onClick={handleAdd}
          style={{
            padding: '0 12px', borderRadius: 'var(--radius-sm)',
            background: 'var(--color-accent)', border: 'none',
            color: 'var(--color-label-inverted)', cursor: 'pointer', fontSize: 15, flexShrink: 0,
            transition: 'opacity var(--duration-fast)',
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.82')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >+</button>
      </div>

      {/* 过滤 Tab */}
      <div className="age-filter-tabs">
        {(['all', 'pending', 'in_progress', 'done'] as const).map(s => (
          <button
            key={s}
            className={`age-filter-tab${filter === s ? ' active' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s === 'all' ? '全部' : s === 'in_progress' ? '进行中' : TODO_STATUS_CFG[s]?.label}
            <span style={{ marginLeft: 4, fontSize: 10 }}>{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="age-panel-body">
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
            <ReloadOutlined spin style={{ color: 'var(--color-label-tertiary)', fontSize: 18 }} />
          </div>
        ) : filtered.length === 0
          ? <EmptyState text="暂无任务 ✨" />
          : filtered.map((t, i) => {
              const scfg = TODO_STATUS_CFG[t.status] ?? TODO_STATUS_CFG.pending
              const pcfg = PRIORITY_CFG[t.priority]  ?? PRIORITY_CFG.medium
              return (
                <Card
                  key={t.id}
                  variant="default"
                  className="age-card-animate"
                  style={{
                    marginBottom: 4,
                    animationDelay: `${i * 0.05}s`,
                    opacity: t.status === 'done' ? 0.55 : 1,
                    background: 'var(--color-bg-tertiary)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--spacing-2) var(--spacing-3)' }}>
                    {/* 复选框 */}
                    <div
                      onClick={() => handleToggle(t)}
                      style={{
                        width: 16, height: 16,
                        borderRadius: 'var(--radius-xs)',
                        border: `1.5px solid ${t.status === 'done' ? 'var(--color-green)' : 'var(--color-gray-4)'}`,
                        background: t.status === 'done' ? 'var(--color-green-subtle)' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', flexShrink: 0,
                        transition: 'all var(--duration-fast)',
                      }}
                    >
                      {t.status === 'done' && <span style={{ color: 'var(--color-green)', fontSize: 10, lineHeight: 1 }}>✓</span>}
                    </div>

                    {/* 标题 */}
                    <span style={{
                      flex: 1, fontSize: 'var(--text-caption1-size)',
                      color: t.status === 'done' ? 'var(--color-label-tertiary)' : 'var(--color-label)',
                      textDecoration: t.status === 'done' ? 'line-through' : 'none',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      transition: 'all var(--duration-fast)',
                    }}>{t.title}</span>

                    {/* 优先级 */}
                    <span style={{ fontSize: 10, color: pcfg.color, flexShrink: 0 }}>{pcfg.label}</span>

                    {/* 状态 badge */}
                    {t.status !== 'pending' && t.status !== 'done' && (
                      <span style={{
                        fontSize: 10, color: scfg.color, background: scfg.bg,
                        padding: '1px 6px', borderRadius: 'var(--radius-full)', flexShrink: 0,
                      }}>{scfg.label}</span>
                    )}

                    <IconBtn title="删除" icon={<DeleteOutlined />} onClick={() => handleDelete(t.id)} danger />
                  </div>

                  {t.dueAt && (
                    <div style={{
                      padding: '0 var(--spacing-3) var(--spacing-2) 34px',
                      fontSize: 10, color: 'var(--color-label-tertiary)',
                    }}>
                      截止 {new Date(t.dueAt).toLocaleDateString('zh-CN')}
                    </div>
                  )}
                </Card>
              )
            })}
      </div>
    </div>
  )
}

/* ── Main App ────────────────────────────────────────────────────────────── */
export default function App() {
  injectStyles()

  const [activePanel, setActivePanel] = usePersist<PanelKey>('ui.activePanel', 'chat')
  const { addSession, openSettings }  = useSessionStore()

  /* 首次加载远端会话 */
  useEffect(() => {
    ;(async () => {
      try {
        const result = await conversationApi.listSessions()
        const remote = result.list ?? []
        if (remote.length === 0) return
        useSessionStore.setState((state) => {
          const msgMap   = { ...state.messageMap }
          const usageMap = { ...state.usageMap }
          remote.forEach(r => { if (r.totalUsage) usageMap[r.sessionId] = r.totalUsage as any })
          const existingIds  = new Set(state.sessions.map(s => s.id))
          const newSessions  = remote
            .filter(s => !existingIds.has(s.sessionId))
            .map(s => ({
              id: s.sessionId,
              title: s.lastMessage
                ? s.lastMessage.slice(0, 24) + (s.lastMessage.length > 24 ? '...' : '')
                : '历史对话',
              createdAt: s.lastAt,
              lastMessage: s.lastMessage,
            }))
          if (!newSessions.length) return { usageMap }
          const merged = [...newSessions, ...state.sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          newSessions.forEach(s => { if (!msgMap[s.id]) msgMap[s.id] = []; if (!usageMap[s.id]) usageMap[s.id] = null })
          return { sessions: merged, messageMap: msgMap, usageMap }
        })
      } catch { /* offline */ }
    })()
  }, [])

  const sidebarPanel = () => {
    switch (activePanel) {
      case 'explorer':  return <ExplorerPanel />
      case 'chat':      return <SessionList onNewChat={() => { addSession(); setActivePanel('chat') }} />
      case 'agents':    return <AgentPanel />
      case 'mcp':       return <McpPanel />
      case 'knowledge': return <KnowledgePanel />
      case 'tools':     return <ToolsPanel />
      case 'memory':    return <MemoryPanel />
      case 'tasks':     return <TasksPanel />
      case 'history':   return <HistoryPanel />
      default:          return null
    }
  }

  const { isDark } = useTheme()

  const [sidebarWidth, setSidebarWidth] = usePersist<number>('ui.sidebarWidth', 240)
  const [sidebarDragging, setSidebarDragging] = useState(false)
  const sidebarDraggingRef = useRef(false)
  const sidebarDragStart   = useRef({ x: 0, w: 0 })

  const onSidebarResizerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    sidebarDraggingRef.current = true
    setSidebarDragging(true)
    sidebarDragStart.current = { x: e.clientX, w: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDraggingRef.current) return
      const next = sidebarDragStart.current.w + (ev.clientX - sidebarDragStart.current.x)
      setSidebarWidth(Math.max(120, Math.min(600, next)))
    }
    const onUp = () => {
      sidebarDraggingRef.current = false
      setSidebarDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth, setSidebarWidth])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary:       isDark ? '#0A84FF' : '#007AFF',
          colorBgBase:        isDark ? '#000000' : '#FFFFFF',
          colorBgContainer:   isDark ? '#1C1C1E' : '#F2F2F7',
          colorBgElevated:    isDark ? '#2C2C2E' : '#FFFFFF',
          colorBorder:        isDark ? '#3A3A3C' : '#E5E5EA',
          colorText:          isDark ? '#FFFFFF'  : '#000000',
          colorTextSecondary: isDark ? 'rgba(235,235,245,0.60)' : 'rgba(60,60,67,0.60)',
          borderRadius:       10,
          fontFamily:         '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
          fontSize:           13,
        },
        components: {
          Button: { borderRadius: 10 },
          Input:  {
            colorBgContainer: isDark ? '#2C2C2E' : '#FFFFFF',
            colorBorder:      isDark ? '#3A3A3C' : '#D1D1D6',
            colorText:        isDark ? '#FFFFFF'  : '#000000',
          },
          Select: {
            colorBgContainer: isDark ? '#2C2C2E' : '#FFFFFF',
            colorBgElevated:  isDark ? '#1C1C1E' : '#FFFFFF',
            colorBorder:      isDark ? '#3A3A3C' : '#D1D1D6',
          },
          Modal:  { colorBgElevated: isDark ? '#1C1C1E' : '#FFFFFF' },
          Slider: {
            colorPrimaryBorder: isDark ? '#0A84FF' : '#007AFF',
            colorPrimary:       isDark ? '#0A84FF' : '#007AFF',
          },
        },
      }}
    >
      <AntdApp>
        {/* ── 根容器 ── */}
        <div className="age-root">

          {/* ── Activity Bar ── */}
          <div className="age-activity-bar">
            <div className="age-activity-bar-top">
              {ACTIVITIES.map(item => (
                <button
                  key={item.key}
                  title={item.label}
                  className={`age-activity-btn${activePanel === item.key ? ' active' : ''}`}
                  onClick={() => setActivePanel(item.key)}
                >
                  {item.icon}
                </button>
              ))}
            </div>
            <div className="age-activity-bar-bottom">
              <button
                title="设置"
                className="age-activity-btn"
                onClick={() => openSettings('general')}
              >
                <SettingOutlined />
              </button>
            </div>
          </div>

          {/* ── Sidebar ── */}
          <div
            className="age-sidebar"
            style={{ width: sidebarWidth }}
          >
            {sidebarPanel()}
          </div>

          {/* ── Sidebar resize handle ── */}
          <div
            className={`age-sidebar-resizer${sidebarDragging ? ' dragging' : ''}`}
            onMouseDown={onSidebarResizerDown}
          />

          {/* ── Main content ── */}
          <div className="age-main">
            <MainArea />
          </div>
        </div>

        <SettingsModal />
      </AntdApp>
    </ConfigProvider>
  )
}

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { ConfigProvider, theme, Tooltip, App as AntdApp, message as antMsg } from 'antd'
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
import { conversationApi, toolsApi, memoryApi, todoApi, deepseekApi } from './api'
import type { Tool, MemoryEntry } from './types'
import type { Todo } from './api'
import styles from './App.module.css'
import 'highlight.js/styles/vs2015.css'
import EditorArea from './components/EditorArea'

const ExplorerPanel = process.env.REACT_APP_NEW_EXPLORER === '0' ? OldExplorerPanel : NewExplorerPanel

// 始终显示聊天（不受文件标签影响）
function ChatOnly() {
  return <ChatArea />
}

// ── localStorage 持久化 helper ────────────────────────────────────────────────
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

// ── Explorer + Chat split layout ──────────────────────────────────────────────
type SplitMode = 'chat-only' | 'horizontal' | 'vertical'

function MainArea() {
  const [splitMode, setSplitMode] = usePersist<SplitMode>('ui.splitMode', 'vertical')
  // horizontal: 上下；vertical: 左右
  const [splitRatio, setSplitRatio] = usePersist<number>('ui.splitRatio', 0.5)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // 拖拽时禁止 iframe/canvas 抢焦点
  const [isDragging, setIsDragging] = useState(false)

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    draggingRef.current = true

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      let ratio: number
      if (splitMode === 'horizontal') {
        ratio = (ev.clientY - rect.top) / rect.height
      } else {
        ratio = (ev.clientX - rect.left) / rect.width
      }
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
    horizontal: <SplitCellsOutlined style={{ transform: 'rotate(90deg)' }} />,
    vertical: <ColumnWidthOutlined />,
  }
  const modeTips: Record<SplitMode, string> = { 'chat-only': '仅聊天', horizontal: '上下分割', vertical: '左右分割' }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* 布局切换工具栏 */}
      <div style={{
        display: 'flex', gap: 2, padding: '3px 10px',
        background: '#1a1a1a', borderBottom: '1px solid #2a2a2a',
        flexShrink: 0, alignItems: 'center', justifyContent: 'flex-end',
      }}>
        {(['chat-only', 'horizontal', 'vertical'] as SplitMode[]).map(mode => (
          <Tooltip key={mode} title={modeTips[mode]} placement="bottom">
            <button
              onClick={() => setSplitMode(mode)}
              style={{
                width: 26, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, borderRadius: 3, cursor: 'pointer',
                background: splitMode === mode ? 'rgba(14,99,156,0.35)' : 'transparent',
                border: `1px solid ${splitMode === mode ? '#0e639c' : 'transparent'}`,
                color: splitMode === mode ? '#4fc1ff' : '#555',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (splitMode !== mode) e.currentTarget.style.color = '#aaa' }}
              onMouseLeave={e => { if (splitMode !== mode) e.currentTarget.style.color = '#555' }}
            >{modeIcons[mode]}</button>
          </Tooltip>
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
            {/* 第一块：文件管理/编辑器 */}
            <div style={{
              ...(splitMode === 'horizontal'
                ? { height: `${splitRatio * 100}%`, flexShrink: 0 }
                : { width: `${splitRatio * 100}%`, flexShrink: 0 }),
              overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}>
              <EditorArea />
            </div>

            {/* 分隔线 — 常态可见细线 + hover/拖拽加粗变蓝 */}
            <div
              onMouseDown={onDividerMouseDown}
              style={{
                ...(splitMode === 'horizontal'
                  ? { height: 5, cursor: 'row-resize', width: '100%' }
                  : { width: 5, cursor: 'col-resize', height: '100%' }),
                flexShrink: 0, position: 'relative', zIndex: 10,
                background: isDragging ? '#0e639c' : '#2c2c2c',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#0e639c')}
              onMouseLeave={e => { if (!isDragging) e.currentTarget.style.background = '#2c2c2c' }}
            >
              {/* 中间小圆点提示可拖拽 */}
              <div style={{
                position: 'absolute',
                ...(splitMode === 'horizontal'
                  ? { left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 24, height: 4, flexDirection: 'row' }
                  : { top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 4, height: 24, flexDirection: 'column' }),
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, pointerEvents: 'none',
              }}>
                {[0,1,2].map(i => (
                  <div key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.25)' }} />
                ))}
              </div>
            </div>

            {/* 第二块：聊天（最小宽/高 420px） */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: splitMode === 'vertical' ? 420 : undefined, minHeight: splitMode === 'horizontal' ? 420 : undefined }}>
              <ChatArea />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Activity bar nav ───────────────────────────────────────────────────────────
type PanelKey = 'chat' | 'agents' | 'mcp' | 'knowledge' | 'tools' | 'memory' | 'tasks' | 'history' | 'explorer'

const ACTIVITIES: { key: PanelKey; icon: React.ReactNode; label: string }[] = [
  { key: 'explorer',  icon: <FolderOutlined />,     label: '资源管理器' },
  { key: 'chat',      icon: <MessageOutlined />,    label: '对话' },
  { key: 'agents',    icon: <RobotOutlined />,       label: 'Agents' },
  { key: 'mcp',       icon: <ApiOutlined />,         label: 'MCP Servers' },
  { key: 'knowledge', icon: <DatabaseOutlined />,    label: '知识库' },
  { key: 'tools',     icon: <ToolOutlined />,        label: '工具列表' },
  { key: 'memory',    icon: <ThunderboltOutlined />, label: '记忆存储' },
  { key: 'tasks',     icon: <CheckSquareOutlined />, label: '任务' },
]

// ── Shared panel CSS helpers ───────────────────────────────────────────────────
const panelBase: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column',
  overflow: 'hidden', background: '#252526',
}
const panelHeader = (title: string, count?: number, action?: React.ReactNode): React.ReactNode => (
  <div style={{ padding: '10px 14px 8px', flexShrink: 0, borderBottom: '1px solid #252525', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: '#666', textTransform: 'uppercase' }}>{title}</span>
      {count !== undefined && count > 0 && (
        <span style={{ fontSize: 10, color: '#555', background: 'rgba(255,255,255,0.06)', padding: '1px 7px', borderRadius: 10 }}>{count}</span>
      )}
    </div>
    {action && <div>{action}</div>}
  </div>
)
const iconBtn = (title: string, icon: React.ReactNode, onClick: () => void, danger = false): React.ReactNode => (
  <Tooltip title={title}>
    <div
      onClick={onClick}
      style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', color: danger ? '#666' : '#555', fontSize: 13, transition: 'all 0.12s' }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(248,81,73,0.12)' : 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = danger ? '#f85149' : '#ccc' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = danger ? '#666' : '#555' }}
    >{icon}</div>
  </Tooltip>
)
const emptyState = (text: string): React.ReactNode => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#555' }}>
    <div style={{ fontSize: 28, opacity: 0.4 }}>○</div>
    <div style={{ fontSize: 12 }}>{text}</div>
  </div>
)

// ── History panel ──────────────────────────────────────────────────────────────
function HistoryPanel() {
  const { sessions, switchSession, activeSessionId } = useSessionStore()
  return (
    <div style={panelBase}>
      {panelHeader('历史记录', sessions.length)}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {sessions.length === 0 ? emptyState('暂无历史对话') : sessions.map((s) => {
          const isActive = s.id === activeSessionId
          return (
            <div
              key={s.id}
              onClick={() => switchSession(s.id)}
              style={{
                padding: '9px 12px', borderRadius: 6, cursor: 'pointer', marginBottom: 2,
                background: isActive ? 'rgba(14,99,156,0.2)' : 'transparent',
                border: `1px solid ${isActive ? 'rgba(14,99,156,0.4)' : 'transparent'}`,
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = '#242424' } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' } }}
            >
              <div style={{ fontSize: 13, color: isActive ? '#e8e8e8' : '#b0b0b0', fontWeight: isActive ? 500 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 3 }}>{s.title}</div>
              <div style={{ fontSize: 11, color: '#5a6270' }}>{new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Tools Panel ────────────────────────────────────────────────────────────────
const SOURCE_META: Record<string, { label: string; color: string; bg: string }> = {
  builtin: { label: 'builtin', color: '#4ade80', bg: 'rgba(74,222,128,0.08)' },
  skill:   { label: 'skill',   color: '#c084fc', bg: 'rgba(192,132,252,0.08)' },
  mcp:     { label: 'MCP',     color: '#38bdf8', bg: 'rgba(56,189,248,0.08)' },
}

function ToolsPanel() {
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    setLoading(true)
    toolsApi.list().then((res) => setTools(res.list)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const filtered = search
    ? tools.filter(t => t.name.toLowerCase().includes(search.toLowerCase()) || (t.description ?? '').toLowerCase().includes(search.toLowerCase()))
    : tools

  const toggleExpand = (name: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#1a1a1a' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px 6px', flexShrink: 0, borderBottom: '1px solid #242424' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.08em', color: '#888', textTransform: 'uppercase' }}>
            工具列表
          </span>
          {tools.length > 0 && (
            <span style={{ fontSize: 11, color: '#555', background: 'rgba(255,255,255,0.05)', padding: '1px 7px', borderRadius: 10 }}>
              {filtered.length}{search ? `/${tools.length}` : ''}
            </span>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索工具名称或描述..."
            style={{ width: '100%', background: 'rgba(255,255,255,.04)', border: '1px solid #2e2e2e', borderRadius: 6, padding: '5px 10px 5px 28px', color: '#ccc', fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
          />
          <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#444', fontSize: 12, pointerEvents: 'none' }}>🔍</span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 0', color: '#3c3c3c' }}>
            <ReloadOutlined spin style={{ fontSize: 20 }} />
            <span style={{ fontSize: 12 }}>加载中...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ color: '#333', fontSize: 12, textAlign: 'center', padding: '40px 0' }}>暂无匹配工具</div>
        ) : filtered.map(t => {
          const src = SOURCE_META[t.source ?? '']
          const isOpen = expanded.has(t.name)
          return (
            <div
              key={t.name}
              onClick={() => toggleExpand(t.name)}
              style={{
                marginBottom: 3, borderRadius: 6, overflow: 'hidden',
                border: `1px solid ${isOpen ? '#313131' : '#242424'}`,
                background: isOpen ? 'rgba(255,255,255,0.03)' : 'transparent',
                cursor: 'pointer', transition: 'all 0.12s',
              }}
            >
              {/* 行标题 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                <FunctionOutlined style={{ color: '#555', fontSize: 12, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#d4d4d4', fontFamily: 'Consolas,monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name}
                </span>
                {t.displayName && (
                  <span style={{ fontSize: 10, color: '#666', flexShrink: 0, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.displayName}</span>
                )}
                {src && (
                  <span style={{ fontSize: 10, color: src.color, background: src.bg, borderRadius: 4, padding: '1px 6px', flexShrink: 0, fontWeight: 500 }}>{src.label}</span>
                )}
                <span style={{ color: isOpen ? '#555' : '#3a3a3a', fontSize: 10, flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(180deg)' : 'none' }}>▼</span>
              </div>
              {/* 展开描述 */}
              {isOpen && t.description && (
                <div style={{ padding: '0 10px 10px 30px', fontSize: 12, color: '#6e7681', lineHeight: 1.6, borderTop: '1px solid #242424' }}>
                  <div style={{ paddingTop: 8 }}>{t.description}</div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Memory Panel ───────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,.04)', border: '1px solid #272727',
  borderRadius: 6, padding: '6px 10px', color: '#ccc', fontSize: 12, outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
}

function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchData = () => {
    setLoading(true)
    memoryApi.list().then((r) => setEntries(r.list)).catch(() => {}).finally(() => setLoading(false))
  }
  useEffect(() => { fetchData() }, [])

  const handleSave = async () => {
    if (!key.trim() || !value.trim()) return
    setSaving(true)
    try {
      const entry = await memoryApi.remember(key.trim(), value.trim())
      setEntries((e) => [entry, ...e.filter((x) => x.key !== entry.key)])
      setKey(''); setValue('')
      antMsg.success('已记忆')
    } catch (err: any) { antMsg.error(err.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    try { await memoryApi.delete(id); setEntries((e) => e.filter((x) => x.id !== id)) }
    catch (err: any) { antMsg.error(err.message) }
  }

  return (
    <div style={panelBase}>
      {panelHeader('记忆存储', entries.length, iconBtn('刷新', <ReloadOutlined />, fetchData))}

      {/* 新增表单 */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #1f1f1f', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          value={key} onChange={e => setKey(e.target.value)}
          placeholder="Key（标识符）"
          style={inputStyle}
          onFocus={e => (e.target.style.borderColor = '#0e639c')}
          onBlur={e => (e.target.style.borderColor = '#272727')}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={value} onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder="Value（内容）"
            style={{ ...inputStyle, flex: 1 }}
            onFocus={e => (e.target.style.borderColor = '#0e639c')}
            onBlur={e => (e.target.style.borderColor = '#272727')}
          />
          <button
            onClick={handleSave}
            disabled={saving || !key.trim() || !value.trim()}
            style={{ padding: '0 14px', borderRadius: 6, background: key.trim() && value.trim() ? '#0e639c' : '#1e1e1e', border: '1px solid #272727', color: key.trim() && value.trim() ? '#fff' : '#444', cursor: 'pointer', fontSize: 12, flexShrink: 0, transition: 'all 0.15s' }}
          >存入</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
            <ReloadOutlined spin style={{ color: '#333', fontSize: 18 }} />
          </div>
        ) : entries.length === 0 ? emptyState('暂无记忆条目') : entries.map((e) => (
          <div key={e.id} style={{ marginBottom: 4, borderRadius: 6, border: '1px solid #252525', background: 'rgba(255,255,255,0.025)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px 4px', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#0e639c', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: '#4e9be6', fontFamily: 'Consolas,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.key}</span>
              {iconBtn('删除', <DeleteOutlined />, () => handleDelete(e.id), true)}
            </div>
            <div style={{ padding: '0 10px 8px 24px', fontSize: 12, color: '#8b949e', lineHeight: 1.6, wordBreak: 'break-all' }}>{e.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tasks Panel — 使用与聊天区相同的 todoApi，数据完全同步 ─────────────────────
const TODO_STATUS_CFG: Record<string, { color: string; bg: string; label: string; dot: string }> = {
  pending:     { color: '#d29922', bg: 'rgba(210,153,34,0.12)',  label: '待办',   dot: '#d29922' },
  in_progress: { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)', label: '进行中', dot: '#38bdf8' },
  done:        { color: '#4ade80', bg: 'rgba(74,222,128,0.12)', label: '完成',  dot: '#4ade80' },
  cancelled:   { color: '#6e7681', bg: 'rgba(110,118,129,0.1)', label: '已取消', dot: '#6e7681' },
}
const PRIORITY_CFG: Record<string, { color: string; label: string }> = {
  high:   { color: '#f85149', label: '高' },
  medium: { color: '#d29922', label: '中' },
  low:    { color: '#4ade80', label: '低' },
}

function TasksPanel() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [filter, setFilter] = useState<string>('all')
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const lastTodosUpdate = useSessionStore(s => s.lastTodosUpdate)

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

  const handleDelete = async (id: string) => {
    await todoApi.delete(id); fetchData()
  }

  const filtered = filter === 'all' ? todos : todos.filter(t => t.status === filter)
  const counts = { all: todos.length, pending: todos.filter(t => t.status === 'pending').length, in_progress: todos.filter(t => t.status === 'in_progress').length, done: todos.filter(t => t.status === 'done').length }

  return (
    <div style={panelBase}>
      {panelHeader('待办任务', todos.length, iconBtn('刷新', <ReloadOutlined />, fetchData))}

      {/* 快速添加 */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #2d2d2d', display: 'flex', gap: 6, flexShrink: 0 }}>
        <input
          value={addTitle}
          onChange={e => setAddTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="添加待办任务..."
          style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid #3c3c3c', borderRadius: 5, padding: '5px 9px', color: '#cccccc', fontSize: 12, outline: 'none' }}
          onFocus={e => (e.target.style.borderColor = '#0e639c')}
          onBlur={e => (e.target.style.borderColor = '#3c3c3c')}
        />
        <button onClick={handleAdd} style={{ padding: '0 10px', borderRadius: 5, background: '#0e639c', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13, flexShrink: 0 }}>+</button>
      </div>

      {/* 过滤 Tab */}
      <div style={{ display: 'flex', padding: '4px 8px', gap: 2, borderBottom: '1px solid #2d2d2d', flexShrink: 0 }}>
        {(['all', 'pending', 'in_progress', 'done'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{ padding: '2px 7px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid transparent', background: filter === s ? 'rgba(14,99,156,0.25)' : 'transparent', color: filter === s ? '#4e9be6' : '#666', transition: 'all 0.12s' }}
          >
            {s === 'all' ? '全部' : s === 'in_progress' ? '进行中' : TODO_STATUS_CFG[s]?.label}
            <span style={{ marginLeft: 4, fontSize: 10, color: filter === s ? '#4e9be6' : '#444' }}>{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
            <ReloadOutlined spin style={{ color: '#555', fontSize: 18 }} />
          </div>
        ) : filtered.length === 0 ? emptyState('暂无任务 ✨') : filtered.map((t) => {
          const scfg = TODO_STATUS_CFG[t.status] ?? TODO_STATUS_CFG.pending
          const pcfg = PRIORITY_CFG[t.priority] ?? PRIORITY_CFG.medium
          return (
            <div
              key={t.id}
              style={{ marginBottom: 4, borderRadius: 6, border: `1px solid ${t.status === 'done' ? '#2a2a2a' : '#333'}`, background: t.status === 'done' ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.03)', overflow: 'hidden', transition: 'all 0.15s' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
                {/* 复选框 */}
                <div
                  onClick={() => handleToggle(t)}
                  style={{ width: 16, height: 16, borderRadius: 4, border: `1px solid ${t.status === 'done' ? '#4ade80' : '#3c3c3c'}`, background: t.status === 'done' ? 'rgba(74,222,128,0.15)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' }}
                >
                  {t.status === 'done' && <span style={{ color: '#4ade80', fontSize: 10, lineHeight: 1 }}>✓</span>}
                </div>

                {/* 标题 */}
                <span style={{ flex: 1, fontSize: 12, color: t.status === 'done' ? '#555' : '#cccccc', textDecoration: t.status === 'done' ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'all 0.15s' }}>{t.title}</span>

                {/* 优先级 */}
                <span style={{ fontSize: 10, color: pcfg.color, flexShrink: 0 }}>{pcfg.label}</span>

                {/* 状态 badge（非 pending/done 才显示）*/}
                {t.status !== 'pending' && t.status !== 'done' && (
                  <span style={{ fontSize: 10, color: scfg.color, background: scfg.bg, padding: '1px 6px', borderRadius: 8, flexShrink: 0 }}>{scfg.label}</span>
                )}

                {iconBtn('删除', <DeleteOutlined />, () => handleDelete(t.id), true)}
              </div>
              {t.dueAt && (
                <div style={{ padding: '0 10px 7px 34px', fontSize: 10, color: '#5a6270' }}>截止 {new Date(t.dueAt).toLocaleDateString('zh-CN')}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [activePanel, setActivePanel] = usePersist<PanelKey>('ui.activePanel', 'chat')
  const { addSession, openSettings } = useSessionStore()

  useEffect(() => {
    ;(async () => {
      try {
        const result = await conversationApi.listSessions()
        const remote = result.list ?? []
        if (remote.length === 0) return
        useSessionStore.setState((state) => {
          const msgMap = { ...state.messageMap }
          const usageMap = { ...state.usageMap }

          remote.forEach(r => {
            if (r.totalUsage) {
              usageMap[r.sessionId] = r.totalUsage as any
            }
          })

          const existingIds = new Set(state.sessions.map((s) => s.id))
          const newSessions = remote
            .filter((s) => !existingIds.has(s.sessionId))
            .map((s) => ({
              id: s.sessionId,
              title: s.lastMessage ? s.lastMessage.slice(0, 24) + (s.lastMessage.length > 24 ? '...' : '') : `历史对话`,
              createdAt: s.lastAt,
              lastMessage: s.lastMessage,
            }))
          
          if (!newSessions.length) return { usageMap }
          
          const merged = [...newSessions, ...state.sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          newSessions.forEach((s) => { if (!msgMap[s.id]) msgMap[s.id] = []; if (!usageMap[s.id]) usageMap[s.id] = null })
          return { sessions: merged, messageMap: msgMap, usageMap }
        })
      } catch { /* offline */ }
    })()
  }, [])

  // ── 启动时拉取 DeepSeek 有效价格（供 ChatArea 成本估算使用） ─────────────
  useEffect(() => {
    ;(async () => {
      try {
        const data = await deepseekApi.getPrices()
        if (data?.models) {
          const priceMap: Record<string, any> = {}
          for (const m of data.models) {
            if (m.effectivePrice) priceMap[m.modelId] = m.effectivePrice
          }
          useSessionStore.getState().setDeepSeekPrices(priceMap)
        }
      } catch { /* DeepSeek 未配置，忽略 */ }
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

  const [sidebarWidth, setSidebarWidth] = usePersist<number>('ui.sidebarWidth', 240)
  const sidebarDragging = useRef(false)
  const sidebarDragStart = useRef({ x: 0, w: 0 })

  const onSidebarResizerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    sidebarDragging.current = true
    sidebarDragStart.current = { x: e.clientX, w: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragging.current) return
      const next = sidebarDragStart.current.w + (ev.clientX - sidebarDragStart.current.x)
      setSidebarWidth(Math.max(120, Math.min(600, next)))
    }
    const onUp = () => {
      sidebarDragging.current = false
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
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#0e639c',
          colorBgBase: '#1e1e1e',
          colorBgContainer: '#252526',
          colorBgElevated: '#2d2d2d',
          colorBorder: '#3c3c3c',
          colorText: '#d4d4d4',
          colorTextSecondary: '#8b949e',
          borderRadius: 4,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Segoe WPC', Roboto, 'Helvetica Neue', Arial, sans-serif",
          fontSize: 13,
        },
        components: {
          Button: { borderRadius: 4 },
          Input: { colorBgContainer: '#3c3c3c', colorBorder: '#3c3c3c', colorText: '#cccccc' },
          Select: { colorBgContainer: '#3c3c3c', colorBgElevated: '#252526', colorBorder: '#3c3c3c' },
          Modal: { colorBgElevated: '#1e1e1e' },
          Slider: { colorPrimaryBorder: '#0e639c', colorPrimary: '#0e639c' },
        },
      }}
    >
      <AntdApp>
        <div className={styles.app}>
          {/* Activity Bar */}
          <div className={styles.activityBar}>
            <div className={styles.activityTop}>
              {ACTIVITIES.map((item) => (
                <Tooltip key={item.key} title={item.label} placement="right">
                  <button
                    className={`${styles.activityBtn} ${activePanel === item.key ? styles.activityActive : ''}`}
                    onClick={() => setActivePanel(item.key)}
                  >
                    {item.icon}
                  </button>
                </Tooltip>
              ))}
            </div>
            <div className={styles.activityBottom}>
              <Tooltip title="设置" placement="right">
                <button className={styles.activityBtn} onClick={() => openSettings('general')}>
                  <SettingOutlined />
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Sidebar */}
          <div className={styles.sidebar} style={{ width: sidebarWidth }}>{sidebarPanel()}</div>

          {/* Sidebar resize handle */}
          <div
            className={styles.sidebarResizer}
            onMouseDown={onSidebarResizerDown}
          />

          {/* Main area */}
          <div className={styles.main}>
            <MainArea />
          </div>
        </div>
        <SettingsModal />
      </AntdApp>
    </ConfigProvider>
  )
}
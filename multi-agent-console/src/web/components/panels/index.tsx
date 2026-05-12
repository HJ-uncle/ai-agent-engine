/**
 * panels/index.tsx — 桌面 Sidebar 与移动端单面板共用的面板集合
 *
 * 这些面板从 App.tsx 抽出，避免桌面/移动两套 Shell 各自维护一份。
 * 渲染函数 `renderSidebarPanel` 接收当前激活的 PanelKey，返回对应组件。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Tooltip, App as AntdApp } from 'antd'
import {
  MessageOutlined, RobotOutlined,
  ApiOutlined, DatabaseOutlined,
  FolderOutlined, ThunderboltOutlined, ToolOutlined,
  CheckSquareOutlined, ReloadOutlined, DeleteOutlined,
  FunctionOutlined,
} from '@ant-design/icons'
import SessionList from '../SessionList'
import AgentPanel from '../AgentPanel'
import McpPanel from '../McpPanel'
import KnowledgePanel from '../KnowledgePanel'
import OldExplorerPanel from '../ExplorerPanel'
import NewExplorerPanel from '../explorer'
import { useSessionStore } from '@core/store/session'
import { toolsApi, memoryApi, todoApi } from '@core/api'
import type { Tool, MemoryEntry } from '@core/types'
import type { Todo } from '@core/api'
import {
  type PanelKey,
  ACTIVITY_KEYS,
  TOOL_SOURCE_META,
  TODO_STATUS_CFG,
  TODO_PRIORITY_CFG,
} from '@core/domain/panels'

const ExplorerPanel =
  (import.meta.env.VITE_NEW_EXPLORER || (process.env as any).REACT_APP_NEW_EXPLORER) === '0' ? OldExplorerPanel : NewExplorerPanel

// ── PanelKey + Activities ────────────────────────────────────────────
export type { PanelKey }

const ACTIVITY_ICONS: Record<PanelKey, React.ReactNode> = {
  explorer:  <FolderOutlined />,
  chat:      <MessageOutlined />,
  agents:    <RobotOutlined />,
  mcp:       <ApiOutlined />,
  knowledge: <DatabaseOutlined />,
  tools:     <ToolOutlined />,
  memory:    <ThunderboltOutlined />,
  tasks:     <CheckSquareOutlined />,
  history:   <MessageOutlined />,
}

export const ACTIVITIES: { key: PanelKey; icon: React.ReactNode; label: string }[] =
  ACTIVITY_KEYS.map(a => ({ ...a, icon: ACTIVITY_ICONS[a.key] }))

// ── 共享样式 helpers ─────────────────────────────────────────────────
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

// ── History panel ────────────────────────────────────────────────────
export function HistoryPanel() {
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

// ── Tools Panel ──────────────────────────────────────────────────────
const SOURCE_META = TOOL_SOURCE_META

export function ToolsPanel() {
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

// ── Memory Panel ─────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,.04)', border: '1px solid #272727',
  borderRadius: 6, padding: '6px 10px', color: '#ccc', fontSize: 12, outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
}

export function MemoryPanel() {
  const { message: antMsg } = AntdApp.useApp()
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

// ── Tasks Panel ──────────────────────────────────────────────────────
const PRIORITY_CFG = TODO_PRIORITY_CFG

export function TasksPanel() {
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
                <div
                  onClick={() => handleToggle(t)}
                  style={{ width: 16, height: 16, borderRadius: 4, border: `1px solid ${t.status === 'done' ? '#4ade80' : '#3c3c3c'}`, background: t.status === 'done' ? 'rgba(74,222,128,0.15)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' }}
                >
                  {t.status === 'done' && <span style={{ color: '#4ade80', fontSize: 10, lineHeight: 1 }}>✓</span>}
                </div>

                <span style={{ flex: 1, fontSize: 12, color: t.status === 'done' ? '#555' : '#cccccc', textDecoration: t.status === 'done' ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'all 0.15s' }}>{t.title}</span>

                <span style={{ fontSize: 10, color: pcfg.color, flexShrink: 0 }}>{pcfg.label}</span>

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

// ── 渲染分发：根据 PanelKey 返回对应组件 ───────────────────────────────
export function renderSidebarPanel(
  activePanel: PanelKey,
  ctx: { onNewChat: () => void },
): React.ReactNode {
  switch (activePanel) {
    case 'explorer':  return <ExplorerPanel />
    case 'chat':      return <SessionList onNewChat={ctx.onNewChat} />
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

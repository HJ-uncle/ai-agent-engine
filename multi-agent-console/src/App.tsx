import React, { useState, useEffect } from 'react'
import { ConfigProvider, theme, Tooltip, App as AntdApp, message as antMsg } from 'antd'
import {
  MessageOutlined, RobotOutlined, SettingOutlined,
  HistoryOutlined, ApiOutlined, DatabaseOutlined,
  FolderOutlined,
  ThunderboltOutlined, ToolOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import SessionList from './components/SessionList'
import ChatArea from './components/ChatArea'
import AgentPanel from './components/AgentPanel'
import McpPanel from './components/McpPanel'
import KnowledgePanel from './components/KnowledgePanel'
import ExplorerPanel from './components/ExplorerPanel'
import SettingsModal from './components/SettingsModal'
import { useSessionStore } from './store/session'
import { conversationApi, toolsApi, memoryApi, tasksApi } from './api'
import type { Tool, MemoryEntry, Task } from './types'
import styles from './App.module.css'
import 'highlight.js/styles/vs2015.css'

import EditorArea from './components/EditorArea'

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
  { key: 'tasks',     icon: <HistoryOutlined />,     label: '任务' },
]

// ── History panel ──────────────────────────────────────────────────────────────
function HistoryPanel() {
  const { sessions, switchSession, activeSessionId } = useSessionStore()
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px 6px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#bbb', opacity: 0.7 }}>
        历史记录
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 4px' }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            style={{ padding: '7px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: s.id === activeSessionId ? '#fff' : '#ccc', background: s.id === activeSessionId ? 'rgba(14,99,156,.4)' : 'transparent', marginBottom: 1 }}
            onClick={() => switchSession(s.id)}
          >
            <div style={{ fontWeight: 500, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
            <div style={{ fontSize: 11, color: '#484f58' }}>{new Date(s.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tools Panel ────────────────────────────────────────────────────────────────
function ToolsPanel() {
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    toolsApi.list().then((res) => setTools(res.list)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const filtered = search ? tools.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || (t.description ?? '').toLowerCase().includes(search.toLowerCase())) : tools

  const sourceColor: Record<string, string> = { builtin: '#3fb950', skill: '#c084fc', mcp: '#38bdf8' }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px 6px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#bbb', opacity: 0.7, flexShrink: 0 }}>
        工具列表 {tools.length > 0 && <span style={{ color: '#484f58' }}>({tools.length})</span>}
      </div>
      <div style={{ padding: '0 8px 6px', flexShrink: 0 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索工具..." style={{ width: '100%', background: 'rgba(255,255,255,.05)', border: '1px solid #3c3c3c', borderRadius: 4, padding: '4px 8px', color: '#ccc', fontSize: 12, outline: 'none' }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 6px' }}>
        {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><span style={{ color: '#484f58', fontSize: 12 }}>加载中...</span></div>
          : filtered.length === 0 ? <div style={{ color: 'rgba(255,255,255,.2)', fontSize: 12, textAlign: 'center', padding: 24 }}>暂无工具</div>
          : filtered.map((t) => (
          <div key={t.name} style={{ padding: '6px 8px', borderRadius: 4, marginBottom: 2, background: 'rgba(255,255,255,.03)', border: '1px solid #2d2d2d' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#d4d4d4', fontFamily: 'Consolas,monospace' }}>{t.name}</span>
              {t.displayName && <span style={{ fontSize: 11, color: '#8b949e', background: 'rgba(255,255,255,.06)', borderRadius: 3, padding: '0 4px' }}>{t.displayName}</span>}
              {t.source && <span style={{ fontSize: 10, color: sourceColor[t.source] ?? '#8b949e', background: 'rgba(255,255,255,.06)', borderRadius: 3, padding: '0 4px' }}>{t.source}</span>}
            </div>
            <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2, lineHeight: 1.4 }}>{t.description}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Memory Panel ───────────────────────────────────────────────────────────────
function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const fetch = () => {
    setLoading(true)
    memoryApi.list().then((r) => setEntries(r.list)).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { fetch() }, [])

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
    try {
      await memoryApi.delete(id)
      setEntries((e) => e.filter((x) => x.id !== id))
    } catch (err: any) { antMsg.error(err.message) }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px 6px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#bbb', opacity: 0.7, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span>记忆存储</span>
        <button onClick={fetch} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 13 }}>↻</button>
      </div>
      <div style={{ padding: '0 8px 8px', flexShrink: 0 }}>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key" style={{ width: '100%', background: 'rgba(255,255,255,.05)', border: '1px solid #3c3c3c', borderRadius: 4, padding: '4px 8px', color: '#ccc', fontSize: 12, outline: 'none', marginBottom: 4 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSave()} placeholder="Value" style={{ flex: 1, background: 'rgba(255,255,255,.05)', border: '1px solid #3c3c3c', borderRadius: 4, padding: '4px 8px', color: '#ccc', fontSize: 12, outline: 'none' }} />
          <button onClick={handleSave} disabled={saving || !key.trim()} style={{ padding: '0 10px', borderRadius: 4, background: '#0e639c', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 12 }}>存</button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 6px' }}>
        {loading ? <div style={{ color: '#484f58', fontSize: 12, textAlign: 'center', padding: 16 }}>加载中...</div>
          : entries.length === 0 ? <div style={{ color: 'rgba(255,255,255,.2)', fontSize: 12, textAlign: 'center', padding: 24 }}>暂无记忆</div>
          : entries.map((e) => (
          <div key={e.id} style={{ padding: '6px 8px', borderRadius: 4, marginBottom: 2, background: 'rgba(255,255,255,.03)', border: '1px solid #2d2d2d', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#60a5fa', fontFamily: 'Consolas,monospace' }}>{e.key}</div>
              <div style={{ fontSize: 12, color: '#8b949e', marginTop: 2, wordBreak: 'break-all' }}>{e.value}</div>
            </div>
            <button onClick={() => handleDelete(e.id)} style={{ background: 'none', border: 'none', color: '#484f58', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tasks Panel ────────────────────────────────────────────────────────────────
function TasksPanel() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)

  const statusColor: Record<string, string> = { pending: '#d29922', running: '#38bdf8', completed: '#3fb950', failed: '#f85149', cancelled: '#8b949e' }

  const fetch = () => {
    setLoading(true)
    tasksApi.list().then((r) => setTasks(r.list)).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { fetch() }, [])

  const handleDelete = async (id: string) => {
    try { await tasksApi.delete(id); setTasks((t) => t.filter((x) => x.id !== id)) }
    catch (err: any) { antMsg.error(err.message) }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px 6px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#bbb', opacity: 0.7, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span>任务</span>
        <button onClick={fetch} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 13 }}>↻</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 6px' }}>
        {loading ? <div style={{ color: '#484f58', fontSize: 12, textAlign: 'center', padding: 16 }}>加载中...</div>
          : tasks.length === 0 ? <div style={{ color: 'rgba(255,255,255,.2)', fontSize: 12, textAlign: 'center', padding: 24 }}>暂无任务</div>
          : tasks.map((t) => (
          <div key={t.id} style={{ padding: '6px 8px', borderRadius: 4, marginBottom: 2, background: 'rgba(255,255,255,.03)', border: '1px solid #2d2d2d' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: statusColor[t.status] ?? '#8b949e' }}>● {t.status}</span>
              <span style={{ flex: 1, fontSize: 12, color: '#d4d4d4', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name ?? t.id}</span>
              <button onClick={() => handleDelete(t.id)} style={{ background: 'none', border: 'none', color: '#484f58', cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
            {t.description && <div style={{ fontSize: 11, color: '#8b949e' }}>{t.description}</div>}
            <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>{new Date(t.createdAt).toLocaleString('zh-CN')}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [activePanel, setActivePanel] = useState<PanelKey>('chat')
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
          <div className={styles.sidebar}>{sidebarPanel()}</div>

          {/* Main chat or Editor */}
          <div className={styles.main}>
            {useSessionStore(s => s.activeFile) ? <EditorArea /> : <ChatArea />}
          </div>
        </div>
        <SettingsModal />
      </AntdApp>
    </ConfigProvider>
  )
}
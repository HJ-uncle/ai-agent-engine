import React, { useState, useEffect, useRef, useCallback } from 'react'
import { ConfigProvider, theme, Tooltip, App as AntdApp } from 'antd'
import {
  SettingOutlined,
  ColumnWidthOutlined, SplitCellsOutlined, CommentOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import ChatArea from './components/ChatArea'
import SettingsModal from './components/SettingsModal'
import { useSessionStore } from '@core/store/session'
import { conversationApi, deepseekApi, settingsApi } from '@core/api'
import styles from './App.module.css'
import 'highlight.js/styles/vs2015.css'
import EditorArea from './components/EditorArea'
import { ACTIVITIES, renderSidebarPanel, type PanelKey } from './components/panels'

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

// ── Explorer + Chat split layout (desktop only) ──────────────────────────────
type SplitMode = 'chat-only' | 'horizontal' | 'vertical'

function MainArea({ activePanel }: { activePanel: PanelKey }) {
  const [splitMode, setSplitMode] = usePersist<SplitMode>('ui.splitMode', 'vertical')
  // horizontal: 上下；vertical: 左右
  const [splitRatio, setSplitRatio] = usePersist<number>('ui.splitRatio', 0.5)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // 切换到资源管理器时，默认切换左右分割布局
  useEffect(() => {
    if (activePanel === 'explorer' && splitMode === 'chat-only') {
      setSplitMode('vertical')
    }
  }, [activePanel, splitMode, setSplitMode])

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

// ── 桌面端布局（VSCode 三栏 + 拖拽 Sidebar） ─────────────────────────────────
function DesktopLayout({
  activePanel,
  setActivePanel,
}: {
  activePanel: PanelKey
  setActivePanel: (k: PanelKey) => void
}) {
  const { addSession, openSettings } = useSessionStore()

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
      <div className={styles.sidebar} style={{ width: sidebarWidth }}>
        {renderSidebarPanel(activePanel, {
          onNewChat: () => { addSession(); setActivePanel('chat') },
        })}
      </div>

      {/* Sidebar resize handle */}
      <div
        className={styles.sidebarResizer}
        onMouseDown={onSidebarResizerDown}
      />

      {/* Main area */}
      <div className={styles.main}>
        <MainArea activePanel={activePanel} />
      </div>
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [activePanel, setActivePanel] = usePersist<PanelKey>('ui.activePanel', 'chat')

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
            if (m.effectivePrice) {
              priceMap[m.modelId] = {
                effective: m.effectivePrice,
                normal: m.normalPrice
              }
            }
          }
          useSessionStore.getState().setDeepSeekPrices(priceMap)
        }
      } catch { /* DeepSeek 未配置，忽略 */ }
    })()
  }, [])

  // ── 启动时拉取 OSM 设置 ──────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const settings = await settingsApi.get()
        if (settings) {
          let mode = settings.OSM_MODE || settings.SUPERPOWER_MODE
          if (!mode) {
            const legacy = settings.SUPERPOWER_ENABLED
            mode = (legacy === true || legacy === 'true') ? 'methodology' : 'off'
          }
          useSessionStore.getState().setOsmMode(mode)
        }
      } catch { /* 忽略错误 */ }
    })()
  }, [])

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
          Modal: { 
            colorBgElevated: '#252526', 
            colorText: '#d4d4d4', 
            colorTextHeading: '#ffffff',
            headerBg: '#252526',
            contentBg: '#252526'
          },
          Slider: { colorPrimaryBorder: '#0e639c', colorPrimary: '#0e639c' },
        },
      }}
    >
      <AntdApp>
        <DesktopLayout activePanel={activePanel} setActivePanel={setActivePanel} />
        <SettingsModal />
      </AntdApp>
    </ConfigProvider>
  )
}

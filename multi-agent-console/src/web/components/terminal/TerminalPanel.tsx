/**
 * TerminalPanel — 底部终端面板
 * 包含：Tab 栏、新建按钮、关闭/最小化按钮、可拖拽调整高度
 */
import React, { useRef, useCallback } from 'react'
import { Tooltip, App } from 'antd'
import {
  PlusOutlined,
  DownOutlined,
  FullscreenOutlined,
} from '@ant-design/icons'
import { useTerminalStore } from '@core/store/terminal'
import { useSessionStore } from '@core/store/session'
import { terminalApi } from '@core/api'
import XTerminal from './XTerminal'

interface TerminalPanelProps {
  sessionId: string
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ sessionId }) => {
  const { message } = App.useApp()
  const tabs = useTerminalStore(s => s.tabs)
  const activeId = useTerminalStore(s => s.activeTerminalId)
  const panelHeight = useTerminalStore(s => s.panelHeight)
  const addTab = useTerminalStore(s => s.addTab)
  const removeTab = useTerminalStore(s => s.removeTab)
  const setActive = useTerminalStore(s => s.setActiveTerminal)
  const setTabTitle = useTerminalStore(s => s.setTabTitle)
  const setTabAlive = useTerminalStore(s => s.setTabAlive)
  const setPanelVisible = useTerminalStore(s => s.setPanelVisible)
  const setPanelHeight = useTerminalStore(s => s.setPanelHeight)

  // ── 新建终端 ────────────────────────────────────────────────────────────
  const sessionWorkspacePaths = useSessionStore(s =>
    s.sessions.find(sess => sess.id === s.activeSessionId)?.workspacePaths
  )

  const handleNewTerminal = useCallback(async (cwd?: string) => {
    try {
      const { terminalId, cwd: resolvedCwd } = await terminalApi.create(
        sessionId, cwd, 120, 30, sessionWorkspacePaths ?? undefined
      )
      // 根据操作系统显示合适的 shell 名称
      const isWin = navigator.platform.startsWith('Win') || navigator.userAgent.includes('Windows')
      const shell = isWin ? 'pwsh' : 'bash'
      addTab({ terminalId, title: shell, cwd: resolvedCwd, alive: true })
    } catch (e: any) {
      message.error(`创建终端失败: ${e.message}`)
    }
  }, [sessionId, addTab, message, sessionWorkspacePaths])

  // ── 首次打开时自动创建一个终端 ────────────────────────────────────────────
  React.useEffect(() => {
    if (tabs.length === 0) {
      handleNewTerminal()
    }
    // 仅在组件挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 监听右键菜单事件「在终端中打开」
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string; isDir?: boolean }
      handleNewTerminal(detail?.path)
    }
    window.addEventListener('explorer:open-terminal', handler)
    return () => window.removeEventListener('explorer:open-terminal', handler)
  }, [handleNewTerminal])

  // ── 关闭终端 Tab ─────────────────────────────────────────────────────────
  const handleCloseTab = useCallback(async (terminalId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try { await terminalApi.kill(terminalId) } catch { /* ignore */ }
    removeTab(terminalId)
  }, [removeTab])

  // ── 拖拽调整高度 ──────────────────────────────────────────────────────────
  const dragStartYRef = useRef(0)
  const dragStartHeightRef = useRef(0)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartYRef.current = e.clientY
    dragStartHeightRef.current = panelHeight

    const onMove = (ev: MouseEvent) => {
      const delta = dragStartYRef.current - ev.clientY
      setPanelHeight(dragStartHeightRef.current + delta)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [panelHeight, setPanelHeight])

  // ── 最大化/还原 ────────────────────────────────────────────────────────────
  const handleToggleMax = useCallback(() => {
    setPanelHeight(panelHeight >= 600 ? 260 : 600)
  }, [panelHeight, setPanelHeight])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: panelHeight,
        background: '#141414',
        borderTop: '1px solid #1e1e1e',
        flexShrink: 0,
      }}
    >
      {/* 拖拽条 — 常态可见 */}
      <div
        onMouseDown={handleDragStart}
        style={{
          height: 4,
          cursor: 'row-resize',
          background: '#1e1e1e',
          flexShrink: 0,
          transition: 'background 0.15s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = '#0e639c')}
        onMouseLeave={e => (e.currentTarget.style.background = '#1e1e1e')}
      >
        {/* 拖拽提示三点 */}
        <div style={{ display: 'flex', gap: 3, pointerEvents: 'none' }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.12)' }} />
          ))}
        </div>
      </div>

      {/* Tab 栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 36,
          background: '#1a1a1a',
          borderBottom: '1px solid #222',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        {/* 左侧 TERMINAL 标签 */}
        <div style={{ padding: '0 12px', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: '#3c3c3c', textTransform: 'uppercase', flexShrink: 0 }}>
          终端
        </div>

        {/* 分隔线 */}
        <div style={{ width: 1, height: 16, background: '#2a2a2a', flexShrink: 0 }} />

        {/* 终端 Tab 列表 */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', alignItems: 'stretch', paddingLeft: 4 }}>
          {tabs.map(tab => {
            const isActive = tab.terminalId === activeId
            return (
              <div
                key={tab.terminalId}
                onClick={() => setActive(tab.terminalId)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '0 10px',
                  height: '100%',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: isActive ? '#e0e0e0' : '#555',
                  background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                  borderBottom: isActive ? '2px solid #0e639c' : '2px solid transparent',
                  borderRight: '1px solid #1e1e1e',
                  whiteSpace: 'nowrap',
                  userSelect: 'none',
                  flexShrink: 0,
                  transition: 'all 0.12s',
                }}
              >
                {/* 运行状态指示点 */}
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: tab.alive ? '#3fb950' : '#444',
                  boxShadow: tab.alive && isActive ? '0 0 4px #3fb950' : 'none',
                  transition: 'all 0.2s',
                }} />
                <span style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{tab.title}</span>
                <span
                  onClick={e => handleCloseTab(tab.terminalId, e)}
                  style={{
                    marginLeft: 2, width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 3, fontSize: 10, color: '#444', cursor: 'pointer',
                    transition: 'all 0.1s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#ccc' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#444' }}
                >✕</span>
              </div>
            )
          })}
        </div>

        {/* 右侧按钮组 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, padding: '0 6px', flexShrink: 0 }}>
          {[
            { tip: '新建终端', icon: <PlusOutlined />, action: () => handleNewTerminal() },
            { tip: panelHeight >= 600 ? '还原' : '最大化', icon: <FullscreenOutlined />, action: handleToggleMax },
            { tip: '隐藏终端', icon: <DownOutlined />, action: () => setPanelVisible(false) },
          ].map((btn, i) => (
            <Tooltip key={i} title={btn.tip}>
              <div
                onClick={btn.action}
                style={{
                  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 4, color: '#555', cursor: 'pointer', fontSize: 13, transition: 'all 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = '#aaa' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#555' }}
              >{btn.icon}</div>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* 终端内容区：所有 xterm 实例同时 mount，通过 display 切换可见性 */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', paddingLeft: 4 }}>
        {tabs.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#555',
              fontSize: 13,
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <span>尚无终端</span>
            <span
              onClick={() => handleNewTerminal()}
              style={{ color: '#0e639c', cursor: 'pointer', fontSize: 12 }}
            >
              点击新建 +
            </span>
          </div>
        )}
        {tabs.map(tab => {
          const isActive = tab.terminalId === activeId
          return (
            <div
              key={tab.terminalId}
              style={{
                position: 'absolute',
                inset: 0,
                // display:none 会让 xterm canvas 宽高归零
                // 用 opacity+pointerEvents 代替，保留布局尺寸
                opacity: isActive ? 1 : 0,
                pointerEvents: isActive ? 'auto' : 'none',
                // 非激活时仍占位（不影响布局计算），激活时正常渲染
              }}
            >
              <XTerminal
                terminalId={tab.terminalId}
                style={{ paddingLeft: 8 }}
                wsUrl={terminalApi.wsUrl(tab.terminalId)}
                onTitleChange={title => setTabTitle(tab.terminalId, title)}
                onExit={() => setTabAlive(tab.terminalId, false)}
                // 激活状态传给 xterm，切换时触发 re-fit
                isActive={isActive}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default TerminalPanel

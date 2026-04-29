/**
 * TerminalPanel — 底部终端面板
 * 包含：Tab 栏、新建按钮、关闭/最小化按钮、可拖拽调整高度
 */
import React, { useRef, useCallback } from 'react'
import { Tooltip, App } from 'antd'
import {
  PlusOutlined,
  CloseOutlined,
  DownOutlined,
  FullscreenOutlined,
} from '@ant-design/icons'
import { useTerminalStore } from '../../store/terminal'
import { terminalApi } from '../../api'
import XTerminal from './XTerminal'

interface TerminalPanelProps {
  sessionId: string
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ sessionId }) => {
  const { message } = App.useApp()
  const tabs            = useTerminalStore(s => s.tabs)
  const activeId        = useTerminalStore(s => s.activeTerminalId)
  const panelHeight     = useTerminalStore(s => s.panelHeight)
  const addTab          = useTerminalStore(s => s.addTab)
  const removeTab       = useTerminalStore(s => s.removeTab)
  const setActive       = useTerminalStore(s => s.setActiveTerminal)
  const setTabTitle     = useTerminalStore(s => s.setTabTitle)
  const setTabAlive     = useTerminalStore(s => s.setTabAlive)
  const setPanelVisible = useTerminalStore(s => s.setPanelVisible)
  const setPanelHeight  = useTerminalStore(s => s.setPanelHeight)

  // ── 新建终端 ────────────────────────────────────────────────────────────
  const handleNewTerminal = useCallback(async (cwd?: string) => {
    try {
      const { terminalId, cwd: resolvedCwd } = await terminalApi.create(sessionId, cwd)
      // 根据操作系统显示合适的 shell 名称
      const isWin = navigator.platform.startsWith('Win') || navigator.userAgent.includes('Windows')
      const shell = isWin ? 'pwsh' : 'bash'
      addTab({ terminalId, title: shell, cwd: resolvedCwd, alive: true })
    } catch (e: any) {
      message.error(`创建终端失败: ${e.message}`)
    }
  }, [sessionId, addTab, message])

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
        background: '#1e1e1e',
        borderTop: '1px solid #333',
        flexShrink: 0,
      }}
    >
      {/* 拖拽条 */}
      <div
        onMouseDown={handleDragStart}
        style={{
          height: 4,
          cursor: 'row-resize',
          background: 'transparent',
          flexShrink: 0,
        }}
        onMouseEnter={e => (e.currentTarget.style.background = '#0e639c')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      />

      {/* Tab 栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 35,
          background: '#252526',
          borderBottom: '1px solid #333',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        {/* 终端 Tab 列表 */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', alignItems: 'stretch' }}>
          {tabs.map(tab => (
            <div
              key={tab.terminalId}
              onClick={() => setActive(tab.terminalId)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 10px',
                height: '100%',
                cursor: 'pointer',
                fontSize: 12,
                color: tab.terminalId === activeId ? '#fff' : '#888',
                background: tab.terminalId === activeId ? '#1e1e1e' : 'transparent',
                borderRight: '1px solid #333',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                flexShrink: 0,
              }}
            >
              {/* 运行状态指示点 */}
              <span style={{ color: tab.alive ? '#3fb950' : '#666', fontSize: 8 }}>●</span>
              <span>{tab.title}</span>
              <CloseOutlined
                onClick={e => handleCloseTab(tab.terminalId, e)}
                style={{ fontSize: 10, color: '#888', marginLeft: 2 }}
              />
            </div>
          ))}
        </div>

        {/* 右侧按钮组 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px', flexShrink: 0 }}>
          <Tooltip title="新建终端 (Ctrl+`)">
            <PlusOutlined
              onClick={() => handleNewTerminal()}
              style={{ color: '#ccc', cursor: 'pointer', fontSize: 14 }}
            />
          </Tooltip>
          <Tooltip title={panelHeight >= 600 ? '还原' : '最大化'}>
            <FullscreenOutlined
              onClick={handleToggleMax}
              style={{ color: '#ccc', cursor: 'pointer', fontSize: 14 }}
            />
          </Tooltip>
          <Tooltip title="隐藏终端">
            <DownOutlined
              onClick={() => setPanelVisible(false)}
              style={{ color: '#ccc', cursor: 'pointer', fontSize: 14 }}
            />
          </Tooltip>
        </div>
      </div>

      {/* 终端内容区：所有 xterm 实例同时 mount，通过 display 切换可见性 */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
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

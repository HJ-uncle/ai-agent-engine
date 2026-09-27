import React, { useState, useCallback, useRef, useEffect } from 'react'
import { CloseOutlined } from '@ant-design/icons'
import { useExplorerStore } from '@core/store/explorer'

// ── Tab 右键菜单 ──────────────────────────────────────────────────────────────
interface TabCtxMenu {
  x: number
  y: number
  path: string
}

export function EditorTabs() {
  const tabs = useExplorerStore(s => s.tabs)
  const activeTabPath = useExplorerStore(s => s.activeTabPath)
  const setActiveTab = useExplorerStore(s => s.setActiveTab)
  const closeTab = useExplorerStore(s => s.closeTab)

  const [ctxMenu, setCtxMenu] = useState<TabCtxMenu | null>(null)

  const handleClose = (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    const tab = tabs.find(t => t.path === path)
    if (tab?.isDirty) {
      // Emit event handled by UnsavedDialog
      window.dispatchEvent(new CustomEvent('editor:close-dirty-tab', { detail: { path } }))
    } else {
      closeTab(path)
    }
  }

  const handleRightClick = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, path })
  }, [])

  const handleCloseOthers = useCallback((path: string) => {
    tabs.filter(t => t.path !== path).forEach(t => closeTab(t.path))
    setCtxMenu(null)
  }, [tabs, closeTab])

  const handleCloseRight = useCallback((path: string) => {
    const idx = tabs.findIndex(t => t.path === path)
    if (idx >= 0) tabs.slice(idx + 1).forEach(t => closeTab(t.path))
    setCtxMenu(null)
  }, [tabs, closeTab])

  const handleCloseSaved = useCallback(() => {
    tabs.filter(t => !t.isDirty).forEach(t => closeTab(t.path))
    setCtxMenu(null)
  }, [tabs, closeTab])

  const handleCloseAll = useCallback(() => {
    ;[...tabs].forEach(t => closeTab(t.path))
    setCtxMenu(null)
  }, [tabs, closeTab])

  const tabsRef = useRef<HTMLDivElement>(null)

  // 滚轮横向滚动
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return // 本身就是横向滚动，不拦截
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (tabs.length === 0) return null

  return (
    <>
      <div
        ref={tabsRef}
        style={{
          display: 'flex',
          flexDirection: 'row',
          background: '#1e1e1e',
          borderBottom: '1px solid #252526',
          overflowX: 'auto',
          flexShrink: 0,
          height: 35,
          scrollbarWidth: 'none', // Firefox 隐藏滚动条（滚轮操控）
        }}
        onClick={() => ctxMenu && setCtxMenu(null)}
      >
        {tabs.map(tab => {
          const isActive = tab.path === activeTabPath
          const isDirty = tab.isDirty

          return (
            <div
              key={tab.path}
              onClick={() => setActiveTab(tab.path)}
              onContextMenu={e => handleRightClick(e, tab.path)}
              title={tab.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 12px',
                height: '100%',
                cursor: 'pointer',
                fontSize: 13,
                whiteSpace: 'nowrap',
                userSelect: 'none',
                background: isActive ? '#1e1e1e' : '#2d2d2d',
                borderTop: isActive ? '1px solid #007acc' : '1px solid transparent',
                borderRight: '1px solid #252526',
                color: isActive ? '#fff' : '#999',
                flexShrink: 0,
              }}
            >
              {isDirty && (
                <span style={{ color: '#e2c08d', fontSize: 10, lineHeight: 1 }}>●</span>
              )}
              <span>{tab.name}</span>
              <CloseOutlined
                style={{ fontSize: 10, color: '#888' }}
                onClick={e => handleClose(e, tab.path)}
              />
            </div>
          )
        })}
      </div>

      {/* 右键菜单 */}
      {ctxMenu && (
        <>
          {/* 遮罩层关闭菜单 */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
            onClick={() => setCtxMenu(null)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu(null) }}
          />
          <div
            style={{
              position: 'fixed',
              left: ctxMenu.x,
              top: ctxMenu.y,
              zIndex: 1000,
              background: '#252526',
              border: '1px solid #454545',
              borderRadius: 4,
              minWidth: 180,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              padding: '4px 0',
            }}
          >
            {[
              { label: '关闭', shortcut: 'Ctrl+F4', action: () => { handleClose({ stopPropagation: () => {} } as any, ctxMenu.path); setCtxMenu(null) } },
              { label: '关闭其他', action: () => handleCloseOthers(ctxMenu.path) },
              { label: '关闭右侧标签页', action: () => handleCloseRight(ctxMenu.path) },
              { label: '关闭已保存', shortcut: 'Ctrl+K U', action: handleCloseSaved },
              { label: '全部关闭', shortcut: 'Ctrl+K W', action: handleCloseAll },
            ].map((item, idx) => (
              <div
                key={idx}
                onClick={item.action}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '5px 16px',
                  fontSize: 13,
                  color: '#d4d4d4',
                  cursor: 'pointer',
                  gap: 24,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(14,99,156,0.4)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>{item.label}</span>
                {item.shortcut && <span style={{ fontSize: 11, color: '#888' }}>{item.shortcut}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
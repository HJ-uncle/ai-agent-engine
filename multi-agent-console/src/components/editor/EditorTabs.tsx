import React, { useState, useCallback, useRef, useEffect } from 'react'
import { CloseOutlined } from '@ant-design/icons'
import { useExplorerStore } from '../../store/explorer'

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
          background: 'var(--material-chrome)',
          backdropFilter: 'saturate(1.8) blur(20px)',
          WebkitBackdropFilter: 'saturate(1.8) blur(20px)',
          borderBottom: 'var(--border-hairline)',
          overflowX: 'auto',
          flexShrink: 0,
          height: 36,
          scrollbarWidth: 'none',
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
                background: isActive ? 'var(--color-bg-primary)' : 'transparent',
                borderTop: isActive ? `2px solid var(--color-accent)` : '2px solid transparent',
                borderRight: 'var(--border-hairline)',
                color: isActive ? 'var(--color-label)' : 'var(--color-label-secondary)',
                transition: 'background var(--duration-fast) var(--easing-ease), color var(--duration-fast) var(--easing-ease)',
                flexShrink: 0,
              }}
            >
              {isDirty && (
                <span style={{ color: 'var(--color-orange)', fontSize: 10, lineHeight: 1 }}>●</span>
              )}
              <span>{tab.name}</span>
              <CloseOutlined
                style={{ fontSize: 10, color: 'var(--color-label-tertiary)' }}
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
              background: 'var(--material-thick)',
              backdropFilter: 'saturate(1.8) blur(20px)',
              WebkitBackdropFilter: 'saturate(1.8) blur(20px)',
              border: 'var(--border-default)',
              borderRadius: 'var(--radius-md)',
              minWidth: 180,
              boxShadow: 'var(--shadow-popover)',
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
                  padding: '6px 16px',
                  fontSize: 13,
                  color: 'var(--color-label)',
                  cursor: 'pointer',
                  gap: 24,
                  transition: 'background var(--duration-fast) var(--easing-ease)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-accent-subtle)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>{item.label}</span>
                {item.shortcut && <span style={{ fontSize: 11, color: 'var(--color-label-tertiary)' }}>{item.shortcut}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
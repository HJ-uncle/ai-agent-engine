import React from 'react'
import { CloseOutlined } from '@ant-design/icons'
import { useExplorerStore } from '../../store/explorer'

export function EditorTabs() {
  // 只订阅 tabs 数组和 activeTabPath，isDirty 直接从 tab 对象读取
  // 不使用 selectDirtyTabs（每次返回新数组会触发无限重渲染）
  const tabs = useExplorerStore(s => s.tabs)
  const activeTabPath = useExplorerStore(s => s.activeTabPath)
  const setActiveTab = useExplorerStore(s => s.setActiveTab)
  const closeTab = useExplorerStore(s => s.closeTab)

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

  if (tabs.length === 0) return null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        background: '#1e1e1e',
        borderBottom: '1px solid #252526',
        overflowX: 'auto',
        flexShrink: 0,
        height: 35,
      }}
    >
      {tabs.map(tab => {
        const isActive = tab.path === activeTabPath
        const isDirty = tab.isDirty  // 直接读 tab 自身属性，无需额外 selector

        return (
          <div
            key={tab.path}
            onClick={() => setActiveTab(tab.path)}
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
  )
}

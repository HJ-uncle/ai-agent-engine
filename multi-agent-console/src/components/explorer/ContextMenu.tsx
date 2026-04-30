import React, { useEffect, useRef } from 'react'
import { App, Modal } from 'antd'
import { workspaceApi } from '../../api'
import { useExplorerStore } from '../../store/explorer'
import type { FileNode } from './FileTree'

export interface ContextMenuState {
  x: number
  y: number
  node: FileNode
}

interface ContextMenuProps {
  state: ContextMenuState
  sessionId: string
  onClose: () => void
  onRefresh: () => void
  onStartRename: (node: FileNode) => void
}

interface MenuItemDef {
  label: string
  shortcut?: string
  danger?: boolean
  onClick: () => void
}

export function ContextMenu({ state, sessionId, onClose, onRefresh, onStartRename }: ContextMenuProps) {
  const { message } = App.useApp()
  const openTab = useExplorerStore(s => s.openTab)
  const pushLog = useExplorerStore(s => s.pushLog)
  const menuRef = useRef<HTMLDivElement>(null)

  const { node } = state

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleNewFile = async () => {
    onClose()
    const dirPath = node.type === 'dir' ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))
    const name = prompt('新建文件名：')
    if (!name?.trim()) return
    try {
      const created = await workspaceApi.createFile(sessionId, `${dirPath}/${name.trim()}`)
      if (created?.path) openTab({ path: created.path, name: name.trim(), type: 'text' })
      onRefresh()
    } catch (e: any) {
      message.error(e.message ?? '新建文件失败')
    }
  }

  const handleNewFolder = async () => {
    onClose()
    const dirPath = node.type === 'dir' ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))
    const name = prompt('新建文件夹名：')
    if (!name?.trim()) return
    try {
      await workspaceApi.createFolder(sessionId, `${dirPath}/${name.trim()}`)
      onRefresh()
    } catch (e: any) {
      message.error(e.message ?? '新建文件夹失败')
    }
  }

  const handleRename = () => {
    onClose()
    onStartRename(node)
  }

  const handleDelete = () => {
    onClose()
    Modal.confirm({
      title: `确定删除 "${node.name}" 吗？`,
      content: '文件将移至系统回收站，可在操作日志中撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          await workspaceApi.deleteFile(sessionId, node.path)
          pushLog({ type: 'delete', path: node.path })
          onRefresh()
          message.success('已移至回收站')
        } catch (e: any) {
          message.error(e.message ?? '删除失败')
        }
      },
    })
  }

  const handleCopyPath = () => {
    onClose()
    navigator.clipboard.writeText(node.path).then(() => message.success('路径已复制'))
  }

  const handleOpenTerminal = () => {
    onClose()
    // 若右键点的是文件，取父目录；若是文件夹，直接用该目录
    const path = node.type === 'dir'
      ? node.path
      : node.path.substring(0, node.path.lastIndexOf('/')) || '.'
    window.dispatchEvent(new CustomEvent('explorer:open-terminal', { detail: { path } }))
  }

  const items: MenuItemDef[] = [
    { label: '新建文件', shortcut: 'Ctrl+N', onClick: handleNewFile },
    { label: '新建文件夹', shortcut: 'Ctrl+Shift+N', onClick: handleNewFolder },
    { label: '重命名', shortcut: 'F2', onClick: handleRename },
    { label: '删除', shortcut: 'Delete', danger: true, onClick: handleDelete },
    { label: '复制路径', shortcut: 'Ctrl+Shift+C', onClick: handleCopyPath },
    { label: '在终端中打开', shortcut: 'Ctrl+`', onClick: handleOpenTerminal },
  ]

  // Adjust position to stay in viewport
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(state.y, window.innerHeight - 240),
    left: Math.min(state.x, window.innerWidth - 220),
    zIndex: 9999,
    background: 'var(--material-thick)',
    backdropFilter: 'saturate(1.8) blur(20px)',
    WebkitBackdropFilter: 'saturate(1.8) blur(20px)',
    border: 'var(--border-default)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-popover)',
    minWidth: 200,
    padding: '4px 0',
    userSelect: 'none',
  }

  return (
    <div ref={menuRef} style={menuStyle}>
      {items.map((item, i) => (
        <div
          key={i}
          onClick={item.onClick}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '6px 12px',
            fontSize: 13,
            cursor: 'pointer',
            color: item.danger ? 'var(--color-red)' : 'var(--color-label)',
            transition: 'background var(--duration-fast) var(--easing-ease)',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-accent-subtle)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span style={{ fontSize: 11, color: 'var(--color-label-tertiary)', marginLeft: 16 }}>{item.shortcut}</span>
          )}
        </div>
      ))}
    </div>
  )
}

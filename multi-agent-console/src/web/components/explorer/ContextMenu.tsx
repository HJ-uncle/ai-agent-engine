import React, { useEffect, useRef } from 'react'
import { App, Modal, Divider } from 'antd'
import { workspaceApi } from '@core/api'
import { useExplorerStore } from '@core/store/explorer'
import { useSessionStore } from '@core/store/session'
import type { FileNode } from './FileTree'

export interface ContextMenuState {
  x: number
  y: number
  node?: FileNode // Optional: if undefined, it's an empty area context menu
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
  const clipboard = useExplorerStore(s => s.clipboard)
  const setClipboard = useExplorerStore(s => s.setClipboard)
  const setChatInputValue = useSessionStore(s => s.setChatInputValue)
  const chatInputValues = useSessionStore(s => s.chatInputValues)
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
    const dirPath = !node || node.type === 'dir' ? (node?.path || '.') : node.path.substring(0, node.path.lastIndexOf('/'))
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
    const dirPath = !node || node.type === 'dir' ? (node?.path || '.') : node.path.substring(0, node.path.lastIndexOf('/'))
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
    if (node) onStartRename(node)
  }

  const handleDelete = () => {
    if (!node) return
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
    if (!node) return
    onClose()
    navigator.clipboard.writeText(node.path).then(() => message.success('路径已复制'))
  }

  const handleCopyFullPath = async () => {
    if (!node) return
    onClose()
    try {
      const info = await workspaceApi.getFileInfo(sessionId, node.path)
      if (info?.workspacePath) {
        await navigator.clipboard.writeText(info.workspacePath)
        message.success('完整路径已复制')
      } else {
        message.error('无法获取完整路径')
      }
    } catch (e: any) {
      message.error(e.message ?? '获取完整路径失败')
    }
  }

  const handleDownload = () => {
    if (!node) return
    onClose()
    const url = `/api/v1/workspace/file/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(node.path)}`
    window.open(url, '_blank')
  }

  const handleAddToChat = () => {
    if (!node) return
    onClose()
    const current = (chatInputValues && chatInputValues[sessionId]) || ''
    const prefix = node.type === 'dir' ? 'folder' : 'file'
    const addition = `\n[${prefix}: ${node.path}]\n`
    setChatInputValue(sessionId, current + addition)
    message.success(`已将${node.type === 'dir' ? '文件夹' : '文件'}添加到对话输入框`)
  }

  const handleCopy = () => {
    if (!node) return
    onClose()
    setClipboard({ path: node.path, type: 'copy' })
    message.success('已复制')
  }

  const handleCut = () => {
    if (!node) return
    onClose()
    setClipboard({ path: node.path, type: 'cut' })
    message.success('已剪切')
  }

  const handlePaste = async () => {
    onClose()
    if (!clipboard) return
    // If no node, paste to root; if node is file, paste to its dir; if node is dir, paste to it.
    const destDir = !node || node.type === 'dir' ? (node?.path || '.') : node.path.substring(0, node.path.lastIndexOf('/'))
    const fileName = clipboard.path.substring(clipboard.path.lastIndexOf('/') + 1)
    const destPath = `${destDir}/${fileName}`

    try {
      if (clipboard.type === 'cut') {
        await workspaceApi.moveFile(sessionId, clipboard.path, destPath)
        setClipboard(null)
      } else {
        const content = await workspaceApi.readFileBinary(sessionId, clipboard.path)
        await workspaceApi.uploadFile(sessionId, destPath, content, 'base64')
      }
      onRefresh()
      message.success('已粘贴')
    } catch (e: any) {
      message.error(e.message ?? '粘贴失败')
    }
  }

  const items: MenuItemDef[] = node ? [
    { label: '新建文件', shortcut: 'Ctrl+N', onClick: handleNewFile },
    { label: '新建文件夹', shortcut: 'Ctrl+Shift+N', onClick: handleNewFolder },
    { label: '添加到对话', onClick: handleAddToChat },
    { label: '下载', onClick: handleDownload },
    { label: '重命名', shortcut: 'F2', onClick: handleRename },
    { label: '剪切', shortcut: 'Ctrl+X', onClick: handleCut },
    { label: '复制', shortcut: 'Ctrl+C', onClick: handleCopy },
    ...(node.type === 'dir' ? [{ label: '粘贴', shortcut: 'Ctrl+V', onClick: handlePaste }] : []),
    { label: '删除', shortcut: 'Delete', danger: true, onClick: handleDelete },
    { label: '复制路径', shortcut: 'Ctrl+Shift+C', onClick: handleCopyPath },
    { label: '复制完整路径', shortcut: 'Ctrl+Shift+A', onClick: handleCopyFullPath },
  ] : [
    { label: '新建文件', shortcut: 'Ctrl+N', onClick: handleNewFile },
    { label: '新建文件夹', shortcut: 'Ctrl+Shift+N', onClick: handleNewFolder },
    { label: '粘贴', shortcut: 'Ctrl+V', onClick: handlePaste },
    { label: '刷新', onClick: onRefresh },
  ]

  // Adjust position to stay in viewport
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(state.y, window.innerHeight - 260),
    left: Math.min(state.x, window.innerWidth - 220),
    zIndex: 9999,
    background: '#252526',
    border: '1px solid #454545',
    borderRadius: 4,
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
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
            padding: '5px 12px',
            fontSize: 13,
            cursor: 'pointer',
            color: item.danger ? '#f14c4c' : '#cccccc',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#094771')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span style={{ fontSize: 11, color: '#888', marginLeft: 16 }}>{item.shortcut}</span>
          )}
        </div>
      ))}
    </div>
  )
}

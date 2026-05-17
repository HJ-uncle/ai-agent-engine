import React, { useEffect, useMemo, useState } from 'react'
import { Dropdown, Input, MenuProps, Tooltip, App, Popconfirm } from 'antd'
import {
  FolderOpenOutlined,
  DesktopOutlined,
  DownOutlined,
  CodeOutlined,
  SearchOutlined,
  SyncOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckOutlined,
  CopyOutlined,
} from '@ant-design/icons'
import { workspaceApi } from '@core/api'
import { copyToClipboard } from '@core/utils/clipboard'
import { useSessionStore } from '@core/store/session'
import { useExplorerStore } from '@core/store/explorer'
import { useTerminalStore } from '@core/store/terminal'
import { FileTree } from './FileTree'
import type { FileNode } from './FileTree'
import { QuickOpenPanel } from './QuickOpenPanel'

export default function NewExplorerPanel() {
  const { message } = App.useApp()
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const sessions = useSessionStore(s => s.sessions)
  const switchSession = useSessionStore(s => s.switchSession)
  const openSettings = useSessionStore(s => s.openSettings)
  const setFiles = useSessionStore(s => s.setFiles)
  const lastFilesUpdate = useSessionStore(s => s.lastFilesUpdate)

  const setQuickOpenVisible = useExplorerStore(s => s.setQuickOpenVisible)
  const quickOpenVisible = useExplorerStore(s => s.quickOpenVisible)

  // ── Terminal panel toggle ──────────────────────────────────────────────────
  const terminalPanelVisible = useTerminalStore(s => s.panelVisible)
  const setPanelVisible = useTerminalStore(s => s.setPanelVisible)
  const toggleTerminal = () => setPanelVisible(!terminalPanelVisible)

  const [treeData, setTreeData] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)
  const [recentWorkspaces, setRecentWorkspaces] = useState<any[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Rename modal for workspace (not file rename)
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState('')
  const [newName, setNewName] = useState('')

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchFiles = async () => {
    if (!activeSessionId) { setTreeData([]); return }
    setLoading(true)
    try {
      const data = await workspaceApi.listFiles(activeSessionId)
      const allFilePaths: string[] = []
      const transform = (node: any): FileNode => {
        const isDir = node.type === 'dir'
        const path = node.path ?? ''
        if (!isDir && path) allFilePaths.push(path)
        return {
          title: node.name,
          key: path || node.name,
          name: node.name,
          path,
          type: isDir ? 'dir' : 'file',
          isLeaf: !isDir,
          children: node.children ? node.children.map(transform) : undefined,
        }
      }
      if (data?.children) {
        setTreeData(data.children.map(transform))
        setFiles(allFilePaths)
      } else {
        setTreeData([])
        setFiles([])
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const fetchRecent = async () => {
    try {
      const recent = await workspaceApi.listRecent()
      setRecentWorkspaces(recent)
    } catch (e) { console.error(e) }
  }

  useEffect(() => {
    fetchFiles()
    fetchRecent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, lastFilesUpdate])

  // ── Global Ctrl+P shortcut for Quick Open ─────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        setQuickOpenVisible(true)
      }
      // Ctrl+` 切换终端面板
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault()
        const currentVisible = useTerminalStore.getState().panelVisible
        useTerminalStore.getState().setPanelVisible(!currentVisible)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setQuickOpenVisible])

  // ── Workspace rename ──────────────────────────────────────────────────────

  const handleRename = (name: string) => {
    setRenameTarget(name)
    setNewName(name)
    setRenameModalOpen(true)
  }

  const submitRename = async () => {
    try {
      await workspaceApi.rename(renameTarget, newName)
      useSessionStore.getState().renameSessionId(renameTarget, newName)
      setRenameModalOpen(false)
      fetchRecent()
      fetchFiles()
      message.success('重命名成功')
    } catch (e: any) {
      message.error(e.message ?? '重命名失败')
    }
  }

  // ── Workspace dropdown ────────────────────────────────────────────────────

  const workspaceMenu: MenuProps = {
    onClick: info => {
      if (info.key.startsWith('recent-')) switchSession(info.key.replace('recent-', ''))
      else if (info.key === 'open-folder') openSettings('workspace')
      else if (info.key === 'connect-remote') openSettings('remote')
    },
    items: [
      { key: 'open-folder', icon: <FolderOpenOutlined />, label: '打开文件夹' },
      { key: 'connect-remote', icon: <DesktopOutlined />, label: '连接远程主机' },
      { type: 'divider' },
      {
        type: 'group', label: '最近',
        children: recentWorkspaces.map(w => {
          const session = sessions.find(s => s.id === w.name)
          const isActive = activeSessionId === w.name
          return {
            key: `recent-${w.name}`,
            label: (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    {session && <span style={{ fontWeight: isActive ? 600 : 400, color: isActive ? '#4fc1ff' : undefined }}>{session.title}</span>}
                    <span style={{ fontSize: 11, color: '#666' }}>{w.name}</span>
                  </div>
                  <span style={{ fontSize: 11, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.path}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                  {isActive && <CheckOutlined style={{ color: '#4fc1ff', fontSize: 12 }} />}
                  <Tooltip title="重命名">
                    <EditOutlined style={{ fontSize: 12, color: '#888' }} onClick={() => handleRename(w.name)} />
                  </Tooltip>
                  {!w.hasSession && (
                    <Popconfirm
                      title="确定删除这个无会话的工作区吗？"
                      onConfirm={() => workspaceApi.deleteRecent(w.name).then(fetchRecent)}
                      okButtonProps={{ danger: true }}
                    >
                      <Tooltip title="删除工作区"><DeleteOutlined style={{ fontSize: 12, color: '#888' }} /></Tooltip>
                    </Popconfirm>
                  )}
                </div>
              </div>
            ),
          }
        }),
      },
    ],
  }

  // ── Search filter ─────────────────────────────────────────────────────────

  const filteredTreeData = useMemo(() => {
    if (!searchQuery) return treeData
    const filterTree = (nodes: FileNode[]): FileNode[] =>
      nodes.flatMap(node => {
        const match = node.name.toLowerCase().includes(searchQuery.toLowerCase())
        if (node.children) {
          const filteredChildren = filterTree(node.children)
          if (filteredChildren.length > 0 || match) {
            return [{ ...node, children: filteredChildren }]
          }
          return []
        }
        return match ? [node] : []
      })
    return filterTree(treeData)
  }, [treeData, searchQuery])

  // ── Collect all file paths for Quick Open ─────────────────────────────────

  const allFiles = useMemo(() => {
    const collect = (nodes: FileNode[], acc: string[] = []): string[] => {
      for (const n of nodes) {
        if (n.isLeaf) acc.push(n.path)
        if (n.children) collect(n.children, acc)
      }
      return acc
    }
    return collect(treeData)
  }, [treeData])

  const activeSession = sessions.find(s => s.id === activeSessionId)
  const activeWorkspace = recentWorkspaces.find(w => w.name === activeSessionId)

  const handleCopyWorkspacePath = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (activeWorkspace?.path) {
      copyToClipboard(activeWorkspace.path)
      message.success('工作区路径已复制')
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Workspace Header Dropdown */}
      <Dropdown menu={workspaceMenu} trigger={['click']} styles={{ root: { minWidth: 260 } }}>
        <div style={{
          padding: '10px 14px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(255,255,255,0.02)',
          borderBottom: '1px solid #30363d',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '0.05em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeSession?.title || '未选择工作空间'}
              </span>
              <DownOutlined style={{ fontSize: 10, color: '#888' }} />
            </div>
            {activeSessionId && (
              <div style={{ fontSize: 11, color: '#666', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>ID: {activeSessionId}</span>
                {activeWorkspace?.path && (
                  <Tooltip title="复制路径">
                    <CopyOutlined style={{ fontSize: 10, cursor: 'pointer' }} onClick={handleCopyWorkspacePath} />
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        </div>
      </Dropdown>

      {/* Explorer Header */}
      <div style={{
        padding: '8px 12px 6px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.08em',
        color: '#bbb',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <span>文件管理器</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* <Tooltip title="切换终端 (Ctrl+`)">
            <CodeOutlined
              style={{ cursor: 'pointer', color: terminalPanelVisible ? '#0e639c' : undefined }}
              onClick={toggleTerminal}
            />
          </Tooltip> */}
          <Tooltip title="搜索文件 (Ctrl+P)">
            <SearchOutlined style={{ cursor: 'pointer' }} onClick={() => setShowSearch(v => !v)} />
          </Tooltip>
          <Tooltip title="刷新">
            <SyncOutlined spin={loading} onClick={fetchFiles} style={{ cursor: 'pointer' }} />
          </Tooltip>
        </div>
      </div>

      {/* Inline search */}
      {showSearch && (
        <div style={{ padding: '4px 12px' }}>
          <Input
            size="small"
            placeholder="搜索文件..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #3c3c3c', color: '#ccc' }}
            allowClear
          />
        </div>
      )}

      {/* File tree */}
      <FileTree
        treeData={filteredTreeData}
        sessionId={activeSessionId ?? ''}
        onRefresh={fetchFiles}
      />

      {/* Quick Open panel */}
      {quickOpenVisible && (
        <QuickOpenPanel
          files={allFiles}
          onClose={() => setQuickOpenVisible(false)}
        />
      )}

      {/* Workspace rename modal */}
      {renameModalOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
          onClick={() => setRenameModalOpen(false)}
        >
          <div
            style={{ background: '#1e1e1e', border: '1px solid #454545', borderRadius: 6, padding: 24, minWidth: 320 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ marginBottom: 12, fontWeight: 600, color: '#ccc' }}>重命名工作区</div>
            <Input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="请输入新的工作区名称"
              onPressEnter={submitRename}
              autoFocus
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setRenameModalOpen(false)}
                style={{ padding: '4px 12px', background: 'transparent', border: '1px solid #555', color: '#ccc', borderRadius: 4, cursor: 'pointer' }}
              >取消</button>
              <button
                onClick={submitRename}
                style={{ padding: '4px 12px', background: '#0e639c', border: 'none', color: '#fff', borderRadius: 4, cursor: 'pointer' }}
              >确认</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

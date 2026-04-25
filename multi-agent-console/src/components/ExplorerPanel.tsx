import React, { useEffect, useState, useMemo } from 'react'
import { Tree, Dropdown, MenuProps, Tooltip, Input, Modal, App, Popconfirm } from 'antd'
import {
  FolderOpenOutlined,
  FolderOutlined,
  DesktopOutlined,
  DownOutlined,
  RightOutlined,
  SearchOutlined,
  SyncOutlined,
  CloseOutlined,
  EditOutlined,
  DeleteOutlined
} from '@ant-design/icons'
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js'
import { workspaceApi } from '../api'
import { useSessionStore } from '../store/session'
import styles from './ExplorerPanel.module.css'

export default function ExplorerPanel() {
  const { message } = App.useApp()
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const sessions = useSessionStore(s => s.sessions)
  const switchSession = useSessionStore(s => s.switchSession)
  const openSettings = useSessionStore(s => s.openSettings)
  const setFiles = useSessionStore(s => s.setFiles)
  const [treeData, setTreeData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [recentWorkspaces, setRecentWorkspaces] = useState<any[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [autoExpandParent, setAutoExpandParent] = useState(true)

  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState('')
  const [newName, setNewName] = useState('')

  const onExpand = (keys: React.Key[]) => {
    setExpandedKeys(keys)
    setAutoExpandParent(false)
  }

  const fetchFiles = async () => {
    if (!activeSessionId) {
      setTreeData([])
      return
    }
    setLoading(true)
    try {
      const data = await workspaceApi.listFiles(activeSessionId)
      const allFilePaths: string[] = []

      // Transform data to antd Tree format
      const transform = (node: any, keyPrefix = '0'): any => {
        const isDir = node.type === 'dir'
        const path = node.path
        if (!isDir && path) {
          allFilePaths.push(path)
        }

        return {
          title: node.name,
          key: node.path || `${keyPrefix}-${node.name}`,
          isLeaf: !isDir,
          type: node.type,
          name: node.name,
          children: node.children ? node.children.map((c: any, i: number) => transform(c, `${keyPrefix}-${i}`)) : undefined
        }
      }
      if (data && data.children) {
        setTreeData(data.children.map((c: any, i: number) => transform(c, `0-${i}`)))
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
    } catch (e) {
      console.error(e)
    }
  }

  useEffect(() => {
    fetchFiles()
    fetchRecent()
  }, [activeSessionId])

  const handleDeleteWorkspace = async (e: any, name: string) => {
    e.stopPropagation()
    if (recentWorkspaces.length <= 1) {
      // Must keep at least one
      return
    }
    try {
      await workspaceApi.deleteRecent(name)
      await fetchRecent()
    } catch (err) {
      console.error(err)
    }
  }

  const handleRename = (oldName: string) => {
    setRenameTarget(oldName)
    setNewName(oldName)
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

  const workspaceMenu: MenuProps = {
    onClick: (info) => {
      if (info.key.startsWith('recent-')) {
        const name = info.key.replace('recent-', '')
        switchSession(name)
      } else if (info.key === 'open-folder') {
        openSettings('workspace')
      } else if (info.key === 'connect-remote') {
        openSettings('remote')
      }
    },
    items: [
      { key: 'open-folder', icon: <FolderOpenOutlined />, label: '打开文件夹' },
      { key: 'connect-remote', icon: <DesktopOutlined />, label: '连接远程主机' },
      { type: 'divider' },
      { type: 'group', label: '最近', children: recentWorkspaces.map(w => {
        const session = sessions.find(s => s.id === w.name)
        return {
          key: `recent-${w.name}`,
          label: (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  {session ? <span>{session.title}</span> : ''}
                  <span style={{ fontSize: 12, color: '#888' }}>{w.name}</span>
                </div>
                <span style={{ fontSize: 12, color: '#888' }}>{w.path}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, paddingLeft: 16 }} onClick={e => e.stopPropagation()}>
                <Tooltip title="重命名">
                  <EditOutlined onClick={() => handleRename(w.name)} />
                </Tooltip>
                {!w.hasSession && (
                  <Popconfirm 
                    title="确定删除这个无会话的工作区吗？" 
                    onConfirm={() => {
                      workspaceApi.deleteRecent(w.name).then(() => fetchRecent())
                    }}
                    okButtonProps={{ danger: true }}
                  >
                    <Tooltip title="删除工作区"><DeleteOutlined /></Tooltip>
                  </Popconfirm>
                )}
              </div>
            </div>
          )
        }
      })}
    ]
  }

  const filteredTreeData = useMemo(() => {
    if (!searchQuery) return treeData
    
    const keys: React.Key[] = []
    const filterTree = (nodes: any[]): any[] => {
      return nodes.map(node => {
        const isMatch = node.title.toLowerCase().includes(searchQuery.toLowerCase())
        if (node.children) {
          const filteredChildren = filterTree(node.children)
          if (filteredChildren.length > 0 || isMatch) {
            if (filteredChildren.length > 0) {
              keys.push(node.key)
            }
            return { ...node, children: filteredChildren }
          }
          return null
        }
        if (isMatch) {
          return node
        }
        return null
      }).filter(Boolean)
    }
    
    const filtered = filterTree(treeData)
    setExpandedKeys(keys)
    setAutoExpandParent(true)
    return filtered
  }, [treeData, searchQuery])

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
          borderBottom: '1px solid #30363d'
        }}>
          <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '0.05em' }}>
            {activeSessionId || '未选择工作空间'}
          </span>
          <DownOutlined style={{ fontSize: 10, color: '#888' }} />
        </div>
      </Dropdown>

      {/* Explorer Actions */}
      <div style={{ 
        padding: '8px 12px 6px', 
        fontSize: 11, 
        fontWeight: 600, 
        letterSpacing: '.08em', 
        color: '#bbb', 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        flexShrink: 0 
      }}>
        <span>文件</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Tooltip title="搜索文件"><SearchOutlined style={{ cursor: 'pointer' }} onClick={() => setShowSearch(!showSearch)} /></Tooltip>
          <Tooltip title="刷新"><SyncOutlined spin={loading} onClick={fetchFiles} style={{ cursor: 'pointer' }} /></Tooltip>
        </div>
      </div>

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

      {/* File Tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        <Tree
          treeData={filteredTreeData}
          showIcon
          blockNode
          className={styles.vscodeTree}
          expandedKeys={expandedKeys}
          autoExpandParent={autoExpandParent}
          onExpand={onExpand}
          onSelect={(selectedKeys, e: any) => {
            if (e.node.isLeaf) {
              useSessionStore.setState({ activeFile: e.node.key as string })
            }
          }}
          icon={(props: any) => {
            let iconName: string | undefined = ''
            if (props.type === 'dir') {
              iconName = props.expanded 
                ? getIconForOpenFolder(props.name) 
                : getIconForFolder(props.name)
            } else {
              iconName = getIconForFile(props.name)
            }
            
            // Fallback for folders if vscode-icons-js returns empty/default
            if (!iconName && props.type === 'dir') {
              iconName = props.expanded ? 'default_folder_opened.svg' : 'default_folder.svg'
            }
            if (!iconName) {
              iconName = 'default_file.svg'
            }

            return (
              <img 
                src={`https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@master/icons/${iconName}`} 
                alt="" 
                style={{ width: 16, height: 16, display: 'block' }} 
              />
            )
          }}
          switcherIcon={(props: any) => {
            if (props.isLeaf) return <span style={{ width: 14 }} />
            return props.expanded 
              ? <DownOutlined style={{ fontSize: 10, transform: 'none' }} /> 
              : <RightOutlined style={{ fontSize: 10, transform: 'none' }} />
          }}
        />
      </div>

      <Modal
        title="重命名工作区"
        open={renameModalOpen}
        onOk={submitRename}
        onCancel={() => setRenameModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <Input 
          value={newName} 
          onChange={e => setNewName(e.target.value)} 
          placeholder="请输入新的工作区名称" 
          onPressEnter={submitRename}
        />
      </Modal>
    </div>
  )
}

import React, { useCallback, useRef, useState } from 'react'
import { Tree, Input } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { DownOutlined, RightOutlined } from '@ant-design/icons'
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js'
import { workspaceApi } from '../../api'
import { useExplorerStore } from '../../store/explorer'
import { ContextMenu, ContextMenuState } from './ContextMenu'
import styles from '../ExplorerPanel.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileNode extends DataNode {
  name: string
  type: 'file' | 'dir'
  path: string
  isLeaf: boolean
  children?: FileNode[]
}

interface FileTreeProps {
  treeData: FileNode[]
  sessionId: string
  onRefresh: () => void
}

// ─── Icon renderer ────────────────────────────────────────────────────────────

function resolveIcon(node: FileNode, expanded: boolean): string {
  if (node.type === 'dir') {
    const iconName = expanded
      ? getIconForOpenFolder(node.name)
      : getIconForFolder(node.name)
    return iconName || (expanded ? 'default_folder_opened.svg' : 'default_folder.svg')
  }
  return getIconForFile(node.name) || 'default_file.svg'
}

const CDN = 'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@master/icons/'

// ─── FileTree ─────────────────────────────────────────────────────────────────

export function FileTree({ treeData, sessionId, onRefresh }: FileTreeProps) {
  const openTab = useExplorerStore(s => s.openTab)
  const pushLog = useExplorerStore(s => s.pushLog)

  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])

  // ── Inline rename state
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<any>(null)

  // ── Context menu state
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)

  // ─── Drag & Drop ─────────────────────────────────────────────────────────

  const onDrop = useCallback(
    async (info: any) => {
      const dragNode: FileNode = info.dragNode
      const dropNode: FileNode = info.node
      const dropToGap = info.dropToGap

      // Determine destination directory
      const destDir = !dropToGap && dropNode.type === 'dir'
        ? dropNode.path
        : dropNode.path.substring(0, dropNode.path.lastIndexOf('/'))

      const fileName = dragNode.path.substring(dragNode.path.lastIndexOf('/') + 1)
      const destPath = `${destDir}/${fileName}`

      if (destPath === dragNode.path) return
      try {
        await workspaceApi.moveFile(sessionId, dragNode.path, destPath)
        onRefresh()
      } catch (e: any) {
        console.error('Move failed', e)
      }
    },
    [sessionId, onRefresh],
  )

  // ─── Rename ───────────────────────────────────────────────────────────────

  const startRename = (node: FileNode) => {
    setRenamingKey(node.path)
    setRenameValue(node.name)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const commitRename = async (node: FileNode) => {
    if (!renameValue.trim() || renameValue === node.name) {
      setRenamingKey(null)
      return
    }
    const dir = node.path.substring(0, node.path.lastIndexOf('/'))
    const newPath = `${dir}/${renameValue.trim()}`
    try {
      await workspaceApi.moveFile(sessionId, node.path, newPath)
      pushLog({ type: 'rename', path: newPath, prevPath: node.path })
      setRenamingKey(null)
      onRefresh()
    } catch (e: any) {
      console.error('Rename failed', e)
      setRenamingKey(null)
    }
  }

  // ─── Right-click ──────────────────────────────────────────────────────────

  const onRightClick = ({ event, node }: { event: React.MouseEvent; node: EventDataNode<FileNode> }) => {
    event.preventDefault()
    setCtxMenu({ x: event.clientX, y: event.clientY, node: node as unknown as FileNode })
  }

  // ─── Title renderer ───────────────────────────────────────────────────────

  const renderTitle = (node: FileNode) => {
    if (renamingKey === node.path) {
      return (
        <Input
          ref={renameInputRef}
          size="small"
          autoFocus
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onPressEnter={() => commitRename(node)}
          onBlur={() => commitRename(node)}
          onKeyDown={e => { if (e.key === 'Escape') setRenamingKey(null) }}
          style={{ height: 20, fontSize: 13, width: 160, padding: '0 4px' }}
          onClick={e => e.stopPropagation()}
        />
      )
    }

    return (
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
    )
  }

  // ─── Build tree data with icons + title ───────────────────────────────────

  const decorateNodes = (nodes: FileNode[]): DataNode[] =>
    nodes.map(n => ({
      ...n,
      title: renderTitle(n),
      icon: (props: any) => (
        <img
          src={`${CDN}${resolveIcon(n, !!props.expanded)}`}
          alt=""
          style={{ width: 16, height: 16, display: 'block', flexShrink: 0 }}
          onError={e => { (e.target as HTMLImageElement).src = `${CDN}default_file.svg` }}
        />
      ),
      children: n.children ? decorateNodes(n.children) : undefined,
    }))

  // ─── Keyboard handler (F2, Delete, Ctrl+Z handled in parent) ──────────────

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'F2' && selectedKeys.length > 0) {
      e.preventDefault()
      const path = selectedKeys[0] as string
      const findNode = (nodes: FileNode[]): FileNode | undefined => {
        for (const n of nodes) {
          if (n.path === path) return n
          if (n.children) { const found = findNode(n.children); if (found) return found }
        }
      }
      const node = findNode(treeData)
      if (node) startRename(node)
    }
  }

  // ─── Select handler (Ctrl+Click multi / Shift+Click range) ────────────────

  const onSelect = (
    keys: React.Key[],
    info: { nativeEvent: MouseEvent; node: EventDataNode<FileNode> },
  ) => {
    const { nativeEvent, node } = info
    const fileNode = node as unknown as FileNode

    if (nativeEvent.ctrlKey || nativeEvent.metaKey) {
      // Toggle selection
      setSelectedKeys(prev =>
        prev.includes(fileNode.path)
          ? prev.filter(k => k !== fileNode.path)
          : [...prev, fileNode.path],
      )
    } else if (nativeEvent.shiftKey && selectedKeys.length > 0) {
      // Range select: collect all visible leaf paths in order
      const flatten = (nodes: FileNode[], acc: string[] = []): string[] => {
        for (const n of nodes) {
          acc.push(n.path)
          if (n.children && expandedKeys.includes(n.path)) flatten(n.children, acc)
        }
        return acc
      }
      const all = flatten(treeData)
      const lastIdx = all.indexOf(selectedKeys[selectedKeys.length - 1] as string)
      const curIdx = all.indexOf(fileNode.path)
      const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx]
      setSelectedKeys(all.slice(from, to + 1))
    } else {
      setSelectedKeys([fileNode.path])
      if (fileNode.isLeaf) {
        openTab({ path: fileNode.path, name: fileNode.name, type: undefined as any })
      }
    }
  }

  return (
    <div
      style={{ flex: 1, overflowY: 'auto', padding: '4px 0', outline: 'none' }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => ctxMenu && setCtxMenu(null)}
    >
      <Tree
        treeData={decorateNodes(treeData)}
        showIcon
        blockNode
        virtual
        height={800}
        itemHeight={22}
        multiple
        draggable={{ icon: false }}
        selectedKeys={selectedKeys}
        expandedKeys={expandedKeys}
        className={styles.vscodeTree}
        onExpand={keys => setExpandedKeys(keys)}
        onSelect={onSelect as any}
        onDrop={onDrop}
        onRightClick={onRightClick as any}
        switcherIcon={(props: any) => {
          if (props.isLeaf) return <span style={{ width: 14 }} />
          return props.expanded
            ? <DownOutlined style={{ fontSize: 10 }} />
            : <RightOutlined style={{ fontSize: 10 }} />
        }}
      />

      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          sessionId={sessionId}
          onClose={() => setCtxMenu(null)}
          onRefresh={onRefresh}
          onStartRename={startRename}
        />
      )}
    </div>
  )
}

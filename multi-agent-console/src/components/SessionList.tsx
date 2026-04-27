import React, { useState } from 'react'
import { Button, Tooltip, Input, Tag, App, Modal, Checkbox } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  RobotOutlined,
  MessageOutlined,
} from '@ant-design/icons'
import { useSessionStore } from '../store/session'
import { useAgentStore } from '../store/agents'
import { conversationApi } from '../api'
import type { Session } from '../types'
import styles from './SessionList.module.css'

interface Props {
  onNewChat: () => void
}

export default function SessionList({ onNewChat }: Props) {
  const { message } = App.useApp()
  const { sessions, activeSessionId, switchSession, deleteSession, updateSessionTitle } =
    useSessionStore()
  const { agents } = useAgentStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [keepWorkspace, setKeepWorkspace] = useState(true)
  
  // 批量选择
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [isBatchMode, setIsBatchMode] = useState(false)

  const startEdit = (s: Session) => {
    setEditingId(s.id)
    setEditTitle(s.title)
  }

  const confirmEdit = (id: string) => {
    if (editTitle.trim()) updateSessionTitle(id, editTitle.trim())
    setEditingId(null)
  }

  const cancelEdit = () => setEditingId(null)

  const getAgent = (agentId?: string) =>
    agentId ? agents.find((a) => a.id === agentId) : undefined

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      const sessionIds = deleteTarget.split(',')
      await Promise.all(sessionIds.map(id => conversationApi.deleteSession(id, keepWorkspace)))
      sessionIds.forEach(id => deleteSession(id))
      setDeleteModalOpen(false)
      setDeleteTarget(null)
      setSelectedSessions(new Set())
      setIsBatchMode(false)
    } catch (e: any) {
      message.error(e.message ?? '删除失败')
    }
  }

  // 批量删除相关
  const toggleSelectSession = (sessionId: string) => {
    const newSelected = new Set(selectedSessions)
    if (newSelected.has(sessionId)) {
      newSelected.delete(sessionId)
    } else {
      newSelected.add(sessionId)
    }
    setSelectedSessions(newSelected)
  }

  const selectAll = () => {
    const allSessionIds = new Set(sessions.map(s => s.id))
    setSelectedSessions(allSessionIds)
  }

  const clearSelection = () => {
    setSelectedSessions(new Set())
    setIsBatchMode(false)
  }

  const handleBatchDelete = () => {
    setDeleteTarget(Array.from(selectedSessions).join(','))
    setDeleteModalOpen(true)
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.headerTitle}>对话</span>
        {isBatchMode ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="text" size="small" onClick={selectAll}>全选</Button>
            <Button type="text" size="small" onClick={clearSelection}>取消</Button>
            <Button type="text" size="small" danger onClick={handleBatchDelete}>删除</Button>
          </div>
        ) : (
          <Tooltip title="新建对话">
            <Button
              type="text"
              icon={<PlusOutlined />}
              size="small"
              className={styles.newBtn}
              onClick={onNewChat}
            />
          </Tooltip>
        )}
      </div>

      {/* Session list */}
      <div className={styles.list}>
        {sessions.length === 0 && (
          <div className={styles.empty}>
            <MessageOutlined className={styles.emptyIcon} />
            <span>暂无对话</span>
          </div>
        )}
        {sessions.map((session) => {
          const agent = getAgent(session.agentId)
          const isActive = session.id === activeSessionId
          const isEditing = editingId === session.id
          const isSelected = selectedSessions.has(session.id)

          return (
            <div
              key={session.id}
              className={`${styles.item} ${isActive ? styles.active : ''} ${isSelected ? styles.selected : ''}`}
              onClick={(e) => {
                if (isBatchMode) {
                  e.stopPropagation()
                  toggleSelectSession(session.id)
                } else if (!isEditing) {
                  switchSession(session.id)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setIsBatchMode(true)
                toggleSelectSession(session.id)
              }}
            >
              {/* 选择框 */}
              {isBatchMode && (
                <Checkbox
                  checked={isSelected}
                  onChange={(e) => toggleSelectSession(session.id)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginRight: 8 }}
                />
              )}
              
              {/* Agent indicator */}
              {agent ? (
                <Tooltip title={`Agent: ${agent.name}`}>
                  <span className={styles.agentDot}>
                    <RobotOutlined />
                  </span>
                </Tooltip>
              ) : (
                <span className={styles.agentDot} style={{ opacity: 0.3 }}>
                  <MessageOutlined />
                </span>
              )}

              {/* Title / Edit */}
              <div className={styles.content}>
                {isEditing ? (
                  <Input
                    size="small"
                    value={editTitle}
                    autoFocus
                    className={styles.editInput}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onPressEnter={() => confirmEdit(session.id)}
                    onKeyDown={(e) => e.key === 'Escape' && cancelEdit()}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className={styles.title}>{session.title}</span>
                    {agent && (
                      <Tag color="blue" className={styles.agentTag}>
                        {agent.name}
                      </Tag>
                    )}
                    {session.lastMessage && (
                      <span className={styles.preview}>{session.lastMessage}</span>
                    )}
                  </>
                )}
              </div>

              {/* Actions */}
              <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
                {isEditing ? (
                  <>
                    <Button
                      type="text"
                      size="small"
                      icon={<CheckOutlined />}
                      className={styles.actionBtn}
                      onClick={() => confirmEdit(session.id)}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      className={styles.actionBtn}
                      onClick={cancelEdit}
                    />
                  </>
                ) : (
                  <>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      className={styles.actionBtn}
                      onClick={() => startEdit(session)}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      className={`${styles.actionBtn} ${styles.deleteBtn}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(session.id)
                        setKeepWorkspace(true)
                        setDeleteModalOpen(true)
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <Modal
        title="删除对话"
        open={deleteModalOpen}
        onOk={confirmDelete}
        onCancel={() => {
          setDeleteModalOpen(false)
          setDeleteTarget(null)
        }}
        okText="删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <p style={{ marginBottom: 16 }}>
          {deleteTarget?.includes(',') ? '确定要删除这些对话记录吗？' : '确定要删除这个对话记录吗？'}
        </p>
        <Checkbox checked={keepWorkspace} onChange={e => setKeepWorkspace(e.target.checked)}>
          同时保留工作区文件 (不删除本地沙盒目录)
        </Checkbox>
      </Modal>
    </div>
  )
}

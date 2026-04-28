import React, { useState, useEffect, useRef } from 'react'
import { Button, Tooltip, Input, Tag, App, Modal, Checkbox } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  RobotOutlined,
  MessageOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
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
  const messageMap = useSessionStore((s) => s.messageMap)

  // 检测会话状态：running / done / error / idle
  type SessionStatus = 'running' | 'done' | 'error' | 'idle'

  const getSessionStatus = (sessionId: string): SessionStatus => {
    const msgs = messageMap[sessionId] ?? []
    if (msgs.length === 0) return 'idle'
    // 有正在 streaming 或 sending 的消息 → running
    if (msgs.some((m) => m.status === 'streaming' || m.status === 'sending')) return 'running'
    // 最后一条 assistant 消息的状态
    const lastAi = [...msgs].reverse().find((m) => m.role === 'assistant')
    if (lastAi?.status === 'error') return 'error'
    if (lastAi?.status === 'done') return 'done'
    return 'idle'
  }

  // 追踪刚完成/出错的会话，短暂展示状态后淡出
  const [flashStatus, setFlashStatus] = useState<Record<string, 'done' | 'error'>>({})
  const prevStatusRef = useRef<Record<string, SessionStatus>>({})

  useEffect(() => {
    const newFlash: Record<string, 'done' | 'error'> = {}
    sessions.forEach((s) => {
      const current = getSessionStatus(s.id)
      const prev = prevStatusRef.current[s.id]
      // 从 running 变为 done/error → 触发闪现
      if (prev === 'running' && (current === 'done' || current === 'error')) {
        newFlash[s.id] = current
      }
      prevStatusRef.current[s.id] = current
    })
    if (Object.keys(newFlash).length > 0) {
      setFlashStatus((old) => ({ ...old, ...newFlash }))
      // 3 秒后清除闪现状态
      const timer = setTimeout(() => {
        setFlashStatus((old) => {
          const next = { ...old }
          Object.keys(newFlash).forEach((id) => delete next[id])
          return next
        })
      }, 3000)
      return () => clearTimeout(timer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageMap, sessions])

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

          const status = getSessionStatus(session.id)
          const flash = flashStatus[session.id]
          const running = status === 'running'
          const showDone = flash === 'done'
          const showError = status === 'error' || flash === 'error'

          return (
            <div
              key={session.id}
              className={`${styles.item} ${isActive ? styles.active : ''} ${isSelected ? styles.selected : ''} ${running ? styles.running : ''} ${showDone ? styles.done : ''} ${showError ? styles.error : ''}`}
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
              {running ? (
                <span className={styles.agentDot}>
                  <LoadingOutlined className={styles.runningIcon} />
                </span>
              ) : showError ? (
                <span className={styles.agentDot}>
                  <ExclamationCircleOutlined className={styles.errorIcon} />
                </span>
              ) : showDone ? (
                <span className={styles.agentDot}>
                  <CheckCircleOutlined className={styles.doneIcon} />
                </span>
              ) : agent ? (
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

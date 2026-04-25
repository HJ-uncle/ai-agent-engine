import React, { useState } from 'react'
import { Button, Tooltip, Popconfirm, Input, Tag, App, Modal, Checkbox } from 'antd'
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
      await conversationApi.deleteSession(deleteTarget, keepWorkspace)
      deleteSession(deleteTarget)
      setDeleteModalOpen(false)
      setDeleteTarget(null)
    } catch (e: any) {
      message.error(e.message ?? '删除失败')
    }
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.headerTitle}>对话</span>
        <Tooltip title="新建对话">
          <Button
            type="text"
            icon={<PlusOutlined />}
            size="small"
            className={styles.newBtn}
            onClick={onNewChat}
          />
        </Tooltip>
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

          return (
            <div
              key={session.id}
              className={`${styles.item} ${isActive ? styles.active : ''}`}
              onClick={() => !isEditing && switchSession(session.id)}
            >
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
        onCancel={() => setDeleteModalOpen(false)}
        okText="删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <p style={{ marginBottom: 16 }}>确定要删除这个对话记录吗？</p>
        <Checkbox checked={keepWorkspace} onChange={e => setKeepWorkspace(e.target.checked)}>
          同时保留工作区文件 (不删除本地沙盒目录)
        </Checkbox>
      </Modal>
    </div>
  )
}

import React, { useState } from 'react'
import { List, ActionSheet, Toast, SwipeAction, Button } from 'antd-mobile'
import { AddOutline } from 'antd-mobile-icons'
import { useSessionStore } from '@core/store/session'
import { AppNavBar } from '../components/AppNavBar'
import styles from './SessionsPage.module.css'

export default function SessionsPage() {
  const {
    sessions,
    activeSessionId,
    addSession,
    switchSession,
    deleteSession,
    updateSessionTitle,
  } = useSessionStore()

  const [actionTarget, setActionTarget] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)

  const handleAddSession = () => {
    addSession()
  }

  const handleDelete = (id: string) => {
    deleteSession(id)
    Toast.show({ icon: 'success', content: '已删除' })
  }

  const handleRenameConfirm = (id: string, title: string) => {
    const t = title.trim()
    if (t) updateSessionTitle(id, t)
    setRenaming(null)
  }

  return (
    <div className={styles.page}>
      <AppNavBar
        title="会话列表"
        back={null}
        right={
          <Button
            fill="none"
            style={{ color: 'var(--adm-color-primary)', fontSize: 22, padding: 0 }}
            onClick={handleAddSession}
          >
            <AddOutline />
          </Button>
        }
      />

      <div className={`${styles.list} scroll-area`}>
        <List>
          {[...sessions].reverse().map((s) => (
            <SwipeAction
              key={s.id}
              rightActions={[
                {
                  key: 'delete',
                  text: '删除',
                  color: 'danger',
                  onClick: () => handleDelete(s.id),
                },
                {
                  key: 'rename',
                  text: '重命名',
                  color: 'primary',
                  onClick: () =>
                    setRenaming({ id: s.id, title: s.title || '新会话' }),
                },
              ]}
            >
              <List.Item
                className={s.id === activeSessionId ? styles.active : undefined}
                onClick={() => {
                  switchSession(s.id)
                }}
                description={
                  <span className={styles.lastMsg}>
                    {s.lastMessage?.slice(0, 50) || '暂无消息'}
                  </span>
                }
                extra={
                  <span className={styles.time}>
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                }
              >
                <span className={styles.title}>{s.title || '新会话'}</span>
              </List.Item>
            </SwipeAction>
          ))}
        </List>

        {sessions.length === 0 && (
          <div className={styles.empty}>暂无会话，点击右上角新建</div>
        )}
      </div>

      {/* 长按 ActionSheet */}
      <ActionSheet
        visible={!!actionTarget}
        actions={[
          {
            text: '重命名',
            key: 'rename',
            onClick: () => {
              const id = actionTarget!
              const s = sessions.find((x) => x.id === id)
              setRenaming({ id, title: s?.title || '新会话' })
              setActionTarget(null)
            },
          },
          {
            text: '删除会话',
            key: 'delete',
            danger: true,
            onClick: () => {
              handleDelete(actionTarget!)
              setActionTarget(null)
            },
          },
        ]}
        onClose={() => setActionTarget(null)}
      />

      {/* 重命名内联编辑 */}
      {renaming && (
        <div className={styles.renameOverlay}>
          <div className={styles.renameBox}>
            <p className={styles.renameTitle}>重命名会话</p>
            <input
              autoFocus
              className={styles.renameInput}
              value={renaming.title}
              onChange={(e) =>
                setRenaming({ ...renaming, title: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameConfirm(renaming.id, renaming.title)
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
            <div className={styles.renameActions}>
              <button
                className={styles.renameCancelBtn}
                onClick={() => setRenaming(null)}
              >
                取消
              </button>
              <button
                className={styles.renameOkBtn}
                onClick={() =>
                  handleRenameConfirm(renaming.id, renaming.title)
                }
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

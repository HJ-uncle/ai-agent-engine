import React, { useEffect, useRef } from 'react'
import { Popup, List, SwipeAction, Button, Tag, SpinLoading } from 'antd-mobile'
import { AddOutline, CloseOutline } from 'antd-mobile-icons'
import { useSessionStore } from '@core/store/session'
import { useAgentStore } from '@core/store/agents'
import styles from './SessionsDrawer.module.css'

interface SessionsDrawerProps {
  visible: boolean
  onClose: () => void
}

function groupSessionsByDate(sessions: any[]) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000
  const weekAgo = today - 7 * 86400000

  const groups: { label: string; items: any[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '最近 7 天', items: [] },
    { label: '更早', items: [] },
  ]

  for (const s of [...sessions].reverse()) {
    const t = s.createdAt
    if (t >= today) groups[0].items.push(s)
    else if (t >= yesterday) groups[1].items.push(s)
    else if (t >= weekAgo) groups[2].items.push(s)
    else groups[3].items.push(s)
  }

  return groups.filter((g) => g.items.length > 0)
}

export function SessionsDrawer({ visible, onClose }: SessionsDrawerProps) {
  const {
    sessions,
    activeSessionId,
    addSession,
    switchSession,
    deleteSession,
    isSessionRunning,
  } = useSessionStore()

  const { agents } = useAgentStore()

  // agentId → 名称快查表
  const agentNameMap = React.useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents],
  )

  const activeRef = useRef<HTMLDivElement>(null)

  // 打开时滚动到当前会话
  useEffect(() => {
    if (visible) {
      setTimeout(() => {
        activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 300)
    }
  }, [visible])

  const handleNewSession = () => {
    addSession()
    onClose()
  }

  const handleSwitch = (id: string) => {
    switchSession(id)
    onClose()
  }

  const groups = groupSessionsByDate(sessions)

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      position="left"
      bodyStyle={{ width: '80vw', maxWidth: 320, height: '100%', display: 'flex', flexDirection: 'column' }}
      destroyOnClose={false}
    >
      {/* 头部 */}
      <div className={styles.header}>
        <span className={styles.title}>历史会话</span>
        <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
          <CloseOutline />
        </button>
      </div>

      {/* 新建按钮 */}
      <div className={styles.newBtnWrap}>
        <Button
          block
          color="primary"
          fill="outline"
          onClick={handleNewSession}
          size="middle"
        >
          <AddOutline /> &nbsp;新建对话
        </Button>
      </div>

      {/* 会话列表 */}
      <div className={`${styles.list} scroll-area`}>
        {sessions.length === 0 ? (
          <div className={styles.empty}>暂无历史会话</div>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className={styles.groupLabel}>{group.label}</div>
              <List>
                {group.items.map((s) => {
                  const isActive = s.id === activeSessionId
                  const running = isSessionRunning(s.id)
                  return (
                    <SwipeAction
                      key={s.id}
                      rightActions={[
                        {
                          key: 'delete',
                          text: '删除',
                          color: 'danger',
                          onClick: () => deleteSession(s.id),
                        },
                      ]}
                    >
                      <div
                        ref={isActive ? activeRef : undefined}
                        className={`${styles.sessionItem} ${isActive ? styles.sessionActive : ''}`}
                        onClick={() => handleSwitch(s.id)}
                      >
                        <div className={styles.sessionTitle}>
                          {s.title || '新对话'}
                          {running && (
                            <span className={styles.runningDot}>
                              <SpinLoading color="primary" style={{ '--size': '14px' }} />
                            </span>
                          )}
                        </div>
                        {s.lastMessage && (
                          <div className={styles.sessionPreview}>{s.lastMessage.slice(0, 40)}</div>
                        )}
                        {s.agentId && (
                          <Tag color="primary" fill="outline" style={{ fontSize: 11, marginTop: 4 }}>
                            {agentNameMap.get(s.agentId) ?? 'Agent'}
                          </Tag>
                        )}
                      </div>
                    </SwipeAction>
                  )
                })}
              </List>
            </div>
          ))
        )}
      </div>
    </Popup>
  )
}

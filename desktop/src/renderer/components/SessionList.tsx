import { PlusOutlined, DeleteOutlined, MessageOutlined } from '@ant-design/icons'
import { Button, Tooltip } from 'antd'
import { useSessionStore } from '../store/session'
import styles from './SessionList.module.css'

export function SessionList() {
  const { sessions, activeSessionId, addSession, switchSession, deleteSession } = useSessionStore()

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>会话列表</span>
        <Tooltip title="新建会话">
          <Button
            type="text"
            icon={<PlusOutlined />}
            size="small"
            onClick={() => addSession()}
            className={styles.addBtn}
          />
        </Tooltip>
      </div>

      <div className={styles.list}>
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`${styles.item} ${s.id === activeSessionId ? styles.active : ''}`}
            onClick={() => switchSession(s.id)}
          >
            <MessageOutlined className={styles.icon} />
            <div className={styles.info}>
              <div className={styles.name}>{s.title}</div>
              {s.lastMessage && (
                <div className={styles.preview}>{s.lastMessage}</div>
              )}
            </div>
            <Tooltip title="删除">
              <button
                className={styles.deleteBtn}
                onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
              >
                <DeleteOutlined />
              </button>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  )
}

import React, { useEffect, useState } from 'react'
import { List, Tag, SpinLoading } from 'antd-mobile'
import { CheckOutline, AppstoreOutline } from 'antd-mobile-icons'
import { useAgentStore } from '@core/store/agents'
import { useSessionStore } from '@core/store/session'
import { agentApi } from '@core/api'
import { AppNavBar } from '../components/AppNavBar'
import styles from './AgentsPage.module.css'

export default function AgentsPage() {
  const { agents, loading, setAgents, setLoading, setError } = useAgentStore()
  const { sessions, activeSessionId, updateSessionAgent } = useSessionStore()
  const [feedback, setFeedback] = useState('')

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const currentAgentId = activeSession?.agentId

  useEffect(() => {
    setLoading(true)
    agentApi
      .list()
      .then((result) => setAgents(result.list))
      .catch((e: any) => {
        setError(e.message)
        // 不使用 Toast（React 18 兼容问题），改用 inline banner
        setFeedback('加载 Agent 失败，请检查网络')
        setTimeout(() => setFeedback(''), 3000)
      })
      .finally(() => setLoading(false))
  }, [setAgents, setError, setLoading])

  const handleSelect = (agentId: string) => {
    const newId = agentId === currentAgentId ? undefined : agentId
    updateSessionAgent(activeSessionId, newId!)
    const msg = newId ? '已切换 Agent' : '已取消 Agent'
    setFeedback(msg)
    setTimeout(() => setFeedback(''), 1500)
  }

  return (
    <div className={styles.page}>
      <AppNavBar title="智能体" back={null} />

      {/* 内联反馈 banner（替代 Toast） */}
      {feedback && (
        <div style={{
          background: 'rgba(0,122,204,0.15)',
          color: 'var(--adm-color-primary)',
          textAlign: 'center',
          padding: '8px 16px',
          fontSize: 13,
          flexShrink: 0,
        }}>
          {feedback}
        </div>
      )}

      <div className={`${styles.list} scroll-area`}>
        {loading ? (
          <div className={styles.loading}>
            <SpinLoading color="primary" />
          </div>
        ) : agents.length === 0 ? (
          <div className={styles.empty}>
            <AppstoreOutline className={styles.emptyIcon} />
            <p>暂无 Agent，请在桌面端创建</p>
          </div>
        ) : (
          <List>
            {agents.map((agent) => {
              const isActive = agent.id === currentAgentId
              return (
                <List.Item
                  key={agent.id}
                  onClick={() => handleSelect(agent.id)}
                  prefix={
                    <div
                      className={`${styles.avatar} ${isActive ? styles.avatarActive : ''}`}
                    >
                      <AppstoreOutline />
                    </div>
                  }
                  description={agent.description || '暂无描述'}
                  extra={isActive ? <CheckOutline color="var(--adm-color-primary)" /> : null}
                >
                  <span className={styles.agentName}>
                    {agent.name}
                    {agent.model && (
                      <Tag
                        color="default"
                        fill="outline"
                        style={{ marginLeft: 8, fontSize: 11 }}
                      >
                        {agent.model}
                      </Tag>
                    )}
                  </span>
                </List.Item>
              )
            })}
          </List>
        )}
      </div>
    </div>
  )
}

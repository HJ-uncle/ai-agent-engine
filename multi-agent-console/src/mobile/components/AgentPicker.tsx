import React, { useEffect } from 'react'
import { Popup, List, Tag, SpinLoading } from 'antd-mobile'
import { CheckOutline, AppstoreOutline } from 'antd-mobile-icons'
import { useAgentStore } from '@core/store/agents'
import { useSessionStore } from '@core/store/session'
import { agentApi } from '@core/api'
import styles from './AgentPicker.module.css'

interface AgentPickerProps {
  visible: boolean
  onClose: () => void
}

export function AgentPicker({ visible, onClose }: AgentPickerProps) {
  const { agents, loading, setAgents, setLoading, setError } = useAgentStore()
  const { sessions, activeSessionId, updateSessionAgent } = useSessionStore()

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const currentAgentId = activeSession?.agentId

  useEffect(() => {
    if (!visible) return
    setLoading(true)
    agentApi
      .list()
      .then((result) => setAgents(result.list))
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false))
  }, [visible, setAgents, setError, setLoading])

  const handleSelect = (agentId: string | undefined) => {
    updateSessionAgent(activeSessionId, agentId as any)
    onClose()
  }

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      position="bottom"
      bodyStyle={{ borderRadius: '16px 16px 0 0', maxHeight: '60vh', display: 'flex', flexDirection: 'column' }}
      destroyOnClose={false}
    >
      <div className={styles.handle} />
      <div className={styles.header}>
        <span className={styles.title}>选择 Agent</span>
      </div>

      <div className={`${styles.list} scroll-area`}>
        {loading ? (
          <div className={styles.loading}><SpinLoading color="primary" /></div>
        ) : (
          <List>
            {/* 默认无 Agent */}
            <List.Item
              prefix={
                <div className={`${styles.avatar} ${!currentAgentId ? styles.avatarActive : ''}`}>
                  <span style={{ fontSize: 18 }}>🤖</span>
                </div>
              }
              extra={!currentAgentId ? <CheckOutline color="var(--adm-color-primary)" /> : null}
              onClick={() => handleSelect(undefined)}
              description="使用默认模型，不绑定特定 Agent"
            >
              <span className={styles.agentName}>默认对话</span>
            </List.Item>

            {agents.map((agent) => {
              const isActive = agent.id === currentAgentId
              return (
                <List.Item
                  key={agent.id}
                  prefix={
                    <div className={`${styles.avatar} ${isActive ? styles.avatarActive : ''}`}>
                      <AppstoreOutline />
                    </div>
                  }
                  extra={isActive ? <CheckOutline color="var(--adm-color-primary)" /> : null}
                  onClick={() => handleSelect(agent.id)}
                  description={agent.description || '暂无描述'}
                >
                  <span className={styles.agentName}>
                    {agent.name}
                    {agent.model && (
                      <Tag
                        color="default"
                        fill="outline"
                        style={{ marginLeft: 6, fontSize: 11 }}
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

      <div className={styles.safeBottom} />
    </Popup>
  )
}

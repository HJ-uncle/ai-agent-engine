import React from 'react'
import { TabBar } from 'antd-mobile'
import {
  MessageOutline,
  UnorderedListOutline,
  AppstoreOutline,
  UserOutline,
  CheckCircleOutline,
} from 'antd-mobile-icons'
import { useNavigate, useLocation } from 'react-router-dom'
import styles from './AppTabBar.module.css'

const TABS = [
  { key: '/chat',     title: '对话',  icon: <MessageOutline /> },
  { key: '/sessions', title: '会话',  icon: <UnorderedListOutline /> },
  { key: '/todo',     title: '任务',  icon: <CheckCircleOutline /> },
  { key: '/agents',   title: '智能体', icon: <AppstoreOutline /> },
  { key: '/me',       title: '我的',  icon: <UserOutline /> },
]

export function AppTabBar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // 当前激活的 tab key
  const activeKey = TABS.find((t) => pathname.startsWith(t.key))?.key ?? '/chat'

  return (
    <div className={styles.tabBarWrapper}>
      <TabBar
        activeKey={activeKey}
        onChange={(key) => navigate(key)}
        style={{
          '--height': `calc(50px + var(--safe-bottom))`,
          background: 'var(--adm-color-background)',
          borderTop: '1px solid var(--adm-color-border)',
          paddingBottom: 'var(--safe-bottom)',
        } as React.CSSProperties}
      >
        {TABS.map((tab) => (
          <TabBar.Item key={tab.key} icon={tab.icon} title={tab.title} />
        ))}
      </TabBar>
    </div>
  )
}

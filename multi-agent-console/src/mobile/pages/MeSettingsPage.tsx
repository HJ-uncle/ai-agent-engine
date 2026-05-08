import React from 'react'
import { List } from 'antd-mobile'
import {
  UserOutline,
  SetOutline,
  EditSOutline,
  InformationCircleOutline,
  RightOutline,
} from 'antd-mobile-icons'
import { useNavigate } from 'react-router-dom'
import { AppNavBar } from '../components/AppNavBar'
import styles from './MeSettingsPage.module.css'

interface MenuItem {
  key: string
  icon: React.ReactNode
  label: string
  path: string
}

const MENU: MenuItem[] = [
  {
    key: 'account',
    icon: <UserOutline />,
    label: '账号',
    path: '/settings/account',
  },
  {
    key: 'model',
    icon: <SetOutline />,
    label: '模型设置',
    path: '/settings/model',
  },
  {
    key: 'api-keys',
    icon: <EditSOutline />,
    label: 'API Key',
    path: '/settings/api-keys',
  },
  {
    key: 'about',
    icon: <InformationCircleOutline />,
    label: '关于 Agent Console',
    path: '/settings/about',
  },
]

export default function MeSettingsPage() {
  const navigate = useNavigate()

  return (
    <div className={styles.page}>
      <AppNavBar title="我的" back={null} />

      <div className={`${styles.content} scroll-area`}>
        <List>
          {MENU.map((item) => (
            <List.Item
              key={item.key}
              prefix={
                <span className={styles.icon}>{item.icon}</span>
              }
              arrow={<RightOutline />}
              onClick={() => navigate(item.path)}
              className={styles.listItem}
            >
              {item.label}
            </List.Item>
          ))}
        </List>

        <div className={styles.version}>v1.0.0</div>
      </div>
    </div>
  )
}

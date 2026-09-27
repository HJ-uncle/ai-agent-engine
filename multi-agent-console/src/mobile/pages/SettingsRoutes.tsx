import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { List } from 'antd-mobile'
import { AppNavBar } from '../components/AppNavBar'
import styles from './SettingsRoutes.module.css'

// ─── 各子页面（占位，后续可独立拆文件） ──────────────────────────────────────

function AccountPage() {
  return (
    <div className={styles.page}>
      <AppNavBar title="账号" />
      <div className={`${styles.content} scroll-area`}>
        <List>
          <List.Item description="即将推出">账号设置</List.Item>
        </List>
      </div>
    </div>
  )
}

function ModelPage() {
  return (
    <div className={styles.page}>
      <AppNavBar title="模型设置" />
      <div className={`${styles.content} scroll-area`}>
        <List>
          <List.Item description="在桌面端可进行更完整的模型配置">
            模型配置
          </List.Item>
        </List>
      </div>
    </div>
  )
}

function ApiKeysPage() {
  return (
    <div className={styles.page}>
      <AppNavBar title="API Key" />
      <div className={`${styles.content} scroll-area`}>
        <List>
          <List.Item description="如需修改 API Key，请前往桌面端设置">
            API Key 管理
          </List.Item>
        </List>
      </div>
    </div>
  )
}

function AboutPage() {
  return (
    <div className={styles.page}>
      <AppNavBar title="关于" />
      <div className={`${styles.content} scroll-area`}>
        <div className={styles.about}>
          <div className={styles.logo}>🤖</div>
          <h2 className={styles.appName}>Multi-Agent Console</h2>
          <p className={styles.ver}>版本 v1.0.0</p>
          <p className={styles.desc}>多智能体协作控制台</p>
        </div>
      </div>
    </div>
  )
}

// ─── 路由汇总 ──────────────────────────────────────────────────────────────

export function SettingsRoutes() {
  return (
    <Routes>
      <Route path="account"  element={<AccountPage />} />
      <Route path="model"    element={<ModelPage />} />
      <Route path="api-keys" element={<ApiKeysPage />} />
      <Route path="about"    element={<AboutPage />} />
    </Routes>
  )
}

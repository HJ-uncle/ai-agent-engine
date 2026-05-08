import React from 'react'
import { Outlet } from 'react-router-dom'
import { AppTabBar } from './AppTabBar'
import styles from './MobileLayout.module.css'

/**
 * 壳布局：全屏容器（100dvh）
 *   ┌─────────────────┐
 *   │   <Outlet />    │  ← 各页面自行包含 NavBar（sticky）+ 滚动区
 *   │   (flex: 1,     │
 *   │   overflow-y)   │
 *   ├─────────────────┤
 *   │   TabBar        │
 *   └─────────────────┘
 *
 * 每个页面通过 PageShell 或直接使用 AppNavBar 来渲染顶部导航。
 */
export function MobileLayout() {
  return (
    <div className={styles.root}>
      {/* 主内容区 —— overflow-y 由页面内的 scroll-area 负责 */}
      <div className={styles.content}>
        <Outlet />
      </div>
      <AppTabBar />
    </div>
  )
}

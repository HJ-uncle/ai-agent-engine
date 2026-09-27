import React from 'react'
import { NavBar } from 'antd-mobile'
import { useNavigate } from 'react-router-dom'
import styles from './AppNavBar.module.css'

interface AppNavBarProps {
  title?: React.ReactNode
  /** 左侧插槽：传 false 时隐藏返回箭头 */
  back?: React.ReactNode | null
  right?: React.ReactNode
  onBack?: () => void
}

export function AppNavBar({ title, back, right, onBack }: AppNavBarProps) {
  const navigate = useNavigate()

  const handleBack = onBack ?? (() => navigate(-1))

  return (
    <div className={styles.navBarWrapper}>
      <NavBar
        back={back === undefined ? '返回' : back}
        right={right}
        onBack={back === null ? undefined : handleBack}
        style={{
          '--height': '44px',
          '--border-bottom': '1px solid var(--adm-color-border)',
          background: 'var(--adm-color-background)',
          color: 'var(--adm-color-text)',
          paddingTop: 'var(--safe-top)',
        } as React.CSSProperties}
      >
        <span className={styles.title}>{title}</span>
      </NavBar>
    </div>
  )
}

import React from 'react'
import styles from './SettingsLayout.module.css'
import { useTheme, type ThemeMode } from '../../hooks/useTheme'

const THEME_OPTIONS: { value: ThemeMode; label: string; desc: string; icon: string }[] = [
  { value: 'dark',   label: '深色',     desc: '始终使用深色主题（默认）',   icon: '🌙' },
  { value: 'light',  label: '浅色',     desc: '始终使用浅色主题',           icon: '☀️' },
  { value: 'system', label: '跟随系统', desc: '自动匹配操作系统的主题偏好', icon: '⚙️' },
]

export default function GeneralSettings() {
  const { mode, setMode } = useTheme()

  return (
    <div className={styles.settingsContainer}>

      {/* ── 界面设置 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>界面设置</div>
        <div className={styles.card}>

          {/* 主题模式 */}
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>主题模式</div>
              <div className={styles.itemDescription}>
                选择界面的颜色主题，「跟随系统」会自动响应 macOS / Windows 的深浅色切换
              </div>
            </div>
            <div className={styles.itemControls}>
              <div className={styles.tileRow}>
                {THEME_OPTIONS.map(opt => {
                  const active = mode === opt.value
                  return (
                    <button
                      key={opt.value}
                      title={opt.desc}
                      onClick={() => setMode(opt.value)}
                      className={`${styles.tile} ${active ? styles.tileActive : ''}`}
                    >
                      <span className={styles.tileIcon}>{opt.icon}</span>
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 显示语言 */}
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>显示语言</div>
              <div className={styles.itemDescription}>
                界面语言（当前版本仅支持简体中文）
              </div>
            </div>
            <div className={styles.itemControls}>
              <div className={styles.controlRow}>
                <div className={styles.readonlyChip}>🇨🇳 中文（简体）</div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

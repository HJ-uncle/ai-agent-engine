import React from 'react'
import { Input } from 'antd'
import styles from './SettingsLayout.module.css'

export default function GeneralSettings() {
  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>界面设置</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>显示语言</div>
              <div className={styles.itemDescription}>选择控制台界面的显示语言</div>
            </div>
            <div className={styles.itemControls}>
              <div className={styles.controlRow}>
                <Input value="中文 (简体)" disabled style={{ width: 120, background: '#2d2d2d', border: '1px solid #444' }} />
              </div>
            </div>
          </div>
          
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>主题风格</div>
              <div className={styles.itemDescription}>当前使用 VS Code 风格的主题</div>
            </div>
            <div className={styles.itemControls}>
              <div className={styles.controlRow}>
                <Input value="VS Code Dark+" disabled style={{ width: 120, background: '#2d2d2d', border: '1px solid #444' }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

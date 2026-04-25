import React, { useEffect, useState } from 'react'
import { Input, Button, App } from 'antd'
import { settingsApi } from '../../api'
import styles from './SettingsLayout.module.css'

export default function SystemSettings() {
  const { message } = App.useApp()
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    settingsApi.get().then((data) => setSettings(data))
  }, [])

  const handleChange = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      await settingsApi.update({
        DATABASE_URL: settings.DATABASE_URL,
      })
      message.success('系统设置已保存')
    } catch (err) {
      message.error('保存失败')
    }
    setLoading(false)
  }

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>数据库配置</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>数据库连接地址</div>
              <div className={styles.itemDescription}>配置存储代理数据的数据库连接路径 (DATABASE_URL)</div>
            </div>
            <div className={styles.itemControls}>
              <Input
                value={settings.DATABASE_URL}
                onChange={(e) => handleChange('DATABASE_URL', e.target.value)}
                style={{ width: 250, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 20, textAlign: 'right', paddingRight: 20 }}>
        <Button type="primary" onClick={handleSave} loading={loading}>保存设置</Button>
      </div>
    </div>
  )
}

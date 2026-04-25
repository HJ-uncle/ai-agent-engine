import React, { useEffect, useState } from 'react'
import { Input, Button, App } from 'antd'
import { settingsApi } from '../../api'
import styles from './SettingsLayout.module.css'

export default function SkillSettings() {
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
        SKILLS_ROOT: settings.SKILLS_ROOT,
      })
      message.success('技能设置已保存')
    } catch (err) {
      message.error('保存失败')
    }
    setLoading(false)
  }

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>技能注册表配置</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>技能脚本目录</div>
              <div className={styles.itemDescription}>配置存放自定义技能的绝对或相对路径 (SKILLS_ROOT)</div>
            </div>
            <div className={styles.itemControls}>
              <Input
                value={settings.SKILLS_ROOT}
                onChange={(e) => handleChange('SKILLS_ROOT', e.target.value)}
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

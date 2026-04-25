import React, { useEffect, useState } from 'react'
import { InputNumber, Button, App } from 'antd'
import { useSessionStore } from '../../store/session'
import { settingsApi } from '../../api'
import styles from './SettingsLayout.module.css'

export default function ChatFlowSettings() {
  const { message } = App.useApp()
  const { maxAskUserCount, setMaxAskUserCount } = useSessionStore()
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
        MAX_ITERATIONS: settings.MAX_ITERATIONS,
        TOKEN_BUDGET: settings.TOKEN_BUDGET,
      })
      message.success('对话流设置已保存')
    } catch (err) {
      message.error('保存失败')
    }
    setLoading(false)
  }

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>交互设置</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>工具提问的最大次数</div>
              <div className={styles.itemDescription}>AI 单次任务允许连续向用户提问的最大轮数</div>
            </div>
            <div className={styles.itemControls}>
              <div className={styles.controlRow}>
                <InputNumber
                  min={1}
                  max={50}
                  value={maxAskUserCount}
                  onChange={(val) => setMaxAskUserCount(val || 5)}
                  style={{ width: 120, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>运行限制</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>最大循环迭代次数</div>
              <div className={styles.itemDescription}>控制智能体内部推理循环的最大次数 (MAX_ITERATIONS)</div>
            </div>
            <div className={styles.itemControls}>
              <InputNumber
                value={settings.MAX_ITERATIONS}
                onChange={(val) => handleChange('MAX_ITERATIONS', val || 50)}
                style={{ width: 120, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>单次任务 Token 预算</div>
              <div className={styles.itemDescription}>设定整个任务允许消耗的最大 Token 数量 (TOKEN_BUDGET)</div>
            </div>
            <div className={styles.itemControls}>
              <InputNumber
                value={settings.TOKEN_BUDGET}
                onChange={(val) => handleChange('TOKEN_BUDGET', val || 80000)}
                style={{ width: 120, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
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

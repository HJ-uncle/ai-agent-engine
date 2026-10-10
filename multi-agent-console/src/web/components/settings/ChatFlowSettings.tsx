import React from 'react'
import { InputNumber, Button } from 'antd'
import { useSessionStore } from '@core/store/session'
import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'

export default function ChatFlowSettings() {
  const { maxAskUserCount, setMaxAskUserCount } = useSessionStore()
  const { settings, handleChange, saveKeys, saving } = useSettings()

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
              <div className={styles.itemDescription}>其他运行模式的迭代上限；清空表示不限。Code 模式不使用此全局限制。</div>
            </div>
            <div className={styles.itemControls}>
              <InputNumber
                min={1}
                placeholder="不限"
                value={settings.MAX_ITERATIONS ?? null}
                onChange={(val) => handleChange('MAX_ITERATIONS', val)}
                style={{ width: 120, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>单次任务 Token 预算</div>
              <div className={styles.itemDescription}>其他运行模式的本地 Token 预算；清空表示不设。Code 模式按模型上下文窗口自动压缩。</div>
            </div>
            <div className={styles.itemControls}>
              <InputNumber
                min={1}
                placeholder="不限"
                value={settings.TOKEN_BUDGET ?? null}
                onChange={(val) => handleChange('TOKEN_BUDGET', val)}
                style={{ width: 120, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 20, textAlign: 'right', paddingRight: 20 }}>
        <Button type="primary" onClick={() => saveKeys(['MAX_ITERATIONS', 'TOKEN_BUDGET'], '对话流设置已保存')} loading={saving}>保存设置</Button>
      </div>
    </div>
  )
}

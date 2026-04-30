import React from 'react'
import { Input, Button, Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'

const INPUT_STYLE: React.CSSProperties = { background: 'var(--color-fill-secondary)', border: '1px solid var(--color-gray-4)', color: 'var(--color-label)', borderRadius: 'var(--radius-sm)' }

function SettingRow({ title, desc, envKey, children }: {
  title: string; desc: string; envKey: string; children: React.ReactNode
}) {
  return (
    <div className={styles.settingItem}>
      <div className={styles.itemInfo}>
        <div className={styles.itemTitle}>
          {title}
          <Tooltip title={`环境变量: ${envKey}`}>
            <InfoCircleOutlined style={{ marginLeft: 6, color: 'var(--color-label-tertiary)', fontSize: 12, cursor: 'help' }} />
          </Tooltip>
        </div>
        <div className={styles.itemDescription}>{desc}</div>
      </div>
      <div className={styles.itemControls}>{children}</div>
    </div>
  )
}

export default function SkillSettings() {
  const { settings, handleChange, saveKeys, saving } = useSettings()

  const KEYS = ['SKILLS_ROOT', 'BASH_PATH', 'WEB_SEARCH_SERVER']

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>技能目录</div>
        <div className={styles.card}>
          <SettingRow
            title="技能脚本目录 (SKILLS_ROOT)"
            desc="存放自定义技能的目录，支持绝对路径或相对于工作目录的相对路径"
            envKey="SKILLS_ROOT"
          >
            <Input
              value={settings.SKILLS_ROOT}
              onChange={(e) => handleChange('SKILLS_ROOT', e.target.value)}
              placeholder="./skills"
              style={{ width: 240, ...INPUT_STYLE }}
            />
          </SettingRow>

          <SettingRow
            title="Bash 可执行路径 (BASH_PATH)"
            desc="Windows 上运行技能脚本所需的 bash 路径（如 Git Bash），Linux/macOS 留空即可"
            envKey="BASH_PATH"
          >
            <Input
              value={settings.BASH_PATH}
              onChange={(e) => handleChange('BASH_PATH', e.target.value)}
              placeholder="C:/Program Files/Git/bin/bash.exe"
              style={{ width: 240, ...INPUT_STYLE }}
            />
          </SettingRow>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>外部服务</div>
        <div className={styles.card}>
          <SettingRow
            title="Web 搜索服务地址 (WEB_SEARCH_SERVER)"
            desc="本地 Web 搜索 Bridge 服务的请求地址"
            envKey="WEB_SEARCH_SERVER"
          >
            <Input
              value={settings.WEB_SEARCH_SERVER}
              onChange={(e) => handleChange('WEB_SEARCH_SERVER', e.target.value)}
              placeholder="http://127.0.0.1:8923"
              style={{ width: 240, ...INPUT_STYLE }}
            />
          </SettingRow>
        </div>
      </div>

      <div style={{ textAlign: 'right', paddingRight: 4 }}>
        <Button type="primary" onClick={() => saveKeys(KEYS, '技能设置已保存')} loading={saving}>
          保存设置
        </Button>
      </div>
    </div>
  )
}
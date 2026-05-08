import React from 'react'
import { Input, InputNumber, Switch, Button, Tooltip, Tag, Space } from 'antd'
import { InfoCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'

const INPUT_STYLE: React.CSSProperties = { background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }

function SettingRow({ title, desc, envKey, badge, children }: {
  title: string; desc: string; envKey: string
  badge?: 'restart' | 'sensitive'
  children: React.ReactNode
}) {
  return (
    <div className={styles.settingItem}>
      <div className={styles.itemInfo}>
        <div className={styles.itemTitle} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {title}
          <Tooltip title={`环境变量: ${envKey}`}>
            <InfoCircleOutlined style={{ color: '#555', fontSize: 12, cursor: 'help' }} />
          </Tooltip>
          {badge === 'restart' && (
            <Tag color="orange" style={{ fontSize: 11, lineHeight: '16px', padding: '0 5px' }}>需重启</Tag>
          )}
          {badge === 'sensitive' && (
            <Tag color="red" style={{ fontSize: 11, lineHeight: '16px', padding: '0 5px' }}>启动参数</Tag>
          )}
        </div>
        <div className={styles.itemDescription}>{desc}</div>
      </div>
      <div className={styles.itemControls}>{children}</div>
    </div>
  )
}

export default function SystemSettings() {
  const { settings, handleChange, saveKeys, saving } = useSettings()

  const KEYS = [
    'WORKSPACE_ROOT',
    'MCP_CONFIG_PATH',
    'CMD_TIMEOUT_MS',
    'MAX_FILE_SIZE_BYTES',
    'QA_LOG_ENABLED',
    'QA_LOG_DIR',
  ]

  return (
    <div className={styles.settingsContainer}>
      {/* ── 工作区 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>工作区</div>
        <div className={styles.card}>
          <SettingRow
            title="工作区根目录 (WORKSPACE_ROOT)"
            desc="Agent 文件操作的沙箱根目录，每个 session 会在此目录下创建独立子目录"
            envKey="WORKSPACE_ROOT"
            badge="restart"
          >
            <Input
              value={settings.WORKSPACE_ROOT}
              onChange={(e) => handleChange('WORKSPACE_ROOT', e.target.value)}
              placeholder="./workspace"
              style={{ width: 220, ...INPUT_STYLE }}
            />
          </SettingRow>
        </div>
      </div>

      {/* ── MCP ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>MCP 配置</div>
        <div className={styles.card}>
          <SettingRow
            title="MCP 配置文件路径 (MCP_CONFIG_PATH)"
            desc="MCP 服务器配置文件的路径，支持绝对或相对路径"
            envKey="MCP_CONFIG_PATH"
            badge="restart"
          >
            <Input
              value={settings.MCP_CONFIG_PATH}
              onChange={(e) => handleChange('MCP_CONFIG_PATH', e.target.value)}
              placeholder="./mcp.config.json"
              style={{ width: 220, ...INPUT_STYLE }}
            />
          </SettingRow>
        </div>
      </div>

      {/* ── 工具限制 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>工具限制</div>
        <div className={styles.card}>
          <SettingRow
            title="命令执行超时 (CMD_TIMEOUT_MS)"
            desc="execute_cmd 工具的最大执行时间（毫秒），超时后强制终止进程"
            envKey="CMD_TIMEOUT_MS"
          >
            <Space.Compact>
              <InputNumber
                min={1000} max={300000} step={1000}
                value={settings.CMD_TIMEOUT_MS}
                onChange={(v) => handleChange('CMD_TIMEOUT_MS', v)}
                style={{ width: 110, ...INPUT_STYLE }}
              />
              <span style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '0 10px', background: '#2d2d2d',
                border: '1px solid #444', borderLeft: 'none',
                borderRadius: '0 6px 6px 0', color: '#888', fontSize: 11,
              }}>ms</span>
            </Space.Compact>
          </SettingRow>

          <SettingRow
            title="文件读取大小上限 (MAX_FILE_SIZE_BYTES)"
            desc="read_file 工具允许读取的最大文件字节数，超出则拒绝读取"
            envKey="MAX_FILE_SIZE_BYTES"
          >
            <InputNumber
              min={102400} max={104857600} step={1048576}
              value={settings.MAX_FILE_SIZE_BYTES}
              onChange={(v) => handleChange('MAX_FILE_SIZE_BYTES', v)}
              style={{ width: 150, ...INPUT_STYLE }}
              formatter={(v) => {
                if (!v) return '0 B'
                if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`
                return `${(v / 1024).toFixed(0)} KB`
              }}
            />
          </SettingRow>
        </div>
      </div>

      {/* ── 可观测性 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>可观测性 / 日志</div>
        <div className={styles.card}>
          <SettingRow
            title="QA 日志开关 (QA_LOG_ENABLED)"
            desc="启用后将每轮对话的完整问答记录到本地 Markdown 文件，用于性能分析"
            envKey="QA_LOG_ENABLED"
          >
            <Switch
              checked={settings.QA_LOG_ENABLED === true || settings.QA_LOG_ENABLED === 'true'}
              onChange={(v) => handleChange('QA_LOG_ENABLED', v)}
            />
          </SettingRow>

          <SettingRow
            title="QA 日志目录 (QA_LOG_DIR)"
            desc="QA 日志文件的输出目录，支持绝对或相对路径"
            envKey="QA_LOG_DIR"
          >
            <Input
              value={settings.QA_LOG_DIR}
              onChange={(e) => handleChange('QA_LOG_DIR', e.target.value)}
              placeholder="./logs/qa"
              style={{ width: 220, ...INPUT_STYLE }}
            />
          </SettingRow>
        </div>
      </div>

      {/* ── 只读提示 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <WarningOutlined style={{ marginRight: 6, color: '#e6c07b' }} />
          启动参数（仅 .env 可配置）
        </div>
        <div className={styles.card}>
          {[
            { label: 'PORT', value: '服务监听端口' },
            { label: 'DB_PATH', value: '数据库文件路径' },
            { label: 'ENCRYPTION_KEY', value: '数据加密密钥（32 字节 hex）' },
            { label: 'JWT_SECRET', value: 'JWT 鉴权密钥' },
            { label: 'AUTH_ENABLED', value: '是否启用鉴权' },
          ].map(({ label, value }) => (
            <div key={label} className={styles.settingItem}>
              <div className={styles.itemInfo}>
                <div className={styles.itemTitle} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code style={{ background: '#2d2d2d', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>{label}</code>
                  <span style={{ fontWeight: 400, color: '#ccc', fontSize: 13 }}>{value}</span>
                </div>
              </div>
              <div className={styles.itemControls}>
                <Tag color="default" style={{ color: '#888' }}>仅 .env</Tag>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ textAlign: 'right', paddingRight: 4 }}>
        <Button type="primary" onClick={() => saveKeys(KEYS, '系统设置已保存')} loading={saving}>
          保存设置
        </Button>
      </div>
    </div>
  )
}
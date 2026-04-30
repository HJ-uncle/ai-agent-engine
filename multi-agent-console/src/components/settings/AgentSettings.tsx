import React from 'react'
import { InputNumber, Slider, Button, Row, Col, Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'

function SettingRow({
  title, desc, envKey, children,
}: {
  title: string
  desc: string
  envKey: string
  children: React.ReactNode
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

const INPUT_STYLE = { background: 'var(--color-fill-secondary)', border: '1px solid var(--color-gray-4)', color: 'var(--color-label)', borderRadius: 'var(--radius-sm)' }

export default function AgentSettings() {
  const { settings, handleChange, saveKeys, saving } = useSettings()

  const KEYS = [
    'MAX_ITERATIONS',
    'TOKEN_BUDGET',
    'HISTORY_MAX_TOKENS',
    'TOOL_OUTPUT_MAX_CHARS',
    'COMPRESS_THRESHOLD_RATIO',
  ]

  return (
    <div className={styles.settingsContainer}>
      {/* ── 推理控制 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>推理控制</div>
        <div className={styles.card}>
          <SettingRow
            title="最大迭代次数"
            desc="每次对话 Agent 最多执行多少轮工具调用后停止（MAX_ITERATIONS）"
            envKey="MAX_ITERATIONS"
          >
            <InputNumber
              min={1} max={500}
              value={settings.MAX_ITERATIONS}
              onChange={(v) => handleChange('MAX_ITERATIONS', v)}
              style={{ width: 120, ...INPUT_STYLE }}
            />
          </SettingRow>

          <SettingRow
            title="Token 预算"
            desc="每次对话允许消耗的最大 token 数，超出后触发历史压缩（TOKEN_BUDGET）"
            envKey="TOKEN_BUDGET"
          >
            <InputNumber
              min={10000} max={500000} step={10000}
              value={settings.TOKEN_BUDGET}
              onChange={(v) => handleChange('TOKEN_BUDGET', v)}
              style={{ width: 120, ...INPUT_STYLE }}
              formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            />
          </SettingRow>
        </div>
      </div>

      {/* ── 历史管理 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>历史管理</div>
        <div className={styles.card}>
          <SettingRow
            title="历史窗口 Token 上限"
            desc="传入 LLM 的历史消息最大 token 数，超出则裁剪最旧消息（HISTORY_MAX_TOKENS）"
            envKey="HISTORY_MAX_TOKENS"
          >
            <InputNumber
              min={1000} max={200000} step={1000}
              value={settings.HISTORY_MAX_TOKENS}
              onChange={(v) => handleChange('HISTORY_MAX_TOKENS', v)}
              style={{ width: 120, ...INPUT_STYLE }}
              formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            />
          </SettingRow>

          <SettingRow
            title="压缩触发比例"
            desc="历史 token 占 TOKEN_BUDGET 的比例达到此阈值时自动压缩（COMPRESS_THRESHOLD_RATIO，0.1–1.0）"
            envKey="COMPRESS_THRESHOLD_RATIO"
          >
            <Row gutter={8} align="middle" style={{ width: 220 }}>
              <Col flex="1">
                <Slider
                  min={0.1} max={1.0} step={0.05}
                  value={settings.COMPRESS_THRESHOLD_RATIO}
                  onChange={(v) => handleChange('COMPRESS_THRESHOLD_RATIO', v)}
                  tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
                />
              </Col>
              <Col>
                <span style={{ color: 'var(--color-label)', fontSize: 13, minWidth: 36, textAlign: 'right', display: 'inline-block' }}>
                  {settings.COMPRESS_THRESHOLD_RATIO
                    ? `${Math.round(settings.COMPRESS_THRESHOLD_RATIO * 100)}%`
                    : '50%'}
                </span>
              </Col>
            </Row>
          </SettingRow>

          <SettingRow
            title="工具输出截断长度"
            desc="单次工具输出超过此字符数时自动截断头尾，防止历史膨胀（TOOL_OUTPUT_MAX_CHARS）"
            envKey="TOOL_OUTPUT_MAX_CHARS"
          >
            <InputNumber
              min={500} max={50000} step={500}
              value={settings.TOOL_OUTPUT_MAX_CHARS}
              onChange={(v) => handleChange('TOOL_OUTPUT_MAX_CHARS', v)}
              style={{ width: 120, ...INPUT_STYLE }}
              formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            />
          </SettingRow>
        </div>
      </div>

      <div style={{ textAlign: 'right', paddingRight: 4 }}>
        <Button type="primary" onClick={() => saveKeys(KEYS, '智能体设置已保存')} loading={saving}>
          保存设置
        </Button>
      </div>
    </div>
  )
}
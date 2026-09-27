import React, { useState } from 'react'
import { Input, Segmented, Tag, Tooltip, App, Button } from 'antd'
import { ThunderboltOutlined, ExclamationCircleOutlined, CheckCircleTwoTone, KeyOutlined } from '@ant-design/icons'
import { useSettings } from './useSettings'
import { settingsApi } from '@core/api'
import { useSessionStore } from '@core/store/session'
import styles from './SettingsLayout.module.css'

type OSMMode = 'off' | 'balanced' | 'methodology' | 'max'
const MODES: OSMMode[] = ['off', 'balanced', 'methodology', 'max']

const MODE_LABELS: Record<OSMMode, string> = {
  off: '低耗',
  balanced: '均衡',
  methodology: '方法论',
  max: '极致',
}

const MODE_TOOLTIPS: Record<OSMMode, string> = {
  off: '仅核心工具（读写/记忆/搜索/任务/技能/交互）；数值保守；24×7 常驻安全。',
  balanced: '全量工具可用；数值 ×2；不注入方法论；适合日常工程任务。',
  methodology: '全量工具 + 数值 ×2 + 自动注入 OSM 注入；自动建 .openspec/ 目录；严肃项目推荐。',
  max: '全量工具 + 数值 ×5/×4 + OSM 注入 + 压缩阈值 0.7；长自治任务用；消耗高。',
}

/** 访问凭据（AUTH_ENABLED=true 时管理类操作需要） */
function AccessKeySection() {
  const { message } = App.useApp()
  const [key, setKey] = useState(() => {
    try { return localStorage.getItem('api_key') ?? '' } catch { return '' }
  })
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      if (key.trim()) localStorage.setItem('api_key', key.trim())
      else localStorage.removeItem('api_key')
      message.success(key.trim() ? '访问密钥已保存，管理类操作即刻生效' : '已清除访问密钥')
    } catch { message.error('保存失败（localStorage 不可用）') }
    finally { setSaving(false) }
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>访问凭据</div>
      <div className={styles.card}>
        <div className={styles.settingItem}>
          <div className={styles.itemInfo}>
            <div className={styles.itemTitle}>Access Key <KeyOutlined /></div>
            <div className={styles.itemDescription}>
              服务器开启 AUTH_ENABLED 时，管理类操作（技能管理/导入等）需携带访问密钥。
              密钥由部署管理员通过 POST /auth/user 注册后颁发；本地开发（AUTH_ENABLED=false）无需填写
            </div>
          </div>
          <div className={styles.itemControls}>
            <div className={styles.controlRow}>
              <Input.Password
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="粘贴部署管理员颁发的 Access Key"
                style={{ width: 260, background: '#2d2d2d', border: '1px solid #444' }}
              />
              <Button loading={saving} onClick={save}>{key ? '保存' : '清除'}</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function GeneralSettings() {
  const { settings, handleChange } = useSettings()
  const { osmMode, setOsmMode } = useSessionStore()
  const { message, modal } = App.useApp()

  const currentMode = osmMode
  const methodologyActive = currentMode === 'methodology' || currentMode === 'max'

  const persistMode = async (mode: OSMMode) => {
    const prev = currentMode
    setOsmMode(mode)
    try {
      await settingsApi.update({ OSM_MODE: mode })
      message.success(`已切换到 ${MODE_LABELS[mode]} 模式`)
    } catch {
      message.error('保存失败，请重试')
      setOsmMode(prev)
    }
  }

  const onModeChange = (v: string | number) => {
    const next = String(v) as OSMMode
    if (next === currentMode) return
    // 进入 max 强制弹确认；其它模式直接切换
    if (next === 'max') {
      modal.confirm({
        title: '确认切换到 极致 模式？',
        icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
        width: 560,
        content: (
          <div style={{ lineHeight: 1.8 }}>
            <p style={{ marginBottom: 12 }}>
              极致模式是最重量级设定，适合长自治任务，非日常默认。启用后：
            </p>
            <ul style={{ paddingLeft: 20, marginBottom: 12 }}>
              <li>Token 预算 × 5、迭代次数 × 4、工具输出上限 × 4、历史窗口 × 4</li>
              <li>全量工具可用（含 <code>run_command</code> / <code>delete_file</code> /
                <code> web_fetch</code> / <code>http_request</code> / <code>install_package</code> /
                <code> subagent</code> 等高风险工具）</li>
              <li>压缩阈值放宽到 0.7，长会话 token 消耗显著上升</li>
              <li>自动注入 OpenSpec 方法论 (OSM)，简单任务也会走提案 / 设计 / TDD 流程</li>
            </ul>
            <p style={{ color: '#d46b08', marginBottom: 0 }}>
              建议仅在受信任工作区 + 并发可控的环境启用。
              如只要方法论但不想 ×5，选 <b>方法论 (Methodology)</b> 即可。
            </p>
          </div>
        ),
        okText: '确认切换到 极致',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => persistMode('max'),
      })
      return
    }
    void persistMode(next)
  }

  return (
    <div className={styles.settingsContainer}>
      {/* ── OSM 模式 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <ThunderboltOutlined
            style={{ marginRight: 6, color: currentMode === 'off' ? '#888' : '#f0c040' }}
          />
          OpenSpec 方法论 (OSM)
          {methodologyActive && (
            <Tag
              color="gold"
              icon={<CheckCircleTwoTone twoToneColor="#f0c040" />}
              style={{ marginLeft: 10 }}
            >
              OSM Methodology active
            </Tag>
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>当前模式</div>
              <div className={styles.itemDescription}>
                选择本节点的默认能力档位。悬停每档查看含义；
                <b>极限 (Max)</b> 会弹出风险确认。
              </div>
            </div>
            <div className={styles.itemControls}>
              <Segmented
                value={currentMode}
                onChange={onModeChange}
                options={MODES.map(m => ({
                  label: (
                    <Tooltip title={MODE_TOOLTIPS[m]} placement="top">
                      <span>{MODE_LABELS[m]}</span>
                    </Tooltip>
                  ),
                  value: m,
                }))}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── 访问凭据 ── */}
      <AccessKeySection />

      {/* ── 界面设置 ── */}
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

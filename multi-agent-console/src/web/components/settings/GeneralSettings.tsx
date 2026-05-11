import React from 'react'
import { Input, Segmented, Tag, Tooltip, App } from 'antd'
import { ThunderboltOutlined, ExclamationCircleOutlined, CheckCircleTwoTone } from '@ant-design/icons'
import { useSettings } from './useSettings'
import { settingsApi } from '@core/api'
import styles from './SettingsLayout.module.css'

type SuperpowerMode = 'off' | 'balanced' | 'methodology' | 'max'
const MODES: SuperpowerMode[] = ['off', 'balanced', 'methodology', 'max']

const MODE_LABELS: Record<SuperpowerMode, string> = {
  off: 'Off',
  balanced: 'Balanced',
  methodology: 'Methodology',
  max: 'Max',
}

const MODE_TOOLTIPS: Record<SuperpowerMode, string> = {
  off: '仅核心工具（读写/记忆/搜索/任务/技能/交互）；数值保守；24×7 常驻安全。',
  balanced: '全量工具可用；数值 ×2；不注入方法论；适合日常工程任务。',
  methodology: '全量工具 + 数值 ×2 + 自动注入方法论 bootstrap；自动建 docs/superpower/ 目录；严肃项目推荐。',
  max: '全量工具 + 数值 ×5/×4 + 方法论 bootstrap + 压缩阈值 0.7；长自治任务用；消耗高。',
}

/**
 * 把后端任意字段形态归一化为 SuperpowerMode。
 * 兼容两种来源：
 *   1. 新字段 SUPERPOWER_MODE：直接用
 *   2. 旧字段 SUPERPOWER_ENABLED：true→methodology，false/缺失→off
 * TODO(remove-in-next-minor): 下个 minor 移除 legacy 兼容。
 */
function normalizeMode(settings: any): SuperpowerMode {
  const raw = settings?.SUPERPOWER_MODE
  if (raw && MODES.includes(raw as SuperpowerMode)) return raw as SuperpowerMode
  const legacy = settings?.SUPERPOWER_ENABLED
  if (legacy === true || legacy === 'true') return 'methodology'
  return 'off'
}

export default function GeneralSettings() {
  const { settings, handleChange } = useSettings()
  const { message, modal } = App.useApp()

  const currentMode: SuperpowerMode = normalizeMode(settings)
  const methodologyActive = currentMode === 'methodology' || currentMode === 'max'

  const persistMode = async (mode: SuperpowerMode) => {
    const prev = currentMode
    handleChange('SUPERPOWER_MODE', mode)
    try {
      await settingsApi.update({ SUPERPOWER_MODE: mode })
      message.success(`已切换到 ${MODE_LABELS[mode]} 模式`)
    } catch {
      message.error('保存失败，请重试')
      handleChange('SUPERPOWER_MODE', prev)
    }
  }

  const onModeChange = (v: string | number) => {
    const next = String(v) as SuperpowerMode
    if (next === currentMode) return
    // 进入 max 强制弹确认；其它模式直接切换
    if (next === 'max') {
      modal.confirm({
        title: '确认切换到 Max 模式？',
        icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
        width: 560,
        content: (
          <div style={{ lineHeight: 1.8 }}>
            <p style={{ marginBottom: 12 }}>
              Max 模式是最重量级设定，适合长自治任务，非日常默认。启用后：
            </p>
            <ul style={{ paddingLeft: 20, marginBottom: 12 }}>
              <li>Token 预算 × 5、迭代次数 × 4、工具输出上限 × 4、历史窗口 × 4</li>
              <li>全量工具可用（含 <code>run_command</code> / <code>delete_file</code> /
                <code> web_fetch</code> / <code>http_request</code> / <code>install_package</code> /
                <code> subagent</code> 等高风险工具）</li>
              <li>压缩阈值放宽到 0.7，长会话 token 消耗显著上升</li>
              <li>自动注入方法论 bootstrap，简单任务也会走 spec / plan / TDD 流程</li>
            </ul>
            <p style={{ color: '#d46b08', marginBottom: 0 }}>
              建议仅在受信任工作区 + 并发可控的环境启用。
              如只要方法论但不想 ×5，选 <b>Methodology</b> 即可。
            </p>
          </div>
        ),
        okText: '确认切换到 Max',
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
      {/* ── Superpower 模式 ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <ThunderboltOutlined
            style={{ marginRight: 6, color: currentMode === 'off' ? '#888' : '#f0c040' }}
          />
          增强模式 (Superpower)
          {methodologyActive && (
            <Tag
              color="gold"
              icon={<CheckCircleTwoTone twoToneColor="#f0c040" />}
              style={{ marginLeft: 10 }}
            >
              Methodology active
            </Tag>
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>当前模式</div>
              <div className={styles.itemDescription}>
                选择本节点的默认能力档位。悬停每档查看含义；
                <b>Max</b> 会弹出风险确认。旧配置 <code>SUPERPOWER_ENABLED</code> 仍生效
                （true → Methodology，false → Off），将在下个 minor 版本移除。
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

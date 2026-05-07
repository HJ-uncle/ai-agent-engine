import React, { useEffect, useState, useCallback } from 'react'
import {
  Button,
  InputNumber,
  Select,
  Switch,
  DatePicker,
  Table,
  Tag,
  Spin,
  Alert,
  Tooltip,
  Space,
  Divider,
  App,
} from 'antd'
import {
  ReloadOutlined,
  SaveOutlined,
  WalletOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  InfoCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'
import { deepseekApi } from '../../api/index'
import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'

// DeepSeek 行为配置 Keys（不含 API Key / Base URL，那两个在模型设置里）
const DS_BEHAVIOR_KEYS = [
  'DEEPSEEK_AUTO_THINKING',
  'DEEPSEEK_THINKING_EFFORT',
  'DEEPSEEK_DEFAULT_JSON_MODE',
  'DEEPSEEK_LOG_CACHE_HITS',
  'DEEPSEEK_INCLUDE_STREAM_USAGE',
]

// ── 价格配置类型 ───────────────────────────────────────────────────────────
interface ModelPriceTier {
  input: number
  output: number
  cacheHit: number
}
interface ModelPriceConfig {
  modelId: string
  normalPrice: ModelPriceTier
  discountPrice?: ModelPriceTier
  discountUntil?: string | null
  effectivePrice?: ModelPriceTier & { isDiscounted: boolean }
}
interface BalanceInfo {
  balance: number
  currency: string
  isAvailable: boolean
  lowBalance: boolean
  lowBalanceThreshold: number
  updatedAt: string
}

export default function DeepSeekSettings() {
  const { message } = App.useApp()
  const { settings, handleChange, saveKeys, saving } = useSettings()

  // ── 价格配置状态 ──────────────────────────────────────────────────────
  const [priceLoading, setPriceLoading] = useState(false)
  const [priceSaving, setPriceSaving] = useState(false)
  const [models, setModels] = useState<ModelPriceConfig[]>([])
  const [lowBalanceThreshold, setLowBalanceThreshold] = useState<number>(10)

  // ── 余额状态 ──────────────────────────────────────────────────────────
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balance, setBalance] = useState<BalanceInfo | null>(null)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  // ── 模型列表状态 ──────────────────────────────────────────────────────
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsFallback, setModelsFallback] = useState(false)

  // ── 加载价格配置 ──────────────────────────────────────────────────────
  const loadPrices = useCallback(async () => {
    setPriceLoading(true)
    try {
      const data = await deepseekApi.getPrices()
      if (data?.models) {
        setModels(data.models)
        setLowBalanceThreshold(data.lowBalanceThreshold ?? 10)
      }
    } catch {
      message.error('加载价格配置失败')
    } finally {
      setPriceLoading(false)
    }
  }, [message])

  // ── 加载余额 ──────────────────────────────────────────────────────────
  const loadBalance = useCallback(async () => {
    setBalanceLoading(true)
    setBalanceError(null)
    try {
      const data = await deepseekApi.getBalance()
      setBalance(data!)
    } catch (err: any) {
      setBalanceError(err?.message ?? '查询余额失败')
    } finally {
      setBalanceLoading(false)
    }
  }, [])

  // ── 加载模型列表 ──────────────────────────────────────────────────────
  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    try {
      const data = await deepseekApi.getModels()
      if (data?.models) {
        setAvailableModels(data.models)
        setModelsFallback(data.fallback)
      }
    } catch {
      setAvailableModels(['deepseek-chat', 'deepseek-reasoner'])
      setModelsFallback(true)
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPrices()
    loadBalance()
    loadModels()
  }, [loadPrices, loadBalance, loadModels])

  // ── 保存价格配置 ──────────────────────────────────────────────────────
  const handleSavePrices = async () => {
    setPriceSaving(true)
    try {
      await deepseekApi.savePrices({ models, lowBalanceThreshold })
      message.success('价格配置已保存')
      await loadPrices()
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setPriceSaving(false)
    }
  }

  // ── 更新模型价格字段 ──────────────────────────────────────────────────
  const updateModelPrice = (
    modelId: string,
    tier: 'normalPrice' | 'discountPrice',
    field: keyof ModelPriceTier,
    value: number,
  ) => {
    setModels((prev) =>
      prev.map((m) => {
        if (m.modelId !== modelId) return m
        const tierData = m[tier] ?? { input: 0, output: 0, cacheHit: 0 }
        return { ...m, [tier]: { ...tierData, [field]: value } }
      }),
    )
  }

  const updateDiscountUntil = (modelId: string, date: Dayjs | null) => {
    setModels((prev) =>
      prev.map((m) =>
        m.modelId === modelId
          ? { ...m, discountUntil: date ? date.toISOString() : null }
          : m,
      ),
    )
  }

  // ── 便捷辅助 ──────────────────────────────────────────────────────────
  const bool = (key: string, def = true) => {
    const v = settings[key]
    if (v === undefined) return def
    if (typeof v === 'boolean') return v
    return String(v) !== 'false'
  }

  // ── 价格表格列 ────────────────────────────────────────────────────────
  const priceColumns = [
    {
      title: '类型', dataIndex: 'field', width: 110,
      render: (v: string) => <span style={{ color: '#8b949e', fontSize: 12 }}>{v}</span>,
    },
    { title: '原价（元/百万）', dataIndex: 'normal', render: (v: any) => v },
    { title: '折扣价（元/百万）', dataIndex: 'discount', render: (v: any) => v },
    { title: '当前有效', dataIndex: 'effective', render: (v: any) => v },
  ]

  return (
    <div className={styles.settingsContainer}>

      {/* ══ 1. 推理与行为配置 ═════════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <SettingOutlined style={{ marginRight: 8 }} />推理与行为配置
        </div>
        <div className={styles.card}>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>自动推理模式（Auto Thinking）</div>
              <div className={styles.itemDescription}>
                R1 / V3-0324 模型：检测到复杂任务时自动启用 thinking（DEEPSEEK_AUTO_THINKING）
              </div>
            </div>
            <div className={styles.itemControls}>
              <Switch
                checked={bool('DEEPSEEK_AUTO_THINKING', true)}
                onChange={(v) => handleChange('DEEPSEEK_AUTO_THINKING', v)}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>推理强度（Reasoning Effort）</div>
              <div className={styles.itemDescription}>
                控制 thinking 模式下的推理深度（DEEPSEEK_THINKING_EFFORT）
              </div>
            </div>
            <div className={styles.itemControls}>
              <Select
                value={settings.DEEPSEEK_THINKING_EFFORT ?? 'medium'}
                onChange={(v) => handleChange('DEEPSEEK_THINKING_EFFORT', v)}
                style={{ width: 120 }}
                options={[
                  { value: 'low',    label: 'Low（快速）' },
                  { value: 'medium', label: 'Medium（均衡）' },
                  { value: 'high',   label: 'High（深度）' },
                ]}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>默认 JSON Mode</div>
              <div className={styles.itemDescription}>
                所有请求默认启用 response_format: json_object（DEEPSEEK_DEFAULT_JSON_MODE）
              </div>
            </div>
            <div className={styles.itemControls}>
              <Switch
                checked={bool('DEEPSEEK_DEFAULT_JSON_MODE', false)}
                onChange={(v) => handleChange('DEEPSEEK_DEFAULT_JSON_MODE', v)}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>流式请求携带 Usage</div>
              <div className={styles.itemDescription}>
                Stream 模式下自动注入 stream_options.include_usage，用于 token 统计（DEEPSEEK_INCLUDE_STREAM_USAGE）
              </div>
            </div>
            <div className={styles.itemControls}>
              <Switch
                checked={bool('DEEPSEEK_INCLUDE_STREAM_USAGE', true)}
                onChange={(v) => handleChange('DEEPSEEK_INCLUDE_STREAM_USAGE', v)}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>KV Cache 命中日志</div>
              <div className={styles.itemDescription}>
                每次请求完成后在后端 console 打印 KV Cache 命中率（DEEPSEEK_LOG_CACHE_HITS）
              </div>
            </div>
            <div className={styles.itemControls}>
              <Switch
                checked={bool('DEEPSEEK_LOG_CACHE_HITS', true)}
                onChange={(v) => handleChange('DEEPSEEK_LOG_CACHE_HITS', v)}
              />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <Button
              type="primary" size="small" icon={<SaveOutlined />}
              loading={saving}
              onClick={() => saveKeys(DS_BEHAVIOR_KEYS, '推理配置已保存')}
            >
              保存
            </Button>
          </div>
        </div>
      </div>

      {/* ══ 3. 账户余额 ══════════════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <WalletOutlined style={{ marginRight: 8 }} />账户余额
        </div>
        <div className={styles.card}>
          <Spin spinning={balanceLoading}>
            {balanceError ? (
              <Alert
                type="warning"
                message={balanceError}
                showIcon
                style={{ marginBottom: 12 }}
                description={
                  balanceError.includes('API Key') || balanceError.includes('未配置')
                    ? <span>请在上方 <strong>API Key</strong> 配置区填写并保存后刷新</span>
                    : null
                }
              />
            ) : balance ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <span style={{ color: '#8b949e', fontSize: 12 }}>可用余额</span>
                  <div style={{ fontSize: 28, fontWeight: 700, color: balance.lowBalance ? '#f59e0b' : '#3fb950' }}>
                    ¥ {balance.balance.toFixed(2)}
                    <span style={{ fontSize: 13, color: '#8b949e', marginLeft: 4 }}>{balance.currency}</span>
                  </div>
                </div>
                {balance.lowBalance && (
                  <Alert
                    type="warning" icon={<WarningOutlined />} showIcon
                    message={
                      <span>
                        余额不足 ¥{balance.lowBalanceThreshold}，请及时{' '}
                        <a href="https://platform.deepseek.com/top_up" target="_blank" rel="noopener noreferrer" style={{ color: '#f59e0b' }}>充值</a>
                      </span>
                    }
                  />
                )}
                {!balance.isAvailable && <Tag color="error">API 暂不可用</Tag>}
                <div style={{ marginLeft: 'auto', fontSize: 11, color: '#6e7681' }}>
                  更新于 {new Date(balance.updatedAt).toLocaleTimeString()}
                </div>
              </div>
            ) : (
              <span style={{ color: '#6e7681' }}>点击"刷新"查询余额</span>
            )}
          </Spin>
          <div style={{ marginTop: 12 }}>
            <Space>
              <Button size="small" icon={<ReloadOutlined />} onClick={loadBalance} loading={balanceLoading}>
                刷新余额
              </Button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#8b949e', fontSize: 12 }}>低余额警告阈值：¥</span>
                <InputNumber
                  size="small" min={0} step={1}
                  value={lowBalanceThreshold}
                  onChange={(v) => setLowBalanceThreshold(v ?? 10)}
                  style={{ width: 80 }}
                />
              </div>
            </Space>
          </div>
        </div>
      </div>

      {/* ══ 4. 价格配置 ══════════════════════════════════════════════════ */}
      <div className={styles.section}>
        <div
          className={styles.sectionTitle}
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>💰 价格配置</span>
          <Space>
            <Tooltip title="折扣截止时间到期后自动回原价，无需重启">
              <InfoCircleOutlined style={{ color: '#8b949e' }} />
            </Tooltip>
            <Button type="primary" size="small" icon={<SaveOutlined />} loading={priceSaving} onClick={handleSavePrices}>
              保存
            </Button>
          </Space>
        </div>
        <Spin spinning={priceLoading}>
          {models.map((m) => {
            const isDiscounted = m.effectivePrice?.isDiscounted ?? false
            const priceData = [
              {
                key: 'input', field: '输入 token',
                normal: <InputNumber size="small" min={0} step={0.1} precision={2} value={m.normalPrice.input} onChange={(v) => updateModelPrice(m.modelId, 'normalPrice', 'input', v ?? 0)} style={{ width: 90 }} addonAfter="¥" />,
                discount: <InputNumber size="small" min={0} step={0.1} precision={2} value={m.discountPrice?.input ?? 0} onChange={(v) => updateModelPrice(m.modelId, 'discountPrice', 'input', v ?? 0)} style={{ width: 90 }} addonAfter="¥" />,
                effective: <span style={{ color: isDiscounted ? '#10b981' : '#e6edf3', fontSize: 12 }}>¥{isDiscounted ? (m.discountPrice?.input ?? 0) : m.normalPrice.input}</span>,
              },
              {
                key: 'output', field: '输出 token',
                normal: <InputNumber size="small" min={0} step={0.1} precision={2} value={m.normalPrice.output} onChange={(v) => updateModelPrice(m.modelId, 'normalPrice', 'output', v ?? 0)} style={{ width: 90 }} addonAfter="¥" />,
                discount: <InputNumber size="small" min={0} step={0.1} precision={2} value={m.discountPrice?.output ?? 0} onChange={(v) => updateModelPrice(m.modelId, 'discountPrice', 'output', v ?? 0)} style={{ width: 90 }} addonAfter="¥" />,
                effective: <span style={{ color: isDiscounted ? '#10b981' : '#e6edf3', fontSize: 12 }}>¥{isDiscounted ? (m.discountPrice?.output ?? 0) : m.normalPrice.output}</span>,
              },
              {
                key: 'cacheHit', field: 'KV Cache 命中',
                normal: <InputNumber size="small" min={0} step={0.1} precision={3} value={m.normalPrice.cacheHit} onChange={(v) => updateModelPrice(m.modelId, 'normalPrice', 'cacheHit', v ?? 0)} style={{ width: 90 }} addonAfter="¥" />,
                discount: <InputNumber size="small" min={0} step={0.1} precision={3} value={m.discountPrice?.cacheHit ?? 0} onChange={(v) => updateModelPrice(m.modelId, 'discountPrice', 'cacheHit', v ?? 0)} style={{ width: 90 }} addonAfter="¥" />,
                effective: <span style={{ color: '#10b981', fontSize: 12 }}>¥{isDiscounted ? (m.discountPrice?.cacheHit ?? 0) : m.normalPrice.cacheHit}</span>,
              },
            ]
            return (
              <div key={m.modelId} className={styles.card} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, color: '#e6edf3', fontSize: 14 }}>🐋 {m.modelId}</span>
                  {isDiscounted
                    ? <Tag color="green" icon={<CheckCircleOutlined />}>折扣中</Tag>
                    : <Tag color="default">原价</Tag>
                  }
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#8b949e', fontSize: 12 }}>折扣截止时间：</span>
                    <DatePicker
                      size="small" showTime allowClear
                      value={m.discountUntil ? dayjs(m.discountUntil) : null}
                      onChange={(d) => updateDiscountUntil(m.modelId, d)}
                      placeholder="不设截止（永久折扣）"
                      style={{ width: 200 }}
                    />
                  </div>
                </div>
                <Table size="small" columns={priceColumns} dataSource={priceData} pagination={false} rowKey="key" style={{ fontSize: 12 }} />
                <div style={{ marginTop: 8, fontSize: 11, color: '#6e7681' }}>
                  价格单位：元人民币 / 百万 tokens（以官网为准，此处为估算参考）
                </div>
              </div>
            )
          })}
          {models.length === 0 && !priceLoading && (
            <div style={{ color: '#6e7681', textAlign: 'center', padding: 24 }}>暂无价格配置，请检查后端连接</div>
          )}
        </Spin>
      </div>

      {/* ══ 5. 可用模型列表 ══════════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          可用模型
          {modelsFallback && <Tag color="orange" style={{ marginLeft: 8, fontSize: 11 }}>内置列表</Tag>}
        </div>
        <div className={styles.card}>
          <Spin spinning={modelsLoading}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minHeight: 32 }}>
              {availableModels.map((id) => <Tag key={id} style={{ fontSize: 12 }}>{id}</Tag>)}
              {availableModels.length === 0 && !modelsLoading && (
                <span style={{ color: '#6e7681', fontSize: 12 }}>暂无数据</span>
              )}
            </div>
          </Spin>
          <Divider style={{ margin: '10px 0' }} />
          <Button size="small" icon={<ReloadOutlined />} onClick={loadModels} loading={modelsLoading}>
            刷新模型列表
          </Button>
        </div>
      </div>

    </div>
  )
}

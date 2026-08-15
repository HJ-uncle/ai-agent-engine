import React, { useEffect, useState } from 'react'
import { Input, Select, Button, App, Table, Space, Tag, Popconfirm, Switch } from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined, SwapOutlined } from '@ant-design/icons'
import { modelsApi, settingsApi } from '@core/api'

import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'
import ModelManagerModal from '../models/ModelManagerModal'

export default function ModelSettings() {
  const { message } = App.useApp()
  const { settings, handleChange, reload } = useSettings()

  // Model Management State
  const [models, setModels] = useState<any[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<any | null>(null)
  const [saving, setSaving] = useState(false)

  // API Key Local State (to hide existing keys)
  const [keyChanges, setKeyChanges] = useState<Record<string, string>>({})

  const LLM_KEYS = ['LLM_PROVIDER', 'LLM_PRIMARY_MODEL', 'LLM_REVIEW_MODEL', 'LLM_SUMMARIZE_MODEL', 'AUTO_COMPACT_TOKEN_LIMIT', 'REASONING_EFFORT', 'ENABLE_LONG_TERM_MEMORY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'OLLAMA_BASE_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']
  const SECRET_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']

  const loadModels = async () => {
    setLoadingModels(true)
    try {
      const data = await modelsApi.listModels()
      setModels(data)
    } catch (err: any) {
      message.error(err.message || '加载模型列表失败')
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleEditModel = (record: any) => {
    setEditingModel(record)
    setIsModalOpen(true)
  }

  const handleDeleteModel = async (id: string) => {
    try {
      await modelsApi.deleteModel(id)
      message.success('模型删除成功')
      loadModels()
    } catch (err) {
      message.error('删除模型失败')
    }
  }


  const handleSwitchModel = async (record: any) => {
    // 1. 更新本地 state（UI 立即响应）
    handleChange('LLM_PRIMARY_MODEL', record.modelId)
    handleChange('LLM_PROVIDER', record.provider)
    // 2. 直接用覆盖值持久化到后端，绕过 setState 异步批处理
    setSaving(true)
    try {
      const payload: Record<string, any> = {}
      LLM_KEYS.forEach(key => {
        if (key === 'LLM_PRIMARY_MODEL') payload[key] = record.modelId
        else if (key === 'LLM_PROVIDER') payload[key] = record.provider
        else if (!SECRET_KEYS.includes(key) && settings[key] !== undefined) payload[key] = settings[key]
      })
      await settingsApi.update(payload)
      message.success(`已切换默认模型为 ${record.displayName || record.modelId}`)
    } catch {
      message.error('切换失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const isDefaultModel = (modelId: string, provider: string) =>
    modelId === settings.LLM_PRIMARY_MODEL && provider === settings.LLM_PROVIDER


  const handleSaveSettings = async () => {
    setSaving(true)
    try {
      const payload: Record<string, any> = {}
      LLM_KEYS.forEach(key => {
        if (SECRET_KEYS.includes(key)) {
          // 密钥类字段：只有当用户输入了新值才发送
          if (keyChanges[key]) {
            payload[key] = keyChanges[key]
          }
        } else if (settings[key] !== undefined) {
          // 普通字段：发送当前 state 中的值
          payload[key] = settings[key]
        }
      })

      await settingsApi.update(payload)
      message.success('模型设置已保存')
      setKeyChanges({}) // 清空局部修改
      reload() // 重新加载以确保同步
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    {
      title: '模型名称',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (text: string, record: any) => (
        <Space size={8}>
          <span>{text || record.modelId}</span>
          {isDefaultModel(record.modelId, record.provider) && (
            <Tag color="processing">当前默认</Tag>
          )}
        </Space>
      )
    },
    { title: '模型ID', dataIndex: 'modelId', key: 'modelId' },
    {
      title: '提供商',
      dataIndex: 'provider',
      key: 'provider',
      render: (text: string) => (
        <Tag color={text === 'openai' ? 'green' : text === 'anthropic' ? 'purple' : 'blue'}>
          {text.toUpperCase()}
        </Tag>
      )
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space size="small">
          {!isDefaultModel(record.modelId, record.provider) ? (
            <Popconfirm
              title="确认切换默认模型？"
              description={`将默认模型切换为 ${record.displayName || record.modelId}`}
              onConfirm={() => handleSwitchModel(record)}
              okText="确定"
              cancelText="取消"
            >
              <Button type="text" icon={<SwapOutlined />} size="small">
                切换
              </Button>
            </Popconfirm>
          ) : (
            <Button type="text" size="small" disabled style={{ color: '#52c41a' }}>
              ✓ 当前默认
            </Button>
          )}
          <Button type="text" icon={<EditOutlined />} size="small" onClick={() => handleEditModel(record)} />
          <Popconfirm title="确定要删除这个模型吗？" onConfirm={() => handleDeleteModel(record.id)} okText="确定" cancelText="取消">
            <Button type="text" danger icon={<DeleteOutlined />} size="small" />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const inputStyle = { width: 250, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }

  return (
    <div className={styles.settingsContainer}>
      {/* ── 自定义模型管理 ── */}
      <div className={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className={styles.sectionTitle} style={{ margin: 0 }}>自定义模型管理 (Multi-Model)</div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>添加模型</Button>
        </div>
        <div className={styles.card} style={{ padding: 0, overflow: 'hidden' }}>
          <Table dataSource={models} columns={columns} rowKey="id" pagination={false} loading={loadingModels} size="small" />
        </div>
      </div>

      {/* ── 默认 Provider ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>默认模型提供商配置</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>默认模型提供商</div>
              <div className={styles.itemDescription}>选择使用的 AI 模型接口服务 (LLM_PROVIDER)</div>
            </div>
            <div className={styles.itemControls}>
              <Select
                value={settings.LLM_PROVIDER}
                onChange={(val) => handleChange('LLM_PROVIDER', val)}
                style={{ width: 180 }}
                options={[
                  { value: 'openai', label: 'OpenAI / 兼容接口' },
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'ollama', label: 'Ollama（本地）' },
                ]}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>主要模型名称 (Primary)</div>
              <div className={styles.itemDescription}>默认调用的聊天模型 (LLM_PRIMARY_MODEL)</div>
            </div>
            <div className={styles.itemControls}>
              <Input
                value={settings.LLM_PRIMARY_MODEL}
                onChange={(e) => handleChange('LLM_PRIMARY_MODEL', e.target.value)}
                style={{ width: 200, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>安全审查模型 (Review)</div>
              <div className={styles.itemDescription}>专职模型路由：用于后台安全审计与决策 (LLM_REVIEW_MODEL)</div>
            </div>
            <div className={styles.itemControls}>
              <Input
                value={settings.LLM_REVIEW_MODEL || ''}
                placeholder="与主要模型相同"
                onChange={(e) => handleChange('LLM_REVIEW_MODEL', e.target.value)}
                style={{ width: 200, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>摘要压缩模型 (Summarize)</div>
              <div className={styles.itemDescription}>专职模型路由：用于后台上下文无损压缩 (LLM_SUMMARIZE_MODEL)</div>
            </div>
            <div className={styles.itemControls}>
              <Input
                value={settings.LLM_SUMMARIZE_MODEL || ''}
                placeholder="与主要模型相同"
                onChange={(e) => handleChange('LLM_SUMMARIZE_MODEL', e.target.value)}
                style={{ width: 200, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── 高级特性控制 (Advanced) ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>高级特性配置</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>上下文智能压缩阈值</div>
              <div className={styles.itemDescription}>历史 Token 数超过此值时触发自动压缩 (AUTO_COMPACT_TOKEN_LIMIT)</div>
            </div>
            <div className={styles.itemControls}>
              <Input
                type="number"
                value={settings.AUTO_COMPACT_TOKEN_LIMIT || 500000}
                onChange={(e) => handleChange('AUTO_COMPACT_TOKEN_LIMIT', Number(e.target.value))}
                style={{ width: 120, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>推理模式控制 (Reasoning Effort)</div>
              <div className={styles.itemDescription}>调节推理模型（如 o1, o3, R1 等）的思考深度 (REASONING_EFFORT)</div>
            </div>
            <div className={styles.itemControls}>
              <Select
                value={settings.REASONING_EFFORT || 'medium'}
                onChange={(val) => handleChange('REASONING_EFFORT', val)}
                style={{ width: 180 }}
                options={[
                  { value: 'low', label: 'Low (低)' },
                  { value: 'medium', label: 'Medium (中)' },
                  { value: 'high', label: 'High (高)' },
                ]}
              />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>长期记忆提取 (Long-term Memory)</div>
              <div className={styles.itemDescription}>开启后，系统将在每次对话后自动提取并保留用户的长期偏好与事实。</div>
            </div>
            <div className={styles.itemControls}>
              <Switch
                checked={settings.ENABLE_LONG_TERM_MEMORY !== false && settings.ENABLE_LONG_TERM_MEMORY !== 'false'}
                onChange={(checked: boolean) => handleChange('ENABLE_LONG_TERM_MEMORY', checked)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── OpenAI 兼容 ── */}
      {settings.LLM_PROVIDER === 'openai' && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>OpenAI 兼容配置</div>
          <div className={styles.card}>
            <div className={styles.settingItem}>
              <div className={styles.itemInfo}>
                <div className={styles.itemTitle}>API Base URL</div>
                <div className={styles.itemDescription}>接口请求地址 (OPENAI_BASE_URL)</div>
              </div>
              <div className={styles.itemControls}>
                <Input value={settings.OPENAI_BASE_URL} onChange={(e) => handleChange('OPENAI_BASE_URL', e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div className={styles.settingItem}>
              <div className={styles.itemInfo}>
                <div className={styles.itemTitle}>API Key</div>
                <div className={styles.itemDescription}>密钥 (OPENAI_API_KEY)</div>
              </div>
              <div className={styles.itemControls}>
                <Input.Password
                  value={keyChanges.OPENAI_API_KEY ?? ''}
                  onChange={(e) => setKeyChanges({ ...keyChanges, OPENAI_API_KEY: e.target.value })}
                  placeholder={settings.OPENAI_API_KEY ? '已配置 (输入以覆盖)' : 'sk-...'}
                  style={inputStyle}
                  autoComplete="new-password"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Anthropic ── */}
      {settings.LLM_PROVIDER === 'anthropic' && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Anthropic 配置</div>
          <div className={styles.card}>
            <div className={styles.settingItem}>
              <div className={styles.itemInfo}>
                <div className={styles.itemTitle}>API Key</div>
                <div className={styles.itemDescription}>密钥 (ANTHROPIC_API_KEY)</div>
              </div>
              <div className={styles.itemControls}>
                <Input.Password
                  value={keyChanges.ANTHROPIC_API_KEY ?? ''}
                  onChange={(e) => setKeyChanges({ ...keyChanges, ANTHROPIC_API_KEY: e.target.value })}
                  placeholder={settings.ANTHROPIC_API_KEY ? '已配置 (输入以覆盖)' : 'sk-...'}
                  style={inputStyle}
                  autoComplete="new-password"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Ollama ── */}
      {settings.LLM_PROVIDER === 'ollama' && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Ollama 配置</div>
          <div className={styles.card}>
            <div className={styles.settingItem}>
              <div className={styles.itemInfo}>
                <div className={styles.itemTitle}>Ollama 服务地址</div>
                <div className={styles.itemDescription}>本地 Ollama 服务的请求地址 (OLLAMA_BASE_URL)</div>
              </div>
              <div className={styles.itemControls}>
                <Input value={settings.OLLAMA_BASE_URL} onChange={(e) => handleChange('OLLAMA_BASE_URL', e.target.value)} placeholder="http://localhost:11434" style={inputStyle} />
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, textAlign: 'right', paddingRight: 4 }}>
        <Button type="primary" onClick={handleSaveSettings} loading={saving}>保存设置</Button>
      </div>

      <ModelManagerModal
        open={isModalOpen}
        editModel={editingModel}
        onClose={() => { setIsModalOpen(false); setEditingModel(null) }}
        onSuccess={() => { setIsModalOpen(false); setEditingModel(null); loadModels() }}
      />
    </div>
  )
}
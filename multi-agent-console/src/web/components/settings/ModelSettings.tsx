import React, { useEffect, useState } from 'react'
import { Input, Select, Button, App, Table, Space, Tag, Popconfirm } from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { modelsApi } from '@core/api'
import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'
import ModelManagerModal from '../models/ModelManagerModal'

export default function ModelSettings() {
  const { message } = App.useApp()
  const { settings, handleChange, saveKeys, saving } = useSettings()

  // Model Management State
  const [models, setModels] = useState<any[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<any | null>(null)

  const LLM_KEYS = ['LLM_PROVIDER', 'LLM_PRIMARY_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'OLLAMA_BASE_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']

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

  const columns = [
    {
      title: '模型名称',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (text: string, record: any) => text || record.modelId
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
              <div className={styles.itemTitle}>主要模型名称</div>
              <div className={styles.itemDescription}>默认调用的模型 (LLM_PRIMARY_MODEL)</div>
            </div>
            <div className={styles.itemControls}>
              <Input
                value={settings.LLM_PRIMARY_MODEL}
                onChange={(e) => handleChange('LLM_PRIMARY_MODEL', e.target.value)}
                style={{ width: 200, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
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
                <Input.Password value={settings.OPENAI_API_KEY} onChange={(e) => handleChange('OPENAI_API_KEY', e.target.value)} style={inputStyle} autoComplete="new-password" />
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
                <Input.Password value={settings.ANTHROPIC_API_KEY} onChange={(e) => handleChange('ANTHROPIC_API_KEY', e.target.value)} style={inputStyle} autoComplete="new-password" />
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

      {/* ── DeepSeek 专属 API ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>🐋 DeepSeek 专属配置</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>API Base URL</div>
              <div className={styles.itemDescription}>
                DeepSeek 接口地址 (DEEPSEEK_BASE_URL)，留空或默认时使用 https://api.deepseek.com
              </div>
            </div>
            <div className={styles.itemControls}>
              <Input
                value={settings.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'}
                onChange={(e) => handleChange('DEEPSEEK_BASE_URL', e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>API Key</div>
              <div className={styles.itemDescription}>
                DeepSeek 专属密钥 (DEEPSEEK_API_KEY)；留空时自动复用上方 OPENAI_API_KEY
              </div>
            </div>
            <div className={styles.itemControls}>
              <Input.Password
                value={settings.DEEPSEEK_API_KEY ?? ''}
                onChange={(e) => handleChange('DEEPSEEK_API_KEY', e.target.value)}
                placeholder="留空则复用 OPENAI_API_KEY"
                style={inputStyle}
                autoComplete="new-password"
              />
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 20, textAlign: 'right', paddingRight: 4 }}>
        <Button type="primary" onClick={() => saveKeys(LLM_KEYS, '模型设置已保存')} loading={saving}>保存设置</Button>
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
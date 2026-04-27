import React, { useEffect, useState } from 'react'
import { Input, Select, Button, App, Table, Space, Tag, Popconfirm } from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { settingsApi, modelsApi } from '../../api'
import styles from './SettingsLayout.module.css'
import ModelManagerModal from '../models/ModelManagerModal'

export default function ModelSettings() {
  const { message } = App.useApp()
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(false)
  
  // Model Management State
  const [models, setModels] = useState<any[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<any | null>(null)

  const loadSettings = () => {
    settingsApi.get().then((data) => setSettings(data))
  }

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
    loadSettings()
    loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      await settingsApi.update({
        LLM_PROVIDER: settings.LLM_PROVIDER,
        LLM_PRIMARY_MODEL: settings.LLM_PRIMARY_MODEL,
        OPENAI_API_KEY: settings.OPENAI_API_KEY,
        OPENAI_BASE_URL: settings.OPENAI_BASE_URL,
        ANTHROPIC_API_KEY: settings.ANTHROPIC_API_KEY,
      })
      message.success('模型设置已保存')
    } catch (err) {
      message.error('保存失败')
    }
    setLoading(false)
  }

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
    {
      title: '模型ID',
      dataIndex: 'modelId',
      key: 'modelId',
    },
    {
      title: '提供商',
      dataIndex: 'provider',
      key: 'provider',
      render: (text: string) => <Tag color={text === 'openai' ? 'green' : text === 'anthropic' ? 'purple' : 'blue'}>{text.toUpperCase()}</Tag>
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space size="small">
          <Button
            type="text"
            icon={<EditOutlined />}
            size="small"
            onClick={() => handleEditModel(record)}
          />
          <Popconfirm
            title="确定要删除这个模型吗？"
            onConfirm={() => handleDeleteModel(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button type="text" danger icon={<DeleteOutlined />} size="small" />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className={styles.sectionTitle} style={{ margin: 0 }}>自定义模型管理 (Multi-Model)</div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>
            添加模型
          </Button>
        </div>
        <div className={styles.card} style={{ padding: 0, overflow: 'hidden' }}>
          <Table 
            dataSource={models} 
            columns={columns} 
            rowKey="id" 
            pagination={false}
            loading={loadingModels}
            size="small"
          />
        </div>
      </div>

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
                style={{ width: 150 }}
                options={[
                  { value: 'openai', label: 'OpenAI / 兼容接口' },
                  { value: 'anthropic', label: 'Anthropic' },
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
                <Input
                  value={settings.OPENAI_BASE_URL}
                  onChange={(e) => handleChange('OPENAI_BASE_URL', e.target.value)}
                  style={{ width: 250, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
                />
              </div>
            </div>
            <div className={styles.settingItem}>
              <div className={styles.itemInfo}>
                <div className={styles.itemTitle}>API Key</div>
                <div className={styles.itemDescription}>密钥 (OPENAI_API_KEY)</div>
              </div>
              <div className={styles.itemControls}>
                <Input.Password
                  value={settings.OPENAI_API_KEY}
                  onChange={(e) => handleChange('OPENAI_API_KEY', e.target.value)}
                  style={{ width: 250, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

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
                  value={settings.ANTHROPIC_API_KEY}
                  onChange={(e) => handleChange('ANTHROPIC_API_KEY', e.target.value)}
                  style={{ width: 250, background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, textAlign: 'right', paddingRight: 20 }}>
        <Button type="primary" onClick={handleSave} loading={loading}>保存设置</Button>
      </div>

      <ModelManagerModal
        open={isModalOpen}
        editModel={editingModel}
        onClose={() => {
          setIsModalOpen(false)
          setEditingModel(null)
        }}
        onSuccess={() => {
          setIsModalOpen(false)
          setEditingModel(null)
          loadModels()
        }}
      />
    </div>
  )
}

import React, { useState, useEffect, useCallback } from 'react'
import { Form, Input, Switch, Button, Space, App, InputNumber, Tag, Divider, Typography } from 'antd'
import { PlusOutlined, SaveOutlined, RestOutlined } from '@ant-design/icons'
import styles from './SettingsLayout.module.css'

const { Title, Text } = Typography

interface WebFetchConfig {
  enabled: boolean
  allowList: string[]
  blockList: string[]
  allowListEnabled: boolean
  blockListEnabled: boolean
  allowedProtocols: string[]
  maxContentLength: number
}

const DEFAULT_CONFIG: WebFetchConfig = {
  enabled: true,
  allowList: [],
  blockList: ['localhost', '127.0.0.1', '10.', '172.16.', '192.168.', '0.0.0.0', '::1'],
  allowListEnabled: false,
  blockListEnabled: true,
  allowedProtocols: ['https:', 'http:'],
  maxContentLength: 50000
}

export default function WebFetchSettings() {
  const { message: antMessage } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [config, setConfig] = useState<WebFetchConfig>(DEFAULT_CONFIG)
  const [blockList, setBlockList] = useState<string[]>(DEFAULT_CONFIG.blockList)
  const [allowList, setAllowList] = useState<string[]>(DEFAULT_CONFIG.allowList)
  const [newBlockItem, setNewBlockItem] = useState('')
  const [newAllowItem, setNewAllowItem] = useState('')

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/settings')
      const result = await response.json()
      if (result.code === 200 && result.data.webFetch) {
        const webFetch = result.data.webFetch
        setConfig(webFetch)
        setBlockList(webFetch.blockList || DEFAULT_CONFIG.blockList)
        setAllowList(webFetch.allowList || DEFAULT_CONFIG.allowList)
        form.setFieldsValue({
          enabled: webFetch.enabled !== undefined ? webFetch.enabled : DEFAULT_CONFIG.enabled,
          allowListEnabled: webFetch.allowListEnabled !== undefined ? webFetch.allowListEnabled : DEFAULT_CONFIG.allowListEnabled,
          blockListEnabled: webFetch.blockListEnabled !== undefined ? webFetch.blockListEnabled : DEFAULT_CONFIG.blockListEnabled,
          maxContentLength: webFetch.maxContentLength || DEFAULT_CONFIG.maxContentLength
        })
      } else {
        form.setFieldsValue({
          enabled: DEFAULT_CONFIG.enabled,
          allowListEnabled: DEFAULT_CONFIG.allowListEnabled,
          blockListEnabled: DEFAULT_CONFIG.blockListEnabled,
          maxContentLength: DEFAULT_CONFIG.maxContentLength
        })
      }
    } catch (error) {
      antMessage.error('加载配置失败，使用默认设置')
      form.setFieldsValue({
        enabled: DEFAULT_CONFIG.enabled,
        allowListEnabled: DEFAULT_CONFIG.allowListEnabled,
        blockListEnabled: DEFAULT_CONFIG.blockListEnabled,
        maxContentLength: DEFAULT_CONFIG.maxContentLength
      })
    }
  }, [form])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const handleSave = async () => {
    setLoading(true)
    try {
      const values = await form.validateFields()
      const webFetch: WebFetchConfig = {
        ...values,
        blockList,
        allowList,
        allowedProtocols: config.allowedProtocols
      }
      
      const response = await fetch('/api/v1/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webFetch })
      })
      const result = await response.json()
      if (result.code === 200) {
        antMessage.success('保存成功')
        loadConfig()
      } else {
        antMessage.error('保存失败')
      }
    } catch (error) {
      antMessage.error('保存失败')
    } finally {
      setLoading(false)
    }
  }

  const addToBlockList = () => {
    if (newBlockItem && !blockList.includes(newBlockItem)) {
      setBlockList([...blockList, newBlockItem])
      setNewBlockItem('')
    }
  }

  const removeFromBlockList = (item: string) => {
    setBlockList(blockList.filter(i => i !== item))
  }

  const addToAllowList = () => {
    if (newAllowItem && !allowList.includes(newAllowItem)) {
      setAllowList([...allowList, newAllowItem])
      setNewAllowItem('')
    }
  }

  const removeFromAllowList = (item: string) => {
    setAllowList(allowList.filter(i => i !== item))
  }

  const SettingRow = ({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) => (
    <div className={styles.settingRow}>
      <div className={styles.settingLabel}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        {description && <div className={styles.settingDescription}>{description}</div>}
      </div>
      <div className={styles.settingControl}>{children}</div>
    </div>
  )

  return (
    <Form form={form} className={styles.settingsContainer}>
      <Title level={4} className={styles.sectionTitle}>Web Fetch 安全设置</Title>
      
      <div className={styles.settingSection}>
        <SettingRow 
          label="启用 Web Fetch" 
          description="允许 Agent 使用 Web Fetch 工具访问外部网站"
        >
          <Form.Item name="enabled" valuePropName="checked" style={{ margin: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>

        <SettingRow 
          label="启用黑名单" 
          description="阻止访问黑名单中的域名"
        >
          <Form.Item name="blockListEnabled" valuePropName="checked" style={{ margin: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>

        <SettingRow 
          label="启用白名单" 
          description="仅允许访问白名单中的域名（优先级高于黑名单）"
        >
          <Form.Item name="allowListEnabled" valuePropName="checked" style={{ margin: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>

        <SettingRow 
          label="最大内容长度" 
          description="Web Fetch 返回内容的最大字节数"
        >
          <Form.Item name="maxContentLength" style={{ margin: 0, width: 180 }}>
            <InputNumber 
              min={1000} 
              max={1000000} 
              step={1000} 
              style={{ width: '100%' }}
            />
          </Form.Item>
        </SettingRow>
      </div>

      <Divider className={styles.settingDivider} />

      <div className={styles.settingSection}>
        <Title level={5} className={styles.sectionSubtitle}>黑名单域名</Title>
        <Text type="secondary" className={styles.sectionDescription}>
          被列入黑名单的域名将无法通过 Web Fetch 访问
        </Text>
        
        <div className={styles.tagContainer}>
          {blockList.map(item => (
            <Tag
              key={item}
              closable
              onClose={() => removeFromBlockList(item)}
              color="red"
              className={styles.domainTag}
            >
              {item}
            </Tag>
          ))}
        </div>

        <Space.Compact className={styles.addInput}>
          <Input
            placeholder="输入域名"
            value={newBlockItem}
            onChange={e => setNewBlockItem(e.target.value)}
            onPressEnter={addToBlockList}
            style={{ flex: 1 }}
          />
          <Button 
            type="default" 
            onClick={addToBlockList} 
            icon={<PlusOutlined />}
            disabled={!newBlockItem}
          >
            添加
          </Button>
        </Space.Compact>
      </div>

      <Divider className={styles.settingDivider} />

      <div className={styles.settingSection}>
        <Title level={5} className={styles.sectionSubtitle}>白名单域名</Title>
        <Text type="secondary" className={styles.sectionDescription}>
          只有在白名单中的域名才能被访问（需启用白名单模式）
        </Text>
        
        <div className={styles.tagContainer}>
          {allowList.map(item => (
            <Tag
              key={item}
              closable
              onClose={() => removeFromAllowList(item)}
              color="green"
              className={styles.domainTag}
            >
              {item}
            </Tag>
          ))}
        </div>

        <Space.Compact className={styles.addInput}>
          <Input
            placeholder="输入域名"
            value={newAllowItem}
            onChange={e => setNewAllowItem(e.target.value)}
            onPressEnter={addToAllowList}
            style={{ flex: 1 }}
          />
          <Button 
            type="default" 
            onClick={addToAllowList} 
            icon={<PlusOutlined />}
            disabled={!newAllowItem}
          >
            添加
          </Button>
        </Space.Compact>
      </div>

      <Divider className={styles.settingDivider} />

      <div className={styles.settingSection}>
        <Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={loading}
            className={styles.actionButton}
          >
            保存更改
          </Button>
          <Button
            icon={<RestOutlined />}
            onClick={loadConfig}
            className={styles.actionButton}
          >
            重置
          </Button>
        </Space>
      </div>
    </Form>
  )
}

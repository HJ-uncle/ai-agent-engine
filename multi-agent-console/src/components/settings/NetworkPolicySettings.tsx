import React, { useEffect, useState, useCallback } from 'react'
import { App, Button, Divider, Form, Input, InputNumber, Space, Switch, Tag, Typography } from 'antd'
import { PlusOutlined, SaveOutlined, ReloadOutlined } from '@ant-design/icons'
import { securityApi, type NetworkPolicy } from '../../api'
import styles from './SettingsLayout.module.css'

const { Title, Text } = Typography

const DEFAULT_POLICY: NetworkPolicy = {
  allowedProtocols: ['https:', 'http:'],
  denyListEnabled: true,
  denyDomains: ['metadata.google.internal', 'metadata.aws.internal'],
  denyCidrs: [],
  allowListEnabled: false,
  allowDomains: [],
  blockPrivateIP: true,
  dnsCacheTtl: 300,
  maxResponseBytes: 5 * 1024 * 1024,
  timeoutMs: 30000,
}

export default function NetworkPolicySettings() {
  const { message } = App.useApp()
  const [form] = Form.useForm<NetworkPolicy>()
  const [loading, setLoading] = useState(false)
  const [denyDomains, setDenyDomains] = useState<string[]>([])
  const [allowDomains, setAllowDomains] = useState<string[]>([])
  const [denyCidrs, setDenyCidrs] = useState<string[]>([])
  const [newDeny, setNewDeny] = useState('')
  const [newAllow, setNewAllow] = useState('')
  const [newCidr, setNewCidr] = useState('')

  const load = useCallback(async () => {
    try {
      const p = await securityApi.getNetworkPolicy()
      const merged = { ...DEFAULT_POLICY, ...p }
      setDenyDomains(merged.denyDomains ?? [])
      setAllowDomains(merged.allowDomains ?? [])
      setDenyCidrs(merged.denyCidrs ?? [])
      form.setFieldsValue({
        denyListEnabled: merged.denyListEnabled,
        allowListEnabled: merged.allowListEnabled,
        blockPrivateIP: merged.blockPrivateIP,
        dnsCacheTtl: merged.dnsCacheTtl,
        maxResponseBytes: merged.maxResponseBytes,
        timeoutMs: merged.timeoutMs,
      } as any)
    } catch (e: any) {
      message.error(`加载失败: ${e.message}`)
    }
  }, [form, message])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    setLoading(true)
    try {
      const values = await form.validateFields()
      const policy: NetworkPolicy = {
        ...DEFAULT_POLICY,
        ...values,
        denyDomains,
        allowDomains,
        denyCidrs,
        allowedProtocols: ['https:', 'http:'],
      }
      await securityApi.updateNetworkPolicy(policy)
      message.success('网络策略已保存')
      load()
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(`保存失败: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async () => {
    try {
      await securityApi.resetNetworkPolicy()
      message.success('已重置为默认策略')
      load()
    } catch (e: any) {
      message.error(`重置失败: ${e.message}`)
    }
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
      <Title level={4} className={styles.sectionTitle}>网络访问策略（防 SSRF / 数据泄漏）</Title>
      <Text type="secondary" className={styles.sectionDescription}>
        统一作用于 <code>web_fetch</code> 和 <code>http_request</code> 工具。所有决策都会写入审计日志。
      </Text>

      <div className={styles.settingSection}>
        <SettingRow label="阻止访问私有 IP" description="DNS 解析后若目标 IP 属于私有 / 保留网段（10/8、172.16/12、192.168/16、127/8、169.254/16、云 metadata 等），直接拒绝">
          <Form.Item name="blockPrivateIP" valuePropName="checked" style={{ margin: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow label="启用域名/网段黑名单">
          <Form.Item name="denyListEnabled" valuePropName="checked" style={{ margin: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow label="启用域名白名单（仅允许列表）" description="优先级高于黑名单">
          <Form.Item name="allowListEnabled" valuePropName="checked" style={{ margin: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow label="最大响应字节数" description="0 表示不限制；建议 5MB">
          <Form.Item name="maxResponseBytes" style={{ margin: 0 }}>
            <InputNumber min={0} step={1024 * 1024} style={{ width: 180 }} />
          </Form.Item>
        </SettingRow>
        <SettingRow label="请求超时 (ms)">
          <Form.Item name="timeoutMs" style={{ margin: 0 }}>
            <InputNumber min={1000} max={300000} step={1000} style={{ width: 180 }} />
          </Form.Item>
        </SettingRow>
        <SettingRow label="DNS 缓存 TTL (秒)">
          <Form.Item name="dnsCacheTtl" style={{ margin: 0 }}>
            <InputNumber min={0} max={3600} style={{ width: 180 }} />
          </Form.Item>
        </SettingRow>
      </div>

      <Divider className={styles.settingDivider} />

      <div className={styles.settingSection}>
        <Title level={5} className={styles.sectionSubtitle}>黑名单域名</Title>
        <div className={styles.tagContainer}>
          {denyDomains.map((d) => (
            <Tag key={d} closable color="red" className={styles.domainTag}
                 onClose={() => setDenyDomains(denyDomains.filter((x) => x !== d))}>
              {d}
            </Tag>
          ))}
        </div>
        <Space.Compact className={styles.addInput}>
          <Input placeholder="如 evil.example.com" value={newDeny}
                 onChange={(e) => setNewDeny(e.target.value)}
                 onPressEnter={() => { if (newDeny && !denyDomains.includes(newDeny)) { setDenyDomains([...denyDomains, newDeny]); setNewDeny('') } }} />
          <Button icon={<PlusOutlined />} disabled={!newDeny}
                  onClick={() => { if (!denyDomains.includes(newDeny)) { setDenyDomains([...denyDomains, newDeny]); setNewDeny('') } }}>
            添加
          </Button>
        </Space.Compact>
      </div>

      <Divider className={styles.settingDivider} />

      <div className={styles.settingSection}>
        <Title level={5} className={styles.sectionSubtitle}>黑名单 IP 网段 (CIDR)</Title>
        <div className={styles.tagContainer}>
          {denyCidrs.map((c) => (
            <Tag key={c} closable color="volcano" className={styles.domainTag}
                 onClose={() => setDenyCidrs(denyCidrs.filter((x) => x !== c))}>
              {c}
            </Tag>
          ))}
        </div>
        <Space.Compact className={styles.addInput}>
          <Input placeholder="如 203.0.113.0/24" value={newCidr}
                 onChange={(e) => setNewCidr(e.target.value)}
                 onPressEnter={() => { if (newCidr && !denyCidrs.includes(newCidr)) { setDenyCidrs([...denyCidrs, newCidr]); setNewCidr('') } }} />
          <Button icon={<PlusOutlined />} disabled={!newCidr}
                  onClick={() => { if (!denyCidrs.includes(newCidr)) { setDenyCidrs([...denyCidrs, newCidr]); setNewCidr('') } }}>
            添加
          </Button>
        </Space.Compact>
      </div>

      <Divider className={styles.settingDivider} />

      <div className={styles.settingSection}>
        <Title level={5} className={styles.sectionSubtitle}>白名单域名</Title>
        <div className={styles.tagContainer}>
          {allowDomains.map((d) => (
            <Tag key={d} closable color="green" className={styles.domainTag}
                 onClose={() => setAllowDomains(allowDomains.filter((x) => x !== d))}>
              {d}
            </Tag>
          ))}
        </div>
        <Space.Compact className={styles.addInput}>
          <Input placeholder="如 api.trusted.com" value={newAllow}
                 onChange={(e) => setNewAllow(e.target.value)}
                 onPressEnter={() => { if (newAllow && !allowDomains.includes(newAllow)) { setAllowDomains([...allowDomains, newAllow]); setNewAllow('') } }} />
          <Button icon={<PlusOutlined />} disabled={!newAllow}
                  onClick={() => { if (!allowDomains.includes(newAllow)) { setAllowDomains([...allowDomains, newAllow]); setNewAllow('') } }}>
            添加
          </Button>
        </Space.Compact>
      </div>

      <Divider className={styles.settingDivider} />
      <div className={styles.settingSection}>
        <Space>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading}>保存更改</Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>重置为默认</Button>
        </Space>
      </div>
    </Form>
  )
}

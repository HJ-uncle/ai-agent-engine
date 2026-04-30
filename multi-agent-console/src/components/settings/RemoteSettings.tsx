import React from 'react'
import { Form, Input, Button, App, Space } from 'antd'
import styles from './SettingsLayout.module.css'

export default function RemoteSettings() {
  const { message } = App.useApp()
  const [form] = Form.useForm()

  const handleFinish = () => {
    message.success('正在测试连接...')
  }

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>远程主机配置</div>
        <div className={styles.card} style={{ padding: 24 }}>
          <Form 
            form={form} 
            layout="vertical" 
            onFinish={handleFinish}
            initialValues={{ port: '22', user: 'root' }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 16 }}>
              <Form.Item label="SSH 主机" name="host" required>
                <Input placeholder="例如: 192.168.1.100" />
              </Form.Item>
              <Form.Item label="端口" name="port">
                <Input placeholder="22" />
              </Form.Item>
            </div>
            
            <Form.Item label="用户名" name="user">
              <Input placeholder="root" />
            </Form.Item>
            
            <Form.Item label="私钥路径或密码" name="auth">
              <Input.Password placeholder="~/.ssh/id_rsa" />
            </Form.Item>

            <Space style={{ marginTop: 8 }}>
              <Button type="primary" htmlType="submit">
                测试连接并挂载
              </Button>
              <Button ghost>保存配置</Button>
            </Space>
          </Form>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>连接状态</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>当前状态</div>
              <div className={styles.itemDescription}>未连接到远程主机</div>
            </div>
            <div className={styles.itemControls}>
              <div className={styles.controlRow}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-label-tertiary)', marginRight: 8 }} />
                <span style={{ color: 'var(--color-label-tertiary)', fontSize: 12 }}>离线</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

import React from 'react'
import { Form, Input, Button, App } from 'antd'
import styles from './SettingsLayout.module.css'

export default function WorkspaceSettings() {
  const { message } = App.useApp()
  const [form] = Form.useForm()

  const handleFinish = () => {
    message.success('工作区设置已保存')
  }

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>本地工作区</div>
        <div className={styles.card}>
          <div className={styles.settingItem} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 16 }}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>项目根目录</div>
              <div className={styles.itemDescription}>
                请输入本地机器上的绝对路径，Agent 将挂载此目录作为工作区进行操作。
              </div>
            </div>
            <Form 
              form={form} 
              layout="vertical" 
              onFinish={handleFinish} 
              style={{ width: '100%' }}
            >
              <Form.Item name="path" style={{ marginBottom: 12 }}>
                <Input 
                  placeholder="/Users/username/my-project" 
                  style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc' }}
                />
              </Form.Item>
              <Button type="primary" htmlType="submit">
                打开并重新加载
              </Button>
            </Form>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>安全限制</div>
        <div className={styles.card}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>只读模式</div>
              <div className={styles.itemDescription}>禁止 Agent 修改工作区中的任何文件</div>
            </div>
            <div className={styles.itemControls}>
              <div className={styles.controlRow}>
                <span className={styles.controlLabel}>可选</span>
                <Input value="已禁用" disabled size="small" style={{ width: 80, textAlign: 'center' }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

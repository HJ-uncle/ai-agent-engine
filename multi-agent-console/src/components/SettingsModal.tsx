import React from 'react'
import { Modal, Tabs, Input, Button, Form, message } from 'antd'
import { useSessionStore } from '../store/session'

export default function SettingsModal() {
  const { isSettingsOpen, settingsTab, closeSettings, openSettings } = useSessionStore()

  const handleFinish = () => {
    message.success('设置已保存')
    closeSettings()
  }

  const items = [
    {
      key: 'general',
      label: '常规设置',
      children: (
        <div style={{ paddingTop: 16, color: '#ccc' }}>
          <Form layout="vertical">
            <Form.Item label="显示语言">
              <Input value="中文 (简体)" disabled style={{ color: '#888' }} />
            </Form.Item>
            <Form.Item label="主题">
              <Input value="VS Code Dark+" disabled style={{ color: '#888' }} />
            </Form.Item>
          </Form>
        </div>
      ),
    },
    {
      key: 'workspace',
      label: '工作区',
      children: (
        <div style={{ paddingTop: 16 }}>
          <Form layout="vertical" onFinish={handleFinish}>
            <Form.Item label="打开本地文件夹" extra="请输入本地机器上的绝对路径，Agent 将挂载此目录作为工作区">
              <Input placeholder="/Users/username/my-project" />
            </Form.Item>
            <Button type="primary" htmlType="submit" style={{ marginTop: 8 }}>
              打开并重新加载
            </Button>
          </Form>
        </div>
      ),
    },
    {
      key: 'remote',
      label: '远程主机',
      children: (
        <div style={{ paddingTop: 16 }}>
          <Form layout="vertical" onFinish={handleFinish}>
            <Form.Item label="SSH 主机" required>
              <Input placeholder="例如: 192.168.1.100" />
            </Form.Item>
            <Form.Item label="端口">
              <Input placeholder="22" defaultValue="22" />
            </Form.Item>
            <Form.Item label="用户名">
              <Input placeholder="root" />
            </Form.Item>
            <Form.Item label="私钥路径或密码">
              <Input.Password placeholder="~/.ssh/id_rsa" />
            </Form.Item>
            <Button type="primary" htmlType="submit" style={{ marginTop: 8 }}>
              测试连接并挂载
            </Button>
          </Form>
        </div>
      ),
    }
  ]

  return (
    <Modal
      title="设置"
      open={isSettingsOpen}
      onCancel={closeSettings}
      footer={null}
      width={600}
      bodyStyle={{ minHeight: 300 }}
    >
      <Tabs 
        activeKey={settingsTab} 
        onChange={(k) => openSettings(k)} 
        items={items} 
        tabPosition="left"
        style={{ marginTop: 16 }}
      />
    </Modal>
  )
}

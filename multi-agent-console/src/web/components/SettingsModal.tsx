import React from 'react'
import { Modal, Tabs, ConfigProvider, theme } from 'antd'
import {
  SettingOutlined,
  SafetyCertificateOutlined,
  FolderOpenOutlined,
  CloudServerOutlined,
  UserOutlined,
  RobotOutlined,
  ApiOutlined,
  MessageOutlined,
  CodeOutlined,
  BulbOutlined,
  InfoCircleOutlined,
  DatabaseOutlined,
  AuditOutlined,
  GlobalOutlined,
  ThunderboltOutlined,
  BugOutlined,
} from '@ant-design/icons'
import { useSessionStore } from '@core/store/session'
import GeneralSettings from './settings/GeneralSettings'
import WhitelistManager from './settings/WhitelistManager'
import WebFetchSettings from './settings/WebFetchSettings'
import WorkspaceSettings from './settings/WorkspaceSettings'
import RemoteSettings from './settings/RemoteSettings'
import ModelSettings from './settings/ModelSettings'
import AgentSettings from './settings/AgentSettings'
import ChatFlowSettings from './settings/ChatFlowSettings'
import SkillSettings from './settings/SkillSettings'
import SystemSettings from './settings/SystemSettings'
import McpSettings from './settings/McpSettings'
import SecurityPolicySettings from './settings/SecurityPolicySettings'
import NetworkPolicySettings from './settings/NetworkPolicySettings'
import AuditLogViewer from './settings/AuditLogViewer'
import LspSettings from './settings/LspSettings'
import PerformanceSettings from './settings/PerformanceSettings'
import DeepSeekSettings from './settings/DeepSeekSettings'
import styles from './settings/SettingsLayout.module.css'

export default function SettingsModal() {
  const { isSettingsOpen, settingsTab, closeSettings, openSettings } = useSessionStore()

  const items = [
    {
      key: 'account',
      label: (
        <span>
          <UserOutlined />
          <span style={{ marginLeft: 8 }}>账号</span>
        </span>
      ),
      children: <div className={styles.settingsContainer}><div className={styles.sectionTitle}>账号设置 (即将推出)</div></div>,
    },
    {
      key: 'general',
      label: (
        <span>
          <SettingOutlined />
          <span style={{ marginLeft: 8 }}>通用</span>
        </span>
      ),
      children: <GeneralSettings />,
    },
    {
      key: 'model',
      label: (
        <span>
          <BulbOutlined />
          <span style={{ marginLeft: 8 }}>模型</span>
        </span>
      ),
      children: <ModelSettings />,
    },
    {
      key: 'deepseek',
      label: (
        <span>
          <span style={{ marginRight: 6, fontSize: 14 }}>🐋</span>
          <span>DeepSeek</span>
        </span>
      ),
      children: <DeepSeekSettings />,
    },
    {
      key: 'workspace',
      label: (
        <span>
          <FolderOpenOutlined />
          <span style={{ marginLeft: 8 }}>开发环境</span>
        </span>
      ),
      children: <WorkspaceSettings />,
    },
    {
      key: 'agent',
      label: (
        <span>
          <RobotOutlined />
          <span style={{ marginLeft: 8 }}>智能体</span>
        </span>
      ),
      children: <AgentSettings />,
    },
    {
      key: 'skills',
      label: (
        <span>
          <CodeOutlined />
          <span style={{ marginLeft: 8 }}>技能</span>
        </span>
      ),
      children: <SkillSettings />,
    },
    {
      key: 'system',
      label: (
        <span>
          <DatabaseOutlined />
          <span style={{ marginLeft: 8 }}>系统</span>
        </span>
      ),
      children: <SystemSettings />,
    },
    {
      key: 'mcp',
      label: (
        <span>
          <ApiOutlined />
          <span style={{ marginLeft: 8 }}>MCP</span>
        </span>
      ),
      children: <McpSettings />,
    },
    {
      key: 'chatflow',
      label: (
        <span>
          <MessageOutlined />
          <span style={{ marginLeft: 8 }}>对话流</span>
        </span>
      ),
      children: <ChatFlowSettings />,
    },
    {
      key: 'whitelist',
      label: (
        <span>
          <SafetyCertificateOutlined />
          <span style={{ marginLeft: 8 }}>命令白名单</span>
        </span>
      ),
      children: <WhitelistManager />,
    },
    {
      key: 'security-policy',
      label: (
        <span>
          <SafetyCertificateOutlined />
          <span style={{ marginLeft: 8 }}>安全策略</span>
        </span>
      ),
      children: <SecurityPolicySettings />,
    },
    {
      key: 'network-policy',
      label: (
        <span>
          <GlobalOutlined />
          <span style={{ marginLeft: 8 }}>网络策略</span>
        </span>
      ),
      children: <NetworkPolicySettings />,
    },
    {
      key: 'audit-log',
      label: (
        <span>
          <AuditOutlined />
          <span style={{ marginLeft: 8 }}>审计日志</span>
        </span>
      ),
      children: <AuditLogViewer />,
    },
    {
      key: 'lsp',
      label: (
        <span>
          <BugOutlined />
          <span style={{ marginLeft: 8 }}>代码诊断</span>
        </span>
      ),
      children: <LspSettings />,
    },
    {
      key: 'performance',
      label: (
        <span>
          <ThunderboltOutlined />
          <span style={{ marginLeft: 8 }}>性能</span>
        </span>
      ),
      children: <PerformanceSettings />,
    },
    {
      key: 'webfetch',
      label: (
        <span>
          <CloudServerOutlined />
          <span style={{ marginLeft: 8 }}>Web Fetch</span>
        </span>
      ),
      children: <WebFetchSettings />,
    },
    {
      key: 'remote',
      label: (
        <span>
          <CloudServerOutlined />
          <span style={{ marginLeft: 8 }}>远程主机</span>
        </span>
      ),
      children: <RemoteSettings />,
    },
    // {
    //   key: 'beta',
    //   label: (
    //     <span>
    //       <ThunderboltOutlined />
    //       <span style={{ marginLeft: 8 }}>Beta</span>
    //     </span>
    //   ),
    //   children: <div className={styles.settingsContainer}><div className={styles.sectionTitle}>Beta 功能 (即将推出)</div></div>,
    // },
    {
      key: 'about',
      label: (
        <span>
          <InfoCircleOutlined />
          <span style={{ marginLeft: 8 }}>关于 Agent Console</span>
        </span>
      ),
      children: <div className={styles.settingsContainer}><div className={styles.sectionTitle}>版本信息: v1.0.0</div></div>,
    },
  ]

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#007acc',
          borderRadius: 6,
          colorBgContainer: '#1e1e1e',
          colorBgElevated: '#252526',
        },
      }}
    >
      <Modal
        title={null}
        open={isSettingsOpen}
        onCancel={closeSettings}
        footer={null}
        width={1000}
        styles={{
          body: { padding: 0, height: '70vh', overflow: 'hidden' },
          mask: { backdropFilter: 'blur(4px)' },
        }}
        centered
        destroyOnHidden
      >
        <div style={{ display: 'flex', flexDirection: 'row', height: '100%' }}>
          <div style={{ flex: 1, height: '100%', overflow: 'hidden' }}>
            <Tabs
              activeKey={settingsTab || 'general'}
              onChange={(k) => openSettings(k)}
              items={items}
              tabPlacement="start"
              className={`${styles.settingsTabs} settings-modal-tabs`}
              style={{ height: '100%' }}
            />
          </div>
        </div>
      </Modal>
    </ConfigProvider>
  )
}

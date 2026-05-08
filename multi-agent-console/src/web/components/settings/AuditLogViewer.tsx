import React, { useEffect, useState, useCallback } from 'react'
import { App, Button, Select, Space, Table, Tag, Typography, Modal, InputNumber } from 'antd'
import { ReloadOutlined, DeleteOutlined } from '@ant-design/icons'
import { securityApi, type AuditEntry } from '@core/api'
import styles from './SettingsLayout.module.css'

const { Title, Text } = Typography

const DECISION_COLOR: Record<string, string> = {
  allow: 'green', ask: 'gold', deny: 'red', error: 'magenta',
}
const CAT_COLOR: Record<string, string> = {
  cmd: 'blue', network: 'cyan', fs: 'purple', lsp: 'geekblue',
}

export default function AuditLogViewer() {
  const { message, modal } = App.useApp()
  const [list, setList] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [category, setCategory] = useState<string | undefined>()
  const [decision, setDecision] = useState<string | undefined>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { list, total } = await securityApi.listAuditLog({ current, pageSize, category, decision })
      setList(list)
      setTotal(total)
    } catch (e: any) {
      message.error(`加载失败: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [current, pageSize, category, decision, message])

  useEffect(() => { load() }, [load])

  const handlePurge = () => {
    let days = 30
    modal.confirm({
      title: '清理旧审计日志',
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>删除多少天之前的记录？</div>
          <InputNumber min={1} max={365} defaultValue={30} onChange={(v) => { if (v) days = v }} />
        </div>
      ),
      okText: '确认清理',
      cancelText: '取消',
      onOk: async () => {
        const res = await securityApi.purgeAuditLog(days)
        message.success(`已清理 ${res?.removed ?? 0} 条记录`)
        load()
      },
    })
  }

  const columns = [
    {
      title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 170,
      render: (v: number) => new Date(v * 1000).toLocaleString(),
    },
    {
      title: '类别', dataIndex: 'category', key: 'category', width: 80,
      render: (v: string) => <Tag color={CAT_COLOR[v]}>{v}</Tag>,
    },
    {
      title: '决策', dataIndex: 'decision', key: 'decision', width: 80,
      render: (v: string) => <Tag color={DECISION_COLOR[v]}>{v.toUpperCase()}</Tag>,
    },
    { title: '目标', dataIndex: 'target', key: 'target', ellipsis: true },
    { title: '原因', dataIndex: 'reason', key: 'reason', ellipsis: true, width: 220 },
    {
      title: '详情', dataIndex: 'details', key: 'details', width: 80,
      render: (v: any) => v
        ? <Button type="link" size="small" onClick={() => Modal.info({
            title: '审计详情',
            width: 600,
            content: <pre style={{ background: '#1e1e1e', padding: 12, color: '#ccc', maxHeight: 400, overflow: 'auto' }}>{JSON.stringify(v, null, 2)}</pre>,
          })}>查看</Button>
        : '—',
    },
  ]

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <Title level={4} className={styles.sectionTitle}>安全审计日志</Title>
        <Text type="secondary" className={styles.sectionDescription}>
          记录所有命令执行、网络访问、LSP 诊断等安全相关操作。
        </Text>
        <div className={styles.card} style={{ padding: 16 }}>
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <Space wrap>
              <Select placeholder="类别" allowClear style={{ width: 140 }} value={category} onChange={(v) => { setCategory(v); setCurrent(1) }}>
                <Select.Option value="cmd">命令</Select.Option>
                <Select.Option value="network">网络</Select.Option>
                <Select.Option value="fs">文件</Select.Option>
                <Select.Option value="lsp">LSP</Select.Option>
              </Select>
              <Select placeholder="决策" allowClear style={{ width: 140 }} value={decision} onChange={(v) => { setDecision(v); setCurrent(1) }}>
                <Select.Option value="allow">ALLOW</Select.Option>
                <Select.Option value="ask">ASK</Select.Option>
                <Select.Option value="deny">DENY</Select.Option>
                <Select.Option value="error">ERROR</Select.Option>
              </Select>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            </Space>
            <Button danger icon={<DeleteOutlined />} onClick={handlePurge}>清理旧日志</Button>
          </div>
          <Table<AuditEntry>
            rowKey="id"
            size="small"
            columns={columns as any}
            dataSource={list}
            loading={loading}
            pagination={{
              current, pageSize, total, size: 'small',
              showSizeChanger: true,
              onChange: (c, s) => { setCurrent(c); setPageSize(s) },
            }}
          />
        </div>
      </div>
    </div>
  )
}

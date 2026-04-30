import React, { useCallback, useEffect, useState } from 'react'
import {
  Table, Button, Switch, Tag, Space, Modal, Form, Input, Select,
  Popconfirm, App, Tooltip, Divider
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, EditOutlined,
  ApiOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined,
} from '@ant-design/icons'
import { mcpApi } from '../../api'
import type { McpServer, CreateMcpServerInput } from '../../types'
import styles from './SettingsLayout.module.css'

const TRANSPORT_OPTIONS = [
  { value: 'http',          label: 'HTTP (REST)' },
  { value: 'streamableHttp',label: 'Streamable HTTP (JSON-RPC)' },
  { value: 'sse',           label: 'SSE' },
  { value: 'stdio',         label: 'stdio（暂不支持）', disabled: true },
]

const TRANSPORT_COLOR: Record<string, string> = {
  http: 'blue', streamableHttp: 'purple', sse: 'cyan', stdio: 'default',
}

interface TestResult {
  success: boolean
  toolCount?: number
  tools?: { name: string; description: string }[]
  error?: string
}

export default function McpSettings() {
  const { message } = App.useApp()
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({})
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { list } = await mcpApi.list({ pageSize: 100 })
      setServers(list)
    } catch (e: any) {
      message.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { load() }, [load])

  // ── 新增 / 编辑 ──────────────────────────────────────────────────────────────
  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ transportType: 'streamableHttp', enabled: true })
    setModalOpen(true)
  }

  const openEdit = (record: McpServer) => {
    setEditing(record)
    form.setFieldsValue({
      ...record,
      env: record.env ? JSON.stringify(record.env, null, 2) : '',
      headers: record.headers ? JSON.stringify(record.headers, null, 2) : '',
      args: record.args?.join(' ') ?? '',
    })
    setModalOpen(true)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()

      // 转换 env / headers / args
      const payload: any = { ...values }
      try { payload.env = values.env ? JSON.parse(values.env) : undefined } catch { payload.env = undefined }
      try { payload.headers = values.headers ? JSON.parse(values.headers) : undefined } catch { payload.headers = undefined }
      payload.args = values.args ? values.args.split(/\s+/).filter(Boolean) : undefined

      if (editing) {
        await mcpApi.update(editing.id, payload)
        message.success('更新成功')
      } else {
        await mcpApi.create(payload as CreateMcpServerInput)
        message.success('添加成功')
      }
      setModalOpen(false)
      load()
    } catch (e: any) {
      if (e.message) message.error(e.message)
    }
  }

  // ── 启用 / 禁用 ──────────────────────────────────────────────────────────────
  const handleToggle = async (record: McpServer, enabled: boolean) => {
    try {
      enabled ? await mcpApi.enable(record.id) : await mcpApi.disable(record.id)
      setServers((prev) => prev.map((s) => s.id === record.id ? { ...s, enabled } : s))
    } catch (e: any) {
      message.error(e.message || '操作失败')
    }
  }

  // ── 删除 ─────────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    try {
      await mcpApi.delete(id)
      message.success('删除成功')
      load()
    } catch (e: any) {
      message.error(e.message || '删除失败')
    }
  }

  // ── 测试连接 ─────────────────────────────────────────────────────────────────
  const handleTest = async (record: McpServer) => {
    setTesting(record.id)
    try {
      const res = await mcpApi.test(record.id) as any
      setTestResult((prev) => ({
        ...prev,
        [record.id]: { success: true, toolCount: res.toolCount, tools: res.tools },
      }))
      message.success(`连接成功，发现 ${res.toolCount} 个工具`)
    } catch (e: any) {
      setTestResult((prev) => ({
        ...prev,
        [record.id]: { success: false, error: e.message },
      }))
      message.error(`连接失败: ${e.message}`)
    } finally {
      setTesting(null)
    }
  }

  // ── 表格列 ───────────────────────────────────────────────────────────────────
  const transportType = Form.useWatch('transportType', form)

  const columns = [
    {
      title: '状态',
      width: 56,
      render: (_: any, r: McpServer) => (
        <Switch size="small" checked={r.enabled} onChange={(v) => handleToggle(r, v)} />
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 160,
      render: (text: string, r: McpServer) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--color-label)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {text}
          </div>
          {r.description && (
            <div style={{ color: 'var(--color-label-tertiary)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {r.description}
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'ID',
      dataIndex: 'id',
      width: 160,
      render: (v: string) => (
        <Tooltip title={v}>
          <code style={{
            background: 'var(--color-fill)', padding: '1px 6px', borderRadius: 'var(--radius-xs)',
            fontSize: 12, color: 'var(--color-teal)',
            display: 'inline-block', maxWidth: 140,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {v}
          </code>
        </Tooltip>
      ),
    },
    {
      title: '传输类型',
      dataIndex: 'transportType',
      width: 130,
      render: (v: string) => <Tag color={TRANSPORT_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: 'URL / 命令',
      ellipsis: { showTitle: false },
      render: (_: any, r: McpServer) => (
        <Tooltip title={r.url || r.command}>
          <span style={{ color: 'var(--color-label-secondary)', fontSize: 12 }}>{r.url || r.command || '—'}</span>
        </Tooltip>
      ),
    },
    {
      title: '测试',
      width: 110,
      render: (_: any, r: McpServer) => {
        const res = testResult[r.id]
        return (
          <Space size={4}>
            <Button
              size="small"
              icon={testing === r.id ? <SyncOutlined spin /> : <ApiOutlined />}
              onClick={() => handleTest(r)}
              disabled={testing !== null}
            >
              测试
            </Button>
            {res && (
              <Tooltip title={res.success
                ? `${res.toolCount} 个工具: ${res.tools?.map(t => t.name).join(', ')}`
                : res.error}>
                {res.success
                  ? <CheckCircleOutlined style={{ color: 'var(--color-green)' }} />
                  : <CloseCircleOutlined style={{ color: 'var(--color-red)' }} />}
              </Tooltip>
            )}
          </Space>
        )
      },
    },
    {
      title: '操作',
      width: 72,
      render: (_: any, r: McpServer) => (
        <Space size={2}>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          <Popconfirm
            title={`确定删除 "${r.name}" 吗？`}
            onConfirm={() => handleDelete(r.id)}
            okText="删除" cancelText="取消"
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div className={styles.sectionTitle} style={{ margin: 0 }}>MCP 服务器管理</div>
            <div style={{ color: 'var(--color-label-tertiary)', fontSize: 12, marginTop: 4 }}>
              配置外部 MCP (Model Context Protocol) 服务器，Agent 将自动注册其提供的工具
            </div>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>添加服务器</Button>
        </div>

        <div className={styles.card} style={{ padding: 0, overflow: 'hidden' }}>
          <Table
            dataSource={servers}
            columns={columns}
            rowKey="id"
            loading={loading}
            pagination={false}
            size="small"
            locale={{ emptyText: '暂无 MCP 服务器，点击「添加服务器」进行配置' }}
          />
        </div>
      </div>

      {/* ── 新增 / 编辑 Modal ── */}
      <Modal
        title={editing ? `编辑 MCP 服务器 — ${editing.name}` : '添加 MCP 服务器'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        okText={editing ? '保存' : '添加'}
        cancelText="取消"
        width={600}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          {!editing && (
            <Form.Item
              name="id"
              label="服务器 ID"
              rules={[
                { required: true, message: '请输入 ID' },
                { pattern: /^[a-z0-9][a-z0-9-_]*$/, message: '只能包含小写字母、数字、连字符、下划线' },
              ]}
              extra="唯一标识符，创建后不可修改，例如: my-mcp-server"
            >
              <Input placeholder="my-mcp-server" />
            </Form.Item>
          )}

          <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="我的 MCP 服务器" />
          </Form.Item>

          <Form.Item name="description" label="描述（可选）">
            <Input placeholder="简要说明此服务器提供的功能" />
          </Form.Item>

          <Form.Item name="transportType" label="传输类型" rules={[{ required: true }]}>
            <Select options={TRANSPORT_OPTIONS} />
          </Form.Item>

          {transportType !== 'stdio' ? (
            <Form.Item
              name="url"
              label="服务器 URL"
              rules={[{ required: true, message: '请输入 URL' }]}
            >
              <Input placeholder="https://your-mcp-server.com/mcp" />
            </Form.Item>
          ) : (
            <>
              <Form.Item name="command" label="命令" rules={[{ required: true }]}>
                <Input placeholder="/usr/bin/python3" />
              </Form.Item>
              <Form.Item name="args" label="参数（空格分隔）">
                <Input placeholder="server.py --port 8080" />
              </Form.Item>
            </>
          )}

          <Form.Item
            name="headers"
            label="请求头（JSON，可选）"
            extra='例如: {"Authorization": "Bearer sk-xxx"}'
          >
            <Input.TextArea
              rows={3}
              placeholder='{"Authorization": "Bearer sk-xxx"}'
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </Form.Item>

          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Divider style={{ borderColor: 'var(--color-separator)' }} />

          <Form.Item
            name="env"
            label="环境变量（JSON，stdio 专用，可选）"
          >
            <Input.TextArea
              rows={3}
              placeholder='{"MY_VAR": "value"}'
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

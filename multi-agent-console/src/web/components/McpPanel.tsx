import React, { useState, useEffect, useCallback } from 'react'
import {
  Button, Input, Tag, Tooltip, Popconfirm, Modal, Form, Switch,
  Spin, Radio, message as antMsg,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined,
  EditOutlined, StopOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  ApiOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { mcpApi } from '@core/api'
import type { McpServer, CreateMcpServerInput } from '@core/types'
import styles from './McpPanel.module.css'

// ── Status badge ───────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status?: McpServer['status'] }) {
  const map: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    running:  { color: '#3fb950', icon: <CheckCircleOutlined />, label: '运行中' },
    stopped:  { color: '#8b949e', icon: <StopOutlined />,        label: '已停止' },
    error:    { color: '#f85149', icon: <CloseCircleOutlined />, label: '错误'   },
    unknown:  { color: '#d29922', icon: <ApiOutlined />,         label: '未知'   },
  }
  const s = map[status ?? 'unknown'] ?? map.unknown
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: s.color, fontSize: 12 }}>
      {s.icon} {s.label}
    </span>
  )
}

// ── MCP Form Modal ─────────────────────────────────────────────────────────────
function McpFormModal({
  open, editing, onClose, onSaved,
}: {
  open: boolean
  editing?: McpServer | null
  onClose: () => void
  onSaved: (s: McpServer) => void
}) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      if (editing) {
        form.setFieldsValue({
          name: editing.name,
          command: editing.command,
          args: editing.args?.join(' ') ?? '',
          enabled: editing.enabled ?? true,
          envJson: editing.env ? JSON.stringify(editing.env, null, 2) : '',
        })
      } else {
        form.resetFields()
        form.setFieldsValue({ enabled: true, scope: 'project' })
      }
    }
  }, [open, editing, form])

  const submit = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      const input: CreateMcpServerInput = {
        id: values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        name: values.name,
        description: '',
        transportType: 'stdio',
        command: values.command,
        args: values.args ? values.args.trim().split(/\s+/) : [],
        enabled: values.enabled ?? true,
        env: values.envJson ? JSON.parse(values.envJson) : undefined,
        isBuiltIn: false,
        scope: editing ? undefined : (values.scope ?? 'project'),
      }
      let server: McpServer
      if (editing) {
        server = await mcpApi.update(editing.id, input)
      } else {
        server = await mcpApi.create(input)
      }
      antMsg.success(editing ? '已更新' : '已创建')
      onSaved(server)
    } catch (err: any) {
      if (err?.errorFields) return
      antMsg.error(err.message ?? '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={editing ? '编辑 MCP Server' : '添加 MCP Server'}
      open={open} onCancel={onClose} onOk={submit}
      okText={editing ? '保存' : '添加'} confirmLoading={loading} width={560}
    >
      <Form form={form} layout="vertical" size="small">
        {!editing && (
          <Form.Item name="scope" label="保存层级" initialValue="project">
            <Radio.Group>
              <Radio.Button value="project">项目级</Radio.Button>
              <Radio.Button value="global">全局级</Radio.Button>
            </Radio.Group>
          </Form.Item>
        )}
        {editing?.scope === 'global' && (
          <div style={{ marginBottom: 12, fontSize: 12, color: '#d29922' }}>
            该 Server 定义在全局层（~/.aether/mcp.json）。保存后将在项目级创建覆盖副本，全局定义保持不变。
          </div>
        )}
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input placeholder="例如：my-mcp-server" />
        </Form.Item>
        <Form.Item name="command" label="命令" rules={[{ required: true }]}>
          <Input placeholder="例如：node /path/to/server.js" />
        </Form.Item>
        <Form.Item name="args" label="参数（空格分隔）">
          <Input placeholder="--port 3001 --debug" />
        </Form.Item>
        <Form.Item name="envJson" label="环境变量 (JSON)">
          <Input.TextArea
            placeholder='{"API_KEY": "xxx"}'
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
        </Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ── MCP Server Card ────────────────────────────────────────────────────────────
function McpCard({
  server, onEdit, onDelete, onToggle, onTest,
}: {
  server: McpServer
  onEdit: (s: McpServer) => void
  onDelete: (s: McpServer) => void
  onToggle: (s: McpServer) => void
  onTest: (s: McpServer) => void
}) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <ApiOutlined className={styles.icon} />
        <div className={styles.info}>
          <div className={styles.name}>
            {server.name}
            {server.scope === 'global' && (
              <Tooltip title="全局 MCP Server（~/.aether/mcp.json），对所有项目生效">
                <span style={{ fontSize: 10, color: '#58a6ff', background: 'rgba(88,166,255,0.12)', padding: '1px 6px', borderRadius: 4, marginLeft: 6, verticalAlign: 'middle' }}>全局</span>
              </Tooltip>
            )}
          </div>
          <div className={styles.cmd}>{server.command}{server.args?.length ? ' ' + server.args.join(' ') : ''}</div>
        </div>
        <div className={styles.meta}>
          <StatusBadge status={server.status} />
          {server.toolCount != null && (
            <Tag color="blue" style={{ marginLeft: 6, fontSize: 10 }}>{server.toolCount} tools</Tag>
          )}
        </div>
      </div>
      <div className={styles.cardActions}>
        <Tooltip title={server.enabled ? '禁用' : '启用'}>
          <Switch size="small" checked={server.enabled} onChange={() => onToggle(server)} />
        </Tooltip>
        <Tooltip title="测试连接">
          <Button type="text" size="small" icon={<ThunderboltOutlined />} className={styles.btn} onClick={() => onTest(server)} />
        </Tooltip>
        <Tooltip title="编辑">
          <Button type="text" size="small" icon={<EditOutlined />} className={styles.btn} onClick={() => onEdit(server)} />
        </Tooltip>
        <Popconfirm
          title={server.scope === 'global' ? `删除全局 Server "${server.name}"？` : `删除 "${server.name}"？`}
          description={server.scope === 'global' ? '将从 ~/.aether/mcp.json 删除，影响所有项目' : undefined}
          onConfirm={() => onDelete(server)}
          okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
        >
          <Button type="text" size="small" icon={<DeleteOutlined />} className={`${styles.btn} ${styles.danger}`} />
        </Popconfirm>
      </div>
    </div>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────────
export default function McpPanel() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<McpServer | null>(null)

  const fetchServers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await mcpApi.list()
      setServers(res.list)
    } catch (err: any) {
      antMsg.error(err.message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchServers() }, [fetchServers])

  const handleDelete = async (server: McpServer) => {
    try {
      await mcpApi.delete(server.id, server.scope)
      setServers((s) => s.filter((x) => x.id !== server.id))
      antMsg.success('已删除')
    } catch (err: any) { antMsg.error(err.message) }
  }

  const handleToggle = async (server: McpServer) => {
    try {
      const updated = server.enabled
        ? await mcpApi.disable(server.id, server.scope)
        : await mcpApi.enable(server.id, server.scope)
      setServers((s) => s.map((x) => x.id === server.id ? { ...x, ...updated } : x))
    } catch (err: any) { antMsg.error(err.message) }
  }

  const handleTest = async (server: McpServer) => {
    try {
      const res = await mcpApi.test(server.id, { scope: server.scope })
      if (res?.success) {
        antMsg.success(`连接成功，发现 ${res.toolCount ?? 0} 个工具`)
      } else {
        antMsg.warning('连接测试失败')
      }
    } catch (err: any) { antMsg.error(err.message) }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>MCP Servers</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Tooltip title="刷新">
            <Button type="text" size="small" icon={<ReloadOutlined />} className={styles.headerBtn} onClick={fetchServers} loading={loading} />
          </Tooltip>
          <Tooltip title="添加">
            <Button type="text" size="small" icon={<PlusOutlined />} className={styles.headerBtn} onClick={() => { setEditing(null); setModalOpen(true) }} />
          </Tooltip>
        </div>
      </div>
      <div className={styles.list}>
        {loading && servers.length === 0 ? (
          <div className={styles.empty}><Spin size="small" /></div>
        ) : servers.length === 0 ? (
          <div className={styles.empty}>
            <ApiOutlined style={{ fontSize: 28, opacity: 0.25 }} />
            <span>暂无 MCP Server</span>
          </div>
        ) : (
          servers.map((s) => (
            <McpCard
              key={s.id} server={s}
              onEdit={(sv) => { setEditing(sv); setModalOpen(true) }}
              onDelete={handleDelete}
              onToggle={handleToggle}
              onTest={handleTest}
            />
          ))
        )}
      </div>
      <McpFormModal
        open={modalOpen} editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={(sv) => {
          setServers((s) => {
            const exists = s.find((x) => x.id === sv.id)
            return exists ? s.map((x) => x.id === sv.id ? sv : x) : [sv, ...s]
          })
          setModalOpen(false)
        }}
      />
    </div>
  )
}

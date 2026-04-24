import React, { useState, useEffect, useCallback } from 'react'
import {
  Button, Input, Tag, Tooltip, Popconfirm, Modal, Form, Switch,
  Spin, Badge, message as antMsg, Select,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined,
  EditOutlined, PlayCircleOutlined, StopOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SyncOutlined,
  ApiOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { mcpApi } from '../api'
import type { McpServer, CreateMcpServerInput } from '../types'
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
        form.setFieldsValue({ enabled: true })
      }
    }
  }, [open, editing, form])

  const submit = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      const input: CreateMcpServerInput = {
        name: values.name,
        command: values.command,
        args: values.args ? values.args.trim().split(/\s+/) : [],
        enabled: values.enabled ?? true,
        env: values.envJson ? JSON.parse(values.envJson) : undefined,
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
  server, onEdit, onDelete, onToggle, onTest, onRestart,
}: {
  server: McpServer
  onEdit: (s: McpServer) => void
  onDelete: (id: string) => void
  onToggle: (s: McpServer) => void
  onTest: (s: McpServer) => void
  onRestart: (s: McpServer) => void
}) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <ApiOutlined className={styles.icon} />
        <div className={styles.info}>
          <div className={styles.name}>{server.name}</div>
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
        <Tooltip title="重启">
          <Button type="text" size="small" icon={<SyncOutlined />} className={styles.btn} onClick={() => onRestart(server)} />
        </Tooltip>
        <Tooltip title="编辑">
          <Button type="text" size="small" icon={<EditOutlined />} className={styles.btn} onClick={() => onEdit(server)} />
        </Tooltip>
        <Popconfirm title={`删除 "${server.name}"？`} onConfirm={() => onDelete(server.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
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

  const handleDelete = async (id: string) => {
    try {
      await mcpApi.delete(id)
      setServers((s) => s.filter((x) => x.id !== id))
      antMsg.success('已删除')
    } catch (err: any) { antMsg.error(err.message) }
  }

  const handleToggle = async (server: McpServer) => {
    try {
      const updated = server.enabled
        ? await mcpApi.disable(server.id)
        : await mcpApi.enable(server.id)
      setServers((s) => s.map((x) => x.id === server.id ? { ...x, ...updated } : x))
    } catch (err: any) { antMsg.error(err.message) }
  }

  const handleTest = async (server: McpServer) => {
    try {
      const res = await mcpApi.test(server.id)
      if (res?.success) {
        antMsg.success(`连接成功，发现 ${res.toolCount ?? 0} 个工具`)
      } else {
        antMsg.warning('连接测试失败')
      }
    } catch (err: any) { antMsg.error(err.message) }
  }

  const handleRestart = async (server: McpServer) => {
    try {
      await mcpApi.restart(server.name)
      antMsg.success('重启指令已发送')
      setTimeout(fetchServers, 1500)
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
              onRestart={handleRestart}
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

import React, { useEffect, useState, useCallback } from 'react'
import { Button, Table, Space, Tag, Modal, Form, Input, Select, InputNumber, Switch, Popconfirm, App, Tooltip, Alert } from 'antd'
import { PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { securityApi, type PolicyRule } from '@core/api'
import { useSessionStore } from '@core/store/session'
import styles from './SettingsLayout.module.css'

const ACTION_COLORS: Record<string, string> = {
  allow: 'green',
  ask: 'gold',
  deny: 'red',
}

const ACTION_LABELS: Record<string, string> = {
  allow: 'ALLOW',
  ask: 'ASK',
  deny: 'DENY',
}

const CODE_STYLE: React.CSSProperties = {
  background: '#2a2a2a',
  border: '1px solid #3d3d3d',
  color: '#ce9178',
  padding: '1px 6px',
  borderRadius: 3,
  fontSize: 12,
  fontFamily: 'Consolas, monospace',
  whiteSpace: 'nowrap' as const,
}

export default function SecurityPolicySettings() {
  const { message, modal } = App.useApp()
  const securityMode = useSessionStore((s) => s.securityMode)
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [loading, setLoading] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<PolicyRule | null>(null)
  const [form] = Form.useForm<PolicyRule>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { list } = await securityApi.listPolicies({ current: 1, pageSize: 500 })
      setRules(list)
    } catch (e: any) {
      message.error(`加载失败: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setEditOpen(true)
  }
  const openEdit = (r: PolicyRule) => {
    setEditing(r)
    setEditOpen(true)
  }

  useEffect(() => {
    if (!editOpen) return
    const timer = setTimeout(() => {
      if (editing) {
        form.setFieldsValue(editing as any)
      } else {
        form.resetFields()
        form.setFieldsValue({ action: 'ask', priority: 100, enabled: true } as any)
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [editOpen, editing, form])

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      if (editing?.id) {
        await securityApi.updatePolicy(editing.id, values)
        message.success('规则已更新')
      } else {
        await securityApi.createPolicy(values)
        message.success('规则已创建')
      }
      setEditOpen(false)
      load()
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(`保存失败: ${e.message}`)
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await securityApi.deletePolicy(id)
      message.success('规则已删除')
      load()
    } catch (e: any) {
      message.error(`删除失败: ${e.message}`)
    }
  }

  const handleReset = () => {
    modal.confirm({
      title: '确认恢复默认规则？',
      content: '当前所有自定义规则都会被清除，恢复为系统内置默认策略。',
      okText: '确认恢复',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await securityApi.resetPolicies()
          message.success('已恢复默认')
          load()
        } catch (e: any) {
          message.error(`重置失败: ${e.message}`)
        }
      },
    })
  }

  const columns = [
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 72,
      align: 'center' as const,
      sorter: (a: PolicyRule, b: PolicyRule) => a.priority - b.priority,
      render: (v: number) => <span style={{ color: '#888', fontSize: 12 }}>{v}</span>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 150,
      ellipsis: true,
      render: (v: string) => <span style={{ fontSize: 13 }}>{v}</span>,
    },
    {
      title: '命令',
      dataIndex: 'command',
      key: 'command',
      width: 100,
      render: (v: string) => <code style={CODE_STYLE}>{v}</code>,
    },
    {
      title: '参数正则',
      dataIndex: 'argPattern',
      key: 'argPattern',
      ellipsis: true,
      render: (v?: string | null) =>
        v ? (
          <Tooltip title={v}>
            <code style={{ ...CODE_STYLE, color: '#9cdcfe', maxWidth: 160, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle' }}>
              {v}
            </code>
          </Tooltip>
        ) : (
          <span style={{ color: '#444', fontSize: 12 }}>—</span>
        ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 82,
      align: 'center' as const,
      render: (v: string) => (
        <Tag color={ACTION_COLORS[v]} style={{ minWidth: 48, textAlign: 'center', margin: 0 }}>
          {ACTION_LABELS[v] ?? v}
        </Tag>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 60,
      align: 'center' as const,
      render: (v: boolean, r: PolicyRule) => (
        <Switch
          checked={v}
          size="small"
          onChange={async (checked) => {
            await securityApi.updatePolicy(r.id!, { enabled: checked })
            load()
          }}
        />
      ),
    },
    {
      title: '操作',
      key: 'op',
      width: 110,
      align: 'center' as const,
      render: (_: any, r: PolicyRule) => (
        <Space size={4}>
          <Tooltip title="编辑">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm
            title="确定删除该规则？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(r.id!)}
          >
            <Tooltip title="删除">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        {securityMode !== 'safe' && (
          <Alert
            type={securityMode === 'full-access' ? 'error' : 'info'}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              securityMode === 'full-access'
                ? '当前为「完全访问」模式 — 以下策略规则不生效，所有命令直接放行'
                : '当前为「标准」模式 — deny 规则仍生效，ask 规则自动放行无需确认'
            }
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>命令安全策略</div>
          <span style={{ color: '#555', fontSize: 11 }}>优先级越小越优先 · allow / ask / deny</span>
        </div>

        <div className={styles.card} style={{ padding: '12px 12px 0' }}>
          {/* 工具栏 */}
          <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
              新增规则
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            <Button size="small" danger onClick={handleReset}>恢复默认</Button>
          </div>

          {/* 表格：scroll 防止在容器内撑开 */}
          <Table<PolicyRule>
            rowKey="id"
            columns={columns as any}
            dataSource={rules}
            loading={loading}
            size="small"
            tableLayout="fixed"
            scroll={{ x: 640 }}
            pagination={{
              pageSize: 10,
              size: 'small',
              showTotal: (t) => `共 ${t} 条`,
              style: { padding: '8px 0' },
            }}
          />
        </div>
      </div>

      {/* 编辑 / 新增 Modal */}
      <Modal
        title={editing ? '编辑策略规则' : '新增策略规则'}
        open={editOpen}
        onOk={handleSave}
        onCancel={() => setEditOpen(false)}
        destroyOnHidden
        width={520}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" preserve={false} style={{ paddingTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入名称' }]}>
              <Input placeholder="如 ask-git-force-push" />
            </Form.Item>
            <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入命令' }]}
              tooltip="* 匹配所有命令">
              <Input placeholder="如 rm / git / *" />
            </Form.Item>
          </div>

          <Form.Item name="argPattern" label="参数正则（可选）"
            tooltip="将所有参数用空格 join 后，用此正则匹配整体字符串">
            <Input placeholder="如 --force|--no-verify" style={{ fontFamily: 'Consolas, monospace' }} />
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 80px', gap: '0 12px', alignItems: 'start' }}>
            <Form.Item name="action" label="动作" rules={[{ required: true }]}>
              <Select>
                <Select.Option value="allow">
                  <Tag color="green" style={{ marginRight: 4 }}>ALLOW</Tag>直接放行
                </Select.Option>
                <Select.Option value="ask">
                  <Tag color="gold" style={{ marginRight: 4 }}>ASK</Tag>询问用户确认
                </Select.Option>
                <Select.Option value="deny">
                  <Tag color="red" style={{ marginRight: 4 }}>DENY</Tag>直接拒绝
                </Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="priority" label="优先级" tooltip="数字越小越优先，默认 100">
              <InputNumber min={1} max={9999} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>

          <Form.Item name="description" label="描述" style={{ marginBottom: 0 }}>
            <Input.TextArea rows={2} placeholder="可选，方便团队理解规则意图" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

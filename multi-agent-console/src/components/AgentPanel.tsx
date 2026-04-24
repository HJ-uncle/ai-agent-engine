import React, { useState, useEffect } from 'react'
import {
  Button, Input, Tooltip, Popconfirm, Modal,
  Form, Select, Slider, Tag, Spin, message as antMsg
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  RobotOutlined, ReloadOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { agentApi } from '../api'
import { useAgentStore } from '../store/agents'
import { useSessionStore } from '../store/session'
import type { Agent, CreateAgentInput } from '../types'
import styles from './AgentPanel.module.css'

const MODEL_OPTIONS = [
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
]

// ── Agent Card ─────────────────────────────────────────────────────────────────
function AgentCard({
  agent,
  onEdit,
  onDelete,
  onChat,
}: {
  agent: Agent
  onEdit: (a: Agent) => void
  onDelete: (id: string) => void
  onChat: (id: string) => void
}) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <div className={styles.cardAvatar}>
          <RobotOutlined />
        </div>
        <div className={styles.cardInfo}>
          <div className={styles.cardName}>{agent.name}</div>
          {agent.model && (
            <Tag color="blue" className={styles.modelTag}>{agent.model}</Tag>
          )}
        </div>
        <div className={styles.cardActions}>
          <Tooltip title="开始对话">
            <Button type="text" size="small" icon={<ThunderboltOutlined />} className={styles.actionBtn} onClick={() => onChat(agent.id)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} className={styles.actionBtn} onClick={() => onEdit(agent)} />
          </Tooltip>
          <Popconfirm title={`删除 Agent "${agent.name}"？`} onConfirm={() => onDelete(agent.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
            <Tooltip title="删除">
              <Button type="text" size="small" icon={<DeleteOutlined />} className={`${styles.actionBtn} ${styles.dangerBtn}`} />
            </Tooltip>
          </Popconfirm>
        </div>
      </div>

      {agent.description && (
        <p className={styles.cardDesc}>{agent.description}</p>
      )}

      <div className={styles.cardMeta}>
        {agent.skills.length > 0 && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>技能</span>
            <span className={styles.metaValue}>{agent.skills.length}</span>
          </div>
        )}
        {agent.mcpServers.length > 0 && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>MCP</span>
            <span className={styles.metaValue}>{agent.mcpServers.length}</span>
          </div>
        )}
        {agent.knowledgeBases.length > 0 && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>知识库</span>
            <span className={styles.metaValue}>{agent.knowledgeBases.length}</span>
          </div>
        )}
        {agent.temperature != null && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Temperature</span>
            <span className={styles.metaValue}>{agent.temperature}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Agent Form Modal ───────────────────────────────────────────────────────────
interface AgentFormModalProps {
  open: boolean
  editing?: Agent | null
  onClose: () => void
  onSaved: (agent: Agent) => void
}

function AgentFormModal({ open, editing, onClose, onSaved }: AgentFormModalProps) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      if (editing) {
        form.setFieldsValue({
          name: editing.name,
          description: editing.description,
          model: editing.model,
          temperature: editing.temperature ?? 0.7,
          systemPrompt: editing.systemPrompt,
          skills: editing.skills ?? [],
          mcpServers: editing.mcpServers ?? [],
          knowledgeBases: editing.knowledgeBases ?? [],
        })
      } else {
        form.resetFields()
        form.setFieldsValue({ temperature: 0.7 })
      }
    }
  }, [open, editing, form])

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      let agent: Agent
      if (editing) {
        agent = await agentApi.update(editing.id, values as CreateAgentInput)
      } else {
        agent = await agentApi.create(values as CreateAgentInput)
      }
      antMsg.success(editing ? 'Agent 已更新' : 'Agent 已创建')
      onSaved(agent)
    } catch (err: any) {
      if (err?.errorFields) return // validation error
      antMsg.error(err.message ?? '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={editing ? '编辑 Agent' : '新建 Agent'}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={editing ? '保存' : '创建'}
      confirmLoading={loading}
      width={600}
      className={styles.modal}
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入 Agent 名称' }]}>
          <Input placeholder="例如：代码助手" />
        </Form.Item>

        <Form.Item name="description" label="描述">
          <Input placeholder="简短描述 Agent 的用途" />
        </Form.Item>

        <Form.Item name="model" label="模型">
          <Select
            placeholder="默认使用系统配置的模型"
            options={MODEL_OPTIONS}
            allowClear
            showSearch
          />
        </Form.Item>

        <Form.Item name="temperature" label={`Temperature`}>
          <Slider min={0} max={2} step={0.1} />
        </Form.Item>

        <Form.Item name="systemPrompt" label="System Prompt">
          <Input.TextArea
            placeholder="输入系统提示词，定义 Agent 的行为和角色..."
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
        </Form.Item>

        <Form.Item name="skills" label="技能 (Skills)">
          <Select mode="tags" placeholder="输入技能名称后回车" />
        </Form.Item>

        <Form.Item name="mcpServers" label="MCP Servers">
          <Select mode="tags" placeholder="输入 MCP Server 名称后回车" />
        </Form.Item>

        <Form.Item name="knowledgeBases" label="知识库 (Knowledge Bases)">
          <Select mode="tags" placeholder="输入知识库 ID 后回车" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ── Main AgentPanel ────────────────────────────────────────────────────────────
export default function AgentPanel() {
  const { agents, loading, setAgents, setLoading, setError, upsertAgent, removeAgent } = useAgentStore()
  const { addSession } = useSessionStore()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [search, setSearch] = useState('')

  const fetchAgents = async () => {
    setLoading(true)
    try {
      const data = await agentApi.list()
      setAgents(data.list ?? [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAgents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDelete = async (id: string) => {
    try {
      await agentApi.delete(id)
      removeAgent(id)
      antMsg.success('已删除')
    } catch (err: any) {
      antMsg.error(err.message ?? '删除失败')
    }
  }

  const handleChat = (agentId: string) => {
    addSession(agentId)
    antMsg.success('已创建新对话，请切换到「对话」标签')
  }

  const filtered = agents.filter((a) =>
    !search || a.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.headerTitle}>Agents</span>
        <div className={styles.headerActions}>
          <Tooltip title="刷新">
            <Button type="text" size="small" icon={<ReloadOutlined />} className={styles.headerBtn} onClick={fetchAgents} loading={loading} />
          </Tooltip>
          <Tooltip title="新建 Agent">
            <Button type="text" size="small" icon={<PlusOutlined />} className={styles.headerBtn} onClick={() => { setEditing(null); setModalOpen(true) }} />
          </Tooltip>
        </div>
      </div>

      {/* Search */}
      <div className={styles.searchBox}>
        <Input
          placeholder="搜索 Agent..."
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          className={styles.search}
        />
      </div>

      {/* List */}
      <div className={styles.list}>
        {loading && agents.length === 0 ? (
          <div className={styles.loading}><Spin size="small" /></div>
        ) : filtered.length === 0 ? (
          <div className={styles.empty}>
            <RobotOutlined className={styles.emptyIcon} />
            <span>{search ? '无匹配 Agent' : '暂无 Agent，点击 + 创建'}</span>
          </div>
        ) : (
          filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onEdit={(a) => { setEditing(a); setModalOpen(true) }}
              onDelete={handleDelete}
              onChat={handleChat}
            />
          ))
        )}
      </div>

      {/* Form Modal */}
      <AgentFormModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={(agent) => {
          upsertAgent(agent)
          setModalOpen(false)
        }}
      />
    </div>
  )
}

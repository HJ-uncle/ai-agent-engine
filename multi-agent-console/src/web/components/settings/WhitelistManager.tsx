import React, { useState } from 'react'
import { Modal, Input, Button, Form, App, Table, Space, Popconfirm, Select, Upload } from 'antd'
import { UploadOutlined, DownloadOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import styles from './SettingsLayout.module.css'

interface WhitelistItem {
  command: string
  category: 'common' | 'dangerous'
  description?: string
  frequency?: number
}

const DEFAULT_WHITELIST: WhitelistItem[] = [
  { command: 'ls', category: 'common', description: 'List directory contents', frequency: 0 },
  { command: 'npm', category: 'common', description: 'Node package manager', frequency: 0 },
  { command: 'wc', category: 'common', description: 'Print newline, word, and byte counts', frequency: 0 },
  { command: 'rm', category: 'dangerous', description: 'Remove files or directories', frequency: 0 },
]

export default function WhitelistManager() {
  const { message } = App.useApp()
  const [items, setItems] = useState<WhitelistItem[]>(DEFAULT_WHITELIST)
  const [search, setSearch] = useState('')
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<WhitelistItem | null>(null)
  const [form] = Form.useForm()

  const handleAdd = () => {
    setEditingItem(null)
    form.resetFields()
    setIsModalOpen(true)
  }

  const handleEdit = (record: WhitelistItem) => {
    setEditingItem(record)
    form.setFieldsValue(record)
    setIsModalOpen(true)
  }

  const handleDelete = (command: string) => {
    setItems(items.filter((i) => i.command !== command))
    message.success('已删除')
  }

  const handleBatchDelete = () => {
    setItems(items.filter((i) => !selectedRowKeys.includes(i.command)))
    setSelectedRowKeys([])
    message.success('批量删除成功')
  }

  const handleSave = () => {
    form.validateFields().then((values) => {
      if (editingItem) {
        setItems(items.map((i) => (i.command === editingItem.command ? { ...i, ...values } : i)))
        message.success('更新成功')
      } else {
        if (items.some(i => i.command === values.command)) {
          message.error('命令已存在')
          return
        }
        setItems([...items, { ...values, frequency: 0 }])
        message.success('添加成功')
      }
      setIsModalOpen(false)
    })
  }

  const handleExport = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(items))
    const downloadAnchorNode = document.createElement('a')
    downloadAnchorNode.setAttribute("href", dataStr)
    downloadAnchorNode.setAttribute("download", "whitelist.json")
    document.body.appendChild(downloadAnchorNode)
    downloadAnchorNode.click()
    downloadAnchorNode.remove()
  }

  const handleImport = (file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string)
        setItems(imported)
        message.success('导入成功')
      } catch (error) {
        message.error('解析文件失败')
      }
    }
    reader.readAsText(file)
    return false
  }

  const columns = [
    { title: '命令', dataIndex: 'command', key: 'command' },
    { title: '描述', dataIndex: 'description', key: 'description' },
    { title: '使用频率', dataIndex: 'frequency', key: 'frequency' },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: WhitelistItem) => (
        <Space size="middle">
          <button type="button" onClick={() => handleEdit(record)} style={{ background: 'none', border: 'none', color: '#1677ff', cursor: 'pointer', padding: 0 }}>编辑</button>
          <Popconfirm title="确定删除吗?" onConfirm={() => handleDelete(record.command)}>
            <button type="button" style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', padding: 0 }}>删除</button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const filteredData = items.filter(
    (i) => (i.command.includes(search) || i.description?.includes(search))
  )

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>命令访问控制</div>
        <div className={styles.card} style={{ padding: 16 }}>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
            <Space>
              <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加</Button>
              <Button danger disabled={selectedRowKeys.length === 0} onClick={handleBatchDelete} icon={<DeleteOutlined />}>批量删除</Button>
              <Upload beforeUpload={handleImport} showUploadList={false}>
                <Button icon={<UploadOutlined />}>导入</Button>
              </Upload>
              <Button icon={<DownloadOutlined />} onClick={handleExport}>导出</Button>
            </Space>
            <Input.Search
              placeholder="搜索命令或描述"
              onSearch={(val) => setSearch(val)}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 200 }}
              allowClear
            />
          </div>
          <Table
            rowSelection={{
              selectedRowKeys,
              onChange: (keys) => setSelectedRowKeys(keys),
            }}
            columns={columns}
            dataSource={filteredData}
            rowKey="command"
            pagination={{ pageSize: 5 }}
            size="small"
          />
        </div>
      </div>

      <Modal
        title={editingItem ? '编辑白名单项' : '添加白名单项'}
        open={isModalOpen}
        onOk={handleSave}
        onCancel={() => setIsModalOpen(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入命令' }]}>
            <Input disabled={!!editingItem} />
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
            <Select>
              <Select.Option value="common">常用命令</Select.Option>
              <Select.Option value="dangerous">危险命令</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

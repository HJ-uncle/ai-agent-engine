import React, { useState, useEffect, useCallback } from 'react'
import { List, SwipeAction, Tag, Checkbox, Input, Button, Tabs, Empty, SpinLoading, Dialog, NavBar } from 'antd-mobile'
import { DeleteOutline, AddOutline, PlayOutline, CheckCircleOutline } from 'antd-mobile-icons'
import { todoApi, type Todo } from '@core/api'
import { useSessionStore } from '@core/store/session'
import styles from './TodoPage.module.css'

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  high:   { label: '高', color: '#ff4d4f' },
  medium: { label: '中', color: '#ff9c6e' },
  low:    { label: '低', color: '#73d13d' },
}

export default function TodoPage() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [newTitle, setNewTitle] = useState('')

  const activeSessionId = useSessionStore(state => state.activeSessionId)
  const lastTodosUpdate = useSessionStore(state => state.lastTodosUpdate)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await todoApi.list({ sessionId: activeSessionId })
      setTodos(list)
    } finally {
      setLoading(false)
    }
  }, [activeSessionId])

  useEffect(() => {
    load()
  }, [load, lastTodosUpdate])

  const handleAdd = async () => {
    const title = newTitle.trim()
    if (!title) return
    await todoApi.create({ title, priority: 'medium', sessionId: activeSessionId })
    setNewTitle('')
    load()
  }

  const handleStatus = async (id: string, status: Todo['status']) => {
    await todoApi.update(id, { status })
    load()
  }

  const handleDelete = async (id: string) => {
    await todoApi.delete(id)
    load()
  }

  const filtered = activeTab === 'all' ? todos : todos.filter(t => t.status === activeTab)

  return (
    <div className={styles.container}>
      <NavBar back={null} className={styles.nav}>任务管理</NavBar>
      
      <div className={styles.addBox}>
        <Input
          placeholder="添加一个新任务..."
          value={newTitle}
          onChange={setNewTitle}
          onEnterPress={handleAdd}
          className={styles.input}
        />
        <Button color="primary" fill="solid" onClick={handleAdd} className={styles.addBtn}>
          <AddOutline />
        </Button>
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab} className={styles.tabs}>
        <Tabs.Tab title="全部" key="all" />
        <Tabs.Tab title="进行中" key="in_progress" />
        <Tabs.Tab title="待办" key="pending" />
        <Tabs.Tab title="已完成" key="done" />
      </Tabs>

      <div className={styles.listArea}>
        {loading && <div className={styles.center}><SpinLoading /></div>}
        {!loading && filtered.length === 0 && (
          <Empty description="暂无相关任务" />
        )}
        <List>
          {filtered.map(todo => (
            <SwipeAction
              key={todo.id}
              rightActions={[
                {
                  key: 'delete',
                  text: '删除',
                  color: 'danger',
                  onClick: () => handleDelete(todo.id),
                },
              ]}
            >
              <List.Item
                prefix={
                  <Checkbox
                    checked={todo.status === 'done'}
                    onChange={val => handleStatus(todo.id, val ? 'done' : 'pending')}
                  />
                }
                extra={
                  <div className={styles.itemExtra}>
                    <Tag color={PRIORITY_LABELS[todo.priority].color} fill="outline">
                      {PRIORITY_LABELS[todo.priority].label}
                    </Tag>
                  </div>
                }
                description={
                  todo.dueAt && `截止: ${new Date(todo.dueAt).toLocaleDateString()}`
                }
              >
                <div className={todo.status === 'done' ? styles.todoDone : ''}>
                  {todo.title}
                </div>
                <div className={styles.actions}>
                   {todo.status === 'pending' && (
                     <Button size="mini" fill="none" onClick={() => handleStatus(todo.id, 'in_progress')}>
                       <PlayOutline /> 开始
                     </Button>
                   )}
                   {todo.status === 'in_progress' && (
                     <Button size="mini" fill="none" color="success" onClick={() => handleStatus(todo.id, 'done')}>
                       <CheckCircleOutline /> 完成
                     </Button>
                   )}
                </div>
              </List.Item>
            </SwipeAction>
          ))}
        </List>
      </div>
    </div>
  )
}

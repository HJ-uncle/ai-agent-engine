import React, { useState, useEffect, useCallback } from 'react'
import { todoApi, type Todo } from '@core/api'
import { useSessionStore } from '@core/store/session'
import styles from './TodoPanel.module.css'

interface TodoPanelProps {
  sessionId?: string
  visible: boolean
  onClose: () => void
}

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  high:   { label: '高', color: '#f5222d' },
  medium: { label: '中', color: '#fa8c16' },
  low:    { label: '低', color: '#52c41a' },
}

const STATUS_LABELS: Record<string, string> = {
  pending:     '待办',
  in_progress: '进行中',
  done:        '已完成',
  cancelled:   '已取消',
}

export const TodoPanel: React.FC<TodoPanelProps> = ({ sessionId, visible, onClose }) => {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [addPriority, setAddPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [filter, setFilter] = useState<string>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const lastTodosUpdate = useSessionStore(state => state.lastTodosUpdate)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await todoApi.list({ sessionId })
      setTodos(list)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (visible) load()
  }, [visible, load, lastTodosUpdate])

  const handleAdd = async () => {
    const title = addTitle.trim()
    if (!title) return
    await todoApi.create({ title, priority: addPriority, sessionId })
    setAddTitle('')
    load()
  }

  const handleStatus = async (todo: Todo, status: Todo['status']) => {
    await todoApi.update(todo.id, { status })
    load()
  }

  const handleDelete = async (id: string) => {
    await todoApi.delete(id)
    load()
  }

  const handleEditSave = async (id: string) => {
    if (editTitle.trim()) {
      await todoApi.update(id, { title: editTitle.trim() })
    }
    setEditingId(null)
    load()
  }

  const filtered = filter === 'all' ? todos : todos.filter(t => t.status === filter)
  const counts = {
    all: todos.length,
    pending: todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    done: todos.filter(t => t.status === 'done').length,
  }

  if (!visible) return null

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>待办任务</span>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
      </div>

      {/* 快速添加 */}
      <div className={styles.addRow}>
        <input
          className={styles.addInput}
          placeholder="添加待办..."
          value={addTitle}
          onChange={e => setAddTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <select
          className={styles.prioritySelect}
          value={addPriority}
          onChange={e => setAddPriority(e.target.value as any)}
        >
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
        <button className={styles.addBtn} onClick={handleAdd}>+</button>
      </div>

      {/* 过滤标签 */}
      <div className={styles.filters}>
        {(['all', 'pending', 'in_progress', 'done'] as const).map(s => (
          <button
            key={s}
            className={`${styles.filterBtn} ${filter === s ? styles.filterActive : ''}`}
            onClick={() => setFilter(s)}
          >
            {s === 'all' ? '全部' : STATUS_LABELS[s]}
            <span className={styles.filterCount}>{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div className={styles.list}>
        {loading && <div className={styles.empty}>加载中...</div>}
        {!loading && filtered.length === 0 && (
          <div className={styles.empty}>暂无待办 ✨</div>
        )}
        {filtered.map(todo => (
          <div key={todo.id} className={`${styles.item} ${todo.status === 'done' ? styles.done : ''}`}>
            {/* 状态复选框区域 */}
            <div className={styles.itemLeft}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={todo.status === 'done'}
                onChange={e => handleStatus(todo, e.target.checked ? 'done' : 'pending')}
              />
            </div>

            {/* 内容 */}
            <div className={styles.itemContent}>
              {editingId === todo.id ? (
                <input
                  className={styles.editInput}
                  value={editTitle}
                  autoFocus
                  onChange={e => setEditTitle(e.target.value)}
                  onBlur={() => handleEditSave(todo.id)}
                  onKeyDown={e => { if (e.key === 'Enter') handleEditSave(todo.id); if (e.key === 'Escape') setEditingId(null) }}
                />
              ) : (
                <span
                  className={styles.itemTitle}
                  onDoubleClick={() => { setEditingId(todo.id); setEditTitle(todo.title) }}
                >
                  {todo.title}
                </span>
              )}
              <div className={styles.itemMeta}>
                <span className={styles.priorityBadge} style={{ color: PRIORITY_LABELS[todo.priority].color }}>
                  {PRIORITY_LABELS[todo.priority].label}
                </span>
                {todo.status !== 'done' && todo.status !== 'pending' && (
                  <span className={styles.statusBadge}>{STATUS_LABELS[todo.status]}</span>
                )}
                {todo.dueAt && (
                  <span className={styles.dueAt}>截止 {new Date(todo.dueAt).toLocaleDateString('zh-CN')}</span>
                )}
              </div>
            </div>

            {/* 操作 */}
            <div className={styles.itemActions}>
              {todo.status === 'pending' && (
                <button className={styles.actionBtn} title="开始" onClick={() => handleStatus(todo, 'in_progress')}>▶</button>
              )}
              {todo.status === 'in_progress' && (
                <button className={styles.actionBtn} title="完成" onClick={() => handleStatus(todo, 'done')}>✓</button>
              )}
              <button className={styles.deleteBtn} title="删除" onClick={() => handleDelete(todo.id)}>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

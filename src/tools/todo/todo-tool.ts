import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { TodoStore } from '../../storage/todo/index.js'
import type { TodoStatus, TodoPriority } from '../../storage/todo/index.js'

const store = new TodoStore()

export const todoTools: Tool[] = [
  {
    name: 'todo_list',
    displayName: '列出待办',
    description: '列出待办任务',
    parameters: { type: 'object', properties: {
      status: { type: 'string', enum: ['pending','in_progress','done','cancelled'] },
    }, required: [] },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      try {
        let todos = await store.list(ctx.tenantId, ctx.sessionId)
        const { status } = rawArgs as { status?: TodoStatus }
        if (status) todos = todos.filter(t => t.status === status)
        if (todos.length === 0) return { success: true, output: '暂无待办任务' }
        const lines = todos.map(t =>
          `[${t.id}] [${t.priority}] [${t.status}] ${t.title}${t.dueAt ? ` (截止: ${new Date(t.dueAt).toLocaleString('zh-CN')})` : ''}`
        )
        return { success: true, output: `共 ${todos.length} 条待办:\n${lines.join('\n')}` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'todo_create',
    displayName: '创建待办',
    description: '创建待办任务',
    parameters: { type: 'object', properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string', enum: ['low','medium','high'] },
      dueAt: { type: 'string', description: 'ISO 8601' },
    }, required: ['title'] },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { title, description, priority, dueAt } = rawArgs as any
      try {
        const todo = await store.create(ctx.tenantId, {
          title, description, priority, sessionId: ctx.sessionId,
          dueAt: dueAt ? new Date(dueAt).getTime() : undefined,
        })
        return { success: true, output: `✅ 已创建待办 [${todo.id}]: ${todo.title}` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'todo_update',
    displayName: '更新待办',
    description: '更新待办状态/标题/优先级',
    parameters: { type: 'object', properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', enum: ['pending','in_progress','done','cancelled'] },
      priority: { type: 'string', enum: ['low','medium','high'] },
      dueAt: { type: 'string' },
    }, required: ['id'] },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id, ...updates } = rawArgs as any
      try {
        const all = await store.list(ctx.tenantId)
        const todo = all.find(t => t.id === id || t.id.startsWith(id))
        if (!todo) return { success: false, output: `待办 "${id}" 不存在` }
        const updated = await store.update(todo.id, ctx.tenantId, {
          ...updates,
          dueAt: updates.dueAt ? new Date(updates.dueAt).getTime() : undefined,
        })
        return { success: true, output: `✅ 已更新待办 [${todo.id}]: ${updated?.title}` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'todo_delete',
    displayName: '删除待办',
    description: '删除待办任务',
    parameters: { type: 'object', properties: {
      id: { type: 'string' },
    }, required: ['id'] },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id } = rawArgs as any
      try {
        const all = await store.list(ctx.tenantId)
        const todo = all.find(t => t.id === id || t.id.startsWith(id))
        if (!todo) return { success: false, output: `待办 "${id}" 不存在` }
        await store.delete(todo.id, ctx.tenantId)
        return { success: true, output: `🗑️ 已删除待办: ${todo.title}` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
]
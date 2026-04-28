import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { SQLiteTaskQueue } from '../../storage/task-queue/index.js'

const queue = new SQLiteTaskQueue()

export const taskControlTools: Tool[] = [
  {
    name: 'task_list',
    displayName: '列出后台任务',
    description: '列出后台任务',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending','running','done','failed','cancelled'] },
        limit: { type: 'number' },
      },
      required: [],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      try {
        const { status, limit = 20 } = rawArgs as any
        let jobs: any[] = []
        if (typeof (queue as any).list === 'function') {
          jobs = await (queue as any).list(ctx.tenantId)
        }
        if (status) jobs = jobs.filter((j: any) => j.status === status)
        jobs = jobs.slice(0, limit)
        if (jobs.length === 0) return { success: true, output: '暂无后台任务' }
        const lines = jobs.map((j: any) =>
          `[${j.id.slice(0,8)}] [${j.status}] type="${j.type}" 创建: ${new Date(j.createdAt).toLocaleString('zh-CN')}`
        )
        return { success: true, output: `共 ${jobs.length} 个后台任务:\n${lines.join('\n')}` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'task_cancel',
    displayName: '取消后台任务',
    description: '取消后台任务',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id } = rawArgs as any
      try {
        let jobs: any[] = []
        if (typeof (queue as any).list === 'function') {
          jobs = await (queue as any).list(ctx.tenantId)
        }
        const job = jobs.find((j: any) => j.id === id || j.id.startsWith(id))
        if (!job) return { success: false, output: `任务 "${id}" 不存在` }
        const cancelled = await queue.cancel(job.id)
        return { success: true, output: cancelled ? `✅ 已取消任务 [${job.id.slice(0,8)}]` : `⚠️ 任务 "${id}" 无法取消（可能已完成或正在运行）` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'task_status',
    displayName: '查看任务状态',
    description: '查看任务状态',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id } = rawArgs as any
      try {
        let jobs: any[] = []
        if (typeof (queue as any).list === 'function') {
          jobs = await (queue as any).list(ctx.tenantId)
        }
        const job = jobs.find((j: any) => j.id === id || j.id.startsWith(id))
        if (!job) {
          // 直接查询
          const record = await queue.getStatus(id)
          if (!record) return { success: false, output: `任务 "${id}" 不存在` }
          return { success: true, output: JSON.stringify(record, null, 2) }
        }
        return { success: true, output: JSON.stringify(job, null, 2) }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
]

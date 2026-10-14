import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { SQLiteTaskQueue } from '../../storage/task-queue/index.js'
import { z } from 'zod'
import type { JobRecord } from '../../storage/task-queue/types.js'

const queue = new SQLiteTaskQueue()
const listArgs = z.object({ status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']).optional(), limit: z.number().int().min(1).max(200).default(20) })
const jobArgs = z.object({ id: z.string().trim().min(1).max(256) })
async function resolveJob(id: string, tenantId: string): Promise<JobRecord | null> {
  const exact = await queue.getStatus(id, tenantId)
  if (exact) return exact
  const matches = (await queue.list(tenantId)).filter(job => job.id.startsWith(id))
  if (matches.length > 1) throw new Error('任务 ID 前缀不唯一，请使用完整 ID')
  return matches[0] ?? null
}

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
        const { status, limit } = listArgs.parse(rawArgs)
        let jobs = await queue.list(ctx.tenantId)
        if (status) jobs = jobs.filter(job => job.status === status)
        jobs = jobs.slice(0, limit)
        if (jobs.length === 0) return { success: true, output: '暂无后台任务' }
        const lines = jobs.map((j) =>
          `[${j.id}] [${j.status}] type="${j.type}" 创建: ${new Date(j.createdAt).toLocaleString('zh-CN')}`
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
      try {
        const { id } = jobArgs.parse(rawArgs)
        const job = await resolveJob(id, ctx.tenantId)
        if (!job) return { success: false, output: `任务 "${id}" 不存在` }
        const cancelled = await queue.cancel(job.id, ctx.tenantId)
        return { success: true, output: cancelled ? `✅ 已取消任务 [${job.id}]` : `⚠️ 任务 "${id}" 无法取消（可能已完成或正在运行）` }
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
      try {
        const { id } = jobArgs.parse(rawArgs)
        const job = await resolveJob(id, ctx.tenantId)
        if (!job) return { success: false, output: `任务 "${id}" 不存在` }
        return { success: true, output: JSON.stringify(job, null, 2) }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
]

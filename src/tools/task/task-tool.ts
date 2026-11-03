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
    displayName: '列出旧版队列任务',
    description: '兼容旧版：查询持久化 task-queue 任务，不包含 execute_cmd 命令任务、子代理或定时任务。当前服务没有内置队列处理器；不要用它判断当前 AI 任务是否运行。',
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
    displayName: '取消旧版排队任务',
    description: '兼容旧版：仅取消旧 task-queue 中尚未开始的 pending 任务，不能停止正在运行的任务。AI 命令用 cancel_command，子代理用 subagent_cancel；这里的 id 不与它们互通。',
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
    displayName: '查看旧版队列任务',
    description: '兼容旧版：读取 task-queue 记录；id 必须来自 task_list，不是命令 jobId、子代理 runId 或定时任务 id。',
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

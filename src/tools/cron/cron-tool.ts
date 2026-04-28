import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { CronStore } from '../../storage/cron/index.js'

const store = new CronStore()

export const cronTools: Tool[] = [
  {
    name: 'cron_list',
    displayName: '列出定时任务',
    description: '列出所有定时任务',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_: unknown, ctx: AgentContext): Promise<ToolResult> {
      try {
        const jobs = await store.list(ctx.tenantId)
        if (jobs.length === 0) return { success: true, output: '暂无定时任务' }
        const lines = jobs.map(j =>
          `[${j.id.slice(0,8)}] [${j.enabled ? '启用' : '禁用'}] "${j.name}" cron="${j.cronExpr}" 消息="${j.message.slice(0,30)}" 上次运行: ${j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('zh-CN') : '从未'}`
        )
        return { success: true, output: `共 ${jobs.length} 个定时任务:\n${lines.join('\n')}` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'cron_create',
    displayName: '创建定时任务',
    description: '创建定时任务，到期自动触发 AI 对话',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        cronExpr: { type: 'string', description: '5字段cron：分 时 日 月 周' },
        message: { type: 'string', description: '触发时发给AI的消息' },
        sessionId: { type: 'string' },
        description: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['name', 'cronExpr', 'message'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { name, cronExpr, message, sessionId, description, agentId } = rawArgs as any
      try {
        const job = await store.create(ctx.tenantId, {
          name, cronExpr, message, description, agentId,
          sessionId: sessionId || ctx.sessionId,
        })
        return { success: true, output: `✅ 已创建定时任务 [${job.id.slice(0,8)}]: "${job.name}" (${job.cronExpr})` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'cron_update',
    displayName: '更新定时任务',
    description: '更新定时任务配置',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        cronExpr: { type: 'string' },
        message: { type: 'string' },
        enabled: { type: 'boolean' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id, ...updates } = rawArgs as any
      try {
        const all = await store.list(ctx.tenantId)
        const job = all.find(j => j.id === id || j.id.startsWith(id))
        if (!job) return { success: false, output: `定时任务 "${id}" 不存在` }
        const updated = await store.update(job.id, ctx.tenantId, updates)
        return { success: true, output: `✅ 已更新定时任务 [${job.id.slice(0,8)}]: "${updated?.name}"${updates.enabled !== undefined ? ` → ${updates.enabled ? '启用' : '禁用'}` : ''}` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
  {
    name: 'cron_delete',
    displayName: '删除定时任务',
    description: '删除定时任务',
    parameters: { type: 'object', properties: {
      id: { type: 'string' },
    }, required: ['id'] },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id } = rawArgs as any
      try {
        const all = await store.list(ctx.tenantId)
        const job = all.find(j => j.id === id || j.id.startsWith(id))
        if (!job) return { success: false, output: `定时任务 "${id}" 不存在` }
        await store.delete(job.id, ctx.tenantId)
        return { success: true, output: `🗑️ 已删除定时任务: "${job.name}"` }
      } catch (err) { return { success: false, output: String(err) } }
    },
  },
]
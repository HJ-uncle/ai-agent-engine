import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { cronFixture } from '../../scheduler/__tests__/cron-v2-fixture.js'
import { cronTools } from './cron-tool.js'
import type { CronConfigurationV2 } from '../../scheduler/cron-schedule.js'
import { cronService } from '../../scheduler/cron-service.js'
import { withCronWrite } from '../../storage/cron/runs.js'

const fixture = cronFixture()
const tool = (name: string) => cronTools.find(candidate => candidate.name === name)!
const ctx = (tenantId = 'default') => ({ tenantId, sessionId: 'cron-tool-session', currentToolCallId: 'mutation-call' }) as AgentContext
const configuration: CronConfigurationV2 = { version: 2, schedule: { kind: 'calendar', localTime: '09:00', timeZone: 'Asia/Shanghai', daysOfWeek: [1] },
  target: { kind: 'standalone' }, notificationPolicy: 'all_runs', toolProfile: 'general' }
const args = () => ({ name: '每周汇总', message: '整理项目进度', configuration })
function approved(name: string, raw: Record<string, unknown>, result: ToolResult): AgentContext {
  return { ...ctx(), approvedToolCallId: 'mutation-call', resumeToolCall: {
    toolCall: { id: 'mutation-call', name, args: raw }, decision: 'approved',
    pendingAction: JSON.parse(JSON.stringify(result.pendingAction)),
  } }
}

describe('automation toolkit durable mutations', () => {
  it.each(['create', 'update', 'delete'] as const)('cancels an approved %s waiting for another database writer', async action => {
    const existing = await fixture.jobs.create('default', { ...args(), name: 'Keep this job' })
    const raw = action === 'create' ? args() : action === 'update' ? { id: existing.id, name: 'Cancelled edit' } : { id: existing.id }
    const name = 'cron_' + action
    const waiting = await tool(name).execute(raw, ctx())
    expect(waiting.needsConfirmation).toBe(true)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocker = withCronWrite(fixture.db, async () => { entered(); await gate })
    await held
    const controller = new AbortController()
    const called = vi.spyOn(cronService, action)
    const execution = tool(name).execute(raw, { ...approved(name, raw, waiting), signal: controller.signal })
    try {
      await vi.waitFor(() => expect(called).toHaveBeenCalled())
      controller.abort(new Error('Stopped while queued'))
    } finally { release(); await blocker }
    expect(await execution).toMatchObject({ success: false, output: 'Stopped while queued' })
    expect(await fixture.jobs.list('default')).toEqual([existing])
  })

  it('previews without writing, then creates the exact approved plan once', async () => {
    const raw = args(), waiting = await tool('cron_create').execute(raw, ctx())
    expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
    expect(await fixture.jobs.list('default')).toEqual([])
    const context = approved('cron_create', raw, waiting)
    const result = await tool('cron_create').execute(raw, context)
    expect(result).toMatchObject({ success: true, metadata: { resourceChange: { kind: 'automation', action: 'create' } } })
    const saved = await fixture.jobs.list('default')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ name: raw.name, message: raw.message, configuration })
    expect((await tool('cron_create').execute(raw, context)).success).toBe(false)
    expect(await fixture.jobs.list('default')).toHaveLength(1)
  })

  it('does not accept a model approval flag or changed args, identity or tenant', async () => {
    const raw = args()
    expect((await tool('cron_create').execute({ ...raw, confirmed: true }, ctx())).success).toBe(false)
    const waiting = await tool('cron_create').execute(raw, ctx()), context = approved('cron_create', raw, waiting)
    expect((await tool('cron_create').execute({ ...raw, name: 'changed' }, context)).status).toBe('failed')
    expect((await tool('cron_create').execute(raw, { ...context, tenantId: 'other' })).status).toBe('failed')
    expect((await tool('cron_create').execute(raw, { ...context, resumeToolCall: undefined })).status).toBe('failed')
    expect(await fixture.jobs.list('default')).toEqual([])
  })

  it('rejects stale update and delete approvals instead of overwriting concurrent edits', async () => {
    const job = await fixture.jobs.create('default', { name: 'Initial', message: 'test', configuration })
    const update = { id: job.id, enabled: false }, remove = { id: job.id }
    const updateWaiting = await tool('cron_update').execute(update, ctx())
    const deleteWaiting = await tool('cron_delete').execute(remove, ctx())
    expect(updateWaiting.needsConfirmation).toBe(true); expect(deleteWaiting.needsConfirmation).toBe(true)
    await fixture.jobs.update(job.id, 'default', { name: 'Changed elsewhere' })
    expect((await tool('cron_update').execute(update, approved('cron_update', update, updateWaiting))).success).toBe(false)
    expect((await tool('cron_delete').execute(remove, approved('cron_delete', remove, deleteWaiting))).success).toBe(false)
    expect(await fixture.jobs.getById(job.id, 'default')).toMatchObject({ name: 'Changed elsewhere', enabled: true })
    const fresh = await tool('cron_update').execute(update, ctx())
    expect((await tool('cron_update').execute(update, approved('cron_update', update, fresh))).success).toBe(true)
    expect(await fixture.jobs.getById(job.id, 'default')).toMatchObject({ enabled: false })
  })

  it('reports unsupported tenant dispatch and refuses activation while allowing a paused draft', async () => {
    const capabilities = await tool('cron_capabilities').execute({}, ctx('other'))
    expect(JSON.parse(capabilities.output)).toMatchObject({ executionSupported: false, manualRun: false })
    expect((await tool('cron_create').execute(args(), ctx('other'))).status).toBe('failed')
    const raw = { ...args(), enabled: false }
    const waiting = await tool('cron_create').execute(raw, ctx('other'))
    expect(waiting.needsConfirmation).toBe(true)
    const context = { ...approved('cron_create', raw, waiting), tenantId: 'other' }
    expect((await tool('cron_create').execute(raw, context)).success).toBe(true)
    expect(await fixture.jobs.list('default')).toEqual([])
    expect(await fixture.jobs.list('other')).toHaveLength(1)
  })
})

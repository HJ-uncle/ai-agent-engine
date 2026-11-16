import { z } from 'zod'
import { PluginService } from './service.js'
import { onPluginChanged } from './change-events.js'
import { assertCapability, publishedCapabilityAccess } from './capability-runtime.js'
import { invokePluginApplication } from './application.js'
import { withPluginEventOrigin } from './lifecycle-runtime.js'

const taskSchema = z.object({ pluginId: z.string(), revision: z.number().int().positive(), id: z.string(), title: z.string(), intervalMs: z.number().int().min(1000),
  nextRunAt: z.number().finite(), status: z.enum(['scheduled', 'running', 'error']), lastRunAt: z.number().optional(), lastFinishedAt: z.number().optional(), lastError: z.string().max(200).optional() }).strict()
export type PluginBackgroundTask = z.infer<typeof taskSchema>
const stateSchema = z.object({ version: z.literal(1), tasks: z.array(taskSchema) }).strict()
const keyFor = (task: Pick<PluginBackgroundTask, 'pluginId' | 'revision' | 'id'>) => JSON.stringify([task.pluginId, task.revision, task.id])

/** Engine-owned persisted scheduler; no renderer or browser timer participates. */
export class PluginBackgroundScheduler {
  private timer?: ReturnType<typeof setInterval>
  private unsubscribe?: () => void
  private stopping = false
  private generation = 0
  private initialized = false
  private check?: Promise<void>
  private tasks = new Map<string, Map<string, PluginBackgroundTask>>()
  private syncs = new Map<string, Promise<void>>()
  private saves = new Map<string, Promise<void>>()
  private saved = new Map<string, string>()
  private active = new Map<string, { tenantId: string; pluginId: string; controller: AbortController; completion: Promise<void> }>()
  constructor(readonly service: PluginService, private readonly options: { now?: () => number; pollMs?: number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now() }
  async start(): Promise<void> {
    if (this.timer) return
    this.stopping = false
    this.unsubscribe = onPluginChanged(change => {
      if (change.root === this.service.rootDir) void this.syncTenant(change.tenantId).catch(() => undefined)
    })
    await this.checkAndRun()
    if (!this.stopping) { this.timer = setInterval(() => { void this.checkAndRun().catch(() => undefined) }, this.options.pollMs ?? 1000); this.timer.unref() }
  }
  private persist(tenantId: string): Promise<void> {
    const write = (this.saves.get(tenantId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const value = { version: 1, tasks: [...(this.tasks.get(tenantId)?.values() ?? [])] }, serialized = JSON.stringify(value)
      if (this.saved.get(tenantId) === serialized) return
      await this.service.setBackgroundState(tenantId, value); this.saved.set(tenantId, serialized)
    })
    this.saves.set(tenantId, write)
    return write.finally(() => { if (this.saves.get(tenantId) === write) this.saves.delete(tenantId) })
  }
  syncTenant(tenantId: string): Promise<void> {
    const previous = this.syncs.get(tenantId) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(() => this.reconcile(tenantId))
    this.syncs.set(tenantId, pending)
    return pending.finally(() => { if (this.syncs.get(tenantId) === pending) this.syncs.delete(tenantId) })
  }
  private async reconcile(tenantId: string): Promise<void> {
    if (this.stopping) return
    const first = !this.tasks.has(tenantId)
    if (first) {
      const stored = stateSchema.parse(await this.service.getBackgroundState(tenantId))
      this.tasks.set(tenantId, new Map(stored.tasks.map(task => [keyFor(task), { ...task,
        ...(task.status === 'running' ? { status: 'scheduled' as const, nextRunAt: this.now() } : {}) }])))
    }
    const tasks = this.tasks.get(tenantId)!, eligible = new Set<string>()
    for (const metadata of await this.service.listPublishedMetadata(tenantId)) {
      if (!metadata.enabled || !metadata.manifest.contributes?.background?.length) continue
      const record = await this.service.get(tenantId, metadata.id)
      if (record.permissionRevision !== metadata.revision || !record.permissionGrants?.includes('background.run') || !metadata.manifest.permissions?.requested.includes('background.run')) continue
      for (const item of metadata.manifest.contributes.background) {
        if (item.when?.engineReady === false) continue
        const descriptor = { pluginId: metadata.id, revision: metadata.revision, id: item.id, title: item.title, intervalMs: item.intervalMs }
        const key = keyFor(descriptor); eligible.add(key)
        const current = tasks.get(key)
        if (!current) tasks.set(key, { ...descriptor, nextRunAt: this.now() + (item.runOnStartup ? 0 : item.intervalMs), status: 'scheduled' })
        else if (first && item.runOnStartup) current.nextRunAt = Math.min(current.nextRunAt, this.now())
      }
    }
    for (const [key] of tasks) if (!eligible.has(key)) {
      tasks.delete(key)
      this.active.get(JSON.stringify([tenantId, key]))?.controller.abort()
    }
    await this.persist(tenantId)
  }
  async status(tenantId: string) {
    await this.syncTenant(tenantId)
    const tasks = [...(this.tasks.get(tenantId)?.values() ?? [])].map(task => ({ ...task }))
    return { enabled: tasks.length > 0, running: tasks.filter(task => task.status === 'running').length, tasks }
  }
  checkAndRun(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.check) return this.check
    const generation = this.generation
    const check = (async () => {
      if (!this.initialized) {
        this.initialized = true
        for (const tenantId of await this.service.listTenantIds()) {
          try { await this.syncTenant(tenantId) } catch { /* One damaged tenant cannot stop other authorized schedules. */ }
        }
      }
      const tenants = this.tasks.keys()
      for (const tenantId of tenants) {
        try { await this.syncs.get(tenantId) } catch { continue }
        if (this.stopping || generation !== this.generation) return
        for (const [key, task] of this.tasks.get(tenantId) ?? []) {
          if (task.nextRunAt > this.now() || this.active.has(JSON.stringify([tenantId, key]))) continue
          await this.fire(tenantId, key, task, generation)
        }
      }
    })().finally(() => { if (this.check === check) this.check = undefined })
    this.check = check; return check
  }
  private async fire(tenantId: string, key: string, task: PluginBackgroundTask, generation: number): Promise<void> {
    const activeKey = JSON.stringify([tenantId, key]), controller = new AbortController()
    // Persist the claim before launching. A crash in running state is retried
    // once on restart; missed intervals never create a backlog.
    task.status = 'running'; task.lastRunAt = this.now(); task.nextRunAt = this.now() + task.intervalMs; delete task.lastError
    await this.persist(tenantId)
    if (this.stopping || generation !== this.generation || this.tasks.get(tenantId)?.get(key) !== task) return
    const completion = Promise.resolve().then(async () => {
      try {
        const access = await publishedCapabilityAccess(this.service, tenantId, task.pluginId, task.revision)
        assertCapability(access, 'background.run', task.revision); controller.signal.throwIfAborted()
        const job = access.manifest.contributes?.background?.find(item => item.id === task.id)
        if (!job) return
        await withPluginEventOrigin(task.pluginId, () => invokePluginApplication(this.service, tenantId, task.pluginId, task.revision, job.tool,
          { ...job.args }, controller.signal))
        task.status = 'scheduled'
      } catch {
        task.status = controller.signal.aborted ? 'scheduled' : 'error'
        if (!controller.signal.aborted) task.lastError = '后台任务执行失败，请检查插件工具与权限'
      } finally {
        this.active.delete(activeKey)
        task.lastFinishedAt = this.now(); task.nextRunAt = this.now() + task.intervalMs
        if (controller.signal.aborted && this.stopping) task.nextRunAt = this.now()
        await this.persist(tenantId)
      }
    })
    this.active.set(activeKey, { tenantId, pluginId: task.pluginId, controller, completion })
    void completion.catch(() => undefined)
  }
  async stop(): Promise<void> {
    this.stopping = true; this.generation++
    if (this.timer) clearInterval(this.timer); this.timer = undefined; this.unsubscribe?.(); this.unsubscribe = undefined
    await this.check
    await Promise.allSettled([...this.syncs.values()])
    for (const run of this.active.values()) run.controller.abort()
    await Promise.allSettled([...this.active.values()].map(run => run.completion))
    await Promise.all([...this.saves.values()])
  }
}

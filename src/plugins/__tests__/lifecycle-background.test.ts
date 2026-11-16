import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from '../service.js'
import { PluginBackgroundScheduler } from '../background-runtime.js'
import { PluginLifecycleRuntime, withPluginEventOrigin } from '../lifecycle-runtime.js'
import { invokePluginCapability, publishedCapabilityAccess } from '../capability-runtime.js'
import type { CreatePluginInput } from '../types.js'

const parent = path.resolve('.e2e-tmp/plugin-lifecycle-background')
let root: string, service: PluginService, now: number
const schedulers: PluginBackgroundScheduler[] = [], lifecycles: PluginLifecycleRuntime[] = []
const source = `let raw='';for await(const chunk of process.stdin)raw+=chunk;const {args}=JSON.parse(raw);
if(args.delay){await $AE.settings.set({value:{started:true}});await new Promise(resolve=>setTimeout(resolve,args.delay));}
const old=await $AE.settings.get();await $AE.settings.set({value:{count:(old.count??0)+1,last:args.event??null,context:await $AE.context()}});console.log(JSON.stringify({result:{done:true}}));`
function fixture(kind: 'background' | 'hooks', id = 'test-extension'): CreatePluginInput {
  return { manifest: { apiVersion: 1, id, name: id, version: '1.0.0', runtime: 'node', description: 'Runtime lifecycle fixture',
    tools: [{ name: 'tick', entry: 'main.mjs', description: 'Record runtime call', inputSchema: { type: 'object', additionalProperties: true } }],
    permissions: { requested: [kind === 'background' ? 'background.run' : 'events.subscribe', 'settings.read', 'settings.write'] },
    contributes: kind === 'background' ? { background: [{ id: 'tick', title: 'Tick', tool: 'tick', intervalMs: 1000 }] }
      : { hooks: [{ id: 'message', title: 'Message', tool: 'tick', event: 'message.created' }] } }, files: { 'main.mjs': source } }
}
async function install(input: CreatePluginInput, tenant = 'tenant', granted = true) {
  await service.create(tenant, input); await service.publish(tenant, input.manifest.id, 1)
  if (granted) await service.setPermissionGrants(tenant, input.manifest.id, input.manifest.permissions!.requested, 1)
}
function scheduler() { const value = new PluginBackgroundScheduler(service, { now: () => now, pollMs: 60_000 }); schedulers.push(value); return value }
function lifecycle() { const value = new PluginLifecycleRuntime(service); lifecycles.push(value); return value }
async function count(expected: number, id = 'test-extension') { await vi.waitFor(async () => expect((await service.getSettings('tenant', id)).count).toBe(expected), { timeout: 5000, interval: 30 }) }
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true }); root = fs.mkdtempSync(path.join(parent, 'case-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db')); vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard'); vi.stubEnv('AUTH_ENABLED', 'false')
  service = new PluginService(path.join(root, 'plugins')); now = 100_000
})
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(value => value.stop())); await Promise.all(lifecycles.splice(0).map(value => value.stop()))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== parent || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('persistent engine background plugins', () => {
  it('restores a persisted next run, coalesces missed intervals and needs no renderer', async () => {
    await install(fixture('background'))
    const first = scheduler(); await first.start()
    expect((await first.status('tenant')).tasks[0].nextRunAt).toBe(101_000)
    await first.stop(); now += 60_000
    const restored = scheduler(); await restored.start(); await count(1)
    await vi.waitFor(async () => expect((await restored.status('tenant')).running).toBe(0))
    expect((await restored.status('tenant')).tasks[0].nextRunAt).toBe(161_000)
    await restored.checkAndRun(); expect((await service.getSettings('tenant', 'test-extension')).count).toBe(1)
    now += 1000; await restored.checkAndRun(); await count(2)
  })

  it('does not read or rewrite storage on idle timer ticks', async () => {
    await install(fixture('background')); const runtime = scheduler(); await runtime.start()
    const read = vi.spyOn(service, 'listPublishedMetadata'), tenants = vi.spyOn(service, 'listTenantIds'), write = vi.spyOn(service, 'setBackgroundState')
    await runtime.checkAndRun(); await runtime.checkAndRun()
    expect(read).not.toHaveBeenCalled(); expect(tenants).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  })

  it('denies ungranted schedules, revokes and removes persisted tasks, and recovers with a new grant', async () => {
    const input = fixture('background'); input.manifest.contributes!.background![0].runOnStartup = true
    await install(input, 'tenant', false); const runtime = scheduler(); await runtime.start()
    expect(await runtime.status('tenant')).toMatchObject({ enabled: false, running: 0, tasks: [] })
    await service.setPermissionGrants('tenant', input.manifest.id, input.manifest.permissions!.requested, 1)
    await runtime.checkAndRun(); await count(1)
    await service.setEnabled('tenant', input.manifest.id, false)
    expect(await runtime.status('tenant')).toMatchObject({ enabled: false, tasks: [] })
    expect(await service.getBackgroundState('tenant')).toEqual({ version: 1, tasks: [] })
    now += 60_000; await runtime.checkAndRun(); expect((await service.getSettings('tenant', input.manifest.id)).count).toBe(1)
  })

  it('aborts a running Node task on permission revocation and never overlaps occurrences', async () => {
    const input = fixture('background'); Object.assign(input.manifest.contributes!.background![0], { runOnStartup: true, args: { delay: 10_000 } })
    await install(input); const runtime = scheduler(); await runtime.start()
    expect((await runtime.status('tenant')).running).toBe(1)
    // Observe the actual child, rather than revoking while its async launch is
    // still queued. Windows tree teardown may run two bounded 8s OS helpers.
    await vi.waitFor(async () => expect((await service.getSettings('tenant', input.manifest.id)).started).toBe(true), { timeout: 10_000 })
    now += 60_000; await runtime.checkAndRun(); expect((await runtime.status('tenant')).running).toBe(1)
    await service.setPermissionGrants('tenant', input.manifest.id, ['settings.read', 'settings.write'], 1)
    expect((await runtime.status('tenant')).enabled).toBe(false)
    await runtime.stop()
    expect((await service.getSettings('tenant', input.manifest.id)).count).toBeUndefined()
  }, 30_000)

  it('isolates corrupt persisted state from another valid tenant', async () => {
    await install(fixture('background', 'damaged'), 'broken')
    await service.setBackgroundState('broken', { bad: true })
    const good = fixture('background'); good.manifest.contributes!.background![0].runOnStartup = true; await install(good)
    const runtime = scheduler(); await runtime.start(); await count(1)
  })

  it('recovers an interrupted persisted running claim once after restart', async () => {
    await install(fixture('background'))
    await service.setBackgroundState('tenant', { version: 1, tasks: [{ pluginId: 'test-extension', revision: 1, id: 'tick', title: 'Tick', intervalMs: 1000,
      nextRunAt: now + 60_000, status: 'running', lastRunAt: now - 10_000 }] })
    const runtime = scheduler(); await runtime.start(); await count(1)
    await vi.waitFor(async () => expect((await runtime.status('tenant')).running).toBe(0))
    await runtime.checkAndRun(); expect((await service.getSettings('tenant', 'test-extension')).count).toBe(1)
  })
})

describe('host-owned plugin lifecycle hooks', () => {
  it('binds event and context to the host session, deduplicates and filters event polling by session/tenant', async () => {
    await install(fixture('hooks')); const runtime = lifecycle(); await runtime.start()
    const event = { event: 'message.created', eventId: randomUUID(), sessionId: 'bound', payload: { messageId: 'm1' } }
    expect(await runtime.dispatch('tenant', event)).toMatchObject({ accepted: 1 })
    expect(await runtime.dispatch('tenant', event)).toMatchObject({ accepted: 0 })
    await runtime.drain(); await count(1)
    expect(await service.getSettings('tenant', 'test-extension')).toMatchObject({ context: { sessionId: 'bound' }, last: { type: 'message.created', sessionId: 'bound', payload: { messageId: 'm1' } } })
    const access = await publishedCapabilityAccess(service, 'tenant', 'test-extension', 1)
    const poll = (sessionId: string) => invokePluginCapability(access, 'tenant', { capability: 'events.subscribe', method: 'poll', expectedRevision: 1, args: {}, sessionId })
    expect(await poll('bound')).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ id: event.eventId })]) })
    expect((await poll('different') as { events: unknown[] }).events).not.toContainEqual(expect.objectContaining({ id: event.eventId }))
    expect(runtime.poll('foreign', 'bound').events).toEqual([])
    expect(runtime.poll('tenant', 'bound', 9999).events).toContainEqual(expect.objectContaining({ id: event.eventId }))
  })

  it('rejects engine-event spoofing and missing sessions while accepting larger payloads', async () => {
    const runtime = lifecycle(); await runtime.start()
    await expect(runtime.dispatch('tenant', { event: 'agent.started', eventId: randomUUID(), sessionId: 'bound', payload: {} })).rejects.toMatchObject({ code: 'PLUGIN_EVENT_SOURCE' })
    await expect(runtime.dispatch('tenant', { event: 'message.created', eventId: randomUUID(), payload: {} })).rejects.toMatchObject({ code: 'PLUGIN_SESSION_REQUIRED' })
    const eventId = randomUUID(), text = 'x'.repeat(33 * 1024)
    await expect(runtime.dispatch('tenant', { event: 'message.created', eventId, sessionId: 'bound', payload: { text } })).resolves.toMatchObject({ accepted: 0 })
    expect(runtime.poll('tenant', 'bound').events).toContainEqual(expect.objectContaining({ id: eventId, payload: { text } }))
  })

  it('evicts old payloads at the history watermark while preserving the complete current event', async () => {
    const runtime = lifecycle(); await runtime.start()
    const dispatch = (text: string) => runtime.dispatch('tenant', { event: 'message.created', eventId: randomUUID(), sessionId: 'bound', payload: { text } })
    await dispatch('a'.repeat(5 * 1024 * 1024))
    const second = await dispatch('b'.repeat(5 * 1024 * 1024))
    let retained = runtime.poll('tenant', 'bound').events
    expect(retained.map(event => event.id)).toEqual([second.eventId])
    expect((retained[0].payload.text as string).length).toBe(5 * 1024 * 1024)
    const large = await dispatch('c'.repeat(9 * 1024 * 1024))
    retained = runtime.poll('tenant', 'bound').events
    expect(retained.map(event => event.id)).toEqual([large.eventId])
    expect((retained[0].payload.text as string).length).toBe(9 * 1024 * 1024)
    const last = await dispatch('small')
    expect(runtime.poll('tenant', 'bound').events.map(event => event.id)).toEqual([last.eventId])
  })

  it('retains at most 256 small events and dispatches hooks even when an oversized event replaces history', async () => {
    const runtime = lifecycle(); await runtime.start()
    for (let index = 0; index < 270; index++) {
      await runtime.dispatch('tenant', { event: 'message.created', eventId: randomUUID(), sessionId: 'bound', payload: { index } })
    }
    const retained = runtime.poll('tenant', 'bound', 0, 1000).events
    expect(retained).toHaveLength(256)
    expect(retained[0].payload.index).toBe(14)
    const input = fixture('hooks')
    input.files['main.mjs'] = `let raw='';for await(const chunk of process.stdin)raw+=chunk;const {args}=JSON.parse(raw);await $AE.settings.set({value:{count:1,length:args.event.payload.text.length}});console.log(JSON.stringify({result:{done:true}}));`
    await install(input)
    expect(await runtime.dispatch('tenant', { event: 'message.created', eventId: randomUUID(), sessionId: 'bound', payload: { text: 'x'.repeat(9 * 1024 * 1024) } })).toMatchObject({ accepted: 1 })
    await runtime.drain()
    expect(await service.getSettings('tenant', 'test-extension')).toMatchObject({ count: 1, length: 9 * 1024 * 1024 })
  })

  it('blocks same-plugin feedback and honors immediate permission revocation', async () => {
    await install(fixture('hooks')); const runtime = lifecycle(); await runtime.start()
    const event = () => ({ event: 'message.created', eventId: randomUUID(), sessionId: 'bound', payload: {} })
    expect(await withPluginEventOrigin('test-extension', () => runtime.dispatch('tenant', event(), true))).toMatchObject({ accepted: 0 })
    await service.setPermissionGrants('tenant', 'test-extension', ['settings.read', 'settings.write'], 1)
    expect(await runtime.dispatch('tenant', event())).toMatchObject({ accepted: 0 })
    expect((await service.getSettings('tenant', 'test-extension')).count).toBeUndefined()
  })

  it('joins a running hook after revocation and does not overlap another event for the same hook', async () => {
    const input = fixture('hooks'); input.manifest.contributes!.hooks![0].args = { delay: 10_000 }
    await install(input); const runtime = lifecycle(); await runtime.start()
    const event = () => ({ event: 'message.created', eventId: randomUUID(), sessionId: 'bound', payload: {} })
    expect(await runtime.dispatch('tenant', event())).toMatchObject({ accepted: 1 })
    await vi.waitFor(async () => expect((await service.getSettings('tenant', input.manifest.id)).started).toBe(true), { timeout: 10_000 })
    expect(await runtime.dispatch('tenant', event())).toMatchObject({ accepted: 0, skipped: 1 })
    await service.setPermissionGrants('tenant', 'test-extension', ['settings.read', 'settings.write'], 1)
    await runtime.drain()
    expect((await service.getSettings('tenant', 'test-extension')).count).toBeUndefined()
  }, 30_000)
})

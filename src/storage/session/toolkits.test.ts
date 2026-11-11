import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RootRunStore } from '../root-runs/index.js'
import { clearSessionToolkits, getSessionToolkits } from './toolkits.js'
import { LocalSqliteProcessClient } from '../sqlite/local-process-client.js'
import { prepareUserAdmission, userAdmissionDigest } from '../root-admission/index.js'

let fixture: string, db: LocalSqliteProcessClient, runs: RootRunStore
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-session-toolkits-'))
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'settings.db')}` })
  runs = new RootRunStore(() => db)
})
afterEach(async () => {
  expect((await db.closeWithReceipt()).healthy).toBe(true)
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-session-toolkits-')) throw new Error('Unsafe cleanup target')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

describe('durable session toolkit selection', () => {
  it('commits alongside a root, survives reopening, preserves explicit empty, and isolates tenants/sessions', async () => {
    expect(await getSessionToolkits('a', 'chat', db)).toEqual([])
    const enabled = await runs.create('a', 'chat', 'model', [], { toolProfile: 'general', toolkits: ['agent-management'] })
    expect(enabled.requestConfig?.toolkits).toEqual(['agent-management'])
    expect((await runs.get('a', enabled.runId))?.request.toolkits).toEqual(['agent-management'])
    expect(await getSessionToolkits('b', 'chat', db)).toEqual([])
    expect(await getSessionToolkits('a', 'other', db)).toEqual([])
    await expect(runs.create('a', 'chat', 'model', [], { toolProfile: 'general', toolkits: [] })).rejects.toThrow('already has')
    expect(await getSessionToolkits('a', 'chat', db)).toEqual(['agent-management'])
    await runs.update('a', enabled.runId, { status: 'succeeded' })
    expect((await db.closeWithReceipt()).healthy).toBe(true)
    db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'settings.db')}` })
    runs = new RootRunStore(() => db)
    expect(await getSessionToolkits('a', 'chat', db)).toEqual(['agent-management'])
    const omitted = await runs.create('a', 'chat', 'model', [], {})
    expect(await getSessionToolkits('a', 'chat', db)).toEqual(['agent-management'])
    await runs.update('a', omitted.runId, { status: 'succeeded' })
    const disabled = await runs.create('a', 'chat', 'model', [], { toolProfile: 'general', toolkits: [] })
    expect(disabled.requestConfig?.toolkits).toEqual([])
    expect(await getSessionToolkits('a', 'chat', db)).toEqual([])
  })

  it('restores a parked run from its snapshot without rewriting the session selection', async () => {
    const run = await runs.create('a', 'chat', 'model', [], { toolkits: ['agent-management'] })
    const pending = { requestId: 'q', toolCallId: 'q', kind: 'permission' as const, toolName: 'agent_do_create', args: {} }
    await runs.pending('a', run.runId, pending)
    await clearSessionToolkits('a', 'chat', db)
    const continued = await runs.answer('a', 'chat', run.runId, 'q', 'q', 'agent_do_create', 'approved')
    expect(continued.run.requestConfig?.toolkits).toEqual(['agent-management'])
    expect(await getSessionToolkits('a', 'chat', db)).toEqual([])
  })

  it('rolls back an invalid selection together with the root admission', async () => {
    await expect(runs.create('a', 'chat', 'model', [], { toolkits: ['unknown'] })).rejects.toThrow('toolkits')
    expect(await runs.list('a', 'chat')).toEqual([])
    expect(await getSessionToolkits('a', 'chat', db)).toEqual([])
  })

  it('does not let an idempotent admission replay restore an old toolkit choice', async () => {
    const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
    const context = await runs.userAdmissionContext('a', 'chat')
    const selector = { protocolVersion: 1 as const, namespace: context.namespace, owner: 'work' as const, predecessor: context.predecessor }
    const body = { sessionId: 'chat', message: '管理 Agent', toolkits: ['agent-management'] }
    const request = { ...body, admission: { ...selector, requestKey: 'stable-key', bodyDigest: userAdmissionDigest(body, transport, selector) } }
    const prepared = prepareUserAdmission(request, transport)!
    const first = await runs.createUserAdmission('a', 'model', [], request, prepared)
    expect(first.duplicate).toBe(false)
    expect(await getSessionToolkits('a', 'chat', db)).toEqual(['agent-management'])
    await clearSessionToolkits('a', 'chat', db)
    const repeated = await runs.createUserAdmission('a', 'model', [], request, prepared)
    expect(repeated.duplicate).toBe(true)
    expect(repeated.run.requestConfig?.toolkits).toEqual(['agent-management'])
    expect(await getSessionToolkits('a', 'chat', db)).toEqual([])
  })
})

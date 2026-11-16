// Synthetic SQLite only: no configured engine database, credentials, model calls or MCP discovery.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Pending, ToolResult } from '../../../core/agent-context/index.js'
import { executeToolBatch, executeRegisteredTool } from '../../../core/agent-loop/tool-batch.js'
import { AgentManagementService } from '../../../core/agent-management.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { up as migrateAgents } from '../../../storage/sqlite/migrations/004_add_agents.js'
import { up as migrateTools } from '../../../storage/sqlite/migrations/008_add_agent_allowed_tools.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { agentRoutes } from '../../../api/http/routes/agents.js'
import { createAgentTools, executePendingAgentAction } from '../agent-tool.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), factory: vi.fn() }))
vi.mock('../../../storage/sqlite/db.js', () => ({ getDb: mocks.getDb, getDbEpoch: () => 1 }))
vi.mock('../../../tools/registry-factory.js', () => ({ createToolRegistry: mocks.factory }))
let db: LocalSqliteProcessClient
let root: string
let app: FastifyInstance
const fixtureParent = path.resolve('.e2e-tmp', 'agent-management')
const manager = new AgentManagementService()
const tools = createAgentTools([{ id: 'client-only', name: 'Client', allowedTools: [] }])
const byName = (name: string) => tools.find(tool => tool.name === name)!
const ctx = () => ({ tenantId: 'test-tenant', sessionId: 'test-session', currentToolCallId: 'call-1' }) as AgentContext
const securityScopes = [['test-tenant', 'test-session'], ['test-tenant', 'session-b'], ['test-tenant', 'child-session'], ['other', 'test-session']] as const

beforeEach(async () => {
  vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
  for (const [tenant, session] of securityScopes) clearSecurityMode(tenant, session)
  fs.mkdirSync(fixtureParent, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  db = new LocalSqliteProcessClient({ url: pathToFileURL(path.join(root, 'agents.db')).href })
  mocks.getDb.mockImplementation(() => db)
  mocks.factory.mockReset().mockResolvedValue({ registry: { list: () => [
    'read_file', 'write_file', 'agent_create', 'todo_create', 'plan_update', 'load_tools', 'calculate',
  ].map(name => ({ name })) } })
  await db.execute('CREATE TABLE conversations(id TEXT PRIMARY KEY)')
  await migrateAgents(db)
  await migrateTools(db)
  app = Fastify()
  app.addHook('onRequest', async request => { (request as any).authContext = { tenantId: request.headers['x-test-tenant'] ?? 'test-tenant' } })
  await app.register(agentRoutes)
})

afterEach(async () => {
  for (const [tenant, session] of securityScopes) clearSecurityMode(tenant, session)
  vi.unstubAllEnvs()
  await app?.close()
  db?.close()
  await db?.whenClosed()
  mocks.getDb.mockImplementation(() => { throw new Error('Agent test tried to use an unowned database') })
  if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (!fs.readdirSync(fixtureParent).length) fs.rmdirSync(fixtureParent)
})

function approved(name: string, args: Record<string, unknown>, result: ToolResult, context = ctx()): AgentContext {
  return { ...context, approvedToolCallId: context.currentToolCallId,
    resumeToolCall: { toolCall: { id: context.currentToolCallId!, name, args }, decision: 'approved',
      pendingAction: JSON.parse(JSON.stringify(result.pendingAction)) } }
}
async function confirmed(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const waiting = await byName(name).execute(args, ctx())
  expect(waiting).toMatchObject({ success: false, status: 'waiting', needsConfirmation: true })
  return byName(name).execute(args, approved(name, args, waiting))
}
const seed = (name = 'Existing', tenantId = 'test-tenant') => manager.create(tenantId, { name, allowedTools: ['read_file'] })

describe('Agent management session full access', () => {
  it('persists create, update and delete without parking an approval in the selected session', async () => {
    setSecurityMode('test-tenant', 'test-session', 'full-access')
    const created = await byName('agent_create').execute({ name: 'Autonomous', allowedTools: [] }, ctx())
    expect(created, created.output).toMatchObject({ success: true, status: 'succeeded' })
    expect(created.needsConfirmation).not.toBe(true)
    expect(created.pendingAction).toBeUndefined()
    const agentId = JSON.parse(created.output).agentChange.id as string
    expect(await manager.get('test-tenant', agentId)).toMatchObject({ name: 'Autonomous', allowedTools: [] })

    const updated = await byName('agent_update').execute({ id: agentId, description: 'Saved by the current session' }, ctx())
    expect(updated, updated.output).toMatchObject({ success: true, status: 'succeeded' })
    expect(updated.pendingAction).toBeUndefined()
    expect(await manager.get('test-tenant', agentId)).toMatchObject({ description: 'Saved by the current session' })

    const deleted = await byName('agent_delete').execute({ id: agentId }, ctx())
    expect(deleted, deleted.output).toMatchObject({ success: true, metadata: { agentChange: { action: 'delete', id: agentId } } })
    expect(await manager.list('test-tenant')).toEqual([])
  })

  it('does not authorize another session or the same session ID in another tenant', async () => {
    setSecurityMode('test-tenant', 'test-session', 'full-access')
    for (const other of [{ ...ctx(), sessionId: 'session-b' }, { ...ctx(), tenantId: 'other' }]) {
      const waiting = await byName('agent_create').execute({ name: 'Needs separate authorization', allowedTools: [] }, other)
      expect(waiting).toMatchObject({ success: false, status: 'waiting', needsConfirmation: true })
      expect(await manager.list(other.tenantId)).toEqual([])
    }
  })

  it('reads the live root-session choice and requires approval again after switching back', async () => {
    setSecurityMode('test-tenant', 'test-session', 'full-access')
    setSecurityMode('test-tenant', 'child-session', 'standard')
    const child = { ...ctx(), sessionId: 'child-session', parentSessionId: 'test-session', rootSessionId: 'test-session' }
    const created = await byName('agent_create').execute({ name: 'Root authorized', allowedTools: [] }, child)
    expect(created.success, created.output).toBe(true)
    const agentId = JSON.parse(created.output).agentChange.id as string
    expect(await byName('agent_update').preflight!({ id: agentId, name: 'Must wait' }, child)).toBeUndefined()
    setSecurityMode('test-tenant', 'test-session', 'standard')
    setSecurityMode('test-tenant', 'child-session', 'full-access')
    const waiting = await byName('agent_update').execute({ id: agentId, name: 'Must wait' }, child)
    expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
    expect((await manager.get('test-tenant', agentId)).name).toBe('Root authorized')
  })

  it('keeps exact frozen approvals when full access is enabled after the preview', async () => {
    const args = { name: 'Frozen after switching' }
    const waiting = await byName('agent_create').execute(args, ctx())
    expect(waiting.needsConfirmation).toBe(true)
    setSecurityMode('test-tenant', 'test-session', 'full-access')
    mocks.factory.mockResolvedValue({ registry: { list: () => [{ name: 'execute_cmd' }] } })
    const result = await byName('agent_create').execute(args, approved('agent_create', args, waiting))
    expect(result).toMatchObject({ success: true, metadata: { agentChange: { agent: { allowedTools: ['read_file', 'write_file'] } } } })
    expect(mocks.factory).toHaveBeenCalledTimes(1)
  })

  it('retains validation and tenant ownership instead of turning failures into confirmations', async () => {
    setSecurityMode('test-tenant', 'test-session', 'full-access')
    const invalid = await byName('agent_create').execute({ name: 'Invalid', temperature: 3 }, ctx())
    expect(invalid).toMatchObject({ success: false, status: 'failed', metadata: { code: 40001 } })
    expect(invalid.needsConfirmation).not.toBe(true)
    const foreign = await seed('Foreign', 'other')
    const denied = await byName('agent_delete').execute({ id: foreign.id }, ctx())
    expect(denied).toMatchObject({ success: false, status: 'failed', metadata: { code: 40400 } })
    expect(denied.pendingAction).toBeUndefined()
    expect(await manager.list('test-tenant')).toEqual([])
    expect((await manager.get('other', foreign.id)).name).toBe('Foreign')
  })
})

// Both entry points use the same production validators, manager and transactional store.
describe('Agent management permissions and durable approval', () => {
  it('creates with recommended defaults when omitted and preserves an explicit empty list', async () => {
    const a = await confirmed('agent_create', { name: 'Default' })
    expect(a).toMatchObject({ success: true, metadata: { agentChange: { action: 'create', agent: { allowedTools: ['read_file', 'write_file'] } } } })
    expect(JSON.parse(a.output).agentChange.id).toBe((a.metadata!.agentChange as any).id)
    expect(mocks.factory).toHaveBeenCalledWith(expect.objectContaining({ allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true }))
    const b = await confirmed('agent_create', { name: 'Disabled', allowedTools: [] })
    expect(b).toMatchObject({ success: true, metadata: { agentChange: { agent: { allowedTools: [] } } } })
  })

  it('freezes the exact default permissions shown before approval across a serialized resume', async () => {
    const args = { name: 'Frozen' }
    const waiting = await byName('agent_create').execute(args, ctx())
    expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
    const operation = waiting.pendingAction!.operation as { input: Record<string, unknown> }
    const expectedReason = `Agent 创建确认\n\n${JSON.stringify(operation.input, null, 2)}\n\n确认后执行以上配置。`
    expect(waiting.output).toBe(expectedReason)
    expect(waiting.pendingAction!.reason).toBe(expectedReason)
    const resumed = approved('agent_create', args, waiting)
    expect(resumed.resumeToolCall!.pendingAction!.reason).toBe(expectedReason)
    mocks.factory.mockResolvedValue({ registry: { list: () => [{ name: 'execute_cmd' }] } })
    const result = await byName('agent_create').execute(args, resumed)
    expect(result).toMatchObject({ success: true, metadata: { agentChange: { agent: { allowedTools: ['read_file', 'write_file'] } } } })
    expect(mocks.factory).toHaveBeenCalledTimes(1)
  })

  it('does not publish legacy aliases or authorize creation by a model boolean', async () => {
    expect(tools.map(tool => tool.name)).toEqual(['agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete'])
    const result = await byName('agent_create').execute({ name: 'Unapproved', confirmed: true }, ctx())
    expect(result.success).toBe(false)
    expect(await manager.list('test-tenant')).toEqual([])
  })

  it('requires real pending metadata, the exact call ID, exact args and tenant', async () => {
    const args = { name: 'Guarded', allowedTools: [] }
    const waiting = await byName('agent_create').execute(args, ctx())
    const authentic = approved('agent_create', args, waiting)
    expect((await byName('agent_create').execute(args, { ...authentic, approvedToolCallId: 'other' })).success).toBe(false)
    expect((await byName('agent_create').execute(args, { ...authentic, resumeToolCall: undefined })).status).toBe('failed')
    expect((await byName('agent_create').execute({ ...args, name: 'Changed' }, authentic)).status).toBe('failed')
    expect((await byName('agent_create').execute(args, { ...authentic, tenantId: 'other' })).status).toBe('failed')
    expect(await manager.list('test-tenant')).toEqual([])
  })

  it('uses a genuine batch pending record and resumes the original call after serialization', async () => {
    const context = ctx()
    context.tools = {
      has: name => !!byName(name),
      preflight: (name, args, c) => byName(name).preflight!(args, c),
      execute: (name, args, c) => byName(name).execute(args, c),
    } as AgentContext['tools']
    const item = { call: { id: 'call-1', name: 'agent_create', args: { name: 'Durable', allowedTools: [] } }, messageId: 'message-1' }
    const batch = await executeToolBatch([item], context)
    expect(batch.pending).toMatchObject({ toolCallId: 'call-1', toolName: 'agent_create', kind: 'permission', status: 'pending' })
    expect(await manager.list('test-tenant')).toEqual([])
    const durable = JSON.parse(JSON.stringify(batch.pending)) as Pending
    const result = await executeRegisteredTool(item, { ...context, approvedToolCallId: durable.toolCallId,
      resumeToolCall: { toolCall: item.call, decision: 'approved', pendingAction: durable.pendingAction } })
    expect(result).toMatchObject({ success: true, metadata: { agentChange: { action: 'create' } } })
    expect(await manager.list('test-tenant')).toHaveLength(1)
  })

  it('reopens the durable waiting run and resumes its frozen operation once through a fresh tool service', async () => {
    let runs = new RootRunStore(() => db)
    const run = await runs.create('test-tenant', 'test-session', 'no-model-call', [], { toolkits: ['agent-management'] })
    const args = { name: 'Reopened fixture' }
    const waiting = await byName('agent_create').execute(args, ctx())
    await runs.pending('test-tenant', run.runId, { requestId: 'call-1', toolCallId: 'call-1', toolName: 'agent_create',
      kind: 'permission', args, pendingAction: waiting.pendingAction })
    db.close()
    await db.whenClosed()
    db = new LocalSqliteProcessClient({ url: pathToFileURL(path.join(root, 'agents.db')).href })
    runs = new RootRunStore(() => db)
    await runs.initialize()
    expect((await runs.get('test-tenant', run.runId))?.status).toBe('waiting')
    const accepted = await runs.answer('test-tenant', 'test-session', run.runId, 'call-1', 'call-1', 'agent_create', 'approved')
    expect(accepted.duplicate).toBe(false)
    mocks.factory.mockResolvedValue({ registry: { list: () => [{ name: 'execute_cmd' }] } })
    const freshTool = createAgentTools([], new AgentManagementService()).find(tool => tool.name === 'agent_create')!
    const result = await freshTool.execute(accepted.pending.args, { ...ctx(), approvedToolCallId: 'call-1',
      resumeToolCall: { toolCall: { id: 'call-1', name: 'agent_create', args: accepted.pending.args }, decision: 'approved',
        pendingAction: accepted.pending.pendingAction as NonNullable<ToolResult['pendingAction']> } })
    expect(result).toMatchObject({ success: true, metadata: { agentChange: { action: 'create', agent: { allowedTools: ['read_file', 'write_file'] } } } })
    expect((await runs.answer('test-tenant', 'test-session', run.runId, 'call-1', 'call-1', 'agent_create', 'approved')).duplicate).toBe(true)
    expect(await manager.list('test-tenant')).toHaveLength(1)
  })

  it.each(['agent_update', 'agent_delete'])('%s rejects model-supplied confirmed:true', async name => {
    const agent = await seed()
    const result = await byName(name).execute({ id: agent.id, confirmed: true, ...(name === 'agent_update' ? { name: 'Unapproved' } : {}) }, ctx())
    expect(result).toMatchObject({ success: false, status: 'failed' })
    expect((await manager.get('test-tenant', agent.id)).name).toBe('Existing')
  })

  it.each(['create', 'update', 'delete'] as const)('resumes a frozen legacy do_%s approval without exposing another tool', async action => {
    const agent = action === 'create' ? undefined : await seed()
    const canonical = `agent_${action}`
    const input = action === 'create' ? { name: 'Legacy created', allowedTools: [] }
      : action === 'update' ? { id: agent!.id, description: 'Legacy updated' } : { id: agent!.id }
    const waiting = await byName(canonical).execute(input, ctx())
    const legacyArgs = { ...input, confirmed: true, ...(action === 'delete' ? { agentName: 'Legacy display only' } : {}) }
    const resumed = approved(`agent_do_${action}`, legacyArgs, waiting)
    const result = await executePendingAgentAction(waiting.pendingAction!, resumed)
    expect(result).toMatchObject({ success: true, metadata: { agentChange: { action } } })
    expect(byName(`agent_do_${action}`)).toBeUndefined()
    expect((await executePendingAgentAction(waiting.pendingAction!, { ...resumed, approvedToolCallId: 'wrong' })).success).toBe(false)
  })

  it('closes the exported legacy pending-action bypass', async () => {
    const result = await executePendingAgentAction({ type: 'agent_create', input: { name: 'Bypass' } }, ctx())
    expect(result.status).toBe('failed')
    expect(await manager.list('test-tenant')).toEqual([])
  })

  it.each([
    { name: ' ' }, { name: 'Invalid', temperature: 3 }, { name: 'Invalid', temperature: '0.7' },
    { name: 'Invalid', allowedTools: null }, { name: 'Invalid', allowedTools: [''] },
    { name: 'Invalid', skills: 'read_file' }, { name: 'Invalid', unexpected: true },
  ])('rejects the same invalid payload through tools and REST: %j', async input => {
    const tool = await byName('agent_create').execute(input, ctx())
    const rest = (await app.inject({ method: 'POST', url: '/agents', payload: input })).json()
    expect(tool).toMatchObject({ success: false, status: 'failed', metadata: { code: 40001 } })
    expect(rest.code).toBe(40001)
    expect(rest.message).toBe(tool.output)
    expect(await manager.list('test-tenant')).toEqual([])
  })

  it('retains omitted permissions during update and clears only explicit empty bindings', async () => {
    const agent = await seed()
    const changed = await confirmed('agent_update', { id: agent.id, description: 'Revised' })
    expect(changed).toMatchObject({ success: true, metadata: { agentChange: { action: 'update', agent: { allowedTools: ['read_file'], description: 'Revised' } } } })
    const cleared = await confirmed('agent_update', { id: agent.id, allowedTools: [] })
    expect(cleared).toMatchObject({ success: true, metadata: { agentChange: { agent: { allowedTools: [] } } } })
  })

  it('rejects stale approvals even when resource changes have the same SQL timestamp', async () => {
    const agent = await seed()
    for (const name of ['agent_update', 'agent_delete']) {
      const args = { id: agent.id, ...(name === 'agent_update' ? { name: 'Renamed' } : {}) }
      const waiting = await byName(name).execute(args, ctx())
      await db.execute('INSERT INTO agent_allowed_tools(agent_id, tool_name) VALUES (?, ?)', [agent.id, name])
      const result = await byName(name).execute(args, approved(name, args, waiting))
      expect(result).toMatchObject({ success: false, status: 'failed', metadata: { code: 40900 } })
      expect((await manager.get('test-tenant', agent.id)).name).toBe('Existing')
    }
  })

  it('never chooses a prefix, wrong tenant or read-only inline Agent as a write target', async () => {
    const agent = await seed()
    await seed('Other', 'other')
    for (const id of [agent.id.slice(0, 8), 'client-only', 'missing']) {
      expect((await byName('agent_update').execute({ id, name: 'Wrong' }, ctx())).success).toBe(false)
      expect((await byName('agent_delete').execute({ id }, ctx())).success).toBe(false)
    }
    expect((await byName('agent_delete').execute({ id: agent.id }, { ...ctx(), tenantId: 'other' })).success).toBe(false)
    expect((await byName('agent_get').execute({ id: agent.id.slice(0, 8) }, ctx())).success).toBe(false)
  })

  it('returns tool permissions from agent_get and marks inline entries as read-only', async () => {
    const agent = await seed()
    const result = await byName('agent_get').execute({ id: agent.id }, ctx())
    expect(JSON.parse(result.output)).toMatchObject({ id: agent.id, allowedTools: ['read_file'], toolPermission: 'explicit', readonly: false })
    const inline = await byName('agent_get').execute({ id: 'client-only' }, ctx())
    expect(JSON.parse(inline.output)).toMatchObject({ allowedTools: [], readonly: true, toolPermission: 'business_tools_disabled' })
  })

  it('reports same-name conflicts instead of success for a different profile or a race after preview', async () => {
    const args = { name: 'Duplicate', allowedTools: [] }
    const waiting = await byName('agent_create').execute(args, ctx())
    const other = await seed('Duplicate')
    const raced = await byName('agent_create').execute(args, approved('agent_create', args, waiting))
    expect(raced).toMatchObject({ success: false, metadata: { code: 40900 } })
    expect((await byName('agent_create').execute(args, ctx())).success).toBe(false)
    expect((await manager.get('test-tenant', other.id)).allowedTools).toEqual(['read_file'])
  })

  it('does not claim deletion success if the record disappears while waiting', async () => {
    const agent = await seed()
    const args = { id: agent.id }
    const waiting = await byName('agent_delete').execute(args, ctx())
    await manager.delete('test-tenant', agent.id)
    const result = await byName('agent_delete').execute(args, approved('agent_delete', args, waiting))
    expect(result).toMatchObject({ success: false, metadata: { code: 40400 } })
    expect(result.metadata).not.toHaveProperty('agentChange')
  })

  it('emits a structured deletion receipt only after the matching row is removed', async () => {
    const agent = await seed()
    const result = await confirmed('agent_delete', { id: agent.id })
    expect(result).toMatchObject({ success: true, metadata: { agentChange: { action: 'delete', id: agent.id } } })
    expect(await manager.list('test-tenant')).toEqual([])
  })
})

describe('Agent REST contract', () => {
  it('canonicalizes legacy permission names and deduplicates the saved selection', async () => {
    const result = (await app.inject({ method: 'POST', url: '/agents', payload: { name: 'Canonical permissions',
      allowedTools: ['agent_do_create', 'agent_create', 'agent_do_update', 'agent_do_delete'] } })).json()
    expect(result.code).toBe(200)
    expect(result.data.allowedTools.slice().sort()).toEqual(['agent_create', 'agent_delete', 'agent_update'])
    expect((await manager.get('test-tenant', result.data.id)).allowedTools.slice().sort()).toEqual(['agent_create', 'agent_delete', 'agent_update'])
  })

  it('uses recommended defaults, preserves explicit empty selections and retains response shape', async () => {
    const omitted = (await app.inject({ method: 'POST', url: '/agents', payload: { name: 'Rest default' } })).json()
    expect(omitted).toMatchObject({ code: 200, data: { name: 'Rest default', allowedTools: ['read_file', 'write_file'] } })
    const empty = (await app.inject({ method: 'POST', url: '/agents', payload: { name: 'Rest empty', allowedTools: [] } })).json()
    expect(empty).toMatchObject({ code: 200, data: { allowedTools: [] } })
    const update = (await app.inject({ method: 'PUT', url: `/agents/${omitted.data.id}`, payload: { description: 'Keep' } })).json()
    expect(update).toMatchObject({ code: 200, data: { description: 'Keep', allowedTools: ['read_file', 'write_file'] } })
  })

  it('rejects wrong tenants, missing deletions and renaming into an existing Agent', async () => {
    const first = await seed('First'), second = await seed('Second')
    expect((await app.inject({ method: 'DELETE', url: `/agents/${first.id}`, headers: { 'x-test-tenant': 'other' } })).json().code).toBe(40400)
    expect((await app.inject({ method: 'PUT', url: `/agents/${second.id}`, payload: { name: 'First' } })).json().code).toBe(40900)
    expect((await app.inject({ method: 'PUT', url: `/agents/${second.id}`, payload: {} })).json().code).toBe(40001)
    expect((await app.inject({ method: 'DELETE', url: '/agents/missing' })).json().code).toBe(40400)
    expect((await app.inject({ method: 'DELETE', url: `/agents/${first.id}` })).json()).toMatchObject({ code: 200, data: { id: first.id } })
  })
})

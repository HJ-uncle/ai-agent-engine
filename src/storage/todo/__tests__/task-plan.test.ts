/** Real SQLite coverage for atomic session plans and legacy tool compatibility; no storage mocks. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { SQLiteConversationHistory } from '../../conversation/history.js'
import { closeDb, getDb, initDb } from '../../sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { TodoStore, type PlanStepInput } from '../index.js'
import { planTool, todoTools } from '../../../tools/todo/todo-tool.js'

let fixture: string
const clients: LocalSqliteProcessClient[] = []
const store = new TodoStore()
const tenant = 'plan-tenant'
const session = 'plan-session'
const steps: PlanStepInput[] = [
  { step: '调查当前实现', status: 'completed' },
  { step: '实现功能', status: 'in_progress' },
  { step: '验证结果', status: 'pending' },
]
function context(tenantId = tenant, sessionId = session): AgentContext {
  return { tenantId, sessionId, workspaceDir: fixture, tools: new ToolRegistry(), history: new SQLiteConversationHistory(), logger: pino({ enabled: false }) }
}
function legacy(name: string) {
  const tool = todoTools.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`Missing fixture tool: ${name}`)
  return tool
}
function connect(): LocalSqliteProcessClient {
  const client = getDb() as LocalSqliteProcessClient
  clients.push(client)
  return client
}
beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-task-plan-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  closeDb()
  connect()
  await initDb()
})
beforeEach(async () => {
  await getDb().execute('DROP TRIGGER IF EXISTS reject_plan_insert')
  await getDb().execute('DELETE FROM task_plan_items')
  await getDb().execute('DELETE FROM task_plans')
  await getDb().execute('DELETE FROM todos')
})
afterAll(async () => {
  closeDb()
  for (const client of clients) client.close()
  await Promise.all(clients.map(client => client.whenClosed()))
  vi.unstubAllEnvs()
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-task-plan-')) throw new Error('Unsafe task plan fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('built-in plan persistence', () => {
  it('writes one ordered plan, maps completed into the existing Todo contract and preserves explanation', async () => {
    const result = await store.updatePlan(tenant, session, { plan: steps, explanation: '已确认范围' })
    expect(result.revision).toBe(1)
    expect(new Set(result.plan.map(item => item.id)).size).toBe(3)
    expect(result.plan.map(({ id: _id, ...item }) => item)).toEqual(steps)
    const todos = await store.list(tenant, session)
    expect(todos.map(item => item.title)).toEqual(steps.map(item => item.step))
    expect(todos.map(item => item.status)).toEqual(['done', 'in_progress', 'pending'])
    expect(await store.getPlan(tenant, session)).toEqual(result)
  })

  it('retries without ids idempotently, retaining ids, revision and timestamps', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps, explanation: '计划' })
    const before = await store.list(tenant, session)
    expect(await store.updatePlan(tenant, session, { plan: steps })).toEqual(first)
    expect(await store.list(tenant, session)).toEqual(before)
  })

  it('renames and reorders stable ids without losing legacy todo metadata', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps })
    const current = first.plan[1]
    await store.update(current.id, tenant, { description: '保留说明', priority: 'high', dueAt: 12345 }, session)
    const second = await store.updatePlan(tenant, session, { plan: [first.plan[2], { ...current, step: '实现与联调', status: 'completed' }, first.plan[0]] })
    expect(second.plan.map(item => item.id)).toEqual([first.plan[2].id, current.id, first.plan[0].id])
    expect(second.revision).toBe(2)
    expect(await store.getById(current.id, tenant, session)).toMatchObject({ id: current.id, title: '实现与联调', status: 'done', priority: 'high', description: '保留说明', dueAt: 12345 })
  })

  it('survives database close/reopen and resumes an unchanged plan without duplicate rows', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps, explanation: '续跑依据' })
    const old = connect()
    closeDb()
    await old.whenClosed()
    connect()
    await initDb()
    expect(await store.getPlan(tenant, session)).toEqual(first)
    expect(await store.updatePlan(tenant, session, { plan: steps })).toEqual(first)
    expect(await store.list(tenant, session)).toHaveLength(3)
  })

  it('atomically removes omitted steps and clears only its own session', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps })
    const sibling = await store.updatePlan(tenant, 'sibling', { plan: steps })
    await store.updatePlan(tenant, session, { plan: [first.plan[1]] })
    expect(await store.getById(first.plan[0].id, tenant)).toBeNull()
    await store.updatePlan(tenant, session, { plan: [], explanation: '取消计划' })
    expect(await store.list(tenant, session)).toEqual([])
    expect(await store.getPlan(tenant, 'sibling')).toEqual(sibling)
  })

  it('isolates tenants with equal session ids and rejects foreign ids before changing anything', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps })
    const foreign = await store.updatePlan('other-tenant', session, { plan: steps })
    await expect(store.updatePlan(tenant, session, { plan: [first.plan[0], { ...foreign.plan[0], step: '伪造引用' }] })).rejects.toThrow('不属于当前会话')
    const sibling = await store.updatePlan(tenant, 'sibling', { plan: steps })
    await expect(store.updatePlan(tenant, session, { plan: [sibling.plan[0]] })).rejects.toThrow('不属于当前会话')
    expect(await store.getPlan(tenant, session)).toEqual(first)
    expect(await store.getPlan('other-tenant', session)).toEqual(foreign)
  })

  it('rejects a partially valid batch without persisting its earlier item', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps })
    await expect(store.updatePlan(tenant, session, { plan: [{ step: '不可先写入', status: 'pending' }, { step: '坏状态', status: 'done' }] })).rejects.toThrow()
    expect(await store.getPlan(tenant, session)).toEqual(first)
  })

  it('rolls back preceding updates, deletes and inserts on a database failure', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps })
    const before = await store.list(tenant, session)
    await getDb().execute(`CREATE TRIGGER reject_plan_insert BEFORE INSERT ON todos WHEN NEW.title='拒绝写入' BEGIN SELECT RAISE(ABORT, 'injected plan failure'); END`)
    await expect(store.updatePlan(tenant, session, { plan: [{ ...first.plan[0], status: 'pending' }, { step: '拒绝写入', status: 'pending' }] })).rejects.toThrow('injected plan failure')
    expect(await store.getPlan(tenant, session)).toEqual(first)
    expect(await store.list(tenant, session)).toEqual(before)
  })

  it('serializes simultaneous initial retries without duplicate ids or revisions', async () => {
    const results = await Promise.all([store.updatePlan(tenant, session, { plan: steps }), store.updatePlan(tenant, session, { plan: steps })])
    expect(results[0]).toEqual(results[1])
    expect(results[0].revision).toBe(1)
    expect(await store.list(tenant, session)).toHaveLength(3)
  })

  it('adopts legacy session todos by exact title without duplicating them', async () => {
    const legacy = await store.create(tenant, { sessionId: session, title: steps[0].step })
    const first = await store.updatePlan(tenant, session, { plan: steps })
    expect(first.plan[0].id).toBe(legacy.id)
    expect(await store.list(tenant, session)).toHaveLength(3)
  })

  it('rejects ambiguous legacy title adoption until a stable id is specified', async () => {
    const first = await store.create(tenant, { sessionId: session, title: '相同标题' })
    const second = await store.create(tenant, { sessionId: session, title: '相同标题' })
    await expect(store.updatePlan(tenant, session, { plan: [{ step: '相同标题', status: 'pending' }] })).rejects.toThrow('匹配多项')
    expect(await store.list(tenant, session)).toHaveLength(2)
    const updated = await store.updatePlan(tenant, session, { plan: [{ id: first.id, step: '相同标题', status: 'pending' }] })
    expect(updated.plan[0].id).toBe(first.id)
    expect(await store.getById(second.id, tenant)).toBeNull()
  })

  it.each([
    null, [], {}, { plan: 'bad' }, { plan: [{ step: '', status: 'pending' }] },
    { plan: [{ step: 'a', status: 'pending' }, { step: 'a', status: 'completed' }] },
    { plan: [{ id: 'same', step: 'a', status: 'pending' }, { id: 'same', step: 'b', status: 'pending' }] },
    { plan: [], sessionId: 'foreign' }, { plan: [], explanation: 123 },
    { plan: [{ step: 'a', status: 'pending', tenantId: 'foreign' }] },
  ])('validates the complete untrusted input %j', async input => {
    const first = await store.updatePlan(tenant, session, { plan: steps })
    await expect(store.updatePlan(tenant, session, input)).rejects.toThrow()
    expect(await store.getPlan(tenant, session)).toEqual(first)
  })

  it('registers its migration idempotently without changing an existing plan', async () => {
    const first = await store.updatePlan(tenant, session, { plan: steps })
    const { up } = await import('../../sqlite/migrations/028_task_plans.js')
    await up(getDb()); await up(getDb())
    expect(await store.getPlan(tenant, session)).toEqual(first)
  })
})

describe('plan entry and legacy compatibility', () => {
  it('returns stable ids for a persisted plan and validates errors as failed receipts', async () => {
    const result = await planTool.execute({ plan: steps }, context())
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output)).toEqual(await store.getPlan(tenant, session))
    expect(result.metadata).toMatchObject({ internalControl: 'plan' })
    const failed = await planTool.execute({ plan: [{ step: 'bad', status: 'done' }] }, context())
    expect(failed.success).toBe(false)
    expect(failed.output).toContain('status')
    expect(await store.list(tenant, session)).toHaveLength(3)
  })

  it.each(['todo_update', 'todo_delete'])('prevents %s from changing another session or tenant', async name => {
    const todo = await store.create(tenant, { title: '私有待办', sessionId: 'other-session' })
    expect((await legacy(name).execute({ id: todo.id, ...(name === 'todo_update' ? { status: 'done' } : {}) }, context())).success).toBe(false)
    expect((await legacy(name).execute({ id: todo.id, ...(name === 'todo_update' ? { status: 'done' } : {}) }, context('other-tenant', 'other-session'))).success).toBe(false)
    expect(await store.getById(todo.id, tenant, 'other-session')).toMatchObject({ title: '私有待办', status: 'pending' })
  })

  it('retains unambiguous legacy prefix updates and rejects ambiguous deletion', async () => {
    const first = await store.create(tenant, { title: 'prefix one', sessionId: session })
    const second = await store.create(tenant, { title: 'prefix two', sessionId: session })
    await getDb().execute({ sql: 'UPDATE todos SET id=? WHERE id=?', args: ['prefix-one', first.id] })
    await getDb().execute({ sql: 'UPDATE todos SET id=? WHERE id=?', args: ['prefix-two', second.id] })
    expect((await legacy('todo_update').execute({ id: 'prefix-o', status: 'done' }, context())).success).toBe(true)
    const ambiguous = await legacy('todo_delete').execute({ id: 'prefix-', }, context())
    expect(ambiguous.success).toBe(false)
    expect(ambiguous.output).toContain('匹配多项')
    expect(await store.list(tenant, session)).toHaveLength(2)
    expect((await legacy('todo_delete').execute({ id: 'prefix-one' }, context())).success).toBe(true)
    expect(await store.getById('prefix-one', tenant, session)).toBeNull()
    expect(await store.getById('prefix-two', tenant, session)).toMatchObject({ status: 'pending' })
  })

  it('keeps legacy create/update/list/delete compatible with the persisted plan', async () => {
    const created = await legacy('todo_create').execute({ title: '兼容待办', priority: 'high', dueAt: '2030-01-01T00:00:00Z' }, context())
    expect(created.success).toBe(true)
    const todo = (await store.list(tenant, session))[0]
    expect((await legacy('todo_update').execute({ id: todo.id, status: 'done' }, context())).success).toBe(true)
    expect((await legacy('todo_list').execute({ status: 'done' }, context())).output).toContain('兼容待办')
    expect((await store.getPlan(tenant, session)).plan[0]).toMatchObject({ id: todo.id, status: 'completed' })
    expect((await legacy('todo_delete').execute({ id: todo.id }, context())).success).toBe(true)
    expect(await store.list(tenant, session)).toEqual([])
  })
})

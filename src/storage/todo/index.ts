import { v4 as uuidv4 } from 'uuid'
import type { InValue, Row, Transaction } from '@libsql/client'
import { z } from 'zod'
import { getDb } from '../sqlite/db.js'

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'
export type TodoPriority = 'low' | 'medium' | 'high'
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface Todo {
  id: string
  tenantId: string
  sessionId?: string
  title: string
  description?: string
  status: TodoStatus
  priority: TodoPriority
  dueAt?: number
  createdAt: number
  updatedAt: number
}
export interface CreateTodoInput {
  title: string
  description?: string
  status?: TodoStatus
  priority?: TodoPriority
  dueAt?: number
  sessionId?: string
}
export interface UpdateTodoInput {
  title?: string
  description?: string
  status?: TodoStatus
  priority?: TodoPriority
  dueAt?: number
}
export interface PlanStepInput { id?: string; step: string; status: PlanStatus }
export interface PlanUpdateInput { plan: PlanStepInput[]; explanation?: string }
export interface TaskPlan {
  plan: Array<PlanStepInput & { id: string }>
  explanation?: string
  revision: number
  updatedAt: number
}

/** Identity validation precedes every mutation; the snapshot belongs only to the rejected request's scope. */
export class TaskPlanIdentityError extends Error {
  readonly code = 'PLAN_ID_NOT_OWNED'
  constructor(message: string, readonly savedPlan: TaskPlan) {
    super(message)
    this.name = 'TaskPlanIdentityError'
  }
}

export const PlanUpdateSchema = z.object({
  plan: z.array(z.object({
    id: z.string().trim().min(1).max(128).optional(),
    step: z.string().trim().min(1).max(240),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  }).strict()).max(100),
  explanation: z.string().trim().max(4000).optional(),
}).strict().superRefine((input, ctx) => {
  const ids = new Set<string>()
  const steps = new Set<string>()
  input.plan.forEach((item, index) => {
    if (item.id && ids.has(item.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plan', index, 'id'], message: '计划 id 不能重复' })
    if (steps.has(item.step)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plan', index, 'step'], message: '计划步骤标题不能重复' })
    if (item.id) ids.add(item.id)
    steps.add(item.step)
  })
})

function rowToTodo(row: Row): Todo {
  return {
    id: String(row.id), tenantId: String(row.tenant_id),
    sessionId: row.session_id == null ? undefined : String(row.session_id),
    title: String(row.title), description: row.description == null ? undefined : String(row.description),
    status: String(row.status) as TodoStatus, priority: String(row.priority) as TodoPriority,
    dueAt: row.due_at == null ? undefined : Number(row.due_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}
function planStatus(status: TodoStatus): PlanStatus { return status === 'done' ? 'completed' : status }
function todoStatus(status: PlanStatus): TodoStatus { return status === 'completed' ? 'done' : status }
function requireScope(tenantId: string, sessionId: string): void {
  if (!tenantId.trim() || !sessionId.trim()) throw new Error('计划必须绑定有效的租户和会话')
}
async function scopedRows(db: Pick<Transaction, 'execute'>, tenantId: string, sessionId: string): Promise<Todo[]> {
  let result: { rows: Row[] }
  try {
    result = await db.execute({
      sql: `SELECT t.* FROM todos t LEFT JOIN task_plan_items p
        ON p.todo_id=t.id AND p.tenant_id=t.tenant_id AND p.session_id=t.session_id
        WHERE t.tenant_id=? AND t.session_id=?
        ORDER BY CASE WHEN p.position IS NULL THEN 1 ELSE 0 END, p.position, t.created_at DESC, t.id`,
      args: [tenantId, sessionId],
    })
  } catch (error) {
    // A legacy database can be opened by a lightweight route before the full
    // migration runner has completed. The ordinary todo table is still a
    // valid fallback; plan ordering becomes available after migration.
    if (!/no such table:\s*task_plan_items/i.test(String(error instanceof Error ? error.message : error))) throw error
    result = await db.execute({
      sql: 'SELECT * FROM todos WHERE tenant_id=? AND session_id=? ORDER BY created_at DESC, id',
      args: [tenantId, sessionId],
    })
  }
  return result.rows.map(rowToTodo)
}
async function readPlan(db: Pick<Transaction, 'execute'>, tenantId: string, sessionId: string): Promise<TaskPlan> {
  const todos = await scopedRows(db, tenantId, sessionId)
  let metadata: Row | undefined
  try {
    const result = await db.execute({ sql: 'SELECT * FROM task_plans WHERE tenant_id=? AND session_id=?', args: [tenantId, sessionId] })
    metadata = result.rows[0]
  } catch (error) {
    if (!/no such table:\s*task_plans/i.test(String(error instanceof Error ? error.message : error))) throw error
  }
  return {
    plan: todos.map(todo => ({ id: todo.id, step: todo.title, status: planStatus(todo.status) })),
    explanation: metadata?.explanation == null ? undefined : String(metadata.explanation),
    revision: Number(metadata?.revision ?? 0), updatedAt: Number(metadata?.updated_at ?? 0),
  }
}

export class TodoStore {
  private get db() { return getDb() }

  async create(tenantId: string, input: CreateTodoInput): Promise<Todo> {
    const id = uuidv4()
    const now = Date.now()
    await this.db.execute({
      sql: `INSERT INTO todos (id, tenant_id, session_id, title, description, status, priority, due_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, tenantId, input.sessionId ?? null, input.title, input.description ?? null,
             input.status ?? 'pending', input.priority ?? 'medium', input.dueAt ?? null, now, now],
    })
    return (await this.getById(id, tenantId, input.sessionId))!
  }

  async getById(id: string, tenantId: string, sessionId?: string): Promise<Todo | null> {
    const args: InValue[] = [id, tenantId]
    const scope = sessionId === undefined ? '' : ' AND session_id=?'
    if (sessionId !== undefined) args.push(sessionId)
    const res = await this.db.execute({ sql: `SELECT * FROM todos WHERE id=? AND tenant_id=?${scope}`, args })
    return res.rows[0] ? rowToTodo(res.rows[0]) : null
  }

  async list(tenantId: string, sessionId?: string): Promise<Todo[]> {
    if (sessionId !== undefined) return scopedRows(this.db, tenantId, sessionId)
    const res = await this.db.execute({ sql: 'SELECT * FROM todos WHERE tenant_id=? ORDER BY created_at DESC, id', args: [tenantId] })
    return res.rows.map(rowToTodo)
  }

  /** Prefixes remain compatible, but never select an arbitrary sibling or another conversation. */
  async resolveSessionId(id: string, tenantId: string, sessionId: string): Promise<Todo | null> {
    requireScope(tenantId, sessionId)
    const exact = await this.getById(id, tenantId, sessionId)
    if (exact) return exact
    const matches = (await this.list(tenantId, sessionId)).filter(todo => todo.id.startsWith(id))
    if (matches.length > 1) throw new Error(`待办 id 前缀「${id}」匹配多项，请提供完整 id`)
    return matches[0] ?? null
  }

  async update(id: string, tenantId: string, input: UpdateTodoInput, sessionId?: string): Promise<Todo | null> {
    const todo = await this.getById(id, tenantId, sessionId)
    if (!todo) return null
    const args: InValue[] = [
      input.title ?? todo.title, input.description !== undefined ? input.description : todo.description ?? null,
      input.status ?? todo.status, input.priority ?? todo.priority,
      input.dueAt !== undefined ? input.dueAt : todo.dueAt ?? null, Date.now(), id, tenantId,
    ]
    if (sessionId !== undefined) args.push(sessionId)
    await this.db.execute({
      sql: `UPDATE todos SET title=?, description=?, status=?, priority=?, due_at=?, updated_at=? WHERE id=? AND tenant_id=?${sessionId === undefined ? '' : ' AND session_id=?'}`,
      args,
    })
    return this.getById(id, tenantId, sessionId)
  }

  async delete(id: string, tenantId: string, sessionId?: string): Promise<boolean> {
    const args: InValue[] = [id, tenantId]
    if (sessionId !== undefined) args.push(sessionId)
    const res = await this.db.execute({ sql: `DELETE FROM todos WHERE id=? AND tenant_id=?${sessionId === undefined ? '' : ' AND session_id=?'}`, args })
    return (res.rowsAffected ?? 0) > 0
  }

  async getPlan(tenantId: string, sessionId: string): Promise<TaskPlan> {
    requireScope(tenantId, sessionId)
    const tx = await this.db.transaction('read')
    try {
      const plan = await readPlan(tx, tenantId, sessionId)
      await tx.commit()
      return plan
    } catch (error) { await tx.rollback(); throw error }
  }

  async updatePlan(tenantId: string, sessionId: string, rawInput: unknown): Promise<TaskPlan> {
    requireScope(tenantId, sessionId)
    // Parse the whole snapshot before opening a write transaction. Never accept tenant/session from model arguments.
    const input = PlanUpdateSchema.parse(rawInput)
    const tx = await this.db.transaction('write')
    try {
      const previous = await readPlan(tx, tenantId, sessionId)
      const existing = new Map(previous.plan.map(item => [item.id, item]))
      const retained = new Set<string>()
      const plan = input.plan.map(item => {
        let id = item.id
        if (id && !existing.has(id)) throw new TaskPlanIdentityError(`计划步骤「${id}」不属于当前会话或不存在`, previous)
        if (!id) {
          const matches = previous.plan.filter(candidate => candidate.step === item.step && !retained.has(candidate.id))
          if (matches.length > 1) throw new Error(`计划步骤「${item.step}」匹配多项，请提供完整 id`)
          id = matches[0]?.id ?? uuidv4()
        }
        if (retained.has(id)) throw new Error('同一计划 id 不能重复引用')
        retained.add(id)
        return { id, step: item.step, status: item.status }
      })
      const explanation = input.explanation ?? previous.explanation
      if (JSON.stringify(plan) === JSON.stringify(previous.plan) && explanation === previous.explanation) {
        await tx.commit()
        return previous
      }
      const now = Date.now()
      // A full plan snapshot replaces only its own session. Read/identity validation and all writes share one lock.
      await tx.execute({ sql: 'DELETE FROM task_plan_items WHERE tenant_id=? AND session_id=?', args: [tenantId, sessionId] })
      for (const item of previous.plan) if (!retained.has(item.id)) {
        await tx.execute({ sql: 'DELETE FROM todos WHERE id=? AND tenant_id=? AND session_id=?', args: [item.id, tenantId, sessionId] })
      }
      for (const [position, item] of plan.entries()) {
        if (existing.has(item.id)) {
          const before = existing.get(item.id)!
          if (before.step !== item.step || before.status !== item.status) await tx.execute({
            sql: 'UPDATE todos SET title=?, status=?, updated_at=? WHERE id=? AND tenant_id=? AND session_id=?',
            args: [item.step, todoStatus(item.status), now, item.id, tenantId, sessionId],
          })
        } else await tx.execute({
          sql: `INSERT INTO todos (id, tenant_id, session_id, title, status, priority, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'medium', ?, ?)`,
          args: [item.id, tenantId, sessionId, item.step, todoStatus(item.status), now, now],
        })
        await tx.execute({ sql: 'INSERT INTO task_plan_items (tenant_id, session_id, todo_id, position) VALUES (?, ?, ?, ?)', args: [tenantId, sessionId, item.id, position] })
      }
      const revision = previous.revision + 1
      await tx.execute({
        sql: `INSERT INTO task_plans (tenant_id, session_id, explanation, revision, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, session_id) DO UPDATE SET explanation=excluded.explanation, revision=excluded.revision, updated_at=excluded.updated_at`,
        args: [tenantId, sessionId, explanation ?? null, revision, now],
      })
      await tx.commit()
      return { plan, explanation, revision, updatedAt: now }
    } catch (error) { await tx.rollback(); throw error }
  }
}

import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../sqlite/db.js'

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'
export type TodoPriority = 'low' | 'medium' | 'high'

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

function rowToTodo(row: Record<string, any>): Todo {
  return {
    id: row['id'],
    tenantId: row['tenant_id'],
    sessionId: row['session_id'] ?? undefined,
    title: row['title'],
    description: row['description'] ?? undefined,
    status: row['status'] as TodoStatus,
    priority: row['priority'] as TodoPriority,
    dueAt: row['due_at'] ?? undefined,
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
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
    return (await this.getById(id, tenantId))!
  }

  async getById(id: string, tenantId: string): Promise<Todo | null> {
    const res = await this.db.execute({ sql: 'SELECT * FROM todos WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    if (!res.rows[0]) return null
    return rowToTodo(res.rows[0] as any)
  }

  async list(tenantId: string, sessionId?: string): Promise<Todo[]> {
    let sql = 'SELECT * FROM todos WHERE tenant_id=?'
    const args: any[] = [tenantId]
    if (sessionId) { sql += ' AND session_id=?'; args.push(sessionId) }
    sql += ' ORDER BY created_at DESC'
    const res = await this.db.execute({ sql, args })
    return res.rows.map(r => rowToTodo(r as any))
  }

  async update(id: string, tenantId: string, input: UpdateTodoInput): Promise<Todo | null> {
    const todo = await this.getById(id, tenantId)
    if (!todo) return null
    const now = Date.now()
    await this.db.execute({
      sql: `UPDATE todos SET title=?, description=?, status=?, priority=?, due_at=?, updated_at=? WHERE id=? AND tenant_id=?`,
      args: [
        input.title ?? todo.title,
        input.description !== undefined ? input.description : todo.description ?? null,
        input.status ?? todo.status,
        input.priority ?? todo.priority,
        input.dueAt !== undefined ? input.dueAt : todo.dueAt ?? null,
        now, id, tenantId,
      ],
    })
    return this.getById(id, tenantId)
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    const res = await this.db.execute({ sql: 'DELETE FROM todos WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    return (res.rowsAffected ?? 0) > 0
  }
}

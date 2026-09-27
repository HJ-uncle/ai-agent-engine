import { getDb } from '../storage/sqlite/db.js'
import type { Row } from '@libsql/client'

type Ctx = { tenantId: string }

export interface PromptTemplate {
  id: number
  tenantId: string
  name: string
  content: string
  description?: string
  isBuiltin: boolean
  createdAt: number
  updatedAt: number
}

export class PromptTemplateStore {
  // Render a template by name, replacing {{variable}} placeholders
  async render(name: string, variables: Record<string, string>, ctx: Ctx): Promise<string> {
    const template = await this.get(name, ctx)
    if (!template) {
      throw new Error(`Prompt template "${name}" not found`)
    }
    return template.content.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      return variables[key] ?? `{{${key}}}`
    })
  }

  async get(name: string, ctx: Ctx): Promise<PromptTemplate | null> {
    const db = getDb()
    // Check tenant-specific first, then fall back to 'default' (built-ins)
    const result = await db.execute({
      sql: `SELECT * FROM prompt_templates 
            WHERE (tenant_id = ? OR (tenant_id = 'default' AND is_builtin = 1)) AND name = ?
            ORDER BY is_builtin ASC LIMIT 1`,
      args: [ctx.tenantId, name],
    })
    const row = result.rows[0]
    return row ? rowToTemplate(row) : null
  }

  async list(ctx: Ctx): Promise<PromptTemplate[]> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT * FROM prompt_templates 
            WHERE tenant_id = ? OR (tenant_id = 'default' AND is_builtin = 1)
            ORDER BY is_builtin DESC, name ASC`,
      args: [ctx.tenantId],
    })
    return result.rows.map(rowToTemplate)
  }

  async create(name: string, content: string, description: string | undefined, ctx: Ctx): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: `INSERT INTO prompt_templates (tenant_id, name, content, description, is_builtin)
            VALUES (?, ?, ?, ?, 0)`,
      args: [ctx.tenantId, name, content, description ?? null],
    })
  }

  async update(name: string, content: string, ctx: Ctx): Promise<boolean> {
    const db = getDb()
    const result = await db.execute({
      sql: `UPDATE prompt_templates 
            SET content = ?, updated_at = unixepoch()
            WHERE tenant_id = ? AND name = ? AND is_builtin = 0`,
      args: [content, ctx.tenantId, name],
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async delete(name: string, ctx: Ctx): Promise<boolean> {
    const db = getDb()
    const result = await db.execute({
      sql: `DELETE FROM prompt_templates 
            WHERE tenant_id = ? AND name = ? AND is_builtin = 0`,
      args: [ctx.tenantId, name],
    })
    return (result.rowsAffected ?? 0) > 0
  }
}

function rowToTemplate(row: Row): PromptTemplate {
  return {
    id: Number(row['id']),
    tenantId: row['tenant_id'] as string,
    name: row['name'] as string,
    content: row['content'] as string,
    description: row['description'] != null ? (row['description'] as string) : undefined,
    isBuiltin: Number(row['is_builtin']) === 1,
    createdAt: Number(row['created_at']) * 1000,
    updatedAt: Number(row['updated_at']) * 1000,
  }
}

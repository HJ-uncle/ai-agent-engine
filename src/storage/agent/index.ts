import { getDb } from '../sqlite/db.js'
import { v4 as uuidv4 } from 'uuid'

export interface Agent {
  id: string
  tenantId: string
  name: string
  description?: string
  systemPrompt?: string
  model?: string
  temperature?: number
  skills: string[]
  mcpServers: string[]
  knowledgeBases: string[]
  allowedTools: string[]
  createdAt: number
  updatedAt: number
}

export type CreateAgentInput = Omit<Agent, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>
export type UpdateAgentInput = Partial<CreateAgentInput>

export class SQLiteAgentStore {
  async create(tenantId: string, input: CreateAgentInput): Promise<Agent> {
    const db = getDb()
    const id = uuidv4()
    
    await db.execute({
      sql: `INSERT INTO agents (id, tenant_id, name, description, system_prompt, model, temperature)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        tenantId,
        input.name,
        input.description ?? null,
        input.systemPrompt ?? null,
        input.model ?? null,
        input.temperature ?? null,
      ]
    })

    await this.updateRelations(id, input.skills, input.mcpServers, input.knowledgeBases, input.allowedTools)
    
    return this.getById(id, tenantId) as Promise<Agent>
  }

  async getById(id: string, tenantId: string): Promise<Agent | null> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT * FROM agents WHERE id = ? AND tenant_id = ?`,
      args: [id, tenantId]
    })

    if (result.rows.length === 0) return null
    const row = result.rows[0]

    // Fetch relations
    const skills = await db.execute({ sql: `SELECT skill_name FROM agent_skills WHERE agent_id = ?`, args: [id] })
    const mcpServers = await db.execute({ sql: `SELECT mcp_server_name FROM agent_mcp WHERE agent_id = ?`, args: [id] })
    const knowledgeBases = await db.execute({ sql: `SELECT knowledge_id FROM agent_knowledge WHERE agent_id = ?`, args: [id] })
    const allowedTools = await db.execute({ sql: `SELECT tool_name FROM agent_allowed_tools WHERE agent_id = ?`, args: [id] })

    return {
      id: String(row['id']),
      tenantId: String(row['tenant_id']),
      name: String(row['name']),
      description: row['description'] ? String(row['description']) : undefined,
      systemPrompt: row['system_prompt'] ? String(row['system_prompt']) : undefined,
      model: row['model'] ? String(row['model']) : undefined,
      temperature: row['temperature'] != null ? Number(row['temperature']) : undefined,
      skills: skills.rows.map(r => String(r['skill_name'])),
      mcpServers: mcpServers.rows.map(r => String(r['mcp_server_name'])),
      knowledgeBases: knowledgeBases.rows.map(r => String(r['knowledge_id'])),
      allowedTools: allowedTools.rows.map(r => String(r['tool_name'])),
      createdAt: Number(row['created_at']) * 1000,
      updatedAt: Number(row['updated_at']) * 1000,
    }
  }

  async list(tenantId: string): Promise<Agent[]> {
    const db = getDb()
    const result = await db.execute({
      sql: `SELECT id FROM agents WHERE tenant_id = ? ORDER BY updated_at DESC`,
      args: [tenantId]
    })

    const agents = []
    for (const row of result.rows) {
      const agent = await this.getById(String(row['id']), tenantId)
      if (agent) agents.push(agent)
    }
    return agents
  }

  async update(id: string, tenantId: string, input: UpdateAgentInput): Promise<Agent | null> {
    const current = await this.getById(id, tenantId)
    if (!current) return null

    const db = getDb()
    
    // Update main table fields if provided
    const fields = []
    const args: any[] = []
    if (input.name !== undefined) { fields.push('name = ?'); args.push(input.name) }
    if (input.description !== undefined) { fields.push('description = ?'); args.push(input.description) }
    if (input.systemPrompt !== undefined) { fields.push('system_prompt = ?'); args.push(input.systemPrompt) }
    if (input.model !== undefined) { fields.push('model = ?'); args.push(input.model) }
    if (input.temperature !== undefined) { fields.push('temperature = ?'); args.push(input.temperature) }

    if (fields.length > 0) {
      fields.push('updated_at = (unixepoch())')
      args.push(id, tenantId)
      await db.execute({
        sql: `UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`,
        args
      })
    }

    // Update relations
    await this.updateRelations(
      id, 
      input.skills ?? current.skills,
      input.mcpServers ?? current.mcpServers,
      input.knowledgeBases ?? current.knowledgeBases,
      input.allowedTools ?? current.allowedTools
    )

    return this.getById(id, tenantId)
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    const db = getDb()
    const result = await db.execute({
      sql: `DELETE FROM agents WHERE id = ? AND tenant_id = ?`,
      args: [id, tenantId]
    })
    return result.rowsAffected > 0
  }

  private async updateRelations(id: string, skills: string[], mcpServers: string[], knowledgeBases: string[], allowedTools: string[]) {
    const db = getDb()
    
    // Replace skills
    await db.execute({ sql: `DELETE FROM agent_skills WHERE agent_id = ?`, args: [id] })
    for (const skill of skills) {
      await db.execute({ sql: `INSERT INTO agent_skills (agent_id, skill_name) VALUES (?, ?)`, args: [id, skill] })
    }

    // Replace MCPs
    await db.execute({ sql: `DELETE FROM agent_mcp WHERE agent_id = ?`, args: [id] })
    for (const mcp of mcpServers) {
      await db.execute({ sql: `INSERT INTO agent_mcp (agent_id, mcp_server_name) VALUES (?, ?)`, args: [id, mcp] })
    }

    // Replace Knowledge
    await db.execute({ sql: `DELETE FROM agent_knowledge WHERE agent_id = ?`, args: [id] })
    for (const kb of knowledgeBases) {
      await db.execute({ sql: `INSERT INTO agent_knowledge (agent_id, knowledge_id) VALUES (?, ?)`, args: [id, kb] })
    }

    // Replace allowedTools
    await db.execute({ sql: `DELETE FROM agent_allowed_tools WHERE agent_id = ?`, args: [id] })
    for (const tool of allowedTools) {
      await db.execute({ sql: `INSERT INTO agent_allowed_tools (agent_id, tool_name) VALUES (?, ?)`, args: [id, tool] })
    }
  }
}

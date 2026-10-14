import { getDb } from '../sqlite/db.js'
import { v4 as uuidv4 } from 'uuid'
import type { Client, InValue, Transaction } from '@libsql/client'

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
    return this.transaction('write', async db => {
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

      await this.updateRelations(
        db,
        id,
        {
          skills: input.skills ?? [],
          mcpServers: input.mcpServers ?? [],
          knowledgeBases: input.knowledgeBases ?? [],
          allowedTools: input.allowedTools ?? [],
        }
      )

      const created = await this.readById(db, id, tenantId)
      if (!created) throw new Error('Created agent could not be read in its transaction')
      return created
    })
  }

  async getById(id: string, tenantId: string): Promise<Agent | null> {
    return this.transaction('read', db => this.readById(db, id, tenantId))
  }

  private async readById(db: Pick<Client, 'execute'>, id: string, tenantId: string): Promise<Agent | null> {
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
    return this.transaction('read', async db => {
      const result = await db.execute({
        sql: `SELECT * FROM agents WHERE tenant_id = ? ORDER BY updated_at DESC`,
        args: [tenantId]
      })

      if (result.rows.length === 0) return []

      const agentIds = result.rows.map(r => String(r['id']))
      const placeholders = agentIds.map(() => '?').join(',')

      // Fetch all relations in bulk
      const [allSkills, allMcps, allKbs, allTools] = await Promise.all([
        db.execute({ sql: `SELECT agent_id, skill_name FROM agent_skills WHERE agent_id IN (${placeholders})`, args: agentIds }),
        db.execute({ sql: `SELECT agent_id, mcp_server_name FROM agent_mcp WHERE agent_id IN (${placeholders})`, args: agentIds }),
        db.execute({ sql: `SELECT agent_id, knowledge_id FROM agent_knowledge WHERE agent_id IN (${placeholders})`, args: agentIds }),
        db.execute({ sql: `SELECT agent_id, tool_name FROM agent_allowed_tools WHERE agent_id IN (${placeholders})`, args: agentIds }),
      ])

      // Group relations by agent_id
      const skillsMap: Record<string, string[]> = {}
      const mcpsMap: Record<string, string[]> = {}
      const kbsMap: Record<string, string[]> = {}
      const toolsMap: Record<string, string[]> = {}

      allSkills.rows.forEach(r => {
        const aid = String(r['agent_id'])
        if (!skillsMap[aid]) skillsMap[aid] = []
        skillsMap[aid].push(String(r['skill_name']))
      })
      allMcps.rows.forEach(r => {
        const aid = String(r['agent_id'])
        if (!mcpsMap[aid]) mcpsMap[aid] = []
        mcpsMap[aid].push(String(r['mcp_server_name']))
      })
      allKbs.rows.forEach(r => {
        const aid = String(r['agent_id'])
        if (!kbsMap[aid]) kbsMap[aid] = []
        kbsMap[aid].push(String(r['knowledge_id']))
      })
      allTools.rows.forEach(r => {
        const aid = String(r['agent_id'])
        if (!toolsMap[aid]) toolsMap[aid] = []
        toolsMap[aid].push(String(r['tool_name']))
      })

      return result.rows.map(row => {
        const id = String(row['id'])
        return {
          id,
          tenantId: String(row['tenant_id']),
          name: String(row['name']),
          description: row['description'] ? String(row['description']) : undefined,
          systemPrompt: row['system_prompt'] ? String(row['system_prompt']) : undefined,
          model: row['model'] ? String(row['model']) : undefined,
          temperature: row['temperature'] != null ? Number(row['temperature']) : undefined,
          skills: skillsMap[id] ?? [],
          mcpServers: mcpsMap[id] ?? [],
          knowledgeBases: kbsMap[id] ?? [],
          allowedTools: toolsMap[id] ?? [],
          createdAt: Number(row['created_at']) * 1000,
          updatedAt: Number(row['updated_at']) * 1000,
        }
      })
    })
  }

  async update(id: string, tenantId: string, input: UpdateAgentInput): Promise<Agent | null> {
    return this.transaction('write', async db => {
      // BEGIN IMMEDIATE protects the existence check and partial update together.
      // No relation can be overwritten from a profile read before another writer.
      const current = await this.readById(db, id, tenantId)
      if (!current) return null

      // Update main table fields if provided
      const fields = []
      const args: InValue[] = []
      if (input.name !== undefined) { fields.push('name = ?'); args.push(input.name) }
      if (input.description !== undefined) { fields.push('description = ?'); args.push(input.description) }
      if (input.systemPrompt !== undefined) { fields.push('system_prompt = ?'); args.push(input.systemPrompt) }
      if (input.model !== undefined) { fields.push('model = ?'); args.push(input.model) }
      if (input.temperature !== undefined) { fields.push('temperature = ?'); args.push(input.temperature) }

      const bindingsChanged = input.skills !== undefined || input.mcpServers !== undefined
        || input.knowledgeBases !== undefined || input.allowedTools !== undefined
      if (fields.length > 0 || bindingsChanged) {
        fields.push('updated_at = (unixepoch())')
        args.push(id, tenantId)
        await db.execute({
          sql: `UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`,
          args
        })
      }

      // Update relations
      await this.updateRelations(db, id, input)

      return this.readById(db, id, tenantId)
    })
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    return this.transaction('write', async db => {
      const result = await db.execute({
        sql: `DELETE FROM agents WHERE id = ? AND tenant_id = ?`,
        args: [id, tenantId]
      })
      return result.rowsAffected > 0
    })
  }

  private async updateRelations(db: Transaction, id: string, input: UpdateAgentInput) {
    // Leave omitted bindings untouched; an empty array explicitly clears them.
    // Replace skills
    if (input.skills !== undefined) {
      await db.execute({ sql: `DELETE FROM agent_skills WHERE agent_id = ?`, args: [id] })
      for (const skill of input.skills) {
        await db.execute({ sql: `INSERT INTO agent_skills (agent_id, skill_name) VALUES (?, ?)`, args: [id, skill] })
      }
    }

    // Replace MCPs
    if (input.mcpServers !== undefined) {
      await db.execute({ sql: `DELETE FROM agent_mcp WHERE agent_id = ?`, args: [id] })
      for (const mcp of input.mcpServers) {
        await db.execute({ sql: `INSERT INTO agent_mcp (agent_id, mcp_server_name) VALUES (?, ?)`, args: [id, mcp] })
      }
    }

    // Replace Knowledge
    if (input.knowledgeBases !== undefined) {
      await db.execute({ sql: `DELETE FROM agent_knowledge WHERE agent_id = ?`, args: [id] })
      for (const kb of input.knowledgeBases) {
        await db.execute({ sql: `INSERT INTO agent_knowledge (agent_id, knowledge_id) VALUES (?, ?)`, args: [id, kb] })
      }
    }

    // Replace allowedTools
    if (input.allowedTools !== undefined) {
      await db.execute({ sql: `DELETE FROM agent_allowed_tools WHERE agent_id = ?`, args: [id] })
      for (const tool of input.allowedTools) {
        await db.execute({ sql: `INSERT INTO agent_allowed_tools (agent_id, tool_name) VALUES (?, ?)`, args: [id, tool] })
      }
    }
  }

  private async transaction<T>(mode: 'read' | 'write', operation: (db: Transaction) => Promise<T>): Promise<T> {
    const tx = await getDb().transaction(mode)
    try {
      const result = await operation(tx)
      await tx.commit()
      return result
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        // Retain both failures: close is a final release attempt, not an ACK
        // proving that an interrupted rollback was durably completed.
        throw new AggregateError([error, rollbackError],
          'Agent configuration transaction failed; rollback was not confirmed', { cause: error })
      }
      throw error
    } finally {
      tx.close()
    }
  }
}

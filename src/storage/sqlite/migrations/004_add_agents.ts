import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  const statements = [
    // Create agents table
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT,
      model TEXT,
      temperature REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id)`,

    // Create agent_skills mapping table
    `CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skill_name TEXT NOT NULL,
      PRIMARY KEY(agent_id, skill_name)
    )`,

    // Create agent_mcp mapping table
    `CREATE TABLE IF NOT EXISTS agent_mcp (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_server_name TEXT NOT NULL,
      PRIMARY KEY(agent_id, mcp_server_name)
    )`,

    // Create agent_knowledge mapping table (binding to documents or categories)
    `CREATE TABLE IF NOT EXISTS agent_knowledge (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      knowledge_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, knowledge_id)
    )`,

    // Add agent_id to conversations to bind a session to an agent
    `ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id)`
  ]

  await client.batch(statements.map((sql) => ({ sql })), 'write')
}

export async function down(client: Client): Promise<void> {
  const statements = [
    `DROP INDEX IF EXISTS idx_conversations_agent_id`,
    `ALTER TABLE conversations DROP COLUMN agent_id`,
    `DROP TABLE IF EXISTS agent_knowledge`,
    `DROP TABLE IF EXISTS agent_mcp`,
    `DROP TABLE IF EXISTS agent_skills`,
    `DROP INDEX IF EXISTS idx_agents_tenant`,
    `DROP TABLE IF EXISTS agents`
  ]

  await client.batch(statements.map((sql) => ({ sql })), 'write')
}

import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS agent_allowed_tools (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        PRIMARY KEY (agent_id, tool_name)
      )
    `)
  } catch (err: any) {
    if (!err.message?.includes('already exists')) {
      throw err
    }
  }
}

export async function down(client: Client): Promise<void> {
  await client.execute(`DROP TABLE IF EXISTS agent_allowed_tools`)
}
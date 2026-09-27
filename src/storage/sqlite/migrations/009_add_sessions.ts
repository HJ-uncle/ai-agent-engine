import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  try {
    /**
     * sessions 表：记录每个会话首次绑定的 agentId。
     *
     * - 会话第一条消息时写入（agent_id 可为 NULL，表示无 Agent 裸对话）
     * - 后续请求只能沿用该 agent_id，不允许切换
     */
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT NOT NULL,
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        agent_id    TEXT,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (session_id, tenant_id)
      )
    `)
  } catch (err: any) {
    if (!err.message?.includes('already exists')) throw err
  }
}

export async function down(client: Client): Promise<void> {
  await client.execute(`DROP TABLE IF EXISTS sessions`)
}

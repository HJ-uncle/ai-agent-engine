import { getDb } from '../sqlite/db.js'

/**
 * SessionStore：管理会话与 Agent 的绑定关系。
 *
 * 规则：
 * - 会话首次发送消息时，绑定当前 agentId（可为 null，表示裸对话）
 * - 后续请求只能使用同一 agentId，不允许切换
 * - 通过 `bindAgent` 写入绑定，`getBoundAgentId` 查询绑定
 */
export class SessionStore {
  private db = getDb()

  /**
   * 获取会话已绑定的 agentId。
   * 返回 undefined 表示该会话尚无记录（首次请求）。
   * 返回 null 表示该会话绑定了"无 Agent"（裸对话）。
   * 返回字符串表示已绑定具体 Agent。
   */
  async getBoundAgentId(sessionId: string, tenantId: string): Promise<string | null | undefined> {
    const result = await this.db.execute({
      sql: `SELECT agent_id FROM sessions WHERE session_id = ? AND tenant_id = ? LIMIT 1`,
      args: [sessionId, tenantId],
    })
    if (result.rows.length === 0) return undefined
    const row = result.rows[0]
    const agentId = row['agent_id']
    return agentId === null ? null : String(agentId)
  }

  /**
   * 首次绑定会话与 agentId（INSERT OR IGNORE，保证只写一次）。
   */
  async bindAgent(sessionId: string, tenantId: string, agentId: string | null): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR IGNORE INTO sessions (session_id, tenant_id, agent_id) VALUES (?, ?, ?)`,
      args: [sessionId, tenantId, agentId ?? null],
    })
  }

  /**
   * 清除会话绑定（删除会话历史时同步调用，允许重新选择 Agent）。
   */
  async clearBinding(sessionId: string, tenantId: string): Promise<void> {
    await this.db.execute({
      sql: `DELETE FROM sessions WHERE session_id = ? AND tenant_id = ?`,
      args: [sessionId, tenantId],
    })
  }
}

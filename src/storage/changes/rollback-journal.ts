import type { Client } from '@libsql/client'
import { getDb } from '../sqlite/db.js'
import type { RevertBatchResult } from './index.js'

export interface ConversationRollback {
  state: 'pending' | 'files_reverted' | 'succeeded'
  turnIds: string[]
  roots: Array<{ runId: string; turnId: string; attemptId?: string }>
  changeIds: string[]
  report?: RevertBatchResult
}

const schemas = new WeakMap<Client, Promise<void>>()

/** Exact identities make unknown HTTP outcomes and restart retries safe after
 * the original root/messages are gone. No transcript or file bytes are copied. */
export class RollbackJournal {
  private async ready(): Promise<Client> {
    const db = getDb()
    let ready = schemas.get(db)
    if (!ready) {
      ready = db.execute(`CREATE TABLE IF NOT EXISTS conversation_rollback_requests (
        tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, request_key TEXT NOT NULL, message_id TEXT NOT NULL,
        record TEXT NOT NULL, PRIMARY KEY (tenant_id,session_id,request_key)
      )`).then(() => {})
      schemas.set(db, ready)
      ready.catch(() => { if (schemas.get(db) === ready) schemas.delete(db) })
    }
    await ready
    return db
  }

  async get(tenantId: string, sessionId: string, messageId: string, requestKey: string): Promise<ConversationRollback | undefined> {
    const db = await this.ready()
    const result = await db.execute({ sql: 'SELECT message_id,record FROM conversation_rollback_requests WHERE tenant_id=? AND session_id=? AND request_key=?',
      args: [tenantId, sessionId, requestKey] })
    if (result.rows[0] && result.rows[0].message_id !== messageId)
      throw Object.assign(new Error('回退请求标识已绑定另一个目标消息'), { statusCode: 409 })
    return result.rows[0] ? JSON.parse(String(result.rows[0].record)) as ConversationRollback : undefined
  }

  /** Caller owns the session history mutation lease for every update. */
  async save(tenantId: string, sessionId: string, messageId: string, requestKey: string, record: ConversationRollback): Promise<void> {
    const db = await this.ready()
    await db.execute({ sql: `INSERT INTO conversation_rollback_requests(tenant_id,session_id,request_key,message_id,record) VALUES(?,?,?,?,?)
      ON CONFLICT(tenant_id,session_id,request_key) DO UPDATE SET record=excluded.record WHERE message_id=excluded.message_id`,
      args: [tenantId, sessionId, requestKey, messageId, JSON.stringify(record)] })
  }
}

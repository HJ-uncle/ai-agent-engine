// Fresh native Node process: persisted maintenance is the only recovery input.
import fs from 'node:fs'
import path from 'node:path'
import { JSONLConversationHistory } from '../../../../storage/conversation/jsonl-history.js'
import { readAuthenticatedJSONLHistory } from '../../../../storage/conversation/jsonl-origin.js'
import { getDb, closeDb } from '../../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'

const input = JSON.parse(process.argv[2]) as { tenantId: string; sessionId: string; turnId: string; anchorId: string }
const db = getDb() as LocalSqliteProcessClient
let result: Record<string, unknown>
try {
  const history = new JSONLConversationHistory()
  await history.append({ id: 'fresh-process-marker', role: 'assistant', content: 'Fresh process continued exact reserved bytes', conversationId: input.turnId }, input)
  const messages = await readAuthenticatedJSONLHistory(history, input)
  const receipt = (await db.execute('SELECT state FROM collaboration_history_maintenance')).rows
  const file = path.join(path.dirname(process.env.DATA_DIR!), 'sessions', input.tenantId, input.sessionId + '.jsonl')
  const rows = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line) as { type: string }] } catch { return [] } })
  result = { recovered: true, pid: process.pid, anchor: messages?.find(message => message.id === input.anchorId),
    messageIds: messages?.map(message => message.id), receiptStates: receipt.map(row => row.state), summaryRows: rows.filter(row => row.type === 'summary').length }
} catch (error) {
  result = { recovered: false, pid: process.pid, error: error instanceof Error ? error.message : String(error) }
}
await closeDb()
const closed = await db.closeWithReceipt()
console.log(JSON.stringify({ ...result, healthyClose: closed.healthy }))

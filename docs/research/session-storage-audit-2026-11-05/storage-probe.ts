/** Read-only audit of engine code; writes synthetic data only to an OS temporary directory. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-session-audit-'))
process.env.DATA_DIR = path.join(fixture, 'agent.db')
process.env.HISTORY_MAX_TOKENS = '1'
process.env.OSM_MODE = 'off'
const { initDb, closeDb } = await import('../../../src/storage/sqlite/db.js')
const { JSONLConversationHistory } = await import('../../../src/storage/conversation/jsonl-history.js')
const { SQLiteConversationHistory } = await import('../../../src/storage/conversation/history.js')
const result: Record<string, unknown> = {}
try {
  await initDb()
  const ctx = { tenantId: 'audit', sessionId: 'partial-tail' }
  const history = new JSONLConversationHistory()
  await history.append({ id: 'before', role: 'user', content: 'synthetic before' }, ctx)
  fs.appendFileSync(path.join(fixture, 'sessions', ctx.tenantId, ctx.sessionId + '.jsonl'), '{"type":"assistant","payload":')
  await history.append({ id: 'after', role: 'assistant', content: 'synthetic after' }, ctx)
  result.partialTail = {
    warmIds: (await history.getFullHistory(ctx)).map(message => message.id),
    coldIds: (await new JSONLConversationHistory().getFullHistory(ctx)).map(message => message.id),
  }

  const duplicateCtx = { tenantId: 'audit', sessionId: 'compacted-id' }
  const duplicateHistory = new JSONLConversationHistory()
  for (let index = 0; index < 6; index++) {
    await duplicateHistory.append({ id: 'message-' + index, role: index % 2 ? 'assistant' : 'user',
      content: 'synthetic message ' + index, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }, duplicateCtx)
  }
  await duplicateHistory.compress(duplicateCtx, async () => 'synthetic summary', 2)
  await duplicateHistory.append({ id: 'message-0', role: 'user', content: 'synthetic message 0',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }, duplicateCtx)
  result.compactedOrdinaryAppend = {
    archivedMessage0Copies: (await duplicateHistory.getArchive(duplicateCtx)).messages.filter(message => message.id === 'message-0').length,
    totalTokens: (await duplicateHistory.getSessionUsage(duplicateCtx)).totalTokens,
  }

  for (const [name, backend] of [['jsonl', new JSONLConversationHistory()], ['sqlite', new SQLiteConversationHistory()]] as const) {
    const backendCtx = { tenantId: 'audit', sessionId: 'window-' + name }
    for (let index = 0; index < 4; index++) await backend.append({ id: name + index, role: index % 2 ? 'assistant' : 'user',
      content: 'synthetic window ' + index, tokens: 20 }, backendCtx)
    result[name] = {
      defaultWindowMessages: (await backend.getHistory(backendCtx)).length,
      inheritFalseRoles: (await backend.getHistory({ ...backendCtx, inheritContext: false })).map(message => message.role),
    }
  }
  console.log('AUDIT_RESULT=' + JSON.stringify(result))
} finally {
  await closeDb()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-session-audit-')) throw new Error('Unsafe cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

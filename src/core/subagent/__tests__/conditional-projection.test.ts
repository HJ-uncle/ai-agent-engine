/** Real SQLite/outbox/JSONL tests for atomic projection, cold replay fences and uncertain write recovery. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationHistory, ConversationToolCallAnchor, Message } from '../../agent-context/types.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../store.js'
import { projectPendingSubagents } from '../projection.js'
import { serializeConversationHistory, bindHistoryGeneration, invalidateSessionHistory } from '../../../storage/conversation/serialization.js'
import { ensureProjectionReceipts } from '../../../storage/conversation/projection-receipts.js'
const state = vi.hoisted(() => ({ db: null as unknown as LocalSqliteProcessClient, store: null as unknown as SubagentStore }))
vi.mock('../../../storage/sqlite/db.js', () => ({ getDb: () => state.db }))
vi.mock('../store.js', async original => ({ ...await original<typeof import('../store.js')>(), getSubagentStore: () => state.store }))
const ctx = { tenantId: 'tenant', sessionId: 'parent' }
const anchor: ConversationToolCallAnchor = { messageId: 'dispatch', toolCallId: 'spawn', conversationId: 'turn' }
const fixtureBase = path.resolve('.e2e-tmp')
let fixture: string
let runId: string
const jsonlFile = (scope = ctx) => path.join(fixture, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
const resultId = () => 'subagent-result:' + runId
const result = (): Message & { conversationId: string } => ({ id: resultId(), role: 'tool', toolCallId: anchor.toolCallId,
  toolName: 'subagent', content: 'Synthetic child result', conversationId: anchor.conversationId })
const createHistory = (backend: 'sqlite' | 'jsonl') => backend === 'sqlite' ? new SQLiteConversationHistory() : new JSONLConversationHistory()
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function seedMessages(history: ConversationHistory, scope = ctx, key = anchor) {
  await history.append({ id: 'user', role: 'user', content: 'Synthetic task', ...{ conversationId: key.conversationId } }, scope)
  await history.append({ id: key.messageId, role: 'assistant', content: '', toolCall: { id: key.toolCallId, name: 'subagent', args: {} },
    ...{ conversationId: key.conversationId } }, scope)
}
async function seed(backend: 'sqlite' | 'jsonl') {
  const history = createHistory(backend)
  await seedMessages(history)
  const run = (await state.store.createRun({ ...ctx, rootSessionId: ctx.sessionId, parentSessionId: ctx.sessionId,
    parentConversationId: anchor.conversationId, parentMessageId: anchor.messageId, parentToolCallId: anchor.toolCallId,
    childSessionId: 'child', task: 'Synthetic task', description: 'Synthetic task', modelId: 'test' })).snapshot
  runId = run.runId
  await state.store.appendSnapshot(ctx.tenantId, runId, 'finished', { status: 'succeeded', resultSummary: 'Synthetic child result' })
  return history
}
async function receipt() {
  return (await state.db.execute({ sql: 'SELECT * FROM conversation_projection_receipts WHERE tenant_id=? AND session_id=? AND message_id=?',
    args: [ctx.tenantId, ctx.sessionId, resultId()] })).rows[0]
}
async function rawResultCount(backend: 'sqlite' | 'jsonl') {
  if (backend === 'sqlite') return Number((await state.db.execute({ sql: 'SELECT COUNT(*) AS count FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?',
    args: [ctx.tenantId, ctx.sessionId, resultId()] })).rows[0].count)
  if (!fs.existsSync(jsonlFile())) return 0
  return fs.readFileSync(jsonlFile(), 'utf8').split('\n').reduce((count, line) => {
    try { return count + Number(JSON.parse(line).uuid === resultId()) } catch { return count }
  }, 0)
}
async function mutate(history: ConversationHistory, kind: string) {
  if (kind === 'message') await history.deleteMessage(anchor.messageId, ctx.tenantId)
  if (kind === 'result') await history.deleteMessage(resultId(), ctx.tenantId)
  if (kind === 'turn') await history.deleteByConversationId(anchor.conversationId, ctx.tenantId)
  if (kind === 'clear') await history.clear(ctx, { tombstone: false })
  if (kind === 'truncate') await history.deleteMessagesAfterId((await history.getMessageById('user', ctx.tenantId))!.dbId, ctx.sessionId, ctx.tenantId)
  if (kind === 'compact') {
    await history.append({ id: 'old-answer', role: 'assistant', content: 'Old answer' }, ctx)
    await history.append({ id: 'new-user', role: 'user', content: 'New task' }, ctx)
    await history.compress(ctx, async () => 'Synthetic compacted summary', 1)
  }
}
beforeEach(async () => {
  fs.mkdirSync(fixtureBase, { recursive: true })
  fixture = fs.mkdtempSync(path.join(fixtureBase, 'g7-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  state.db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'agent.db').replaceAll('\\', '/')}` })
  await state.db.execute(`CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, session_id TEXT, conversation_id TEXT,
    message_id TEXT, role TEXT, content TEXT, reasoning_content TEXT, tool_call_id TEXT, tool_call_name TEXT, tool_name TEXT, tool_args TEXT,
    tokens INTEGER, token_usage TEXT, model_id TEXT, metadata TEXT, created_at INTEGER DEFAULT (unixepoch()))`)
  await state.db.execute('CREATE TABLE sessions (tenant_id TEXT, session_id TEXT, agent_id TEXT, metadata TEXT)')
  state.store = new SubagentStore(state.db)
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); state.db.close(); await state.db.whenClosed()
  if (path.dirname(fixture) !== fixtureBase || !path.basename(fixture).startsWith('g7-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe.each(['sqlite', 'jsonl'] as const)('conditional projection on %s', backend => {
  it.each(['message', 'turn', 'clear', 'truncate', 'compact'])('suppresses a %s removed before conditional persistence', async mutation => {
    const history = await seed(backend)
    await mutate(history, mutation)
    await projectPendingSubagents(createHistory(backend), ctx.tenantId)
    expect(await rawResultCount(backend)).toBe(0)
    expect(await receipt()).toMatchObject({ disposition: 'suppressed', tenant_id: ctx.tenantId, session_id: ctx.sessionId,
      anchor_message_id: anchor.messageId, anchor_tool_call_id: anchor.toolCallId, anchor_conversation_id: anchor.conversationId })
    expect(await state.store.listPendingParentProjections(ctx.tenantId)).toEqual([])
  })
  it.each(['result', 'turn', 'clear', 'truncate', 'compact'])('cold retry after lost ACK and %s cannot resurrect the result', async mutation => {
    const history = await seed(backend)
    vi.spyOn(state.store, 'ackProjection').mockRejectedValueOnce(new Error('lost outbox ACK'))
    await expect(projectPendingSubagents(history, ctx.tenantId)).rejects.toThrow('lost outbox ACK')
    expect(await receipt()).toMatchObject({ disposition: 'appended' })
    expect(await state.store.listPendingParentProjections(ctx.tenantId)).toHaveLength(1)
    await mutate(history, mutation)
    if (mutation === 'clear' || mutation === 'truncate') await seedMessages(history)
    const countAfterMutation = await rawResultCount(backend)
    const cold = createHistory(backend)
    await projectPendingSubagents(cold, ctx.tenantId)
    expect(await rawResultCount(backend)).toBe(countAfterMutation)
    expect((await cold.getFullHistory(ctx)).filter(message => message.id === resultId())).toEqual([])
    expect(await state.store.listPendingParentProjections(ctx.tenantId)).toEqual([])
  })
  it('two concurrent projector instances persist one stable result and ledger receipt', async () => {
    await seed(backend)
    await Promise.all([projectPendingSubagents(createHistory(backend), ctx.tenantId), projectPendingSubagents(createHistory(backend), ctx.tenantId)])
    expect(await rawResultCount(backend)).toBe(1)
    expect(await receipt()).toMatchObject({ disposition: 'appended' })
    expect(await state.store.listPendingParentProjections(ctx.tenantId)).toEqual([])
  })
  it('same result ID is independent by tenant and session, but a scoped anchor collision fails closed', async () => {
    const history = await seed(backend)
    expect(await history.appendIfActiveToolCallAnchor!(result(), ctx, anchor)).toMatchObject({ disposition: 'appended' })
    for (const scope of [{ ...ctx, tenantId: 'tenant-other' }, { ...ctx, sessionId: 'parent-other' }]) {
      await seedMessages(history, scope)
      expect(await history.appendIfActiveToolCallAnchor!(result(), scope, anchor)).toMatchObject({ disposition: 'appended' })
    }
    const foreign = { ...anchor, messageId: 'another-dispatch' }
    await history.append({ id: foreign.messageId, role: 'assistant', content: '', toolCall: { id: foreign.toolCallId, name: 'subagent', args: {} }, ...{ conversationId: foreign.conversationId } }, ctx)
    await expect(history.appendIfActiveToolCallAnchor!(result(), ctx, foreign)).rejects.toThrow('receipt identity collision')
    expect(await rawResultCount(backend)).toBe(1)
    const rows = await state.db.execute('SELECT tenant_id,session_id,disposition FROM conversation_projection_receipts')
    expect(rows.rows).toHaveLength(3)
  })
  it('rejects incorrect result identity and generation-bound stale writers', async () => {
    const history = await seed(backend)
    await expect(history.appendIfActiveToolCallAnchor!({ ...result(), toolCallId: 'foreign' }, ctx, anchor)).rejects.toThrow('does not match')
    const bound = bindHistoryGeneration(serializeConversationHistory(history), ctx.tenantId, ctx.sessionId)
    invalidateSessionHistory(ctx.tenantId, ctx.sessionId)
    await expect(bound.appendIfActiveToolCallAnchor!(result(), ctx, anchor)).rejects.toThrow('History was changed')
    expect(await rawResultCount(backend)).toBe(0)
  })
  it('an existing unrelated row with the stable result ID is an explicit collision, never an ACK', async () => {
    const history = await seed(backend)
    await history.append({ id: resultId(), role: 'assistant', content: 'Unrelated existing row', ...{ conversationId: anchor.conversationId } }, ctx)
    await expect(projectPendingSubagents(history, ctx.tenantId)).rejects.toThrow('result identity collision')
    expect(await state.store.listPendingParentProjections(ctx.tenantId)).toHaveLength(1)
    expect(await rawResultCount(backend)).toBe(1)
  })
})

it('SQLite anchor predicate, result and receipt are in one real write transaction against another connection delete', async () => {
  const history = await seed('sqlite')
  await ensureProjectionReceipts(state.db)
  const other = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'agent.db').replaceAll('\\', '/')}` })
  const entered = barrier(), resume = barrier()
  const original = state.db.transaction.bind(state.db)
  vi.spyOn(state.db, 'transaction').mockImplementation(async (...args) => {
    const tx = await original(...args), execute = tx.execute.bind(tx)
    vi.spyOn(tx, 'execute').mockImplementation(async statement => {
      const value = await execute(statement)
      if (typeof statement === 'object' && statement.sql.startsWith('SELECT c.message_id')) { entered.release(); await resume.promise }
      return value
    })
    return tx
  })
  try {
    const projected = history.appendIfActiveToolCallAnchor!(result(), ctx, anchor)
    await entered.promise
    const deletion = other.execute({ sql: 'DELETE FROM conversations WHERE tenant_id=? AND session_id=?', args: [ctx.tenantId, ctx.sessionId] })
    resume.release()
    expect(await projected).toMatchObject({ disposition: 'appended' })
    await deletion
    expect(await rawResultCount('sqlite')).toBe(0)
    expect(await createHistory('sqlite').appendIfActiveToolCallAnchor!(result(), ctx, anchor)).toMatchObject({ disposition: 'duplicate' })
    expect(await rawResultCount('sqlite')).toBe(0)
  } finally { resume.release(); other.close(); await other.whenClosed() }
})

it.each(['insert', 'commit-before', 'commit-after'] as const)('SQLite %s failure keeps outbox, then recovers exactly once', async fault => {
  const history = await seed('sqlite'), original = state.db.transaction.bind(state.db)
  let failed = false
  vi.spyOn(state.db, 'transaction').mockImplementation(async (...args) => {
    const tx = await original(...args), execute = tx.execute.bind(tx), commit = tx.commit.bind(tx)
    let resultInserted = false
    vi.spyOn(tx, 'execute').mockImplementation(async statement => {
      if (typeof statement === 'object' && statement.sql.startsWith('INSERT INTO conversations')) {
        if (fault === 'insert' && !failed) { failed = true; throw new Error('injected INSERT failure') }
        resultInserted = true
      }
      return execute(statement)
    })
    vi.spyOn(tx, 'commit').mockImplementation(async () => {
      if (resultInserted && !failed) {
        failed = true
        if (fault === 'commit-after') await commit()
        throw new Error('injected commit failure')
      }
      return commit()
    })
    return tx
  })
  await expect(projectPendingSubagents(history, ctx.tenantId)).rejects.toThrow('injected')
  expect(await state.store.listPendingParentProjections(ctx.tenantId)).toHaveLength(1)
  expect(await rawResultCount('sqlite')).toBe(fault === 'commit-after' ? 1 : 0)
  await projectPendingSubagents(createHistory('sqlite'), ctx.tenantId)
  expect(await rawResultCount('sqlite')).toBe(1)
  expect(await receipt()).toMatchObject({ disposition: 'appended' })
  expect(await state.store.listPendingParentProjections(ctx.tenantId)).toEqual([])
})

it('JSONL multi-instance lease orders clear after active check, append, flush and receipt', async () => {
  const history = await seed('jsonl'), entered = barrier(), resume = barrier()
  const lookup = history.getActiveToolCallAnchor!.bind(history)
  vi.spyOn(history, 'getActiveToolCallAnchor').mockImplementation(async (scope, key) => {
    const value = await lookup(scope, key); entered.release(); await resume.promise; return value
  })
  const writing = history.appendIfActiveToolCallAnchor!(result(), ctx, anchor)
  await entered.promise
  const clearing = createHistory('jsonl').clear(ctx, { tombstone: false })
  resume.release()
  expect(await writing).toMatchObject({ disposition: 'appended' })
  await clearing
  expect(await receipt()).toMatchObject({ disposition: 'appended' })
  const backup = fs.readdirSync(path.dirname(jsonlFile())).find(file => file.endsWith('.bak'))!
  expect(fs.readFileSync(path.join(path.dirname(jsonlFile()), backup), 'utf8')).toContain(resultId())
  const cold = createHistory('jsonl')
  expect(await cold.appendIfActiveToolCallAnchor!(result(), ctx, anchor)).toMatchObject({ disposition: 'duplicate' })
  expect(await cold.getFullHistory(ctx)).toEqual([])
})

it('JSONL a paused projection cannot stall another physical session', async () => {
  const history = await seed('jsonl'), other = { ...ctx, sessionId: 'other' }, entered = barrier(), resume = barrier()
  await seedMessages(history, other)
  const lookup = history.getActiveToolCallAnchor!.bind(history)
  vi.spyOn(history, 'getActiveToolCallAnchor').mockImplementation(async (scope, key) => {
    const value = await lookup(scope, key)
    if (scope.sessionId === ctx.sessionId) { entered.release(); await resume.promise }
    return value
  })
  const writing = history.appendIfActiveToolCallAnchor!(result(), ctx, anchor)
  await entered.promise
  try { expect(await createHistory('jsonl').appendIfActiveToolCallAnchor!(result(), other, anchor)).toMatchObject({ disposition: 'appended' }) }
  finally { resume.release() }
  expect(await writing).toMatchObject({ disposition: 'appended' })
})

it.each(['open', 'sync', 'partial'] as const)('JSONL %s failure retains pending receipt and resumes from actual durable archive bytes', async fault => {
  const history = await seed('jsonl'), open = fs.promises.open.bind(fs.promises)
  let failed = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === jsonlFile() && args[1] === 'a+' && fault === 'open' && !failed) { failed = true; throw new Error('injected file open failure') }
    const handle = await open(...args)
    if (String(args[0]) === jsonlFile() && args[1] === 'a+' && !failed) {
      if (fault === 'sync') vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { failed = true; throw new Error('injected fsync failure') })
      if (fault === 'partial') {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async value => {
          failed = true; await write(String(value).slice(0, 70)); throw new Error('injected partial append failure')
        })
      }
    }
    return handle
  })
  await expect(projectPendingSubagents(history, ctx.tenantId)).rejects.toThrow('injected')
  expect(await receipt()).toMatchObject({ disposition: 'pending' })
  expect(await state.store.listPendingParentProjections(ctx.tenantId)).toHaveLength(1)
  expect(await rawResultCount('jsonl')).toBe(fault === 'sync' ? 1 : 0)
  await projectPendingSubagents(createHistory('jsonl'), ctx.tenantId)
  expect(await rawResultCount('jsonl')).toBe(1)
  expect((await createHistory('jsonl').getFullHistory(ctx)).filter(message => message.id === resultId())).toHaveLength(1)
  expect(await receipt()).toMatchObject({ disposition: 'appended' })
  expect(await state.store.listPendingParentProjections(ctx.tenantId)).toEqual([])
})

it('JSONL failed completed-receipt write reconciles an already flushed but deleted result without reappend', async () => {
  const history = await seed('jsonl'), transaction = state.db.transaction.bind(state.db)
  let failed = false
  vi.spyOn(state.db, 'transaction').mockImplementation(async (...args) => {
    const tx = await transaction(...args), execute = tx.execute.bind(tx)
    vi.spyOn(tx, 'execute').mockImplementation(async statement => {
      if (!failed && typeof statement === 'object' && statement.sql.startsWith('INSERT INTO conversation_projection_receipts')
        && Array.isArray(statement.args) && statement.args[7] === 'appended') {
        failed = true; throw new Error('injected receipt write failure')
      }
      return execute(statement)
    })
    return tx
  })
  await expect(projectPendingSubagents(history, ctx.tenantId)).rejects.toThrow('receipt write failure')
  expect(await receipt()).toMatchObject({ disposition: 'pending' })
  expect(await rawResultCount('jsonl')).toBe(1)
  await history.deleteMessage(resultId(), ctx.tenantId)
  await projectPendingSubagents(createHistory('jsonl'), ctx.tenantId)
  expect(await rawResultCount('jsonl')).toBe(1)
  expect((await createHistory('jsonl').getFullHistory(ctx)).filter(message => message.id === resultId())).toEqual([])
  expect(await receipt()).toMatchObject({ disposition: 'appended' })
})

it.each(['clear', 'truncate', 'failed-clear'] as const)('JSONL pending reservation cannot resume after %s, including same IDs recreated', async mutation => {
  const history = await seed('jsonl'), open = fs.promises.open.bind(fs.promises)
  const failure = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === jsonlFile() && args[1] === 'a+') throw new Error('injected open failure')
    return open(...args)
  })
  await expect(projectPendingSubagents(history, ctx.tenantId)).rejects.toThrow('injected open failure')
  failure.mockRestore()
  expect(await receipt()).toMatchObject({ disposition: 'pending' })
  if (mutation === 'failed-clear') {
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('rename refused'))
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('clear tombstone write failed'))
    await expect(history.clear(ctx, { tombstone: false })).rejects.toThrow('clear tombstone write failed')
    expect(await history.getActiveToolCallAnchor!(ctx, anchor)).toEqual(anchor)
  } else {
    await mutate(history, mutation)
    await seedMessages(history)
  }
  await projectPendingSubagents(createHistory('jsonl'), ctx.tenantId)
  expect(await rawResultCount('jsonl')).toBe(0)
  expect(await receipt()).toMatchObject({ disposition: 'suppressed' })
  expect(await state.store.listPendingParentProjections(ctx.tenantId)).toEqual([])
})

it('durable receipt survives SQLite-to-JSONL migration without resurrecting a deleted result', async () => {
  const sqlite = await seed('sqlite')
  await sqlite.appendIfActiveToolCallAnchor!(result(), ctx, anchor)
  await sqlite.deleteMessage(resultId(), ctx.tenantId)
  const jsonl = createHistory('jsonl')
  expect((await jsonl.getFullHistory(ctx)).some(message => message.id === anchor.messageId)).toBe(true)
  expect(await jsonl.appendIfActiveToolCallAnchor!(result(), ctx, anchor)).toMatchObject({ disposition: 'duplicate' })
  expect(await rawResultCount('jsonl')).toBe(0)
  expect(await receipt()).toMatchObject({ disposition: 'appended', backend: 'sqlite' })
})

it('old JSONL archive owner cannot read/write replay receipts from a newly selected data directory', async () => {
  const history = await seed('jsonl')
  vi.stubEnv('DATA_DIR', path.join(fixture, 'other.db'))
  await expect(history.appendIfActiveToolCallAnchor!(result(), ctx, anchor)).rejects.toThrow('source changed')
  expect(await rawResultCount('jsonl')).toBe(0)
  expect(await state.store.listPendingParentProjections(ctx.tenantId)).toHaveLength(1)
})

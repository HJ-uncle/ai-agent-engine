/** Real history backends and physical SQLite reopen; only provider streams are scripted. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { ReActStrategy } from '../react.js'
import { getDb, closeDb, initDb } from '../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { consumeEmptyOutputRecovery } from '../../../storage/conversation/empty-output-recovery.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
const fixtureRoot = path.resolve('.e2e-tmp')
let directory: string, db: LocalSqliteProcessClient
beforeEach(async () => {
  const previous = getDb() as LocalSqliteProcessClient; closeDb(); await previous.whenClosed()
  fs.mkdirSync(fixtureRoot, { recursive: true })
  directory = fs.mkdtempSync(path.join(fixtureRoot, 'empty-recovery-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'agent.db'))
  db = getDb() as LocalSqliteProcessClient; await initDb()
})
afterEach(async () => {
  vi.restoreAllMocks(); closeDb(); await db.whenClosed(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== fixtureRoot || !path.basename(directory).startsWith('empty-recovery-')) throw new Error('Unsafe recovery fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
const empty = (): LLMStreamChunk => ({ done: true, finishReason: 'stop', promptTokens: 20, completionTokens: 108 })
const answer = (): LLMStreamChunk => ({ done: true, finishReason: 'stop', content: 'Verified completion.', promptTokens: 30, completionTokens: 5 })
function fixture() {
  const outcomes: RunOutcome[] = []
  const ctx = { tenantId: path.basename(directory), sessionId: 'session', rootRunId: 'root', turnId: 'turn',
    userMessageId: 'user', assistantMessageId: 'final', workspaceDir: directory, toolProfile: 'general',
    modelCaps: { contextWindow: 100_000 }, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: createConversationHistory(), tools: { list: () => [], has: () => true, executionMode: () => 'serial',
      execute: vi.fn(async () => ({ success: true, output: 'File written exactly once.' })) },
    runObserver: { onUsage: vi.fn(), onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }) },
  } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'same-model', provider: 'fixture', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* () { yield empty() }) }
  async function run(input: string | null = 'Complete the same task.') {
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 6 }).run(input, ctx)) { /* drain */ }
  }
  return { ctx, llm, outcomes, run }
}

describe.each(['jsonl', 'sqlite'] as const)('%s durable empty-output allowance', backend => {
  beforeEach(() => { vi.stubEnv('HISTORY_BACKEND', backend) })

  it('does not regain a retry after continued work, two full compactions and physical reopen', async () => {
    const f = fixture(); let requests = 0
    f.llm.stream = vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (++requests === 1) yield empty()
      else if (requests === 2) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'one-write', name: 'write_file', args: '{"path":"fixture.txt","content":"complete"}' }] }
      else yield answer()
    })
    await f.run()
    expect(requests).toBe(3); expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
    expect((await f.ctx.history.getFullHistory(f.ctx)).filter(m => m.metadata?.emptyOutputRecovery)).toHaveLength(1)
    for (let round = 0; round < 2; round++) {
      for (let n = 0; n < 8; n++) await f.ctx.history.append({ id: `later-${round}-${n}`, role: 'assistant', content: 'Completed work evidence '.repeat(20) }, f.ctx)
      await f.ctx.history.compress(f.ctx, async () => 'Original task and completed tool work, summarized.', 2)
    }
    expect((await f.ctx.history.getFullHistory(f.ctx)).some(m => m.metadata?.emptyOutputRecovery)).toBe(false)
    closeDb(); await db.whenClosed(); db = getDb() as LocalSqliteProcessClient; await initDb()
    f.ctx.history = createConversationHistory()
    const archive = f.ctx.history.searchArchive ? vi.spyOn(f.ctx.history, 'searchArchive') : undefined
    let resumedRequests = 0
    f.llm.stream = vi.fn(async function* (messages: Message[]) {
      expect(messages.some(m => m.metadata?.emptyOutputRecovery)).toBe(false)
      resumedRequests++; yield empty()
    })
    await f.run(null)
    expect(resumedRequests).toBe(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'empty_output', error: { code: 'EMPTY_OUTPUT' } })
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    if (archive) expect(archive).not.toHaveBeenCalled()
    expect((await db.execute('SELECT count(*) AS n FROM conversation_empty_output_recovery')).rows[0].n).toBe(1)
    // A later independent root in the same chat keeps its own allowance.
    Object.assign(f.ctx, { rootRunId: 'next-root', turnId: 'next-turn', userMessageId: 'next-user', assistantMessageId: 'next-final' })
    let nextRequests = 0
    f.llm.stream = vi.fn(async function* () { yield ++nextRequests === 1 ? empty() : answer() })
    await f.run('New independent task.')
    expect(nextRequests).toBe(2); expect(f.outcomes.at(-1)?.status).toBe('succeeded')
  })

  it('atomically claims once while keeping tenant/session/root/turn scopes independent', async () => {
    const f = fixture()
    expect((await Promise.all(Array.from({ length: 8 }, () => consumeEmptyOutputRecovery(f.ctx)))).filter(Boolean)).toHaveLength(1)
    for (const change of [{ tenantId: 'another-tenant' }, { sessionId: 'child-session' }, { rootRunId: 'another-root' }, { turnId: 'another-turn' }]) {
      expect(await consumeEmptyOutputRecovery({ ...f.ctx, ...change })).toBe(true)
      expect(await consumeEmptyOutputRecovery({ ...f.ctx, ...change })).toBe(false)
    }
    expect((await db.execute('SELECT count(*) AS n FROM conversation_empty_output_recovery')).rows[0].n).toBe(5)
  })

  it('fails closed if durable receipt persistence fails', async () => {
    const f = fixture()
    await consumeEmptyOutputRecovery({ ...f.ctx, rootRunId: 'schema-only' })
    await db.execute(`CREATE TRIGGER reject_empty_recovery BEFORE INSERT ON conversation_empty_output_recovery
      BEGIN SELECT RAISE(ABORT, 'Synthetic receipt persistence failure'); END`)
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    expect((await f.ctx.history.getFullHistory(f.ctx)).some(m => m.metadata?.emptyOutputRecovery)).toBe(false)
  })

  it('keeps a claimed allowance consumed when the diagnostic append fails', async () => {
    const f = fixture(), append = f.ctx.history.append.bind(f.ctx.history)
    const mocked = vi.spyOn(f.ctx.history, 'append').mockImplementation(async (message, scope) => {
      if (message.metadata?.emptyOutputRecovery) throw new Error('Synthetic diagnostic append failure')
      return append(message, scope)
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    mocked.mockRestore()
    f.ctx.history = createConversationHistory()
    f.llm.stream = vi.fn(async function* () { yield empty() })
    await f.run(null)
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)?.stopReason).toBe('empty_output')
  })
})

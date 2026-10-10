import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import { OpenAIAdapter } from '../../llm-adapter/openai.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RequestBudget, type RequestAttempt } from '../budget.js'
import { SubagentPool } from '../pool.js'
import { SubagentRunner } from '../runner.js'
import { SubagentStore } from '../store.js'

vi.mock('../projection.js', () => ({ projectPendingSubagents: vi.fn().mockResolvedValue(undefined) }))

let fixture: string
let db: LocalSqliteProcessClient
let store: SubagentStore
let runner: SubagentRunner
let parent: AgentContext
let budget: RequestBudget

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-unknown-'))
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'runs.db').replace(/\\/g, '/')}` })
  store = new SubagentStore(db)
  runner = new SubagentRunner(store, new SubagentPool(1))
  budget = new RequestBudget(Infinity)
  parent = { tenantId: 'usage-tenant', sessionId: 'parent', toolProfile: 'code',
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, history: {},
    onRequestAttempt: (event: RequestAttempt) => budget.observe(event),
  } as unknown as AgentContext
})

afterEach(async () => {
  vi.unstubAllGlobals()
  db.close()
  await db.whenClosed()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-subagent-unknown-')) {
    throw new Error('Unsafe unknown-usage fixture cleanup')
  }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

describe('partial provider usage remains a durable lower bound', () => {
  it.each([
    { usage: { input_tokens: 120 }, input: 120, output: 0 },
    { usage: { output_tokens: 7 }, input: 0, output: 7 },
  ])('retains known counts and unknown total after a stream disconnect: $usage', async ({ usage, input, output }) => {
    const frames = [{ id: 'm', model: 'MiniMax-M2.5',
      choices: [{ index: 0, delta: { content: 'partial evidence' }, finish_reason: null }], usage }]
    const wire = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })))
    const run = await runner.run({ tenantId: 'usage-tenant', rootSessionId: 'parent', parentSessionId: 'parent',
      parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'delegate',
      task: 'inspect fixture', description: 'usage fixture', modelId: 'MiniMax-M2.5' }, parent,
    async ({ signal, observer, onRequestAttempt }) => {
      const adapter = new OpenAIAdapter('MiniMax-M2.5', 'fixture-key', 'http://model.invalid')
      for await (const chunk of adapter.stream([{ role: 'user', content: 'inspect fixture' }],
        { model: adapter.model, signal, onRequestAttempt })) {
        if (chunk.content) await observer.onOutput?.(chunk.content)
      }
    })
    const expected = { inputTokens: input, outputTokens: output, totalTokens: input + output, unknown: true }
    expect(run.status).toBe('failed')
    expect(run.partialOutput).toBe('partial evidence')
    expect(run.usage).toMatchObject(expected)
    expect((await store.getRun('usage-tenant', run.runId))?.usage).toMatchObject(expected)
    expect(budget.snapshot).toMatchObject({ charged: input + output, reserved: 0, unknown: true })
    expect((await store.listEvents('usage-tenant', run.runId)).filter(event => event.kind === 'usage.updated')).toHaveLength(1)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import * as modelResolution from '../../llm-adapter/resolve-model.js'
import type { CompactionState, RunOutcome } from '../../subagent/types.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { ReActStrategy } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

let fixtureDirectory: string
beforeEach(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-compaction-progress-'))
  vi.stubEnv('DATA_DIR', path.join(fixtureDirectory, 'agent.db'))
  vi.stubEnv('LLM_SUMMARIZE_MODEL', '')
  vi.stubEnv('COMPRESS_THRESHOLD_RATIO', '0.92')
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixtureDirectory) !== path.resolve(os.tmpdir())
    || !path.basename(fixtureDirectory).startsWith('aether-compaction-progress-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixtureDirectory, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(seed = true) {
  const location = { tenantId: 'progress-tenant', sessionId: 'progress-session' }
  const directory = path.join(fixtureDirectory, 'sessions', location.tenantId)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, location.sessionId + '.jsonl'), '')
  const history = new JSONLConversationHistory()
  if (seed) for (let index = 0; index < 10; index++) await history.append({
    id: `source-${index}`, role: 'assistant', content: `Verified development step ${index}; preserve this evidence. `.repeat(150),
  }, location)
  const states: CompactionState[] = [], outcomes: RunOutcome[] = []
  const ctx = {
    ...location, rootRunId: 'root-progress', turnId: 'turn-progress',
    userMessageId: 'current-request', assistantMessageId: 'current-answer',
    workspaceDir: '.', toolProfile: 'code', modelCaps: { contextWindow: 20_000 },
    history, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tools: { list: () => [] },
    runObserver: {
      onCompaction: vi.fn(async (state: CompactionState) => { states.push(state) }),
      onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }),
    },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    model: 'fixture-main-model', provider: 'test', countTokens: () => 0,
    complete: vi.fn(async () => ({ content: '<summary>All development checkpoints are retained. Continue the latest task.</summary>', promptTokens: 12, completionTokens: 8, finishReason: 'stop' as const })),
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, content: 'Continued the verified task.', promptTokens: 450, completionTokens: 10 }
    }),
  }
  const run = async () => {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, { maxIterations: 2 }).run('Continue from the verified checkpoint.', ctx)) frames.push(frame)
    return frames
  }
  return { ctx, history, llm, states, outcomes, run }
}

describe('observable automatic compaction lifecycle', () => {
  it('publishes running while the summary is blocked and succeeds only after history is durably committed', async () => {
    const f = await fixture()
    const entered = deferred(), release = deferred()
    f.llm.complete = vi.fn(async () => {
      entered.resolve(); await release.promise
      return { content: '<summary>Retain every verified checkpoint; continue the latest task.</summary>', promptTokens: 10, completionTokens: 8, finishReason: 'stop' as const }
    })
    let persistedAtSuccess = false
    const compacted = vi.fn(async (state: CompactionState) => {
      f.states.push(state)
      if (state.phase === 'succeeded') persistedAtSuccess = (await new JSONLConversationHistory().getFullHistory(f.ctx))
        .some(message => message.metadata?.isCompactSummary)
    })
    f.ctx.runObserver!.onCompaction = compacted
    const running = f.run()
    try {
      await entered.promise
      expect(f.states).toEqual([{ phase: 'running', startedAt: expect.any(Number), beforeTokens: expect.any(Number) }])
      expect(f.llm.stream).not.toHaveBeenCalled()
      expect((await f.history.getFullHistory(f.ctx)).some(message => message.metadata?.isCompactSummary)).toBe(false)
    } finally { release.resolve(); await running }
    expect(f.states.map(state => state.phase)).toEqual(['running', 'succeeded'])
    expect(persistedAtSuccess).toBe(true)
    expect(f.states[1]).toMatchObject({ startedAt: f.states[0].startedAt, finishedAt: expect.any(Number),
      beforeTokens: expect.any(Number), afterTokens: expect.any(Number) })
    expect(f.states[1].afterTokens!).toBeLessThan(f.states[1].beforeTokens!)
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
    expect((await new JSONLConversationHistory().getArchive(f.ctx)).messages.map(message => message.id))
      .toEqual(expect.arrayContaining(['source-0', 'source-9', 'current-request', 'current-answer']))
  })

  it('publishes failed summary status and leaves the original transcript intact for replay', async () => {
    const f = await fixture()
    const before = await f.history.getFullHistory(f.ctx)
    f.llm.complete = vi.fn(async () => { throw new Error('Synthetic summary service unavailable') })
    await f.run()
    expect(f.states.map(state => state.phase)).toEqual(['running', 'failed'])
    expect(f.states[1]).toMatchObject({ startedAt: f.states[0].startedAt, finishedAt: expect.any(Number),
      error: 'Synthetic summary service unavailable' })
    const replay = await new JSONLConversationHistory().getFullHistory(f.ctx)
    expect(replay.slice(0, before.length)).toEqual(before)
    expect(replay.some(message => message.metadata?.isCompactSummary)).toBe(false)
    expect((await f.history.getArchive(f.ctx)).messages.map(message => message.id)).toEqual([
      ...before.map(message => message.id), 'current-request',
    ])
  })

  it('does not let failed progress observers break reduction or the subsequent response', async () => {
    const f = await fixture()
    f.ctx.runObserver!.onCompaction = vi.fn(async (state: CompactionState) => {
      f.states.push(state); throw new Error('Synthetic notification failure')
    })
    await f.run()
    expect(f.states.map(state => state.phase)).toEqual(['running', 'succeeded'])
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect((await new JSONLConversationHistory().getFullHistory(f.ctx)).some(message => message.metadata?.isCompactSummary)).toBe(true)
  })

  it('does not show compaction when storage has nothing reducible or when light cleanup is enough', async () => {
    const f = await fixture(false)
    await f.history.append({ id: 'single-large-input', role: 'user', content: 'irreducible requirement '.repeat(4500) }, f.ctx)
    vi.spyOn(f.history, 'compress').mockResolvedValue({ preTokens: 30_000, postTokens: 30_000 })
    await f.run()
    expect(f.states).toEqual([])
    expect(f.llm.complete).not.toHaveBeenCalled()
    const g = await fixture(false)
    await g.history.append({ id: 'old-tool', role: 'tool', toolCallId: 'old-call', toolName: 'read_file',
      content: 'large prior source code '.repeat(4500) }, g.ctx)
    vi.spyOn(g.history, 'microCompactToolResults').mockImplementation(async () => {
      await g.history.clear(g.ctx)
      return { cleared: 1, freedTokens: 30_000 }
    })
    await g.run()
    expect(g.states).toEqual([])
    expect(g.llm.complete).not.toHaveBeenCalled()
    expect(g.outcomes.at(-1)?.status).toBe('succeeded')
  })

  it('uses the configured summary model database context window for every summary request', async () => {
    const f = await fixture()
    const specialty = { ...f.llm, model: 'fixture-summary-model' }
    specialty.complete = vi.fn(async (_messages, options?: LLMAdapterOptions) => {
      expect(options?.contextWindow).toBe(12_000)
      expect(options!.requestInputTokenEstimate! + options!.maxTokens!).toBeLessThanOrEqual(12_000)
      return { content: '<summary>Retain the development checkpoints.</summary>', promptTokens: 10, completionTokens: 8, finishReason: 'stop' as const }
    })
    vi.stubEnv('LLM_SUMMARIZE_MODEL', specialty.model)
    vi.spyOn(modelResolution, 'resolveModelConfig').mockResolvedValue({ model: specialty.model, provider: 'test',
      capabilities: { contextWindow: 12_000 } } as modelResolution.ResolvedModelConfig)
    vi.spyOn(modelResolution, 'createAdapterFromResolved').mockReturnValue(specialty)
    await f.run()
    expect(specialty.complete).toHaveBeenCalled()
    expect(f.llm.complete).not.toHaveBeenCalled()
    expect(f.states.map(state => state.phase)).toEqual(['running', 'succeeded'])
    expect(f.outcomes.at(-1)?.status).toBe('succeeded')
  })
})

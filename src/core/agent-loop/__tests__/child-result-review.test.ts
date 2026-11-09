import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter } from '../../llm-adapter/types.js'
import { ChildResultReview } from '../child-result-review.js'
import { ReActStrategy } from '../react.js'

const fixture = vi.hoisted(() => ({ rows: vi.fn(), wait: vi.fn(), assert: vi.fn(), binding: {
  kind: 'root', tenantId: 'tenant', sessionId: 'parent', rootRunId: 'root', turnId: 'turn',
} }))
vi.mock('../../collaboration/execution-owner.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../collaboration/execution-owner.js')>(),
  assertOwnedDispatch: vi.fn(),
  serviceForOwner: () => ({ db: {}, producerForExecution: () => ({}), collaboration: {
    executionBinding: () => fixture.binding, store: { assertProducer: fixture.assert, executionInvocations: fixture.rows },
  } }),
}))
vi.mock('../../subagent/runner.js', () => ({ getSubagentRunner: () => ({ waitOwned: fixture.wait }) }))
vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
vi.mock('../../../storage/results/index.js', () => ({ finalResults: { prepare: async () => undefined }, TOOL_RESULT_IMAGE_ASSETS: '__images' }))

const completed = () => ({ state: 'completed', run: { runId: 'child-run', status: 'succeeded', description: '独立计算',
  resultSummary: '已完成：23 × 29 = 667，独立复核通过。', usage: {}, toolCalls: [] } })
function context(): AgentContext {
  return { ...fixture.binding, executionOwner: {}, signal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
}
beforeEach(() => {
  fixture.rows.mockReset().mockResolvedValue([])
  fixture.wait.mockReset().mockResolvedValue(completed())
  fixture.assert.mockReset().mockResolvedValue(undefined)
})

describe('parent child-result review', () => {
  it('adds no wait to ordinary tasks or child agents', async () => {
    expect(await new ChildResultReview().beforeFinal(context())).toBe(false)
    expect(await new ChildResultReview().beforeFinal({ ...context(), parentSessionId: 'parent' })).toBe(false)
    expect(fixture.wait).not.toHaveBeenCalled()
  })

  it('does not fetch results already present in the actual model request', async () => {
    fixture.rows.mockResolvedValue([{ runId: 'child-run', terminal: true, seq: 4 }])
    const review = new ChildResultReview()
    review.recordRequest([{ id: 'subagent-result:child-run', role: 'assistant', content: '667' }])
    expect(await review.beforeFinal(context())).toBe(false)
    expect(fixture.wait).not.toHaveBeenCalled()
  })

  it('joins unseen children and supplies one bounded result without duplicating the transcript', async () => {
    fixture.rows.mockResolvedValue([{ runId: 'child-run', terminal: false, seq: 1 }])
    const review = new ChildResultReview(), ctx = context()
    expect(await review.beforeFinal(ctx)).toBe(true)
    expect(fixture.wait).toHaveBeenCalledWith(ctx, 'child-run', expect.objectContaining({ timeoutMs: 60_000 }))
    const next = review.includeResults([])
    expect(next).toHaveLength(1)
    expect(next[0].content).toContain('667')
    expect(review.includeResults(next)).toHaveLength(1)
    review.recordRequest(next)
    expect(await review.beforeFinal(ctx)).toBe(false)
    expect(fixture.wait).toHaveBeenCalledTimes(1)
  })

  it('waits across timeouts without model polling and wakes for new input', async () => {
    fixture.rows.mockResolvedValue([{ runId: 'child-run', terminal: false, seq: 1 }])
    fixture.wait.mockResolvedValueOnce({ state: 'pending', runId: 'child-run' })
      .mockResolvedValueOnce({ state: 'pending', runId: 'child-run', reason: 'message' })
    expect(await new ChildResultReview().beforeFinal(context())).toBe(true)
    expect(fixture.wait).toHaveBeenCalledTimes(2)
  })

  it('does not treat a cleared result index as reviewed and restores it without breaking the tool pair', async () => {
    fixture.rows.mockResolvedValue([{ runId: 'child-run', terminal: true, seq: 4 }])
    const message: Message = { id: 'subagent-result:child-run', role: 'tool', toolName: 'subagent', toolCallId: 'original-call',
      content: '[tool result cleared]\nEvidence index only; original output/pixels are not in context.' }
    const review = new ChildResultReview()
    review.recordRequest([message])
    expect(await review.beforeFinal(context())).toBe(true)
    const restored = review.includeResults([message])
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ role: 'tool', toolCallId: 'original-call', content: expect.stringContaining('667') })
    expect(message.content).toContain('[tool result cleared]')
    review.recordRequest(restored)
    expect(await review.beforeFinal(context())).toBe(false)
  })

  it('does not accept a caller that mismatches the canonical owner', async () => {
    await expect(new ChildResultReview().beforeFinal({ ...context(), tenantId: 'other' })).rejects.toThrow('AUTHORITY_MISMATCH')
    expect(fixture.wait).not.toHaveBeenCalled()
  })

  it('returns a fast result without waiting for a slow sibling or stopping its executor', async () => {
    fixture.rows.mockResolvedValue([{ runId: 'child-run', terminal: false }, { runId: 'slow', terminal: false }])
    fixture.wait.mockImplementation(async (_ctx, id, options) => id === 'child-run' ? completed()
      : new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })))
    const review = new ChildResultReview()
    expect(await review.beforeFinal(context())).toBe(true)
    expect(review.includeResults([]).map(message => message.id)).toEqual(['subagent-result:child-run'])
  })

  it.each(['cancelled', 'projection_failed'])('persists completed provider usage if child waiting ends with %s', async reason => {
    fixture.rows.mockResolvedValue([{ runId: 'child-run', terminal: false, seq: 1 }])
    const controller = new AbortController(), messages: Message[] = []
    fixture.wait.mockImplementation(async () => { if (reason === 'cancelled') controller.abort(); throw new Error(reason) })
    const ctx = { ...context(), signal: controller.signal, workspaceDir: '/review-test', memoryScopes: [], toolProfile: 'general',
      tools: { list: () => [], has: () => false },
      history: { getHistory: async () => [...messages], append: async (message: Message) => { messages.push(message); return message.id } },
      runObserver: { onOutcome: vi.fn() },
    } as unknown as AgentContext
    const llm = { model: 'review-fixture', provider: 'fixture', countTokens: () => 0,
      stream: async function* () { yield { done: true, content: '等待结果整合。', promptTokens: 100, completionTokens: 10 } },
    } as unknown as LLMAdapter
    for await (const _frame of new ReActStrategy(llm).run('委派并汇总。', ctx)) { /* consume */ }
    expect(messages.filter(message => message.usage)).toHaveLength(1)
    expect(messages.find(message => message.usage)?.usage).toMatchObject({ promptTokens: 100, completionTokens: 10 })
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: reason === 'cancelled' ? 'cancelled' : 'failed' }))
  })

  it('permits one correction when selected collaborators were ignored, then reports incomplete without looping', async () => {
    const messages: Message[] = []
    const ctx = { ...context(), workspaceDir: '/review-test', memoryScopes: [], toolProfile: 'general',
      tools: { list: () => [], has: () => false },
      history: { getHistory: async () => [...messages], append: async (message: Message) => { messages.push(message); return message.id } },
      runObserver: { onOutcome: vi.fn() },
    } as unknown as AgentContext
    let requests = 0
    const llm = { model: 'review-fixture', provider: 'fixture', countTokens: () => 0,
      stream: async function* () { requests++; yield { done: true, content: '我做完了。', promptTokens: 100, completionTokens: 10 } },
    } as unknown as LLMAdapter
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 8, hasPendingDelegations: () => true }).run('使用所选协作者。', ctx)) { /* consume */ }
    expect(requests).toBe(2)
    expect(messages.filter(message => message.usage)).toHaveLength(2)
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed',
      error: expect.objectContaining({ code: 'COLLABORATOR_PLAN_REQUIRED' }) }))
  })

  it('runs one integration response after an early final, with both model usages persisted once', async () => {
    fixture.rows.mockResolvedValue([{ runId: 'child-run', terminal: false, seq: 1 }])
    const messages: Message[] = [], requests: Message[][] = []
    const ctx = { ...context(), workspaceDir: '/review-test', memoryScopes: [], toolProfile: 'general',
      tools: { list: () => [], has: () => false },
      history: { getHistory: async () => [...messages], append: async (message: Message) => { messages.push(message); return message.id } },
      runObserver: { onOutcome: vi.fn() },
    } as unknown as AgentContext
    const llm = { model: 'review-fixture', provider: 'fixture', countTokens: () => 0,
      stream: async function* (history: Message[]) {
        requests.push([...history])
        yield { done: true, content: requests.length === 1 ? '任务已安排。' : '已验收子代理结果，乘积为 667。', promptTokens: 100, completionTokens: 10 }
      } } as unknown as LLMAdapter
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 4 }).run('委派计算并汇总。', ctx)) { /* consume */ }
    expect(requests).toHaveLength(2)
    expect(requests[1].some(message => String(message.content).includes('667'))).toBe(true)
    expect(messages.filter(message => message.usage)).toHaveLength(2)
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }))
    expect(messages.at(-1)?.content).toContain('已验收')
  })
})

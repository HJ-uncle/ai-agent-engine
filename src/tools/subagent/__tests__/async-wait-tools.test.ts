import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { boundedToolContext } from '../../../core/agent-loop/tool-output-limit.js'
import { subagentWaitTool, subagentCancelTool } from '../async-tools.js'

const fixture = vi.hoisted(() => ({
  wait: vi.fn(), waitMany: vi.fn(), cancel: vi.fn(), projection: vi.fn(), assertProducer: vi.fn(),
}))
vi.mock('../../../core/subagent/runner.js', () => ({ getSubagentRunner: () => ({
  waitOwned: fixture.wait, waitManyOwned: fixture.waitMany, cancelOwned: fixture.cancel,
  store: { ownedParentProjection: fixture.projection },
}) }))
vi.mock('../../../core/collaboration/execution-owner.js', () => ({ serviceForOwner: () => ({
  db: {}, producerForExecution: () => ({}), collaboration: {
    executionBinding: () => ({ tenantId: 'tenant', sessionId: 'parent', rootSessionId: 'parent', rootRunId: 'root', turnId: 'turn', kind: 'root' }),
    store: { assertProducer: fixture.assertProducer },
  },
}) }))
const ctx = { tenantId: 'tenant', sessionId: 'parent', rootRunId: 'root', turnId: 'turn', executionOwner: {} } as AgentContext
const completed = (runId: string, status = 'succeeded') => ({ state: 'completed', run: {
  runId, childSessionId: `child-${runId}`, lastSeq: 7, status,
  resultSummary: 'UNIQUE_BODY_MUST_NOT_BE_REPEATED'.repeat(1000),
  partialOutput: 'PARTIAL_BODY_MUST_NOT_BE_REPEATED'.repeat(1000),
  ...(status !== 'succeeded' ? { error: { code: 'EXECUTOR_FAILED', message: 'FAILED_BODY' } } : {}),
} })
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('OSM_MODE', 'balanced'); vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000')
  fixture.projection.mockResolvedValue({ acknowledged: true, disposition: 'appended' })
  fixture.assertProducer.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('subagent wait tool contracts', () => {
  it.each([
    {}, { runId: 'one', runIds: ['two'] }, { runIds: [] }, { runIds: [''] }, { runIds: ['  '] },
    { runIds: ['one', 'one'] }, { runIds: Array.from({ length: 9 }, (_, i) => String(i)) },
    { runIds: ['one', 2] }, { runIds: 'one' }, { runIds: ['one'], tenantId: 'other' },
    { runIds: ['one'], timeoutMs: -1 }, { runIds: ['one'], timeoutMs: 60001 }, { runIds: ['one'], timeoutMs: 0.5 },
  ])('rejects invalid or authority-bearing arguments before starting an observation: %j', async args => {
    expect((await subagentWaitTool.execute(args, ctx)).success).toBe(false)
    expect(fixture.wait).not.toHaveBeenCalled(); expect(fixture.waitMany).not.toHaveBeenCalled()
  })
  it('collects eight terminal states in one valid bounded JSON without repeating their bodies', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    fixture.waitMany.mockResolvedValue({ state: 'completed', runs: ids.map((id, i) => completed(id, i ? 'succeeded' : 'failed')) })
    const result = await subagentWaitTool.execute({ runIds: ids, timeoutMs: 60000 }, ctx)
    expect(fixture.waitMany).toHaveBeenCalledTimes(1)
    expect(fixture.waitMany).toHaveBeenCalledWith(ctx, ids, { timeoutMs: 60000 })
    expect(fixture.wait).not.toHaveBeenCalled(); expect(result.success).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(4000)
    expect(result.output).not.toContain('BODY')
    expect(JSON.parse(result.output).runs.map((run: any) => run.runId)).toEqual(ids)
    expect(JSON.parse(result.output).runs[0]).toMatchObject({ state: 'completed', status: 'failed', resultMessageId: 'subagent-result:' + ids[0] })
  })
  it('retains partial completion and message interruption in a single response', async () => {
    fixture.waitMany.mockResolvedValue({ state: 'pending', reason: 'message', runs: [completed('one'), { state: 'pending', runId: 'two' }] })
    const result = await subagentWaitTool.execute({ runIds: ['one', 'two'] }, ctx)
    expect(JSON.parse(result.output)).toMatchObject({ state: 'pending', reason: 'message', runs: [
      { runId: 'one', status: 'succeeded' }, { runId: 'two', state: 'pending' },
    ] })
  })
  it('keeps legacy single target and pending shape, but references completed bodies once', async () => {
    fixture.wait.mockResolvedValueOnce({ state: 'pending', runId: 'one' }).mockResolvedValueOnce(completed('one'))
    const pending = await subagentWaitTool.execute({ runId: 'one', timeoutMs: 0 }, ctx)
    expect(JSON.parse(pending.output)).toEqual({ state: 'pending', runId: 'one' })
    const done = await subagentWaitTool.execute({ runId: 'one' }, ctx)
    expect(JSON.parse(done.output)).toMatchObject({ state: 'completed', runId: 'one', resultMessageId: 'subagent-result:one' })
    expect(done.output).not.toContain('BODY'); expect(fixture.waitMany).not.toHaveBeenCalled()
  })
  it('does not claim a suppressed notification exists or accept an unacknowledged projection', async () => {
    fixture.waitMany.mockResolvedValue({ state: 'completed', runs: [completed('one')] })
    fixture.projection.mockResolvedValueOnce({ acknowledged: true, disposition: 'suppressed' }).mockResolvedValueOnce({ acknowledged: false })
    const suppressed = JSON.parse((await subagentWaitTool.execute({ runIds: ['one'] }, ctx)).output)
    expect(suppressed.runs[0]).toMatchObject({ projection: 'suppressed' })
    expect(suppressed.runs[0]).not.toHaveProperty('resultMessageId')
    expect((await subagentWaitTool.execute({ runIds: ['one'] }, ctx)).success).toBe(false)
  })
  it('never returns chopped JSON when a per-invocation output allowance is too small', async () => {
    fixture.waitMany.mockResolvedValue({ state: 'completed', runs: [completed('one')] })
    const result = await subagentWaitTool.execute({ runIds: ['one'] }, boundedToolContext(ctx, 160))
    expect(result.success).toBe(false); expect(result.output).toContain('allowance')
    expect(result.output.startsWith('{')).toBe(false)
  })
  it('leaves cancellation single-target and never interprets batch waits as cancellation', async () => {
    expect((await subagentCancelTool.execute({ runIds: ['one', 'two'] }, ctx)).success).toBe(false)
    expect(fixture.cancel).not.toHaveBeenCalled()
    expect(subagentCancelTool.parameters.required).toEqual(['runId'])
  })
})

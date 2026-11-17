import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { commandJobs, type CommandJobScope, type CommandJobSnapshot } from '../../../core/command-jobs/index.js'
import { boundedToolContext } from '../../../core/agent-loop/tool-output-limit.js'
import { waitCommandTool, waitCommandsTool } from '../wait-tools.js'
import type { CommandReceipt } from '../command-receipt.js'

const context = { tenantId: 'command-wait-fixture', sessionId: 'root', toolProfile: 'general' } as AgentContext
const snapshots = new Map<string, CommandJobSnapshot>()
const logs = new Map<string, string>()
const pending = new Map<string, Set<(snapshot: CommandJobSnapshot) => void>>()
const observedScopes: CommandJobScope[] = []
let activeObservers = 0

function job(id: string, status: CommandJobSnapshot['status'] = 'running'): CommandJobSnapshot {
  const value: CommandJobSnapshot = { schemaVersion: 1, jobId: id, sessionId: 'root', ownerSessionId: 'root', version: 1,
    status, command: 'fixture', args: [], cwd: '.', background: true, createdAt: 1, updatedAt: 1,
    exitCode: status === 'succeeded' ? 0 : null, signal: null, cursor: 1, earliestCursor: 0 }
  snapshots.set(id, value)
  logs.set(id, `output ${id}`)
  return value
}

function finish(id: string, status: CommandJobSnapshot['status'] = 'succeeded'): void {
  const current = snapshots.get(id)!
  current.status = status
  current.exitCode = status === 'succeeded' ? 0 : 1
  for (const resolve of [...pending.get(id) ?? []]) resolve(current)
}

function visible(scope: CommandJobScope, id: string): CommandJobSnapshot | null {
  const value = snapshots.get(id)
  return value && scope.tenantId === context.tenantId && scope.sessionId === value.sessionId
    && (!scope.ownerSessionId || scope.ownerSessionId === value.ownerSessionId)
    && (!scope.ownerRunId || scope.ownerRunId === value.ownerRunId) ? value : null
}

beforeEach(() => {
  snapshots.clear(); logs.clear(); pending.clear(); observedScopes.length = 0; activeObservers = 0
  vi.useFakeTimers()
  vi.stubEnv('OSM_MODE', 'off')
  vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '8000')
  vi.spyOn(commandJobs, 'waitForCompletion').mockImplementation(async (scope, id, signal) => {
    observedScopes.push(scope)
    const value = visible(scope, id)
    if (!value || !['running', 'cancelling'].includes(value.status)) return value
    if (signal?.aborted) throw signal.reason
    return new Promise((resolve, reject) => {
      activeObservers++
      const listeners = pending.get(id) ?? new Set<(snapshot: CommandJobSnapshot) => void>()
      pending.set(id, listeners)
      const cleanup = () => { activeObservers--; listeners.delete(onFinish); signal?.removeEventListener('abort', onAbort) }
      const onFinish = (snapshot: CommandJobSnapshot) => { cleanup(); resolve(snapshot) }
      const onAbort = () => { cleanup(); reject(signal?.reason) }
      listeners.add(onFinish)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  })
  vi.spyOn(commandJobs, 'output').mockImplementation(async (scope, id, options = {}) => {
    observedScopes.push(scope)
    const value = visible(scope, id)
    if (!value) return null
    const cursor = options.cursor ?? 0, offset = options.cursorOffset ?? 0
    const bytes = Buffer.from(logs.get(id) ?? '', 'utf8')
    const text = cursor < 1 ? bytes.subarray(offset).toString('utf8') : ''
    return { job: value, entries: text ? [{ seq: 1, stream: 'stdout', text }] : [], nextCursor: 1, nextOffset: 0,
      earliestCursor: 0, truncated: false, hasMore: false }
  })
  vi.spyOn(commandJobs, 'cancel').mockImplementation(async () => { throw new Error('Waiting must not cancel commands') })
  vi.spyOn(commandJobs, 'start').mockImplementation(async () => { throw new Error('Waiting must not start commands') })
})

afterEach(() => {
  expect(commandJobs.cancel).not.toHaveBeenCalled()
  expect(commandJobs.start).not.toHaveBeenCalled()
  expect(activeObservers).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers()
})

describe('bounded command waits', () => {
  it('returns the completed state, output and full metadata while releasing its deadline', async () => {
    job('build')
    const result = waitCommandTool.execute({ jobId: 'build', waitMs: 1000 }, context)
    await vi.advanceTimersByTimeAsync(30)
    finish('build')
    const observed = await result
    expect(JSON.parse(observed.output)).toMatchObject({ type: 'command_result', version: 1, status: 'succeeded', exitCode: 0,
      entries: [{ seq: 1, stream: 'stdout', text: 'output build' }], nextCursor: 1, nextOffset: 0 })
    expect(observed.metadata?.commandJob).toBe(snapshots.get('build'))
  })

  it('uses 10 seconds by default and returns true running state without cancelling the job', async () => {
    job('watch')
    let resolved = false
    const result = waitCommandTool.execute({ jobId: 'watch' }, context).then(value => { resolved = true; return value })
    await vi.advanceTimersByTimeAsync(9999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse((await result).output)).toMatchObject({ status: 'running', exitCode: null })
    expect(snapshots.get('watch')?.status).toBe('running')
  })

  it('waits concurrently with one deadline and reports completed and still-cancelling jobs together', async () => {
    job('a'); job('b', 'cancelling'); job('c')
    const result = waitCommandsTool.execute({ jobs: [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }], waitMs: 1000 }, context)
    expect(commandJobs.waitForCompletion).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(300)
    finish('a'); finish('c', 'failed')
    await vi.advanceTimersByTimeAsync(700)
    const observed = await result
    const receipt = JSON.parse(observed.output)
    expect(receipt).toMatchObject({ type: 'command_results', version: 1 })
    expect(receipt.results.map((item: CommandReceipt) => [item.jobId, item.status])).toEqual([
      ['a', 'succeeded'], ['b', 'cancelling'], ['c', 'failed'],
    ])
    expect(observed.success).toBe(true) // Observation success does not claim every process succeeded.
  })

  it('returns immediately after all jobs finish before the shared deadline', async () => {
    job('a'); job('b')
    const result = waitCommandsTool.execute({ jobs: [{ jobId: 'a' }, { jobId: 'b' }], waitMs: 60_000 }, context)
    finish('a'); finish('b')
    expect((await result).success).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads immediately with waitMs=0 and does not attach completion observers', async () => {
    job('watch')
    const result = await waitCommandTool.execute({ jobId: 'watch', waitMs: 0 }, context)
    expect(JSON.parse(result.output).status).toBe('running')
    expect(commandJobs.waitForCompletion).not.toHaveBeenCalled()
  })

  it('aborts all observers immediately, removes the parent listener and does not read output', async () => {
    job('a'); job('b')
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = waitCommandsTool.execute({ jobs: [{ jobId: 'a' }, { jobId: 'b' }], waitMs: 60_000 }, { ...context, signal: controller.signal })
    const rejection = expect(result).rejects.toThrow('user input')
    controller.abort(new Error('user input'))
    await rejection
    expect(commandJobs.output).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
  })

  it('does not register anything for an already-aborted invocation', async () => {
    const controller = new AbortController(); controller.abort(new Error('stopped'))
    await expect(waitCommandTool.execute({ jobId: 'a' }, { ...context, signal: controller.signal })).rejects.toThrow('stopped')
    expect(commandJobs.waitForCompletion).not.toHaveBeenCalled()
    expect(commandJobs.output).not.toHaveBeenCalled()
  })

  it('confines a child wait and read to its root, owner session and owner run', async () => {
    job('root-job', 'succeeded')
    Object.assign(job('own-job', 'succeeded'), { ownerSessionId: 'child', ownerRunId: 'child-run' })
    Object.assign(job('older-run-job', 'succeeded'), { ownerSessionId: 'child', ownerRunId: 'old-run' })
    const child = { ...context, rootSessionId: 'root', sessionId: 'child', runId: 'child-run' }
    const result = await waitCommandsTool.execute({ jobs: [{ jobId: 'root-job' }, { jobId: 'own-job' }, { jobId: 'older-run-job' }] }, child)
    const receipt = JSON.parse(result.output)
    expect(receipt.results[0]).toEqual({ jobId: 'root-job', error: 'COMMAND_JOB_NOT_FOUND' })
    expect(receipt.results[1]).toMatchObject({ jobId: 'own-job', status: 'succeeded' })
    expect(receipt.results[2]).toEqual({ jobId: 'older-run-job', error: 'COMMAND_JOB_NOT_FOUND' })
    expect(result.metadata?.commandJobs).toEqual([snapshots.get('own-job')])
    expect(observedScopes.every(scope => JSON.stringify(scope) === JSON.stringify({ tenantId: context.tenantId,
      sessionId: 'root', ownerSessionId: 'child', ownerRunId: 'child-run' }))).toBe(true)
  })

  it('isolates missing, observer-failed and read-failed jobs without dropping successful siblings', async () => {
    job('ok', 'succeeded'); job('observe-fail', 'succeeded'); job('read-fail', 'succeeded')
    vi.mocked(commandJobs.waitForCompletion).mockImplementationOnce(async () => { throw new Error('db failure') })
    vi.mocked(commandJobs.output).mockImplementationOnce(async () => { throw new Error('db failure') })
    const result = await waitCommandsTool.execute({ jobs: [{ jobId: 'observe-fail' }, { jobId: 'read-fail' }, { jobId: 'missing' }, { jobId: 'ok' }] }, context)
    expect(JSON.parse(result.output).results).toEqual([
      { jobId: 'observe-fail', error: 'COMMAND_WAIT_FAILED' }, { jobId: 'read-fail', error: 'COMMAND_OUTPUT_FAILED' },
      { jobId: 'missing', error: 'COMMAND_JOB_NOT_FOUND' }, expect.objectContaining({ jobId: 'ok', status: 'succeeded' }),
    ])
    expect(result).toMatchObject({ success: false, error: 'COMMAND_WAIT_PARTIAL_FAILURE' })
  })

  it('shares the actual invocation budget and delivers escaped Unicode logs exactly once across pages', async () => {
    job('one', 'succeeded'); job('two', 'succeeded')
    logs.set('one', '一😀"\\\n'.repeat(250)); logs.set('two', '二🚀\t'.repeat(250))
    const ctx = boundedToolContext(context, 1800)
    let jobs = [{ jobId: 'one', cursor: 0, cursorOffset: 0 }, { jobId: 'two', cursor: 0, cursorOffset: 0 }]
    const delivered = new Map([['one', ''], ['two', '']])
    for (let page = 0; page < 40; page++) {
      const result = await waitCommandsTool.execute({ jobs, waitMs: 0 }, ctx)
      expect(result.output.length).toBeLessThanOrEqual(1800)
      expect(result.success).toBe(true)
      const items = JSON.parse(result.output).results as CommandReceipt[]
      for (const item of items) delivered.set(item.jobId, delivered.get(item.jobId)! + item.entries.map(entry => entry.text).join(''))
      jobs = items.map(item => ({ jobId: item.jobId, cursor: item.nextCursor, cursorOffset: item.nextOffset }))
      if (items.every(item => !item.hasMore)) break
    }
    expect(delivered).toEqual(logs)
    expect(jobs.every(item => item.cursor === 1 && item.cursorOffset === 0)).toBe(true)
  })

  it('returns explicit per-item budget errors without fabricated cursors when receipts cannot fit', async () => {
    job('one', 'succeeded'); job('two', 'succeeded')
    const result = await waitCommandsTool.execute({ jobs: [{ jobId: 'one', cursor: 0 }, { jobId: 'two', cursorOffset: 3 }], waitMs: 0 }, boundedToolContext(context, 300))
    expect(result.output.length).toBeLessThanOrEqual(300)
    expect(JSON.parse(result.output).results).toEqual([
      { jobId: 'one', error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' }, { jobId: 'two', error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' },
    ])
  })

  it('refuses an envelope that cannot fit before waiting or consuming any output', async () => {
    const result = await waitCommandsTool.execute({ jobs: [{ jobId: 'x'.repeat(500) }, { jobId: 'y' }] }, boundedToolContext(context, 300))
    expect(result).toMatchObject({ success: false, error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' })
    expect(result.output.length).toBeLessThanOrEqual(300)
    expect(commandJobs.waitForCompletion).not.toHaveBeenCalled()
    expect(commandJobs.output).not.toHaveBeenCalled()
  })

  it.each([null, {}, { jobId: '' }, { jobId: 'a', waitMs: -1 }, { jobId: 'a', waitMs: 60_001 },
    { jobId: 'a', waitMs: 0.5 }, { jobId: 'a', cursor: -1 }, { jobId: 'a', cursorOffset: NaN }])('rejects invalid single arguments %j', async input => {
    expect(await waitCommandTool.execute(input, context)).toMatchObject({ success: false, error: 'COMMAND_INVALID_ARGUMENTS' })
    expect(commandJobs.waitForCompletion).not.toHaveBeenCalled()
  })

  it.each([{}, { jobs: [] }, { jobs: [{ jobId: 'a' }, { jobId: 'a' }] },
    { jobs: Array.from({ length: 9 }, (_, index) => ({ jobId: `${index}` })) },
    { jobs: [{ jobId: 'a', cursorOffset: Infinity }] }, { jobs: [{ jobId: 'a' }], waitMs: '10' }])('rejects invalid batch arguments %j', async input => {
    expect(await waitCommandsTool.execute(input, context)).toMatchObject({ success: false, error: 'COMMAND_INVALID_ARGUMENTS' })
    expect(commandJobs.waitForCompletion).not.toHaveBeenCalled()
  })
})

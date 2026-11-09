import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, ToolCall, ToolResult } from '../../agent-context/types.js'
import type { LLMAdapter } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
vi.mock('../../../storage/results/index.js', () => ({ finalResults: {
  stalePaths: async () => [], prepare: async () => undefined, retainToolImages: async () => [],
}, TOOL_RESULT_IMAGE_ASSETS: '__aetherResultImageAssets' }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, args })
const read = (id: string, path = `${id}.txt`) => call(id, 'read_file', { path })
const write = (id: string, path = `${id}.txt`) => call(id, 'write_file', { path, data: id, expectedHash: 'missing' })

/** Exercise the actual ReAct dispatch/settlement loop. Tools and the provider
 * are controlled in-memory doubles so timing assertions do not use sleeps,
 * filesystem throughput, external services or production state. */
function fixture(calls: ToolCall[], answer = 'Read or written files confirmed.') {
  const history: Message[] = []
  const requests: Message[][] = []
  const executed: string[] = []
  const controller = new AbortController()
  const definitions = [...new Set(calls.map(item => item.name))].map(name => ({ name, description: name, parameters: { type: 'object' as const } }))
  const ctx = {
    tenantId: 'tenant', sessionId: 'batch-io', rootRunId: 'root-batch', turnId: 'turn-batch',
    userMessageId: 'user-batch', assistantMessageId: 'answer-batch', tokenBudget: 100_000,
    signal: controller.signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: async () => 0,
    },
    tools: {
      list: () => definitions, has: (name: string) => definitions.some(item => item.name === name),
      preflight: vi.fn(async (): Promise<ToolResult | undefined> => undefined),
      executionMode: (name: string) => name === 'read_file' ? 'readonly' : 'serial',
      execute: vi.fn(async (_name: string, _args: unknown, invocation: AgentContext): Promise<ToolResult> => {
        executed.push(invocation.currentToolCallId!)
        return { success: true, output: 'ok' }
      }),
    },
    runObserver: { onOutcome: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn() },
    onPending: vi.fn(), commitPending: vi.fn(),
  } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'fixture-model', provider: 'fixture-provider', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (messages) {
      requests.push(structuredClone(messages))
      if (requests.length === 1) yield { done: true, toolCalls: calls.map((item, index) => ({ ...item, args: JSON.stringify(item.args), index })) }
      else yield { done: true, content: answer }
    }),
  }
  return { ctx, history, requests, executed, controller, async run() {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, { maxIterations: 4 }).run('Process the specified files.', ctx)) frames.push(frame)
    return frames
  } }
}
const results = (frames: string[]) => frames.filter(frame => frame.startsWith('\x00__tool_result__'))
  .map(frame => JSON.parse(frame.slice('\x00__tool_result__'.length)))
const toolMessages = (messages: Message[]) => messages.filter(message => message.role === 'tool')

describe('independent file operations share a model round without losing execution barriers', () => {
  it('starts all readonly siblings before any finishes and sends all their receipts to the next model request', async () => {
    const f = fixture([read('a'), read('b'), read('c')])
    const started = deferred(), release = deferred()
    let active = 0, peak = 0
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      f.executed.push(invocation.currentToolCallId!)
      peak = Math.max(peak, ++active)
      if (active === 3) started.resolve()
      await release.promise
      active--
      return { success: true, output: `content:${invocation.currentToolCallId}` }
    })
    const running = f.run()
    try {
      await started.promise
      expect(f.executed).toEqual(['a', 'b', 'c'])
      expect(f.requests).toHaveLength(1)
      expect(peak).toBe(3)
    } finally { release.resolve() }
    const frames = await running
    expect(f.requests).toHaveLength(2)
    expect(toolMessages(f.requests[1]).map(message => message.toolCallId)).toEqual(['a', 'b', 'c'])
    expect(toolMessages(f.requests[1]).map(message => message.content)).toEqual(['content:a', 'content:b', 'content:c'])
    expect(results(frames).map(result => [result.toolCallId, result.status])).toEqual([
      ['a', 'succeeded'], ['b', 'succeeded'], ['c', 'succeeded'],
    ])
  })

  it('writes independent files in one model round while preserving serialized publication and separate receipts', async () => {
    const f = fixture([write('first'), write('second'), write('third')])
    const published = new Map<string, string>(), events: string[] = []
    let active = 0, peak = 0
    f.ctx.tools.execute = vi.fn(async (_name, args, invocation) => {
      const input = args as { path: string; data: string }
      peak = Math.max(peak, ++active)
      events.push(`start:${invocation.currentToolCallId}`)
      await Promise.resolve()
      published.set(input.path, input.data)
      events.push(`end:${invocation.currentToolCallId}`)
      active--
      return { success: true, output: `published:${input.path}`, metadata: { fileMutationApplied: true } }
    })
    const frames = await f.run()
    expect(peak).toBe(1)
    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second', 'start:third', 'end:third'])
    expect([...published.entries()]).toEqual([['first.txt', 'first'], ['second.txt', 'second'], ['third.txt', 'third']])
    expect(f.requests).toHaveLength(2)
    expect(toolMessages(f.requests[1]).map(message => message.content)).toEqual(['published:first.txt', 'published:second.txt', 'published:third.txt'])
    expect(results(frames).every(result => result.success === true)).toBe(true)
    expect(f.ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }))
  })

  it('keeps same-file edit/read barriers and exposes a stale second edit rather than undoing the first', async () => {
    const f = fixture([
      call('edit-1', 'edit_file', { path: 'shared.txt', expectedHash: 'v0', data: 'updated' }), read('read-1', 'shared.txt'),
      call('edit-stale', 'edit_file', { path: 'shared.txt', expectedHash: 'v0', data: 'stale-overwrite' }), read('read-2', 'shared.txt'),
    ], 'The first edit succeeded; the stale second edit was rejected.')
    let content = 'original', version = 'v0'
    f.ctx.tools.execute = vi.fn(async (name, args, invocation) => {
      f.executed.push(invocation.currentToolCallId!)
      const input = args as { expectedHash?: string; data?: string }
      if (name === 'read_file') return { success: true, output: `${version}:${content}` }
      if (input.expectedHash !== version) return { success: false, output: 'VERSION_CONFLICT', metadata: { fileMutationApplied: false } }
      await Promise.resolve()
      content = input.data!; version = 'v1'
      return { success: true, output: `${version}:${content}`, metadata: { fileMutationApplied: true } }
    })
    const frames = await f.run()
    expect(f.executed).toEqual(['edit-1', 'read-1', 'edit-stale', 'read-2'])
    expect(content).toBe('updated')
    expect(f.requests).toHaveLength(2)
    expect(toolMessages(f.requests[1]).map(message => message.content)).toEqual(['v1:updated', 'v1:updated', 'VERSION_CONFLICT', 'v1:updated'])
    expect(results(frames).map(result => result.status)).toEqual(['succeeded', 'succeeded', 'failed', 'succeeded'])
  })

  it('keeps a failed file result distinct while completing independent writes in the same response', async () => {
    const f = fixture([write('good-a'), write('bad'), write('good-b')], 'Two files were written; the bad file could not be written.')
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      f.executed.push(invocation.currentToolCallId!)
      return invocation.currentToolCallId === 'bad'
        ? { success: false, output: 'Destination is unavailable', error: 'FILE_WRITE_FAILED' }
        : { success: true, output: `written:${invocation.currentToolCallId}` }
    })
    const frames = await f.run()
    expect(f.executed).toEqual(['good-a', 'bad', 'good-b'])
    expect(f.requests).toHaveLength(2)
    expect(results(frames).map(result => [result.toolCallId, result.success, result.status])).toEqual([
      ['good-a', true, 'succeeded'], ['bad', false, 'failed'], ['good-b', true, 'succeeded'],
    ])
    expect(toolMessages(f.requests[1])).toHaveLength(3)
  })

  it('preflights the entire batch before performing any write when one sibling requires approval', async () => {
    const f = fixture([write('before'), write('approval'), write('after')])
    f.ctx.tools.preflight = vi.fn(async (_name, _args, invocation) => invocation.currentToolCallId === 'approval'
      ? { success: false, output: 'Requires approval', needsConfirmation: true } : undefined)
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(1)
    expect(results(frames).map(result => result.status)).toEqual(['interrupted', 'waiting', 'interrupted'])
    expect(f.ctx.onPending).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'approval', kind: 'permission' }))
    expect(f.ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'blocked', stopReason: 'permission' }))
  })

  it('retains a completed write receipt but never starts queued writes after cancellation', async () => {
    const f = fixture([write('completed'), write('queued-a'), write('queued-b')])
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      f.executed.push(invocation.currentToolCallId!)
      f.controller.abort()
      return { success: true, output: 'Published before cancellation', metadata: { fileMutationApplied: true } }
    })
    const frames = await f.run()
    expect(f.executed).toEqual(['completed'])
    expect(f.requests).toHaveLength(1)
    expect(results(frames).map(result => result.status)).toEqual(['succeeded', 'cancelled', 'cancelled'])
    expect(f.ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })

  it('does not let a mixed batch continue file work after successful final delivery', async () => {
    const f = fixture([write('accepted'), call('deliver', 'deliver_files', { items: [{ path: 'accepted.txt' }] }),
      write('too-late'), read('also-too-late', 'accepted.txt')], 'Delivered the accepted file.')
    const frames = await f.run()
    expect(f.executed).toEqual(['accepted', 'deliver'])
    expect(f.requests).toHaveLength(2)
    const receipts = results(frames)
    expect(receipts.map(result => result.status)).toEqual(['succeeded', 'succeeded', 'failed', 'failed'])
    expect(toolMessages(f.history).slice(-2).map(message => JSON.parse(String(message.content)).code))
      .toEqual(['FINAL_DELIVERY_CLOSEOUT', 'FINAL_DELIVERY_CLOSEOUT'])
  })
})

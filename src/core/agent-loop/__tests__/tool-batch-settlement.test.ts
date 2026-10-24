import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Pending, Tool, ToolCall, ToolResult } from '../../agent-context/index.js'
import type { LLMAdapter } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'
import { StreamBus } from '../../stream-pipeline/stream-bus.js'
import { imageToolPayload } from '../../utils/multimodal-context.js'
import { TOOL_FILE_EVIDENCE_KEY, CLEARED_TOOL_EVIDENCE_KEY } from '../../utils/tool-evidence.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllEnvs() })

function fixture(calls: ToolCall[]) {
  const history: Message[] = []
  const outcomes: unknown[] = []
  let requestCount = 0
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', rootRunId: 'root-1', turnId: 'turn-1',
    userMessageId: 'user-1', assistantMessageId: 'assistant-1', workspaceDir: '.', tokenBudget: 100_000,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'test' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: vi.fn(async () => 0),
    },
    tools: { list: () => [], has: () => true, preflight: vi.fn(async () => undefined as ToolResult | undefined),
      executionMode: vi.fn(() => 'serial'), execute: vi.fn(async () => ({ success: true, output: 'ok' } as ToolResult)) },
    runObserver: { onOutcome: vi.fn(async outcome => { outcomes.push(outcome) }), onToolStart: vi.fn(), onToolEnd: vi.fn() },
    onPending: vi.fn(async (_pending: Pending) => {}),
  } as unknown as AgentContext
  const llm = { model: 'test', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* () {
      if (requestCount++ === 0 && calls.length) yield { done: true, toolCalls: calls.map((call, index) => ({ ...call, args: JSON.stringify(call.args), index })) }
      else yield { done: true, content: 'done' }
    }) } as LLMAdapter
  async function run(input: string | null = 'task', maxIterations = 3) {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, { maxIterations }).run(input, ctx)) frames.push(frame)
    return frames
  }
  return { ctx, llm, history, outcomes, run }
}
const call = (id: string, name = 'write_file'): ToolCall => ({ id, name, args: { path: `${id}.txt` } })
const toolResults = (frames: string[]) => frames.filter(frame => frame.startsWith('\x00__tool_result__')).map(frame => JSON.parse(frame.slice('\x00__tool_result__'.length)))

describe('D3 batch side effects and terminal evidence', () => {
  it.each(['readonly', 'serial'] as const)('only captures file evidence from registry-authenticated builtin reads (%s)', async mode => {
    const f = fixture([call('file-version', 'read_file')])
    const version = { path: 'D:/workspace/report.png', expectedHash: 'sha256:' + 'f'.repeat(64), encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false }
    const implementation: Tool = { name: 'read_file', description: 'read', parameters: { type: 'object' }, executionMode: 'readonly',
      execute: vi.fn(async () => ({ success: true, output: 'file data', metadata: { ...version,
      [TOOL_FILE_EVIDENCE_KEY]: { path: 'D:/forged', expectedHash: 'sha256:' + 'b'.repeat(64) },
      [CLEARED_TOOL_EVIDENCE_KEY]: { version: 1, messageId: 'foreign-session-message' } } })) }
    const registry = new ToolRegistry()
    registry.register(mode === 'readonly' ? trustBuiltinTool(implementation, 'readonly') : implementation)
    f.ctx.tools = registry
    expect(registry.executionMode('read_file', {})).toBe(mode)
    await f.run()
    const saved = f.history.find(message => message.role === 'tool')!
    expect(saved.metadata[CLEARED_TOOL_EVIDENCE_KEY]).toBeUndefined()
    expect(saved.metadata[TOOL_FILE_EVIDENCE_KEY]).toEqual(mode === 'readonly' ? { path: version.path, expectedHash: version.expectedHash } : undefined)
  })

  it.each([false, true])('budgets native image history semantically and emits recoverable bounded receipts only after storage succeeds (%s)', async failStorage => {
    const f = fixture([call('native-png', 'read_file')])
    const png = Buffer.alloc(900_000)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(400, 16); png.writeUInt32BE(400, 20)
    const dataUrl = 'data:image/png;base64,' + png.toString('base64')
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output: JSON.stringify({ filename: 'layout.png', mimeType: 'image/png', size: png.length, dataUrl, hasDataUrl: true }) }))
    if (failStorage) {
      const append = f.ctx.history.append.bind(f.ctx.history)
      f.ctx.history.append = async (message, scope) => {
        if (message.role === 'tool') throw new Error('Synthetic image history write failure')
        return append(message, scope)
      }
    }
    const frames = await f.run()
    const result = toolResults(frames)[0]
    if (failStorage) {
      expect(result.metadata).not.toHaveProperty('imageOutputRecovery')
      expect(result.output).not.toContain('retainedInHistory')
      expect(f.history.some(message => message.role === 'tool')).toBe(false)
      return
    }
    const saved = f.history.find(message => message.role === 'tool')!
    expect(imageToolPayload(saved.content)?.dataUrl === dataUrl).toBe(true)
    expect(saved.tokens).toBeLessThan(4000)
    expect(JSON.parse(result.output)).toMatchObject({ hasDataUrl: false, dataUrlStripped: true, retainedInHistory: true, omittedFromStream: true })
    expect(result.metadata.imageOutputRecovery.source).toBe('durable-history')
    const bus = new StreamBus(new AbortController())
    for (const frame of frames) await bus.publish(frame)
    await bus.endOrdered()
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('commits answerable pending only after every held sibling receipt is durable', async () => {
    const f = fixture([call('before'), { id: 'ask', name: 'ask_user', args: { question: 'Synthetic choice', options: ['A', 'B'] } }, call('after')])
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>(yes => { release = yes }), started = new Promise<void>(yes => { entered = yes })
    const append = f.ctx.history.append.bind(f.ctx.history)
    f.ctx.history.append = async (message, scope) => {
      if (message.role === 'tool' && message.toolCallId === 'after') { entered(); await hold }
      return append(message, scope)
    }
    let committed = false
    f.ctx.commitPending = async pending => {
      expect(pending.requestId).toBe('ask')
      expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['before', 'after'])
      committed = true
    }
    const running = f.run(); await started
    expect(f.ctx.onPending).toHaveBeenCalledOnce(); expect(committed).toBe(false)
    release(); const frames = await running
    expect(committed).toBe(true); expect(frames.some(frame => frame.startsWith('\x00__permission_request__'))).toBe(true)
  })
  it('never publishes answerable frames when the pending commit cannot park its execution', async () => {
    const f = fixture([{ id: 'ask', name: 'ask_user', args: { question: 'Synthetic question', options: ['A', 'B'] } }])
    f.ctx.commitPending = async () => { throw new Error('Synthetic park receipt unknown') }
    const frames = await f.run()
    expect(frames.some(frame => frame.startsWith('\x00__ask_user__') || frame.startsWith('\x00__permission_request__'))).toBe(false)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'runtime_error',
      error: { code: 'RUNTIME_ERROR', message: 'Synthetic park receipt unknown' } })
    expect(frames.join('')).toContain('[Error: Synthetic park receipt unknown]')
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
  })
  it('keeps the complete tool result in Code mode instead of applying the chat truncation cap', async () => {
    const f = fixture([call('large', 'read_file')])
    const content = 'source line\n'.repeat(1_000)
    f.ctx.toolProfile = 'code'
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output: content }))
    await f.run()
    const result = f.history.find(message => message.role === 'tool')
    expect(result?.content).toBe(content)
  })

  it('publishes browser pixel evidence once so a valid result does not overflow the stream byte budget', async () => {
    const f = fixture([call('browser-click', 'browser_click')])
    const png = Buffer.alloc(300 * 1024)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(400, 16); png.writeUInt32BE(400, 20)
    const screenshot = { dataUrl: 'data:image/png;base64,' + png.toString('base64'), width: 400, height: 400 }
    const output = JSON.stringify({ tab: { tabId: 'owned-tab', title: 'Game', url: 'http://127.0.0.1:3000', navigationId: 1 },
      text: 'A stone was placed', elements: [], truncated: false, screenshot,
      interaction: { type: 'click', x: 100, y: 100, navigationId: 1, screenshot } })
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output }))
    const frames = await f.run()
    const result = toolResults(frames)[0]
    expect(result.status).toBe('succeeded')
    expect(result).not.toHaveProperty('outputPreview')
    expect(JSON.parse(result.output).screenshot.dataUrl).toBe(screenshot.dataUrl)
    expect(JSON.parse(result.output).interaction.screenshot.dataUrl).toBe(screenshot.dataUrl)
    const saved = f.history.find(message => message.role === 'tool')
    expect(saved?.content).toBe(result.output)
    expect(saved?.modelInputContent).not.toContain('data:image/')
    for (const frame of frames.filter(item => item.startsWith('\x00__tool_end__') || item.startsWith('\x00__tool_result__'))) {
      expect(Buffer.byteLength(frame, 'utf8')).toBeLessThan(1024 * 1024)
    }
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it.each([false, true])('bounds oversized browser receipts without claiming failed history is recoverable (storage failure: %s)', async failStorage => {
    const f = fixture([call('large-browser-click', 'browser_click')])
    const png = Buffer.alloc(600_000)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(400, 16); png.writeUInt32BE(400, 20)
    const screenshot = { dataUrl: 'data:image/png;base64,' + png.toString('base64'), width: 400, height: 400 }
    const output = JSON.stringify({ tab: { tabId: 'owned-tab', title: '游戏', url: 'http://127.0.0.1:3000', navigationId: 1 },
      text: '已落子', elements: [], truncated: false, screenshot,
      interaction: { type: 'click', x: 100, y: 100, navigationId: 1, screenshot } })
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output }))
    if (failStorage) {
      const append = f.ctx.history.append.bind(f.ctx.history)
      f.ctx.history.append = async (message, scope) => {
        if (message.role === 'tool') throw new Error('Synthetic history write failure')
        return append(message, scope)
      }
    }
    const frames = await f.run()
    const result = toolResults(frames)[0]
    expect(result.status).toBe('succeeded')
    if (failStorage) {
      expect(result.metadata).not.toHaveProperty('browserOutputRecovery')
      expect(result.output).not.toContain('retainedInHistory')
      expect(f.history.some(message => message.role === 'tool')).toBe(false)
      return
    }
    const saved = f.history.find(message => message.role === 'tool')!
    expect(JSON.parse(saved.content as string).screenshot.dataUrl).toBe(screenshot.dataUrl)
    expect(JSON.parse(saved.content as string).interaction.screenshot.dataUrl).toBe(screenshot.dataUrl)
    expect(saved.modelInputContent).not.toContain('data:image/')
    expect(JSON.parse(result.output).screenshot).toMatchObject({ retainedInHistory: true, omittedFromStream: true })
    expect(JSON.parse(result.output).interaction.screenshot.dataUrl).toBe(screenshot.dataUrl)
    const observed = vi.mocked(f.ctx.runObserver!.onToolEnd!).mock.calls[0][0]
    expect(JSON.parse(observed.output!).screenshot.dataUrl).toBe(screenshot.dataUrl)
    const bus = new StreamBus(new AbortController())
    for (const frame of frames) await bus.publish(frame)
    await bus.endOrdered()
    expect(bus.snapshot().finished).toBe(true)
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('preflights the entire batch before writing, persists pending before its event, and pairs every skipped sibling', async () => {
    const f = fixture([call('write-first'), call('approve', 'execute_cmd'), call('read-last', 'read_file')])
    let persisted = false
    f.ctx.tools.preflight = vi.fn(async name => name === 'execute_cmd' ? { success: false, output: 'approval required', needsConfirmation: true, pendingAction: { type: 'exec_policy' } } : undefined)
    f.ctx.onPending = vi.fn(async pending => { expect(pending).toMatchObject({ requestId: 'approve', toolCallId: 'approve', kind: 'permission' }); persisted = true })
    const frames = await f.run()
    expect(persisted).toBe(true)
    expect(f.ctx.tools.preflight).toHaveBeenCalledTimes(3)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['interrupted', 'waiting', 'interrupted'])
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['write-first', 'read-last'])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'blocked', stopReason: 'permission' })
  })

  it('an ask between siblings leaves no preceding orphan and performs no side effects', async () => {
    const f = fixture([call('before'), { id: 'ask', name: 'ask_user', args: { question: 'Choose a path' } }, call('after')])
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.ctx.onPending).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ask', requestId: 'ask', question: 'Choose a path' }))
    expect(toolResults(frames)).toHaveLength(3)
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['before', 'after'])
  })

  it('only proven read-only calls overlap and unknown tools execute one by one', async () => {
    const f = fixture([call('r1', 'read_file'), call('r2', 'read_file'), call('w1'), call('w2')])
    f.ctx.tools.executionMode = name => name === 'read_file' ? 'readonly' : 'serial'
    const running = new Set<string>()
    let readOverlap = false
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      const id = invocation.currentToolCallId!
      running.add(id)
      if (id === 'r2') readOverlap = running.has('r1')
      if (id.startsWith('w')) expect([...running]).toEqual([id])
      await new Promise(resolve => setTimeout(resolve, 5))
      running.delete(id)
      return { success: true, output: id }
    })
    await f.run()
    expect(readOverlap).toBe(true)
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(4)
  })

  it('settles every started sibling after a dynamic confirmation and a failure limit', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '1')
    const f = fixture([call('waiting', 'read_file'), call('failed', 'read_file'), call('finished', 'read_file')])
    f.ctx.tools.executionMode = () => 'readonly'
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => invocation.currentToolCallId === 'waiting'
      ? { success: false, output: 'confirm', needsConfirmation: true }
      : { success: invocation.currentToolCallId === 'finished', output: invocation.currentToolCallId! })
    const frames = await f.run()
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(3)
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['waiting', 'failed', 'succeeded'])
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['failed', 'finished'])
  })

  it('does not trip the repeated-failure circuit for retryable transient outages', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '1')
    const retry = call('retry', 'read_file')
    const f = fixture([retry])
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, toolCalls: [{ ...retry, args: JSON.stringify(retry.args) }] }
    })
    f.ctx.tools.execute = vi.fn(async () => ({ success: false, status: 'failed', output: 'temporary network timeout',
      error: 'ETIMEDOUT', metadata: { retryable: true } } as ToolResult))
    await f.run()
    expect(f.outcomes.at(-1)).not.toMatchObject({ stopReason: 'repeated_failure' })
    expect(f.outcomes.at(-1)).toMatchObject({ stopReason: 'max_steps' })
  })

  it('continues identical reads when another developer changes the returned file each round', async () => {
    const f = fixture([])
    let request = 0, version = 0
    f.llm.stream = vi.fn(async function* () {
      if (request++ < 12) yield { done: true, toolCalls: [{ id: 'read-' + request, name: 'read_file', args: '{"path":"shared.ts"}' }] }
      else yield { done: true, content: 'All shared versions verified.' }
    })
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output: 'Shared file version ' + ++version }))
    await f.run('Verify shared development.', 20)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(12)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('allows a configured zero to continue permanent failures until the model changes approach', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '0')
    const f = fixture([])
    let request = 0
    f.llm.stream = vi.fn(async function* () {
      if (request++ < 12) yield { done: true, toolCalls: [{ id: 'read-' + request, name: 'read_file', args: '{"path":"missing.ts"}' }] }
      else yield { done: true, content: 'The file is missing; report the unresolved evidence.' }
    })
    f.ctx.tools.execute = vi.fn(async () => ({ success: false, output: 'File does not exist.', error: 'ENOENT' }))
    await f.run('Inspect missing file.', 20)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(12)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('still stops genuinely unchanged successful calls when the optional limit is enabled', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '2')
    const f = fixture([])
    let request = 0
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, toolCalls: [{ id: 'read-' + ++request, name: 'read_file', args: '{"path":"unchanged.ts"}' }] }
    })
    await f.run('Inspect unchanged file.', 20)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(3)
    expect(f.outcomes.at(-1)).toMatchObject({ stopReason: 'repeated_failure' })
  })

  it('continues settling siblings if one history append fails', async () => {
    const f = fixture([call('first'), call('second')])
    const append = f.ctx.history.append
    f.ctx.history.append = vi.fn(async (message, context) => {
      if (message.role === 'tool' && message.toolCallId === 'first') throw new Error('storage unavailable')
      return append(message, context)
    })
    const frames = await f.run()
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(2)
    expect(toolResults(frames)).toHaveLength(2)
    expect(f.history.some(message => message.role === 'tool' && message.toolCallId === 'second')).toBe(true)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('resumes the exact approved call once before the model and emits its original terminal card', async () => {
    const f = fixture([])
    f.ctx.resumeToolCall = { toolCall: call('approved', 'execute_cmd'), messageId: 'original-tool-message', decision: 'approved' }
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      expect(invocation).toMatchObject({ currentToolCallId: 'approved', approvedToolCallId: 'approved' })
      expect(f.llm.stream).not.toHaveBeenCalled()
      return { success: true, output: 'executed original command', metadata: { test: 1 } }
    })
    const frames = await f.run(null)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(toolResults(frames)[0]).toMatchObject({ toolCallId: 'approved', messageId: 'original-tool-message', status: 'succeeded', metadata: { test: 1 }, outputPreview: 'executed original command' })
    expect(toolResults(frames)[0].durationMs).toBeTypeOf('number')
    expect(f.history.find(message => message.role === 'assistant')?.id).toBe('assistant-1')
    expect(frames).toContain('\x00__assistant_msg_id__assistant-1')
  })

  it('rejecting an approval performs no tool side effect and pairs the original call', async () => {
    const f = fixture([])
    f.ctx.resumeToolCall = { toolCall: call('rejected', 'execute_cmd'), decision: 'rejected' }
    const frames = await f.run(null)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames)[0]).toMatchObject({ toolCallId: 'rejected', status: 'interrupted', success: false })
    expect(f.history[0]).toMatchObject({ role: 'tool', toolCallId: 'rejected' })
  })

  it('publishes actual recorded file changes even when the writer reports partial failure', async () => {
    const f = fixture([call('partial')])
    f.ctx.tools.execute = async () => ({ success: false, output: 'partial write', change: { id: 'actual-change', path: 'partial.txt' }, metadata: { fileMutationApplied: true } })
    const frames = await f.run()
    expect(frames.some(frame => frame.startsWith('\x00__file_change__') && frame.includes('actual-change'))).toBe(true)
    expect(f.history.find(message => message.role === 'user')).toMatchObject({ id: 'user-1', metadata: { rootRunId: 'root-1', turnId: 'turn-1' } })
  })

  it('cancels every announced tool when its provider aborts before completing the batch', async () => {
    const f = fixture([])
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    f.llm.stream = async function* () {
      yield { done: false, toolCalls: [{ id: 'announced', name: 'write_file', args: '{"path":', index: 0 }] }
      controller.abort()
      throw new DOMException('cancelled', 'AbortError')
    }
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames)).toMatchObject([{ toolCallId: 'announced', status: 'cancelled' }])
    expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['announced'])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'cancelled' })
  })

  it('marks announced tools interrupted at a final request output limit without executing them', async () => {
    const f = fixture([])
    f.llm.stream = async function* () { yield { done: true, finishReason: 'length', toolCalls: [{ id: 'limited', name: 'write_file', args: '{}', index: 0 }] } }
    const frames = await f.run('task', 1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(toolResults(frames)).toMatchObject([{ toolCallId: 'limited', status: 'interrupted' }])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it('reports a pending persistence failure without emitting an answerable card or retrying tools', async () => {
    const f = fixture([{ id: 'ask', name: 'ask_user', args: { question: 'A?' } }, call('skipped')])
    f.ctx.onPending = async () => { throw new Error('database failed') }
    const frames = await f.run()
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(frames.some(frame => frame.startsWith('\x00__permission_request__'))).toBe(false)
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['failed', 'interrupted'])
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('waits for active siblings to cancel and gives a terminal result to queued serial work', async () => {
    const f = fixture([call('active', 'read_file'), call('abort', 'read_file'), call('unstarted')])
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    f.ctx.tools.executionMode = name => name === 'read_file' ? 'readonly' : 'serial'
    let cleanedUp = false
    f.ctx.tools.execute = vi.fn(async (_name, _args, invocation) => {
      if (invocation.currentToolCallId === 'active') await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => { cleanedUp = true; reject(controller.signal.reason) }, { once: true })
      })
      else { controller.abort(); throw controller.signal.reason }
      return { success: true, output: 'unreachable' }
    })
    const frames = await f.run()
    expect(cleanedUp).toBe(true)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(2)
    expect(toolResults(frames).map(frame => frame.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(3)
  })

  it('persists all sibling results before a stream consumer can return at the first terminal frame', async () => {
    const f = fixture([call('one'), call('two'), call('three')])
    const iterator = new ReActStrategy(f.llm, { maxIterations: 3 }).run('task', f.ctx)[Symbol.asyncIterator]()
    try {
      for (;;) {
        const step = await iterator.next()
        if (step.done) throw new Error('No tool end was emitted')
        if (step.value.startsWith('\x00__tool_end__')) break
      }
      expect(f.history.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['one', 'two', 'three'])
      expect(f.ctx.runObserver?.onToolEnd).toHaveBeenCalledTimes(3)
    } finally { await iterator.return?.() }
  })
})

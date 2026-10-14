import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { AgentContext, Message, ToolCall, ToolResult } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { ReActStrategy } from '../react.js'
import { estimateRequestInput } from '../finalization.js'
import { READONLY_REPETITION_PROMPT } from '../tool-progress.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const readonlyNames = new Set(['grep_search', 'read_file', 'command_output'])
const query = (pattern: string): ToolCall => ({ id: '', name: 'grep_search', args: { pattern, path: 'private/project' } })
const alternating = ['A', 'B', 'A', 'B'].map(query)

function fixture(calls: ToolCall[], profile: 'general' | 'code' = 'code') {
  vi.stubEnv('MAX_CONSECUTIVE_FAILURES', undefined)
  const history: Message[] = []
  const outcomes: RunOutcome[] = []
  const requests: Array<{ messages: Message[]; options: LLMAdapterOptions }> = []
  let request = 0
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', rootRunId: 'root', turnId: 'turn',
    userMessageId: 'user', assistantMessageId: 'assistant', workspaceDir: '.',
    toolProfile: profile, tokenBudget: 100_000, modelCaps: { contextWindow: 100_000 },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getFullHistory: vi.fn(async () => [...history]),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
    },
    tools: {
      list: () => [...readonlyNames, 'write_file'].map(name => ({ name, description: name, parameters: { type: 'object' } })),
      has: () => true, executionMode: (name: string) => readonlyNames.has(name) ? 'readonly' : 'serial',
      preflight: vi.fn(async () => undefined as ToolResult | undefined),
      execute: vi.fn(async (name: string, args: Record<string, unknown>) => ({ success: true, output: name === 'grep_search' ? 'matches ' + args.pattern : 'done' })),
    },
    runObserver: { onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }), onToolStart: vi.fn(), onToolEnd: vi.fn() },
  } as unknown as AgentContext
  const stream: LLMAdapter['stream'] = async function* (messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
    requests.push({ messages: [...messages], options: options! })
    const call = calls[request++]
    if (call) yield { done: true, toolCalls: [{ ...call, id: 'call-' + request, args: JSON.stringify(call.args), index: 0 }], finishReason: 'tool_calls' }
    else yield { done: true, content: 'Verified the remaining work.', finishReason: 'stop' }
  }
  const llm: LLMAdapter = {
    model: 'model', provider: 'mock', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(stream),
  }
  async function run(adapter: LLMAdapter = llm) {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(adapter).run('Develop and verify the approved project.', ctx)) frames.push(frame)
    return frames
  }
  return { ctx, history, requests, outcomes, llm, run }
}

const hasNotice = (request: { options: LLMAdapterOptions }) => request.options.systemPrompt?.includes(READONLY_REPETITION_PROMPT) ?? false

describe('ReAct request-local query cycle recovery', () => {
  it.each(['code', 'general'] as const)('injects safe budgeted guidance for %s and removes it after new evidence without persisting it', async profile => {
    const f = fixture([...alternating, query('new approach')], profile)
    f.ctx.tools.execute = vi.fn(async (_name, args) => ({ success: true, output: 'result for ' + (args as Record<string, unknown>).pattern + ' TOOL_OUTPUT_ATTACK' }))
    const frames = await f.run()
    expect(f.requests.map(hasNotice)).toEqual([false, false, false, false, true, false])
    const corrected = f.requests[4]
    expect(corrected.options.systemPrompt).not.toContain('private/project')
    expect(corrected.options.systemPrompt).not.toContain('TOOL_OUTPUT_ATTACK')
    expect(corrected.options.tools?.map(tool => tool.name)).toEqual([...readonlyNames, 'write_file'])
    expect(corrected.options.requestInputTokenEstimate).toBe(estimateRequestInput(corrected.messages, corrected.options.systemPrompt, f.ctx.tools.list()))
    expect(corrected.options.requestInputTokenEstimate).toBeGreaterThan(estimateRequestInput(corrected.messages, undefined, f.ctx.tools.list()))
    expect(corrected.options.requestInputTokenEstimate! + corrected.options.maxTokens!).toBeLessThanOrEqual(f.ctx.modelCaps!.contextWindow!)
    expect(f.history.filter(message => message.role === 'user')).toHaveLength(1)
    expect(f.history.some(message => String(message.content).includes(READONLY_REPETITION_PROMPT))).toBe(false)
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(5)
    const correctedUsage = f.history.find(message => message.toolCall?.id === 'call-5')?.usage
    expect(correctedUsage?.systemPromptTokens).toBeGreaterThan(0)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', stopReason: 'completed' })
    expect(frames.filter(frame => !frame.startsWith('\x00__')).join('')).toBe('Verified the remaining work.')
  })

  it('allows a model to continue past repeated advice without an artificial stop', async () => {
    const f = fixture(Array.from({ length: 80 }, (_, index) => query(index % 2 ? 'B' : 'A')))
    await f.run()
    expect(f.requests).toHaveLength(81)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(80)
    expect(f.requests.slice(4).every(hasNotice)).toBe(true)
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(80)
    expect(f.requests.slice(2).every(request => request.messages.filter(message => message.toolCall).length === 2)).toBe(true)
    expect(f.requests.at(-1)!.messages.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(f.requests.at(-1)!.options.systemPrompt).toContain('78 older redundant successful read-only call/result pairs')
    expect(f.outcomes).toEqual([expect.objectContaining({ status: 'succeeded', stopReason: 'completed' })])
  })

  it('clears old query evidence after a completed write while preserving tool policy', async () => {
    const f = fixture([...alternating, { id: '', name: 'write_file', args: { path: 'module.ts', content: 'new' } }, query('A')])
    await f.run()
    expect(f.requests.map(hasNotice)).toEqual([false, false, false, false, true, false, false])
    expect(f.ctx.tools.preflight).toHaveBeenCalledWith('write_file', { path: 'module.ts', content: 'new' }, expect.any(Object))
    expect(f.ctx.tools.execute).toHaveBeenCalledWith('write_file', { path: 'module.ts', content: 'new' }, expect.any(Object))
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('does not inject guidance for changing reads, including alternating real file versions', async () => {
    const f = fixture(Array.from({ length: 12 }, () => ({ id: '', name: 'read_file', args: { path: 'module.ts' } })))
    let version = 0
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output: 'version ' + (version++ % 2) }))
    await f.run()
    expect(f.requests.some(hasNotice)).toBe(false)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(12)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('does not inject guidance while an active command is being polled', async () => {
    const f = fixture(Array.from({ length: 12 }, () => ({ id: '', name: 'command_output', args: { jobId: 'build' } })))
    f.ctx.tools.execute = vi.fn(async () => ({ success: true, output: 'no new output', metadata: { commandJob: { status: 'running' } } }))
    await f.run()
    expect(f.requests.some(hasNotice)).toBe(false)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(12)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('preserves a blocked permission outcome instead of changing access to escape a cycle', async () => {
    const f = fixture([...alternating, { id: '', name: 'write_file', args: { path: 'outside/module.ts', content: 'new' } }])
    f.ctx.tools.preflight = vi.fn(async name => name === 'write_file' ? { success: false, output: 'Permission required', needsConfirmation: true,
      pendingAction: { type: 'fs_policy' } } : undefined)
    f.ctx.onPending = vi.fn(async () => {})
    const frames = await f.run()
    expect(f.requests.at(-1)).toSatisfy(hasNotice)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(4)
    expect(f.ctx.onPending).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'write_file', kind: 'permission' }))
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'blocked', stopReason: 'permission' })
    expect(frames.some(frame => frame.startsWith('\x00__permission_request__'))).toBe(true)
  })
})

describe('request projection transport and safe diagnostics', () => {
  it('sends the projected pairs and recovery notice through the real Anthropic adapter wire', async () => {
    const f = fixture(alternating)
    interface Block { type: string; id?: string; name?: string; tool_use_id?: string; input?: Record<string, unknown>; content?: string }
    interface Payload { system?: string; messages: Array<{ role: string; content: Block[] }> }
    const payloads: Payload[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Payload
      payloads.push(payload)
      const index = payloads.length
      const call = alternating[index - 1]
      const frames = [
        { type: 'message_start', message: { id: 'm-' + index, type: 'message', role: 'assistant', model: 'qwen3.8-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 }, stop_reason: null } },
        call ? { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'wire-' + index, name: call.name, input: {} } }
          : { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        call ? { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }
          : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Verified.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const adapter = new AnthropicAdapter('qwen3.8-flash', 'local-test-key', 'http://transport.invalid', { 'X-Access-Token': 'local-test-token' })
    await f.run(adapter)
    expect(payloads).toHaveLength(5)
    const last = payloads.at(-1)!
    expect(last.system).toContain(READONLY_REPETITION_PROMPT)
    expect(last.system).toContain('2 older redundant successful read-only call/result pairs')
    const blocks = last.messages.flatMap(message => message.content)
    expect(blocks.filter(block => block.type === 'tool_use').map(block => block.id)).toEqual(['wire-3', 'wire-4'])
    expect(blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id)).toEqual(['wire-3', 'wire-4'])
    expect(JSON.stringify(last.messages)).toContain('Develop and verify the approved project.')
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(4)
    expect(f.history.some(message => String(message.content).includes('context bookkeeping'))).toBe(false)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('meters every projected dispatch including its current notice and output reservation', async () => {
    const f = fixture(Array.from({ length: 12 }, (_, index) => query(index % 2 ? 'B' : 'A')), 'general')
    await f.run()
    for (const request of f.requests) {
      expect(request.options.requestInputTokenEstimate).toBe(estimateRequestInput(request.messages, request.options.systemPrompt, f.ctx.tools.list()))
      expect(request.options.requestInputTokenEstimate! + request.options.maxTokens!).toBeLessThanOrEqual(f.ctx.modelCaps!.contextWindow!)
    }
    expect(f.requests.at(-1)!.options.systemPrompt).toContain('10 older redundant successful read-only call/result pairs')
    expect(f.ctx.history.compress).not.toHaveBeenCalled()
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(12)
  })

  it('only logs safe activation/count/hash dispatch diagnostics when explicitly enabled', async () => {
    vi.stubEnv('READONLY_RECOVERY_DIAGNOSTICS', '1')
    const f = fixture(alternating)
    await f.run()
    const records = vi.mocked(f.ctx.logger.info).mock.calls.filter(call => call[1] === 'Readonly recovery request dispatch')
    expect(records).toHaveLength(5)
    expect(records.at(-1)![0]).toMatchObject({ readonlyRecovery: { hintActive: true, collapsedPairs: 2,
      hintSha256: createHash('sha256').update(READONLY_REPETITION_PROMPT).digest('hex'),
      systemPromptSha256: createHash('sha256').update(f.requests.at(-1)!.options.systemPrompt!).digest('hex'),
      requestMessageCount: 5, requestInputTokenEstimate: f.requests.at(-1)!.options.requestInputTokenEstimate } })
    expect(JSON.stringify(records)).not.toContain('private/project')
    expect(JSON.stringify(records)).not.toContain('matches A')
    expect(JSON.stringify(records)).not.toContain(READONLY_REPETITION_PROMPT)
  })

  it('does not emit recovery diagnostics by default', async () => {
    vi.stubEnv('READONLY_RECOVERY_DIAGNOSTICS', undefined)
    const f = fixture(alternating)
    await f.run()
    expect(vi.mocked(f.ctx.logger.info).mock.calls.some(call => call[1] === 'Readonly recovery request dispatch')).toBe(false)
  })
})

/** Work output recovery through the actual Anthropic SDK serializer and SSE parser. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Tool } from '../../agent-context/index.js'
import { ReActStrategy } from '../../agent-loop/react.js'
import type { RunOutcome } from '../../subagent/types.js'
import { AnthropicAdapter } from '../anthropic.js'
import type { LLMRequestAttemptEvent } from '../types.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

const MODEL = 'deepseek-v4.1-flash-1017'
const PRIVATE = 'fixture-private-reasoning'
const RESULT = 'The requested file is complete.'
const input = { path: 'index.html', content: '<main>Ready</main>' }
type WireEvent = { type: string; [key: string]: unknown }

function response(blocks: WireEvent[], reason: string, outputTokens: number): Response {
  const frames: WireEvent[] = [
    { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: MODEL,
      content: [], usage: { input_tokens: 20_000, output_tokens: 0 }, stop_reason: null, stop_sequence: null } },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: outputTokens } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } })
}

function reasoning(index: number, tokens = 8192): Response {
  return response([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: PRIVATE + index } },
    { type: 'content_block_stop', index: 0 },
  ], 'max_tokens', tokens)
}

function toolCall(truncated = false): Response {
  return response([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: truncated ? 'partial-tool' : 'complete-tool', name: 'write_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta',
      partial_json: truncated ? '{"path":"index.html","content":"unfinished' : JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
  ], truncated ? 'max_tokens' : 'tool_use', truncated ? 8192 : 30)
}

function answer(): Response {
  return response([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: RESULT } },
    { type: 'content_block_stop', index: 0 },
  ], 'end_turn', 12)
}

function fixture(contextWindow = 268_000) {
  vi.stubEnv('CONTEXT_WINDOW_BUDGET', String(contextWindow))
  const history: Message[] = [], outcomes: RunOutcome[] = [], attempts: LLMRequestAttemptEvent[] = []
  const files = new Map<string, string>()
  const execute = vi.fn(async (_name: string, args: unknown) => {
    const file = args as typeof input
    files.set(file.path, file.content)
    return { success: true, output: 'File written.' }
  })
  const tool: Tool = { name: 'write_file', description: 'Write a complete file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async args => execute('write_file', args) }
  const ctx = {
    tenantId: 'wire-fixture', sessionId: 'work-wire-session', rootRunId: 'work-wire-run', turnId: 'work-wire-turn',
    userMessageId: 'fixture-user', assistantMessageId: 'fixture-assistant', workspaceDir: '.',
    toolProfile: 'general', modelCaps: { contextWindow, thinking: true },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: async (message: Message) => { history.push(message); return message.id ?? 'fixture' },
      getHistory: async () => [...history], getFullHistory: async () => [...history],
      getRawTokenCount: async () => 0, microCompactToolResults: async () => ({ cleared: 0, freedTokens: 0 }),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
    },
    tools: { list: () => [tool], has: () => true, preflight: async () => undefined,
      executionMode: () => 'serial', execute },
    onRequestAttempt: (event: LLMRequestAttemptEvent) => { attempts.push(event) },
    runObserver: { onOutput: vi.fn(), onUsage: vi.fn(), onOutcome: async (outcome: RunOutcome) => { outcomes.push(outcome) } },
  } as unknown as AgentContext
  const wire: Record<string, unknown>[] = []
  const run = async (replies: Array<() => Response>) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      wire.push(JSON.parse(String(init?.body)))
      const next = replies[wire.length - 1]
      if (!next) throw new Error('Unexpected extra provider request')
      return next()
    }))
    const adapter = new AnthropicAdapter(MODEL, 'synthetic-fixture-key', 'http://fixture.invalid/anthropic',
      { 'X-Access-Token': 'synthetic-fixture-token' })
    const frames: string[] = []
    for await (const frame of new ReActStrategy(adapter, {
      maxIterations: replies.length + 1, thinkingEnabled: true, thinkingConfig: { enable_thinking: true },
    }).run('Create the approved file.', ctx)) frames.push(frame)
    return frames
  }
  const assertWireCapacity = () => {
    const starts = attempts.filter(event => event.type === 'start')
    expect(starts).toHaveLength(wire.length)
    for (const [index, request] of wire.entries()) {
      expect(request).toMatchObject({ model: MODEL, enable_thinking: true })
      expect(Number(request.max_tokens)).toBeGreaterThan(16_384)
      expect(Number.isInteger(request.max_tokens)).toBe(true)
      expect(request.max_tokens).toBe(starts[index].maxOutputTokens)
      expect(Number(request.max_tokens) + starts[index].estimatedInputTokens!).toBeLessThanOrEqual(contextWindow)
      expect(request.max_tokens).toBe(Math.min(393_216, contextWindow - starts[index].estimatedInputTokens!))
      expect(JSON.stringify(request.messages)).not.toContain(PRIVATE)
      expect(JSON.stringify(request)).not.toContain('"type":"disabled"')
    }
  }
  return { ctx, history, outcomes, attempts, files, execute, wire, run, assertWireCapacity }
}

describe('Work defaults use available output capacity across actual provider recovery', () => {
  it.each([268_000, 1_000_000])('continues three thinking-only cutoffs and completes with the configured %i context', async window => {
    const f = fixture(window)
    const frames = await f.run([() => reasoning(1), () => reasoning(2, 16_384), () => reasoning(3, 16_384),
      () => toolCall(), answer])
    expect(f.wire).toHaveLength(5)
    f.assertWireCapacity()
    expect(f.ctx.toolProfile).toBe('general')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0].slice(0, 2)).toEqual(['write_file', input])
    expect([...f.files.entries()]).toEqual([[input.path, input.content]])
    expect(frames.filter(frame => !frame.startsWith('\x00__')).join('')).toBe(RESULT)
    expect(f.outcomes).toEqual([{ status: 'succeeded', output: RESULT, stopReason: 'completed' }])
    const segments = f.history.filter(message => message.metadata?.outputReasoningRecovery)
    expect(segments).toHaveLength(3)
    expect(segments.every(message => message.metadata?.responseDiagnostics?.providerStream?.protocol === 'anthropic')).toBe(true)
    expect(segments.every(message => message.metadata?.responseDiagnostics?.providerStream?.rawStopReason === 'max_tokens')).toBe(true)
  })

  it('never executes truncated tool JSON after repeated private-only cutoffs', async () => {
    const f = fixture()
    await f.run([() => reasoning(1), () => reasoning(2), () => reasoning(3), () => toolCall(true), () => toolCall(), answer])
    expect(f.wire).toHaveLength(6)
    f.assertWireCapacity()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect([...f.files.entries()]).toEqual([[input.path, input.content]])
    expect(f.history.filter(message => message.role === 'tool' && message.metadata?.status === 'interrupted')).toHaveLength(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: RESULT })
  })
})

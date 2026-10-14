/** Exercises final serialization and existing SDK paths using fake responses, without live models. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import { OpenAIAdapter } from '../openai.js'
import { OllamaAdapter } from '../ollama.js'
import { DeepSeekAdapter } from '../deepseek.js'
import { QwenAdapter } from '../qwen.js'
import { WORKFLOW_REVIEW_PROMPT, READONLY_REPETITION_PROMPT, MUTATION_REPETITION_PROMPT } from '../../agent-loop/tool-progress.js'
import type { LLMAdapter, LLMAdapterOptions, LLMRequestAttemptEvent } from '../types.js'

type Provider = 'anthropic' | 'openai' | 'ollama' | 'deepseek' | 'qwen'
type Mode = 'complete' | 'stream'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function adapterFor(provider: Provider): LLMAdapter {
  if (provider === 'anthropic') return new AnthropicAdapter('claude-test', 'fixture-key', 'http://fixture.invalid', { 'X-Access-Token': 'fixture-token' })
  if (provider === 'openai') return new OpenAIAdapter('test-model', 'fixture-key', 'http://fixture.invalid')
  if (provider === 'deepseek') return new DeepSeekAdapter('deepseek-chat', 'fixture-key', 'http://fixture.invalid', { logCacheHits: false })
  if (provider === 'qwen') return new QwenAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid', { logUsage: false })
  return new OllamaAdapter('local', 'http://fixture.invalid')
}
function response(provider: Provider, mode: Mode): Response {
  if (mode === 'complete') {
    const result = provider === 'anthropic'
      ? { id: 'm', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }
      : provider !== 'ollama' ? { id: 'm', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
        : { model: 'local', message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 3, eval_count: 1 }
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
  }
  if (provider === 'ollama') return new Response(JSON.stringify({ model: 'local', message: { content: 'ok' }, done: true, prompt_eval_count: 3, eval_count: 1 }) + '\n')
  const frames = provider === 'anthropic' ? [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : [
    { id: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  ]
  return new Response(frames.map(frame => (provider === 'anthropic' && 'type' in frame ? 'event: ' + frame.type + '\n' : '') + 'data: ' + JSON.stringify(frame) + '\n\n').join('')
    + (provider !== 'anthropic' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}
function actualWireSystemHash(body: Record<string, unknown>): string {
  const systemMessages = (Array.isArray(body.messages) ? body.messages : []).filter(message => message.role === 'system' || message.role === 'developer')
  return createHash('sha256').update(JSON.stringify({ system: body.system ?? null,
    messages: systemMessages.map(message => ({ role: message.role, content: message.content })) })).digest('hex')
}
async function capture(provider: Provider, mode: Mode, options: Partial<LLMAdapterOptions> = {}) {
  const bodies: Array<Record<string, unknown>> = [], events: LLMRequestAttemptEvent[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected real serialized request body')
    bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return response(provider, mode)
  }))
  const adapter = adapterFor(provider)
  const configured: LLMAdapterOptions = { model: adapter.model, requestStage: 'normal',
    systemPrompt: 'Original policy\n' + WORKFLOW_REVIEW_PROMPT + '\n' + MUTATION_REPETITION_PROMPT, thinkingEnabled: false,
    ...options, onRequestAttempt: event => { events.push(event) } }
  const messages = [{ role: 'user' as const, content: 'PRIVATE_TASK' }]
  if (mode === 'complete') await adapter.complete(messages, configured)
  else for await (const _chunk of adapter.stream(messages, configured)) { /* drain the actual SDK stream */ }
  return { bodies, events }
}

describe('safe dispatch diagnostic matches actual SDK-serialized body', () => {
  const paths = (['anthropic', 'openai', 'ollama', 'deepseek', 'qwen'] as const).flatMap(provider =>
    (['complete', 'stream'] as const).flatMap(mode => (['normal', 'finalization'] as const).map(stage => [provider, mode, stage] as const)))
  it.each(paths)('%s %s %s captures final system and forwards only local diagnostic metadata', async (provider, mode, stage) => {
    const { bodies, events } = await capture(provider, mode, { requestStage: stage })
    expect(bodies).toHaveLength(1)
    expect(events.map(event => event.type)).toEqual(['start', 'finish'])
    expect(events[0]).toMatchObject({ dispatchDiagnostic: { schemaVersion: 2, availability: 'captured', requestStage: stage,
      systemPromptSha256: actualWireSystemHash(bodies[0]), workflowHintPresent: true, readonlyHintPresent: false, mutationHintPresent: true,
      wireMessageCount: Array.isArray(bodies[0].messages) ? bodies[0].messages.length : 0 } })
    expect(events[0].requestAttemptId).toBe(events[1].requestAttemptId)
    expect(events[1]).toMatchObject({ outcome: 'succeeded' })
    expect(bodies[0]).not.toHaveProperty('requestStage')
    expect(bodies[0]).not.toHaveProperty('dispatchDiagnostic')
    expect(bodies[0]).not.toHaveProperty('requestDispatchDiagnostic')
    expect(JSON.stringify(events)).not.toContain('PRIVATE_TASK')
    expect(JSON.stringify(events)).not.toContain(WORKFLOW_REVIEW_PROMPT)
    expect(JSON.stringify(events)).not.toContain(MUTATION_REPETITION_PROMPT)
  })

  it.each(['complete','stream'] as const)('ollama %s observes final thinkingConfig overrides rather than outer systemPrompt', async mode => {
    const { bodies, events } = await capture('ollama', mode, { requestStage: 'finalization', thinkingEnabled: undefined, thinkingConfig: {
      system: 'Actual finalization policy', messages: [{ role: 'system', content: READONLY_REPETITION_PROMPT }, { role: 'user', content: WORKFLOW_REVIEW_PROMPT + '\n' + MUTATION_REPETITION_PROMPT }],
    } })
    expect(events[0]).toMatchObject({ dispatchDiagnostic: { requestStage: 'finalization', workflowHintPresent: false,
      readonlyHintPresent: true, mutationHintPresent: false, systemPromptSha256: actualWireSystemHash(bodies[0]), wireMessageCount: 2 } })
  })

  it('keeps compatibility retries as distinct attempt IDs with correctly recomposed final diagnostics', async () => {
    const bodies: Array<Record<string, unknown>> = [], events: LLMRequestAttemptEvent[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'", type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      return response('openai', 'complete')
    }))
    const adapter = adapterFor('openai')
    await adapter.complete([{ role: 'user', content: 'task' }], { model: adapter.model, systemPrompt: WORKFLOW_REVIEW_PROMPT + '\n' + MUTATION_REPETITION_PROMPT,
      temperature: 0.7, requestStage: 'normal', onRequestAttempt: event => { events.push(event) } })
    expect(bodies).toHaveLength(2)
    const starts = events.filter(event => event.type === 'start')
    expect(starts).toHaveLength(2)
    expect(starts[0].requestAttemptId).not.toBe(starts[1].requestAttemptId)
    starts.forEach((event, index) => expect(event.dispatchDiagnostic).toMatchObject({ schemaVersion: 2, requestStage: 'normal', workflowHintPresent: true, mutationHintPresent: true, systemPromptSha256: actualWireSystemHash(bodies[index]) }))
    expect(events[1]).toMatchObject({ outcome: 'failed' })
    expect(events[3]).toMatchObject({ outcome: 'succeeded' })
  })
})

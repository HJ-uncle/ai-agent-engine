import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../storage/sqlite/db.js'
import { ModelsStore } from '../../../storage/sqlite/models.js'
import { up as modelSchema } from '../../../storage/sqlite/migrations/007_add_models_management.js'
import { up as capabilitySchema } from '../../../storage/sqlite/migrations/014_add_model_capabilities.js'
import { ReActStrategy } from '../../agent-loop/react.js'
import type { AgentContext, Message } from '../../agent-context/index.js'
import { resolveModelConfig, createAdapterFromResolved } from '../resolve-model.js'
import { FallbackAdapter } from '../retry.js'
import type { LLMAdapter, LLMAdapterOptions, LLMRequestAttemptEvent } from '../types.js'

vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'a1'.repeat(32) })
vi.mock('../../../storage/sqlite/system-config.js', () => ({ systemConfigStore: { get: vi.fn(async () => null) } }))
vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
let db: Client

beforeEach(async () => {
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await modelSchema(db)
  await capabilitySchema(db)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); db.close() })

describe('saved context-window overrides reach actual provider requests', () => {
  it('keeps a stored DeepSeek 128K override through Code mode and the Anthropic SDK wire', async () => {
    vi.stubEnv('LLM_FALLBACK_MODEL', '')
    const model = 'deepseek-v4.1-flash'
    const store = new ModelsStore()
    await store.createModel({ tenantId: 'fixture', provider: 'deepseek', modelId: model,
      apiKey: 'synthetic-fixture-key', baseUrl: 'http://fixture.invalid/anthropic', isEnabled: true,
      capabilities: { contextWindow: 128_000, vision: true } })
    const resolved = await resolveModelConfig({ tenantId: 'fixture', model,
      overrides: { extraHeaders: { 'X-Access-Token': 'synthetic-fixture-token' } } })
    expect(resolved.capabilities.contextWindow).toBe(128_000)
    const requestBodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      const frames = [
        { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model,
          content: [], usage: { input_tokens: 43, output_tokens: 0 }, stop_reason: null, stop_sequence: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Verified.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createAdapterFromResolved(resolved)
    expect(adapter.provider).toBe('anthropic')
    const history: Message[] = []
    const attempts: LLMRequestAttemptEvent[] = []
    const ctx = {
      tenantId: 'fixture', sessionId: 'fixture-session', rootRunId: 'fixture-run', turnId: 'fixture-turn',
      userMessageId: 'fixture-user', assistantMessageId: 'fixture-assistant', workspaceDir: '.',
      tokenBudget: 1, toolProfile: 'code', modelCaps: resolved.capabilities,
      onRequestAttempt: (event: LLMRequestAttemptEvent) => { attempts.push(event) },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      history: {
        append: async (message: Message) => { history.push(message); return message.id ?? 'fixture' },
        getHistory: async () => [...history], getFullHistory: async () => [...history],
        getRawTokenCount: async () => 0, microCompactToolResults: async () => ({ cleared: 0, freedTokens: 0 }),
        compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
      },
      tools: { list: () => [], has: () => true, preflight: async () => undefined,
        executionMode: () => 'serial', execute: async () => ({ success: true, output: '' }) },
    } as unknown as AgentContext
    const frames: string[] = []
    for await (const frame of new ReActStrategy(adapter, { maxIterations: 2 }).run('Verify the saved window.', ctx)) frames.push(frame)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const start = attempts.find(event => event.type === 'start')!
    expect(start.maxOutputTokens! + start.estimatedInputTokens!).toBe(128_000)
    expect(requestBodies[0].max_tokens).toBe(start.maxOutputTokens)
    expect(Number(requestBodies[0].max_tokens)).toBeLessThan(128_000)
    const usage = frames.filter(frame => frame.startsWith('\x00__usage__'))
      .map(frame => JSON.parse(frame.slice('\x00__usage__'.length)))
    expect(usage.length).toBeGreaterThan(1)
    expect(usage.every(frame => frame.contextWindow === 128_000)).toBe(true)
    expect(history.find(message => message.role === 'assistant')?.usage?.contextWindow).toBe(128_000)
  })

  it.each(['complete', 'stream'] as const)('never expands the requested 128K window to a 1M fallback (%s)', async mode => {
    const unavailable = Object.assign(new Error('Synthetic provider unavailable'), { status: 503 })
    const primary: LLMAdapter = {
      model: 'primary', provider: 'fixture', countTokens: () => 1,
      complete: vi.fn(async () => { throw unavailable }),
      stream: vi.fn(async function* () { throw unavailable }),
    }
    const fallback: LLMAdapter = {
      model: 'fallback', provider: 'fixture', countTokens: () => 1,
      complete: vi.fn(async () => ({ content: 'done', promptTokens: 1, completionTokens: 1, finishReason: 'stop' as const })),
      stream: vi.fn(async function* () { yield { done: true, content: 'done', promptTokens: 1, completionTokens: 1 } }),
    }
    const adapter = new FallbackAdapter({ primary, fallbacks: [fallback], modelContextWindows: { fallback: 1_000_000 } })
    const options: LLMAdapterOptions = { model: 'primary', contextWindow: 128_000, unboundedOutput: true,
      requestInputTokenEstimate: 64_000, maxTokens: 64_000 }
    const messages: Message[] = [{ role: 'user', content: 'Continue the project.' }]
    if (mode === 'complete') expect(await adapter.complete(messages, options)).toMatchObject({ contextWindow: 128_000 })
    else for await (const chunk of adapter.stream(messages, options)) expect(chunk.contextWindow).toBe(128_000)
    const call = vi.mocked(mode === 'complete' ? fallback.complete : fallback.stream).mock.calls[0][1]
    expect(call).toMatchObject({ contextWindow: 128_000, maxTokens: 64_000 })
    expect(options.contextWindow).toBe(128_000)
  })
})

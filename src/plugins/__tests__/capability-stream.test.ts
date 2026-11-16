import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamPluginCapability, type CapabilityAccess, type CapabilityCall } from '../capability-runtime.js'
import { PluginError } from '../types.js'
import type { PluginStreamEvent } from '../capability-stream-types.js'
import type { LLMStreamChunk } from '../../core/llm-adapter/types.js'

const mocks = vi.hoisted(() => ({ models: vi.fn(), resolve: vi.fn(), adapter: vi.fn(), stream: vi.fn() }))
vi.mock('../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.models } }))
vi.mock('../../core/llm-adapter/resolve-model.js', () => ({ resolveModelConfig: mocks.resolve, createAdapterFromResolved: mocks.adapter }))
const call: CapabilityCall = { capability: 'ai.run', method: 'stream', args: { modelId: 'configured', prompt: 'Review' }, expectedRevision: 1 }
let access: CapabilityAccess
let events: PluginStreamEvent[]
let chunks: LLMStreamChunk[]
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => {
  events = []
  access = { id: 'test-stream', revision: 1, manifest: { apiVersion: 1, id: 'test-stream', name: 'Stream', version: '1.0.0', description: 'test', runtime: 'node', tools: [], permissions: { requested: ['ai.run'] } },
    grants: ['ai.run'], getSettings: async () => ({}), setSettings: async value => value }
  access.refresh = async () => access
  chunks = [{ reasoningContent: 'private internal reasoning', done: false }, { content: 'First ', done: false }, { content: 'answer.', done: false }, { done: true, finishReason: 'stop', model: 'resolved-model', promptTokens: 20, completionTokens: 10 }]
  mocks.models.mockResolvedValue([{ id: 'configured', modelId: 'model', isEnabled: true }])
  mocks.resolve.mockResolvedValue({ model: 'resolved-model', capabilities: { contextWindow: 32_000 }, thinkingEnabled: false, thinkingConfig: { mode: 'saved' }, responseThinkingField: null })
  mocks.adapter.mockReturnValue({ stream: mocks.stream })
  mocks.stream.mockImplementation(async function* () { yield* chunks })
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })
const run = (signal?: AbortSignal) => streamPluginCapability(access, 'test-tenant', call, event => { events.push(event) }, signal)

describe('plugin capability streams with backpressure', () => {
  it('streams provider text with the configured request options and one complete result, never reasoning', async () => {
    const result = await run()
    expect(result).toEqual({ text: 'First answer.', model: 'resolved-model', usage: { inputTokens: 20, outputTokens: 10 } })
    expect(events.map(event => event.type)).toEqual(['started', 'text-delta', 'text-delta', 'complete'])
    expect(JSON.stringify(events)).not.toContain('private internal reasoning')
    expect(events.at(-1)).toEqual({ type: 'complete', result })
    expect(mocks.stream).toHaveBeenCalledWith([{ role: 'user', content: 'Review' }], expect.objectContaining({ model: 'resolved-model', unboundedOutput: true, contextWindow: 32_000, thinkingEnabled: false, thinkingConfig: { mode: 'saved' } }))
  })
  it('delivers a visible delta before completion and waits for the consumer instead of buffering', async () => {
    const provider = gate(), consumer = gate()
    let reads = 0
    mocks.stream.mockImplementation(async function* () { reads++; yield { content: 'live', done: false }; reads++; await provider.promise; yield { done: true, finishReason: 'stop' } })
    const pending = streamPluginCapability(access, 'test-tenant', call, async event => { events.push(event); if (event.type === 'text-delta') await consumer.promise })
    await vi.waitFor(() => expect(events.some(event => event.type === 'text-delta')).toBe(true))
    expect(reads).toBe(1)
    expect(events.some(event => event.type === 'complete')).toBe(false)
    consumer.resolve(); provider.resolve()
    await expect(pending).resolves.toMatchObject({ text: 'live' })
  })
  it('keeps the terminal stop reason when a trailing usage-only chunk arrives', async () => {
    chunks = [{ content: 'done', done: true, finishReason: 'stop' }, { done: true, promptTokens: 33, completionTokens: 7 }]
    await expect(run()).resolves.toMatchObject({ text: 'done', usage: { inputTokens: 33, outputTokens: 7 } })
    expect(mocks.stream).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ includeStreamUsage: true }))
  })
  it.each([
    ['eof', [{ content: 'partial', done: false }], 'PLUGIN_AI_INCOMPLETE'],
    ['length', [{ content: 'partial', done: true, finishReason: 'length' }], 'PLUGIN_AI_OUTPUT_LIMIT'],
    ['reasoning-only', [{ reasoningContent: 'private', done: true, finishReason: 'stop' }], 'PLUGIN_AI_EMPTY'],
    ['tools', [{ toolCalls: [{ name: 'unsafe', args: '{"secret":1}' }], done: true, finishReason: 'tool_calls' }], 'PLUGIN_AI_INCOMPLETE'],
    ['missing-finish', [{ content: 'partial', done: true }], 'PLUGIN_AI_INCOMPLETE'],
  ] satisfies Array<[string, LLMStreamChunk[], string]>)('rejects %s without a successful terminal', async (_name, value, code) => {
    chunks = structuredClone(value)
    await expect(run()).rejects.toMatchObject({ code })
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code } })
    expect(events.some(event => event.type === 'complete')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('secret')
  })
  it.each(['resolve', 'adapter', 'stream', 'next'] as const)('redacts forged provider PluginErrors from %s', async stage => {
    const failure = new PluginError('PLUGIN_AI_EMPTY', 'credential-secret', 502)
    if (stage === 'resolve') mocks.resolve.mockRejectedValue(failure)
    else if (stage === 'adapter') mocks.adapter.mockImplementation(() => { throw failure })
    else if (stage === 'stream') mocks.stream.mockImplementation(() => { throw failure })
    else mocks.stream.mockImplementation(async function* () { throw failure })
    await expect(run()).rejects.toMatchObject({ code: 'PLUGIN_AI_FAILED' })
    expect(JSON.stringify(events)).not.toContain('credential-secret')
  })
  it('denies absent grants before contacting the provider', async () => {
    access.grants = []
    await expect(run()).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('forces a final grant check even when deltas share the short authorization lease', async () => {
    await expect(streamPluginCapability(access, 'test-tenant', call, event => { events.push(event); if (event.type === 'text-delta') access.grants = [] }))
      .rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    expect(events.filter(event => event.type === 'text-delta')).toHaveLength(2)
    expect(events.some(event => event.type === 'complete')).toBe(false)
  })
  it('shares authorization checks across a burst instead of rereading a project per token', async () => {
    const refresh = vi.fn(async () => access); access.refresh = refresh
    chunks = [...Array.from({ length: 200 }, () => ({ content: 'x', done: false })), { done: true, finishReason: 'stop' }]
    await run()
    expect(refresh).toHaveBeenCalledTimes(2) // admission and terminal; watchdog handles long streams
    expect(events.filter(event => event.type === 'text-delta')).toHaveLength(200)
  })
  it('never sends a second terminal if the receiver rejects the complete callback', async () => {
    await expect(streamPluginCapability(access, 'test-tenant', call, event => {
      events.push(event); if (event.type === 'complete') throw new Error('consumer refused')
    })).rejects.toMatchObject({ code: 'PLUGIN_STREAM_RECEIVER' })
    expect(events.filter(event => event.type === 'complete' || event.type === 'error')).toHaveLength(1)
  })
  it('also stops a silent provider when permission is revoked', async () => {
    const blocked = gate()
    mocks.stream.mockImplementation(async function* () { yield { content: 'first', done: false }; await blocked.promise; yield { done: true, finishReason: 'stop' } })
    const pending = run().catch(error => error)
    await vi.waitFor(() => expect(events.some(event => event.type === 'text-delta')).toBe(true))
    access.grants = []
    await expect(pending).resolves.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    blocked.resolve()
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'PLUGIN_PERMISSION' } })
  })
  it('interrupts a receiver that never acknowledges a delta', async () => {
    const abort = new AbortController(), blocked = gate()
    const pending = streamPluginCapability(access, 'test-tenant', call, async event => { events.push(event); if (event.type === 'text-delta') await blocked.promise }, abort.signal).catch(error => error)
    await vi.waitFor(() => expect(events.some(event => event.type === 'text-delta')).toBe(true))
    abort.abort()
    await expect(pending).resolves.toMatchObject({ code: 'PLUGIN_CANCELLED' })
    blocked.resolve()
    expect(events.some(event => event.type === 'complete')).toBe(false)
  })
  it('adds no plugin deadline and keeps a silent operation cancellable by its caller', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout'), abort = new AbortController()
    mocks.stream.mockImplementation(async function* (_messages, options: { signal: AbortSignal }) {
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    })
    const pending = run(abort.signal).catch(error => error)
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalled())
    expect(timeout).not.toHaveBeenCalled()
    abort.abort()
    await expect(pending).resolves.toMatchObject({ code: 'PLUGIN_CANCELLED' })
    expect(events.some(event => event.type === 'complete')).toBe(false)
  })
  it('streams results larger than the former event and aggregate cutoffs without truncation', async () => {
    const content = 'x'.repeat(9 * 1024 * 1024)
    chunks = [{ content, done: true, finishReason: 'stop' }]
    await expect(run()).resolves.toMatchObject({ text: content })
    expect(events.find(event => event.type === 'text-delta')).toMatchObject({ text: content })
    expect(events.at(-1)).toMatchObject({ type: 'complete' })
  })
  it('does not stop after 50000 events', async () => {
    chunks = [...Array.from({ length: 50001 }, () => ({ content: 'x', done: false })), { done: true, finishReason: 'stop' }]
    await expect(run()).resolves.toMatchObject({ text: 'x'.repeat(50001) })
    expect(events.filter(event => event.type === 'text-delta')).toHaveLength(50001)
  })
  it('allows more than four concurrent streams and cancels all through caller signals', async () => {
    const blocked = gate(), controllers = Array.from({ length: 6 }, () => new AbortController())
    mocks.stream.mockImplementation(async function* () { await blocked.promise; yield { done: true, finishReason: 'stop' } })
    const pending = controllers.map(controller => run(controller.signal).catch(error => error))
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(6))
    controllers.forEach(controller => controller.abort())
    expect(await Promise.all(pending)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PLUGIN_CANCELLED' })]))
    blocked.resolve()
    mocks.stream.mockImplementation(async function* () { yield { content: 'recovered', done: true, finishReason: 'stop' } })
    await expect(run()).resolves.toMatchObject({ text: 'recovered' })
  })
  it('does not expose callback error details', async () => {
    await expect(streamPluginCapability(access, 'test-tenant', call, event => { events.push(event); if (event.type !== 'error') throw new PluginError('UNTRUSTED', 'secret-callback') }))
      .rejects.toMatchObject({ code: 'PLUGIN_STREAM_RECEIVER' })
    expect(JSON.stringify(events)).not.toContain('secret-callback')
  })
})

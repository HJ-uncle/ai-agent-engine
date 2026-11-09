import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { FallbackAdapter, RetryingAdapter } from '../../llm-adapter/retry.js'
import { workspaceManager } from '../../../workspace/index.js'
import { estimateRequestInput } from '../finalization.js'
import { ReActStrategy, type ReActOptions } from '../react.js'

vi.mock('../../codegraph-prompt.js', () => ({ prepareCodegraphRequestContext: vi.fn(async () => '') }))
vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const memory = 'MEMORY_FIXTURE_7249: 用户偏好使用简体中文，金额保留两位小数。'
const updatedMemory = 'MEMORY_FIXTURE_8612: 用户已更正金额规则，改为保留四位小数。'
const input = '只读检查这份虚构报告，并用当前偏好说明结果。'

function fixture() {
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'true')
  vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/memory-request-fixture'])
  const history: Message[] = []
  const requests: Array<{ messages: Message[]; options: LLMAdapterOptions }> = []
  const definitions = [{ name: 'read_file', description: 'Read a bounded fixture', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  } }]
  const ctx = {
    tenantId: 'memory-request', sessionId: 'memory-request-session', rootRunId: 'memory-request-run', turnId: 'memory-request-turn',
    toolProfile: 'general', workspaceDir: '/memory-request-fixture', memoryScopes: ['session'],
    modelCaps: { contextWindow: 100_000 },
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: vi.fn(async () => 0),
    },
    tools: {
      list: () => definitions, has: (name: string) => definitions.some(tool => tool.name === name),
      executionMode: () => 'readonly' as const,
      execute: vi.fn(async () => ({ success: true, output: 'Verified fixture: amount = 12.3456.' })),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    provider: 'fixture', model: 'memory-primary', countTokens: () => 0, complete: vi.fn(),
    stream: vi.fn(async function* (messages, options) {
      if (!options) throw new Error('Missing request options')
      requests.push({ messages: structuredClone(messages), options })
      if (requests.length === 1) yield { done: true, toolCalls: [{ index: 0, id: 'read-memory-fixture', name: 'read_file', args: '{"path":"report.md"}' }] }
      else yield { done: true, content: '虚构报告已检查。' }
    }),
  }
  const run = async (options: ReActOptions = {}, adapter: LLMAdapter = llm) => {
    for await (const _frame of new ReActStrategy(adapter, {
      maxIterations: 3, systemPrompt: 'Respect the latest user request and treat recalled memories as reference data.', ...options,
    }).run(input, ctx)) { /* exercise the real ReAct boundary, without a provider */ }
  }
  return { ctx, history, requests, llm, run }
}

function expectCounted(request: { messages: Message[]; options: LLMAdapterOptions }) {
  const { messages, options } = request
  expect(options.requestInputTokenEstimate).toBe(estimateRequestInput(messages, options.systemPrompt, options.tools ?? [], options.requestContext))
  expect(options.requestInputTokenEstimate! + options.maxTokens!).toBeLessThanOrEqual(options.contextWindow!)
}

describe('memory data after the durable ReAct history', () => {
  it('keeps recalled memory in each request tail, outside system and persisted history across a tool continuation', async () => {
    const f = fixture()
    await f.run({ requestContext: memory })
    expect(f.requests).toHaveLength(2)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    for (const request of f.requests) {
      expect(request.options.requestContext?.split(memory)).toHaveLength(2)
      expect(request.options.systemPrompt).not.toContain(memory)
      expect(JSON.stringify(request.messages)).not.toContain(memory)
      expectCounted(request)
    }
    expect(f.requests[1].options.systemPrompt).toBe(f.requests[0].options.systemPrompt)
    expect(f.requests[1].messages.slice(0, f.requests[0].messages.length)).toEqual(f.requests[0].messages)
    expect(JSON.stringify(f.history)).not.toContain(memory)
    expect(f.history.filter(message => message.role === 'user')).toHaveLength(1)
    expect(f.history.find(message => message.role === 'user')?.content).toBe(input)
  })

  it('sends no recalled data when the caller resolves memory off, while preserving ordinary runtime state', async () => {
    const f = fixture()
    f.ctx.memoryScopes = []
    await f.run()
    for (const request of f.requests) {
      expect(request.options.requestContext).toContain('Long-term memory is off')
      expect(request.options.requestContext).not.toContain('MEMORY_FIXTURE_')
      expect(request.options.systemPrompt).not.toContain('MEMORY_FIXTURE_')
      expectCounted(request)
    }
    expect(JSON.stringify(f.history)).not.toContain('MEMORY_FIXTURE_')
  })

  it('counts the memory payload in physical request admission instead of silently omitting it from input estimates', async () => {
    const f = fixture()
    await f.run({ requestContext: memory.repeat(25) })
    for (const request of f.requests) {
      expectCounted(request)
      const contextWithoutMemory = request.options.requestContext!.replace(memory.repeat(25), '')
      expect(request.options.requestInputTokenEstimate).toBeGreaterThan(estimateRequestInput(
        request.messages, request.options.systemPrompt, request.options.tools ?? [], contextWithoutMemory))
    }
  })

  it('replaces recalled data for the next user turn without changing the stable system or preceding durable messages', async () => {
    const f = fixture()
    await f.run({ requestContext: memory })
    const previous = f.requests.at(-1)!
    const nextIndex = f.requests.length
    await f.run({ requestContext: updatedMemory })
    const next = f.requests[nextIndex]
    expect(next.options.requestContext).toContain(updatedMemory)
    expect(next.options.requestContext).not.toContain(memory)
    expect(next.options.systemPrompt).toBe(previous.options.systemPrompt)
    expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
    expect(JSON.stringify(f.history)).not.toContain('MEMORY_FIXTURE_')
    expect(f.history.filter(message => message.role === 'user')).toHaveLength(2)
  })

  it('retains authorized memory in the evidence-only finalization tail after tool schemas are removed', async () => {
    const f = fixture()
    await f.run({ requestContext: memory, maxIterations: 2, finalizeOnLimit: true })
    expect(f.requests).toHaveLength(2)
    const final = f.requests[1]
    expect(final.options).toMatchObject({ requestStage: 'finalization', tools: [] })
    expect(final.options.requestContext).toContain(memory)
    expect(final.options.systemPrompt).not.toContain(memory)
    expect(JSON.stringify(final.messages)).not.toContain(memory)
    expectCounted(final)
    expect(JSON.stringify(f.history)).not.toContain(memory)
  })

  it('retains memory after history compression without putting it into the compacted transcript', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 8192 } as AgentContext['modelCaps']
    f.history.push({ id: 'old-large-context', role: 'assistant', content: 'Old unrelated material. '.repeat(4_000) })
    f.ctx.history.compress = vi.fn(async () => {
      const currentUser = [...f.history].reverse().find(message => message.role === 'user')!
      f.history.splice(0, f.history.length, { role: 'system', content: 'Retained bounded task summary.' }, currentUser)
      return { preTokens: 25_000, postTokens: 30 }
    })
    await f.run({ requestContext: memory })
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    for (const request of f.requests) {
      expect(request.options.requestContext).toContain(memory)
      expect(request.options.systemPrompt).not.toContain(memory)
      expectCounted(request)
    }
    expect(JSON.stringify(f.history)).not.toContain(memory)
  })

  it('preserves the same nonpersistent memory tail through a transient retry and model fallback', async () => {
    const f = fixture()
    const failedAttempts: LLMAdapterOptions[] = []
    const unavailable: LLMAdapter = {
      provider: 'fixture', model: 'unavailable-primary', countTokens: () => 0, complete: vi.fn(),
      stream: vi.fn(async function* (_messages, options) {
        failedAttempts.push(options!)
        throw Object.assign(new Error('Fixture service unavailable'), { status: 503 })
      }),
    }
    const retrying = new RetryingAdapter(unavailable, { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 })
    const fallback = new FallbackAdapter({ primary: retrying, fallbacks: [f.llm], modelContextWindows: { 'memory-primary': 100_000 } })
    await f.run({ requestContext: memory }, fallback)
    expect(f.requests).toHaveLength(2)
    expect(failedAttempts).toHaveLength(4)
    for (const options of [...failedAttempts, ...f.requests.map(request => request.options)]) {
      expect(options.requestContext).toContain(memory)
      expect(options.systemPrompt).not.toContain(memory)
    }
    for (const request of f.requests) expectCounted(request)
    expect(JSON.stringify(f.history)).not.toContain(memory)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
  })
})

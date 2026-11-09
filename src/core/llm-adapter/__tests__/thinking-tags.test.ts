import { describe, expect, it, vi } from 'vitest'
import { ThinkingTagNormalizer, splitThinkingTagPrefix } from '../thinking-tags.js'
import { OpenAIAdapter } from '../openai.js'
import { DeepSeekAdapter } from '../deepseek.js'
import { QwenAdapter } from '../qwen.js'
import type { LLMAdapter, LLMStreamChunk } from '../types.js'

const visible = (chunks: LLMStreamChunk[]) => chunks.map(chunk => chunk.content ?? '').join('')
const reasoning = (chunks: LLMStreamChunk[]) => chunks.map(chunk => chunk.reasoningContent ?? '').join('')
const providers = [
  { name: 'OpenAI compatible', make: () => new OpenAIAdapter('compatible-model', 'test-key', 'https://gateway.invalid/v1') },
  { name: 'DeepSeek', make: () => new DeepSeekAdapter('deepseek-v4.1-flash', 'test-key', 'https://gateway.invalid/v1', { logCacheHits: false }) },
  { name: 'Qwen', make: () => new QwenAdapter('qwen3-plus', 'test-key', 'https://gateway.invalid/v1') },
]
function mockClient(adapter: LLMAdapter, create: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(adapter, 'client', { value: { baseURL: 'https://gateway.invalid/v1', chat: { completions: { create } } } })
}
type Frame = { choices: { delta: Record<string, unknown>; finish_reason?: string }[]; model?: string; usage?: Record<string, unknown> }
const frame = (content: string, extra: Record<string, unknown> = {}): Frame => ({ choices: [{ delta: { content, ...extra } }] })
async function consume(adapter: LLMAdapter, frames: Frame[], failure?: Error): Promise<LLMStreamChunk[]> {
  mockClient(adapter, vi.fn(async () => (async function* () { yield* frames; if (failure) throw failure })()))
  const chunks: LLMStreamChunk[] = []
  for await (const chunk of adapter.stream([{ role: 'user', content: 'finish the task' }], { model: adapter.model, thinkingEnabled: false })) chunks.push(chunk)
  return chunks
}

describe('leading provider think wrapper normalization', () => {
  const wrapped = ' \n  <ThInK>inspect first\nthen act</tHiNk>Final answer with `<think>` example.'
  it('normalizes every possible two-chunk boundary without leaking a partial tag', () => {
    for (let split = 0; split <= wrapped.length; split++) {
      const parser = new ThinkingTagNormalizer()
      const parts = [parser.push(wrapped.slice(0, split)), parser.push(wrapped.slice(split)), parser.finish()]
      expect(parts.map(part => part.content ?? '').join('')).toBe('Final answer with `<think>` example.')
      expect(parts.map(part => part.reasoningContent ?? '').join('')).toBe('inspect first\nthen act')
    }
  })
  it('delivers reasoning before the closing marker or stream completion', () => {
    const parser = new ThinkingTagNormalizer()
    expect(parser.push('<th')).toEqual({})
    expect(parser.push('ink>first reasoning')).toEqual({ reasoningContent: 'first reasoning' })
    expect(parser.push(' more</thi')).toEqual({ reasoningContent: ' more' })
    expect(parser.push('nk>answer')).toEqual({ content: 'answer' })
    expect(parser.finish()).toEqual({})
  })
  it.each(['<think>', '<think>unfinished', '<think>unfinished</thi'])('keeps an incomplete reasoning block out of the answer: %s', text => {
    const result = splitThinkingTagPrefix(text)
    expect(result.content).toBe('')
    expect(result.reasoningContent ?? '').toBe(text.slice('<think>'.length))
  })
  it.each([
    'Use <think>literal text</think> in this example.',
    '`<think>literal text</think>`',
    '```xml\n<think>literal text</think>\n```',
    '~~~html\n<think>literal text</think>\n~~~',
    '    <think>indented code</think>',
    '\n\t<think>tab-indented code</think>',
    '> <think>quoted text</think>',
    '"<think>quoted value</think>"',
    '&lt;think&gt;escaped text&lt;/think&gt;',
    '<thinking>ordinary tag</thinking>',
    '<think class="example">ordinary markup</think>',
    '<thi',
    'ordinary text\n<think>later example</think>',
  ])('preserves literal answer text exactly: %s', text => {
    expect(splitThinkingTagPrefix(text)).toEqual({ content: text })
    const parser = new ThinkingTagNormalizer(), parts = [...text].map(char => parser.push(char))
    parts.push(parser.finish())
    expect(parts.map(part => part.content ?? '').join('')).toBe(text)
    expect(parts.map(part => part.reasoningContent ?? '').join('')).toBe('')
  })
  it('does not scan answer code after a recognized wrapper closes', () => {
    expect(splitThinkingTagPrefix('<think>plan</think>```xml\n<think>keep me</think>\n```')).toEqual({ reasoningContent: 'plan', content: '```xml\n<think>keep me</think>\n```' })
  })
})

describe('compatible adapter boundary', () => {
  it('preserves original Unicode offsets in complete and split streaming reasoning', async () => {
    const adapter = providers[0].make(), text = '<think>İ</think>Answer'
    mockClient(adapter, vi.fn(async () => ({ model: adapter.model, choices: [{ message: { content: text }, finish_reason: 'stop' }] })))
    expect(await adapter.complete([{ role: 'user', content: 'inspect' }])).toMatchObject({ content: 'Answer', reasoningContent: 'İ' })
    for (let split = 0; split <= text.length; split++) {
      const chunks = await consume(providers[0].make(), [frame(text.slice(0, split)), frame(text.slice(split)), { choices: [{ delta: {}, finish_reason: 'stop' }] }])
      expect(visible(chunks)).toBe('Answer'); expect(reasoning(chunks)).toBe('İ')
    }
  })
  for (const provider of providers) {
    it(provider.name + ' separates complete content and reasoning even when the provider ignores thinking Off', async () => {
      const adapter = provider.make()
      mockClient(adapter, vi.fn(async () => ({ model: adapter.model, choices: [{ message: {
        content: '\n<ThInK>embedded evidence</THINK>answer', reasoning_content: 'native evidence\n',
      }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8 } })))
      expect(await adapter.complete([{ role: 'user', content: 'finish task' }], { model: adapter.model, thinkingEnabled: false })).toMatchObject({
        content: 'answer', reasoningContent: 'native evidence\nembedded evidence', finishReason: 'stop', promptTokens: 10, completionTokens: 8,
      })
    })
    it(provider.name + ' routes split tags to reasoning and preserves structured tool deltas and usage', async () => {
      const adapter = provider.make(), frames = [frame('<'), frame('Th'), frame('InK>plan', { reasoning_content: 'native\n' }), frame('</tHi'), frame('Nk>answer', {
        tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
      }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }], model: 'actual-model', usage: { prompt_tokens: 11, completion_tokens: 9 } }]
      const chunks = await consume(adapter, frames)
      expect(visible(chunks)).toBe('answer'); expect(reasoning(chunks)).toBe('native\nplan')
      expect(chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([{ index: 0, id: 'call-1', name: 'read_file', args: '{"path":"README.md"}' }])
      expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'tool_calls', model: 'actual-model', promptTokens: 11, completionTokens: 9 })
    })
  }
  it('never parses a tool-call example from a complete reasoning prefix as an executable call', async () => {
    const adapter = providers[0].make(), tool = '<tool_call>{"name":"delete_file","arguments":{"path":"important.txt"}}</tool_call>'
    mockClient(adapter, vi.fn(async () => ({ model: adapter.model, choices: [{ message: { content: '<think>' + tool + '</think>No action taken.' }, finish_reason: 'stop' }] })))
    const result = await adapter.complete([{ role: 'user', content: 'inspect' }])
    expect(result.content).toBe('No action taken.'); expect(result.reasoningContent).toBe(tool); expect(result.toolCalls).toBeUndefined()
  })
  it('retains an incomplete prefix as reasoning on a provider length limit', async () => {
    const chunks = await consume(providers[0].make(), [frame('<think>reasoning</thi'), { choices: [{ delta: {}, finish_reason: 'length' }] }])
    expect(visible(chunks)).toBe(''); expect(reasoning(chunks)).toBe('reasoning</thi'); expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'length' })
  })
  it('flushes partial reasoning on cancellation while preserving the thrown error and no terminal success', async () => {
    const adapter = providers[0].make(), error = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    mockClient(adapter, vi.fn(async () => (async function* () { yield frame('<think>reasoning</thi'); throw error })()))
    const chunks: LLMStreamChunk[] = []
    const read = async () => { for await (const chunk of adapter.stream([{ role: 'user', content: 'inspect' }])) chunks.push(chunk) }
    await expect(read()).rejects.toBe(error)
    expect(visible(chunks)).toBe(''); expect(reasoning(chunks)).toBe('reasoning</thi'); expect(chunks.some(chunk => chunk.done)).toBe(false)
  })
  it('streams genuine fenced code and inline quoted tags unchanged', async () => {
    const text = '```xml\n<think>sample</think>\n```\nInline `<think>x</think>`.'
    const chunks = await consume(providers[0].make(), [...[...text].map(char => frame(char)), { choices: [{ delta: {}, finish_reason: 'stop' }] }])
    expect(visible(chunks)).toBe(text); expect(reasoning(chunks)).toBe('')
  })
})

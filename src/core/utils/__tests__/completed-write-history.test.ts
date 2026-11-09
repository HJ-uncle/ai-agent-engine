import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../agent-context/types.js'
import { projectCompletedWriteHistory, restoreCompletedWriteHistory, toolArgumentsSnapshot } from '../completed-write-history.js'
import { estimateModelHistoryTokens } from '../model-context.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'
import { OpenAIAdapter } from '../../llm-adapter/openai.js'
import { DeepSeekAdapter } from '../../llm-adapter/deepseek.js'

const hash = 'sha256:' + 'a'.repeat(64)
const scope = { rootRunId: 'run', turnId: 'turn' }
const options = { argumentRecoveryAvailable: true, canProject: () => true }
const long = '中文原始正文🙂\r\n"quoted"\\value\n'.repeat(500)
function pair(id: string, args: Record<string, unknown> = { path: `${id}.md`, data: long, expectedHash: 'missing' }, name = 'write_file'): Message[] {
  return [{ id: `message:${id}`, role: 'assistant', content: '', metadata: { ...scope }, toolCall: { id, name, args } },
    { id: `result:${id}`, role: 'tool', toolCallId: id, toolName: name,
      content: `path: ${args.path}\nexpectedHash: ${hash}\nVerification: structure passed; business review pending.`,
      metadata: { ...scope, status: 'succeeded', success: true, expectedHash: hash } }]
}
const tail = () => [...pair('inspect1', { path: 'one.md' }, 'read_file'), ...pair('inspect2', { path: 'two.md' }, 'read_file')]
const project = (messages: Message[]) => projectCompletedWriteHistory(messages, options)
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('completed write model history', () => {
  it.each([
    ['write_file', { path: 'report.md', data: long, expectedHash: 'missing', trailingNewline: 'CRLF' }, 'data'],
    ['write_file', { path: 'report.json', content: JSON.stringify({ title: long }), expectedHash: hash }, 'content'],
    ['office_document', { operation: 'create', path: 'report.docx', markdown: long, expectedHash: 'missing', title: '成果' }, 'markdown'],
  ] as const)('projects only old %s text and preserves original arguments, receipts and model reasoning', (name, args, field) => {
    const messages = [...pair('old', args, name), ...tail()]
    messages[0].content = 'The draft follows the approved structure.'
    messages[0].reasoningContent = 'provider-required-reasoning-replay'
    const originalCall = messages[0].toolCall!
    Object.assign(originalCall, { _rawArgs: JSON.stringify(args) })
    const before = JSON.stringify(messages), snapshot = toolArgumentsSnapshot(originalCall)
    const result = project(messages)
    expect(result.projectedCalls).toBe(1)
    expect(result.omittedCharacters).toBeGreaterThan(2000)
    expect(result.messages[0]).toMatchObject({ content: messages[0].content, reasoningContent: messages[0].reasoningContent,
      toolCall: { id: originalCall.id, name, args: { path: args.path, expectedHash: args.expectedHash } } })
    expect(result.messages[0].toolCall!.args[field]).toContain('must NOT be used as new write input')
    expect(result.messages[0].toolCall!.args[field]).toContain(snapshot.sha256)
    expect(result.messages[0].toolCall!.args[field]).toContain('message:old')
    expect(result.messages[0].toolCall!.args[field]).toContain('"toolArguments":true')
    expect(result.messages[0].toolCall).not.toHaveProperty('_rawArgs')
    expect(result.messages[1]).toBe(messages[1])
    expect(result.messages.slice(2)).toEqual(messages.slice(2))
    expect(JSON.stringify(messages)).toBe(before)
    expect(messages[0].toolCall).toBe(originalCall)
    expect(estimateModelHistoryTokens(result.messages)).toBeLessThan(estimateModelHistoryTokens(messages) / 2)
    expect(project(result.messages).messages).toBe(result.messages)
  })

  it('keeps the newest two tool batches, including all current parallel siblings', () => {
    const newest = ['a', 'b', 'c'].map(id => pair(id))
    const messages = [...pair('old'), ...pair('previous'), ...newest.map(item => item[0]), ...newest.map(item => item[1])]
    const projected = project(messages)
    expect(projected.projectedCalls).toBe(1)
    expect(projected.messages.slice(2)).toEqual(messages.slice(2))
  })

  it('projects old successful explicit batches per file while preserving structured data and copy sources', () => {
    const args = { files: [{ path: 'a.md', data: long, expectedHash: 'missing' },
      { path: 'b.md', content: long, trailingNewline: 'LF' },
      { path: 'c.json', data: { value: long } },
      { path: 'copy.md', copyFrom: { path: 'source.md', expectedHash: hash } }] }
    const messages = [...pair('old', args), ...tail()]
    const before = JSON.stringify(messages)
    const projected = project(messages)
    expect(projected.projectedCalls).toBe(1)
    const files = projected.messages[0].toolCall!.args.files as typeof args.files
    expect(files[0].data).toContain('files[0].data')
    expect(files[1].content).toContain('files[1].content')
    expect(files[0].expectedHash).toBe('missing')
    expect(files.slice(2)).toEqual(args.files.slice(2))
    expect(projected.messages[1]).toBe(messages[1])
    expect(JSON.stringify(messages)).toBe(before)
    expect(project(projected.messages).messages).toBe(projected.messages)
    expect(restoreCompletedWriteHistory(projected.messages)).toEqual(messages)
  })

  it('keeps partial or failed explicit batch write arguments available for recovery', () => {
    const messages = [...pair('old', { files: [{ path: 'a.md', data: long }, { path: 'b.md', data: long }] }), ...tail()]
    messages[1].metadata = { ...scope, status: 'failed', success: false, batch: true, files: [{ success: true }, { success: false }] }
    expect(project(messages).messages).toBe(messages)
  })

  it('does nothing without actually available recovery or registry authorization', () => {
    const messages = [...pair('old'), ...tail()]
    const canProject = vi.fn(() => true)
    expect(projectCompletedWriteHistory(messages, { argumentRecoveryAvailable: false, canProject }).messages).toBe(messages)
    expect(canProject).not.toHaveBeenCalled()
    expect(projectCompletedWriteHistory(messages, { ...options, canProject: () => false }).messages).toBe(messages)
  })

  it('restores full arguments when closeout removes recovery, without serializing a hidden copy', () => {
    const messages = [...pair('old'), ...tail()]
    const projected = project(messages).messages
    expect(JSON.stringify(projected)).not.toContain('中文原始正文')
    // ReAct's message-content projection clones messages but retains call identity.
    const cloned = projected.map(message => ({ ...message }))
    const restored = restoreCompletedWriteHistory(cloned)
    expect(restored).toEqual(messages)
    expect(restored[0].toolCall).toBe(messages[0].toolCall)
    expect(restoreCompletedWriteHistory(messages)).toBe(messages)
  })

  it.each(['failed', 'cancelled', 'interrupted', 'waiting'])('retains %s calls and their results', status => {
    const messages = [...pair('old'), ...tail()]
    messages[1].metadata = { ...scope, success: false, status }
    expect(project(messages).messages).toBe(messages)
  })

  it.each([
    (messages: Message[]) => { messages.splice(1, 1) },
    (messages: Message[]) => { messages.splice(2, 0, messages[0]) },
    (messages: Message[]) => { messages.splice(2, 0, messages[1]) },
    (messages: Message[]) => { messages[1].toolName = 'extension_write' },
    (messages: Message[]) => { messages[1].metadata.turnId = 'other-turn' },
    (messages: Message[]) => { messages[1].metadata.rootRunId = 'other-run' },
    (messages: Message[]) => { delete messages[0].id },
    (messages: Message[]) => { messages[0].metadata.partial = true },
    (messages: Message[]) => { messages[1].metadata.error = 'uncertain publication' },
    (messages: Message[]) => { messages[1].metadata.outputTruncated = true },
    (messages: Message[]) => { messages[1].content = '[tool result cleared]' },
    (messages: Message[]) => { messages[1].metadata.__aetherMicroCompactArchive = {} },
    (messages: Message[]) => { messages.splice(1, 0, { role: 'user', content: 'New instructions.' }) },
    (messages: Message[]) => { messages.splice(0, 2, messages[1], messages[0]) },
  ])('retains incomplete, ambiguous, cleared and mismatched evidence %#', mutate => {
    const messages = [...pair('old'), ...tail()]
    mutate(messages)
    expect(project(messages).messages).toBe(messages)
  })

  it.each([
    ['write_file', { path: 'small.md', data: 'x'.repeat(2047) }],
    ['write_file', { path: 'structured.json', data: { value: long } }],
    ['write_file', { path: 'copy.md', copyFrom: { path: 'source.md', expectedHash: hash } }],
    ['office_document', { operation: 'create', path: 'report.xlsx', workbook: { sheets: [{ rows: [{ value: long }] }] } }],
    ['office_document', { operation: 'create', path: 'report.pptx', presentation: { slides: [{ title: 'Title', notes: long }] } }],
    ['office_document', { operation: 'edit', path: 'report.docx', markdown: long }],
    ['another_tool', { path: 'report.md', data: long }],
  ] as const)('preserves short or structured payloads and non-create operations %#', (name, args) => {
    const messages = [...pair('old', args, name), ...tail()]
    expect(project(messages).messages).toBe(messages)
  })
})

it.each(['anthropic', 'openai', 'deepseek'] as const)('%s sends projected args with original tool pairing and receipt', async provider => {
  const original = [...pair('old'), ...tail()]
  const messages = project(original).messages
  let wire: any
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    wire = JSON.parse(String(init?.body))
    return provider === 'anthropic'
      ? Response.json({ id: 'a', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 }, stop_reason: 'end_turn' })
      : Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
  }))
  const adapter = provider === 'anthropic' ? new AnthropicAdapter('test', 'test-key', 'http://model.invalid', undefined, true)
    : provider === 'openai' ? new OpenAIAdapter('test', 'test-key', 'http://model.invalid', true)
      : new DeepSeekAdapter('deepseek-chat', 'test-key', 'http://model.invalid')
  await adapter.complete(messages, { model: adapter.model })
  const text = JSON.stringify(wire)
  expect(text).not.toContain('中文原始正文')
  expect(text).toContain(hash)
  expect(text).toContain('business review pending')
  if (provider === 'anthropic') {
    const blocks = wire.messages.flatMap((message: any) => message.content)
    expect(blocks.find((block: any) => block.type === 'tool_use' && block.id === 'old').input).toEqual(messages[0].toolCall!.args)
    expect(blocks.find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'old')).toBeTruthy()
  } else {
    const calls = wire.messages.flatMap((message: any) => message.tool_calls ?? [])
    expect(JSON.parse(calls.find((call: any) => call.id === 'old').function.arguments)).toEqual(messages[0].toolCall!.args)
    expect(wire.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'old')).toBeTruthy()
  }
  expect(original[0].toolCall!.args.data).toBe(long)
})

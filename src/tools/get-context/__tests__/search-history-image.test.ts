import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import { AnthropicAdapter } from '../../../core/llm-adapter/anthropic.js'
import { OpenAIAdapter } from '../../../core/llm-adapter/openai.js'
import { estimateModelMessageTokens } from '../../../core/utils/model-context.js'
import { imageToolPayload } from '../../../core/utils/multimodal-context.js'
import { largeNativePng } from '../../../core/utils/__tests__/fixtures/native-image.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { searchHistoryTool } from '../search-history-tool.js'

const image = largeNativePng()
const scope = { tenantId: 'image-history-tenant', sessionId: 'image-history-session' }
let fixture: string
let history: JSONLConversationHistory
const context = () => ({ ...scope, history } as unknown as AgentContext)

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-history-image-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  const file = path.join(fixture, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const messages: Message[] = [
    { id: 'layout-image', role: 'user', content: 'Uploaded layout.png.', modelInputContent: [
      { type: 'text', text: 'Image requirements: DECISION=43.' },
      { type: 'image_url', image_url: { url: image.url } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.base64 } },
    ], metadata: { turnId: 'original-layout-turn' } },
    { id: 'tool-image', role: 'tool', content: JSON.stringify({ filename: 'source.png', mimeType: 'image/png', dataUrl: image.url, hasDataUrl: true }), toolCallId: 'read-original' },
    ...Array.from({ length: 6 }, (_, index): Message => ({ id: `later-${index}`, role: 'assistant', content: 'Continued project development.' })),
  ]
  fs.writeFileSync(file, messages.map((message, index) => JSON.stringify({ uuid: message.id, parentUuid: null, type: message.role,
    timestamp: '2026-10-10T00:00:00Z', ...scope, isSidechain: false, dbSeq: index + 1, payload: message })).join('\n') + '\n')
  history = new JSONLConversationHistory()
  await history.compress(scope, async () => 'Continue the project; original layout remains in the archive.', 1)
  history = new JSONLConversationHistory()
})

afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-history-image-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

it('returns semantic text and indexed image identities after real compaction and restart', async () => {
  expect((await history.getFullHistory(scope)).some(message => message.id === 'layout-image')).toBe(false)
  const result = await searchHistoryTool.execute({ query: 'DECISION=43' }, context())
  expect(result.success).toBe(true)
  const output = JSON.parse(result.output)
  expect(output.messages[0]).toMatchObject({ messageId: 'layout-image', turnId: 'original-layout-turn', contentSource: 'model_input' })
  expect(output.messages[0].content).toContain('DECISION=43')
  expect(output.messages[0].content).toContain('Retained image: mime=image/png; sha256=')
  expect(output.messages[0].images.map((value: any) => value.imageIndex)).toEqual([0, 1])
  expect(output.messages[0].images.every((value: any) => value.originalPixelsAvailable && /^[a-f0-9]{64}$/.test(value.sha256))).toBe(true)
  expect(result.output).not.toContain(image.base64)
  expect(result.output).not.toContain('data:image/png;base64,')
  expect(estimateModelMessageTokens({ role: 'tool', content: result.output })).toBeLessThan(4_000)
})

it.each([{ messageId: 'layout-image', imageIndex: 0 }, { messageId: 'layout-image', imageIndex: 1 }, { messageId: 'tool-image', imageIndex: 0 }])('retrieves exactly the retained original PNG by message and image index %#', async args => {
  const result = await searchHistoryTool.execute(args, context())
  expect(result.success).toBe(true)
  const output = JSON.parse(result.output)
  expect(imageToolPayload(result.output)?.dataUrl).toBe(image.url)
  expect(output).toMatchObject({ mimeType: 'image/png', size: image.buffer.length, dataUrl: image.url, hasDataUrl: true })
  expect(output.description).toContain(`messageId=${args.messageId}`)
  expect(output.description).toContain(`imageIndex=${args.imageIndex}`)
  expect(result.output.split(image.base64)).toHaveLength(2)
  expect(JSON.stringify(output.messages)).not.toContain(image.base64)
  expect(estimateModelMessageTokens({ role: 'tool', content: result.output })).toBeLessThan(4_000)
})

it('keeps default image-tool searches semantic and refuses a missing image index', async () => {
  const ordinary = await searchHistoryTool.execute({ messageId: 'tool-image' }, context())
  expect(ordinary.success).toBe(true)
  expect(ordinary.output).not.toContain(image.base64)
  expect(JSON.parse(ordinary.output).messages[0].images).toHaveLength(1)
  const missing = await searchHistoryTool.execute({ messageId: 'layout-image', imageIndex: 2 }, context())
  expect(missing.success).toBe(false)
  expect(missing.metadata).toMatchObject({ code: 'IMAGE_NOT_FOUND' })
  expect(missing.output).not.toContain(image.base64)
})

it.each([{ imageIndex: 0 }, { messageId: 'layout-image', imageIndex: -1 }, { messageId: 'layout-image', imageIndex: 0.5 },
  { messageId: 'layout-image', imageIndex: 0, sessionId: 'private-session' }, { messageId: 'layout-image', imageIndex: 0, tenantId: 'private-tenant' }])('rejects invalid or foreign-scope image requests before reading storage %#', async args => {
  const read = vi.spyOn(history, 'searchArchive')
  const result = await searchHistoryTool.execute(args, context())
  expect(result.success).toBe(false)
  expect(result.metadata).toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(read).not.toHaveBeenCalled()
  expect(result.output).not.toContain(image.base64)
})

it('cannot retrieve a private session image by a known message ID', async () => {
  const privateFile = path.join(fixture, 'sessions', scope.tenantId, 'private-session.jsonl')
  fs.writeFileSync(privateFile, JSON.stringify({ uuid: 'private-known-id', parentUuid: null, type: 'user', timestamp: '2026-10-10T00:00:00Z',
    ...scope, sessionId: 'private-session', isSidechain: false, dbSeq: 1, payload: { id: 'private-known-id', role: 'user', content: 'PRIVATE_IMAGE',
      modelInputContent: [{ type: 'image_url', image_url: { url: image.url } }] } }) + '\n')
  const result = await searchHistoryTool.execute({ messageId: 'private-known-id', imageIndex: 0 }, context())
  expect(result.success).toBe(false)
  expect(result.metadata).toMatchObject({ code: 'IMAGE_NOT_FOUND' })
  expect(result.output).not.toContain(image.base64)
  expect(result.output).not.toContain('PRIVATE_IMAGE')
  expect(JSON.parse(result.output).messages).toEqual([])
})

it.each(['openai', 'anthropic'] as const)('%s SDK complete and stream send retrieved archive pixels once through the native image channel', async provider => {
  const retrieved = await searchHistoryTool.execute({ messageId: 'layout-image', imageIndex: 1 }, context())
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (provider === 'openai') {
      if (!body.stream) return Response.json({ choices: [{ message: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1100, completion_tokens: 3 } })
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1100, completion_tokens: 3 } })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    if (!body.stream) return Response.json({ id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'checked' }], usage: { input_tokens: 1100, output_tokens: 3 }, stop_reason: 'end_turn' })
    const frames = [
      { type: 'message_start', message: { id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage: { input_tokens: 1100, output_tokens: 0 }, stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checked' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  const adapter = provider === 'openai' ? new OpenAIAdapter('gpt-4o', 'test-key', 'http://model.invalid', true)
    : new AnthropicAdapter('claude-test', 'test-key', 'http://model.invalid', { 'X-Access-Token': 'test-token' })
  const messages: Message[] = [
    { role: 'user', content: 'Inspect the original retained layout.' },
    { role: 'assistant', content: '', toolCall: { id: 'archive-image-read', name: 'search_history', args: { messageId: 'layout-image', imageIndex: 1 } } },
    { role: 'tool', toolCallId: 'archive-image-read', toolName: 'search_history', content: retrieved.output },
  ]
  const options = { model: adapter.model, tools: [searchHistoryTool], contextWindow: 100_000, maxTokens: 1000 }
  await adapter.complete(messages, options)
  for await (const _chunk of adapter.stream(messages, options)) { /* consume the SDK transport */ }
  expect(bodies).toHaveLength(2)
  for (const body of bodies) {
    const wire = JSON.stringify(body.messages)
    expect(wire.split(image.base64)).toHaveLength(2)
    expect(wire).toContain('messageId=layout-image')
    expect(wire).toContain('turnId=original-layout-turn')
    if (provider === 'openai') {
      expect(body.messages.find((message: any) => message.role === 'tool').content).not.toContain(image.base64)
      expect(body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((part: any) => part.type === 'image_url').image_url.url).toBe(image.url)
    } else {
      const toolResult = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((part: any) => part.type === 'tool_result')
      expect(toolResult.content.find((part: any) => part.type === 'text').text).not.toContain(image.base64)
      expect(toolResult.content.find((part: any) => part.type === 'image').source).toEqual({ type: 'base64', media_type: 'image/png', data: image.base64 })
      expect(wire).not.toContain('"type":"image_url"')
    }
  }
})

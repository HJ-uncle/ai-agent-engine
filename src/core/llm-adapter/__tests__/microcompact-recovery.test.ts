import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import { projectModelMessage, truncateToolOutput } from '../../agent-loop/react.js'
import { largeNativePng } from '../../utils/__tests__/fixtures/native-image.js'
import { captureFileEvidence, clearedToolEvidence, CLEARED_TOOL_EVIDENCE_KEY, CLEARED_TOOL_RESULT, TOOL_FILE_EVIDENCE_KEY } from '../../utils/tool-evidence.js'
import { searchHistoryTool } from '../../../tools/get-context/search-history-tool.js'
import { AnthropicAdapter } from '../anthropic.js'
import { OpenAIAdapter } from '../openai.js'
import { DeepSeekAdapter } from '../deepseek.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(['anthropic', 'openai', 'deepseek'] as const)('%s sends bounded cleared indexes, then only the explicitly recovered original image', async provider => {
  const urls = ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', largeNativePng().url]
  const originals = urls.map((dataUrl, i): Message => {
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    const version = { path: `D:/workspace/page-${i}.png`, expectedHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false }
    const content = JSON.stringify({ filename: `page-${i}.png`, mimeType: 'image/png', size: bytes.length, dataUrl, fileVersion: version })
    return { id: `image-${i}`, role: 'tool', toolName: 'read_file', toolCallId: `read-${i}`, content, modelInputContent: content,
      metadata: { [TOOL_FILE_EVIDENCE_KEY]: captureFileEvidence(version), privateMetadata: 'ARBITRARY_METADATA_MUST_NOT_REENTER' } }
  })
  const cleared = originals.map(message => ({ ...message, content: CLEARED_TOOL_RESULT,
    metadata: { ...message.metadata, [CLEARED_TOOL_EVIDENCE_KEY]: clearedToolEvidence(message), outputPreview: message.content } }))
  const payloads: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)))
    return provider === 'anthropic'
      ? Response.json({ id: 'a', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 }, stop_reason: 'end_turn' })
      : Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
  }))
  const adapter = provider === 'anthropic' ? new AnthropicAdapter('test', 'test-key', 'http://model.invalid', undefined, true)
    : provider === 'openai' ? new OpenAIAdapter('test', 'test-key', 'http://model.invalid', true)
    : new DeepSeekAdapter('deepseek-chat', 'test-key', 'http://model.invalid', { vision: true })
  const history = (allowed: boolean): Message[] => [{ role: 'user', content: 'Compare the two pages.' }, ...cleared.flatMap((message, i): Message[] => [
    { role: 'assistant', content: '', toolCall: { id: `read-${i}`, name: 'read_file', args: { path: `D:/workspace/page-${i}.png` } } },
    projectModelMessage(message, allowed),
  ])]
  await adapter.complete(history(false), { model: adapter.model, tools: [] })
  const disabled = JSON.stringify(payloads[0])
  expect(disabled).not.toContain('search_history')
  for (const url of urls) expect(disabled).not.toContain(url)

  const recovered = await searchHistoryTool.execute({ messageId: 'image-1', imageIndex: 0 }, {
    tenantId: 'tenant', sessionId: 'same-session', history: { getArchive: async () => ({ messages: originals, backend: 'jsonl' }) },
  } as unknown as AgentContext)
  expect(recovered.success).toBe(true)
  const boundedRecovery = truncateToolOutput(recovered.output, 1000)
  expect(JSON.parse(boundedRecovery).fileVersion.expectedHash).toBe(JSON.parse(originals[1].content as string).fileVersion.expectedHash)
  const messages = history(true)
  messages.push({ role: 'assistant', content: '', toolCall: { id: 'recover-one', name: 'search_history', args: { messageId: 'image-1', imageIndex: 0 } } },
    { role: 'tool', toolCallId: 'recover-one', toolName: 'search_history', content: boundedRecovery })
  await adapter.complete(messages, { model: adapter.model, tools: [searchHistoryTool] })
  const sent = JSON.stringify(payloads[1])
  expect(sent).toContain('image-0'); expect(sent).toContain('image-1')
  expect(sent).toContain('search_history')
  expect(sent).not.toContain('ARBITRARY_METADATA_MUST_NOT_REENTER')
  const firstBase64 = urls[0].slice(urls[0].indexOf(',') + 1), secondBase64 = urls[1].slice(urls[1].indexOf(',') + 1)
  expect(sent).not.toContain(firstBase64)
  expect(sent.split(secondBase64)).toHaveLength(2)
  for (const original of originals) expect(sent).toContain(JSON.parse(original.content as string).fileVersion.expectedHash)
  expect(sent).toContain('dataURLSha256=')
  expect(sent).toContain('fileVersion matches the captured builtin read_file receipt')
  expect(cleared[0].modelInputContent).toBe(originals[0].content)
})

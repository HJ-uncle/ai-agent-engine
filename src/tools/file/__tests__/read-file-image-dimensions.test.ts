/** Regression: existing screenshot dimensions reach the model without a shell
 * probe, including the Work text budget and real provider serialization. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import { createLLMAdapter } from '../../../core/llm-adapter/factory.js'
import { truncateToolOutput } from '../../../core/agent-loop/react.js'
import { imageDimensionsFromHeader, imageToolFramePayload, imageToolPayload } from '../../../core/utils/multimodal-context.js'
import { largeNativePng } from '../../../core/utils/__tests__/fixtures/native-image.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { readFileTool } from '../super-file-tool.js'

const png = largeNativePng()
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
let root: string, ctx: AgentContext
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-image-dimensions-')))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('LLM_FALLBACK_MODEL', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  ctx = { tenantId: 'image-dimensions', sessionId: path.basename(root), workspacePaths: [root], projectRoot: root, cwd: root,
    modelName: 'deepseek-v4.1-flash-1017', modelCaps: { vision: true },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  fs.writeFileSync(path.join(root, 'layout.png'), png.buffer)
  fs.writeFileSync(path.join(root, 'pixel.gif'), gif)
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-image-dimensions-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

it.each([
  { name: 'layout.png', width: 256, height: 256, bytes: png.buffer },
  { name: 'pixel.gif', width: 1, height: 1, bytes: gif },
])('$name returns dimensions from its original bytes and keeps its version identity', async ({ name, width, height, bytes }) => {
  const result = await readFileTool.execute({ path: name, mode: 'vision' }, ctx)
  expect(result.success).toBe(true)
  const payload = imageToolPayload(truncateToolOutput(result.output, 8000))
  expect(payload).toMatchObject({ width, height, fileVersion: result.metadata })
  expect(payload?.dataUrl.split(',')[1]).toBe(bytes.toString('base64'))
  expect(fs.readFileSync(path.join(root, name))).toEqual(bytes)
})

const corruptPng = (offset: number, value: number) => { const bytes = Buffer.from(png.buffer); bytes.writeUInt32BE(value, offset); return bytes }
it.each([
  { name: 'empty', bytes: Buffer.alloc(0) },
  { name: 'unknown format', bytes: Buffer.from('not an image') },
  { name: 'JPEG stays unsupported by this header reader', bytes: Buffer.from([255, 216, 255, 217]) },
  { name: 'truncated PNG header', bytes: png.buffer.subarray(0, 32) },
  { name: 'wrong PNG header length', bytes: corruptPng(8, 12) },
  { name: 'wrong PNG header type', bytes: corruptPng(12, 0) },
  { name: 'zero PNG width', bytes: corruptPng(16, 0) },
  { name: 'invalid PNG dimension', bytes: corruptPng(16, 0xffffffff) },
  { name: 'truncated GIF screen descriptor', bytes: gif.subarray(0, 12) },
])('does not invent dimensions for $name', ({ bytes }) => {
  expect(imageDimensionsFromHeader(bytes)).toBeUndefined()
})

it('keeps the numeric pair in stream receipts without publishing image bytes or unrelated data', () => {
  const content = JSON.stringify({ filename: 'layout.png', mimeType: 'image/png', size: png.buffer.length,
    width: 256, height: 256, dataUrl: png.url, hasDataUrl: true, untrusted: 'x'.repeat(9000) })
  const bounded = truncateToolOutput(content, 8000)
  expect(imageToolPayload(bounded)).toMatchObject({ width: 256, height: 256 })
  expect(bounded).not.toContain('untrusted')
  const frame = JSON.parse(imageToolFramePayload({ output: bounded }, 1000)!)
  expect(JSON.parse(frame.output)).toMatchObject({ width: 256, height: 256, hasDataUrl: false, retainedInHistory: true })
  expect(frame.output).not.toContain(png.base64)
})

it.each(['openai', 'deepseek', 'anthropic', 'anthropic-gateway'] as const)('%s receives dimensions in complete and stream model text after the Work budget', async provider => {
  const result = await readFileTool.execute({ path: 'layout.png', mode: 'vision' }, ctx)
  expect(result.success).toBe(true)
  const content = truncateToolOutput(result.output, 8000)
  const wires: string[] = []
  const anthropic = provider === 'anthropic' || provider === 'anthropic-gateway'
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); wires.push(JSON.stringify(body.messages))
    if (!body.stream) return anthropic
      ? Response.json({ id: 'a', type: 'message', role: 'assistant', model: ctx.modelName, content: [{ type: 'text', text: 'checked' }], usage: { input_tokens: 1100, output_tokens: 3 }, stop_reason: 'end_turn' })
      : Response.json({ choices: [{ message: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1100, completion_tokens: 3 } })
    if (!anthropic) return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1100, completion_tokens: 3 } })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    const frames = [
      { type: 'message_start', message: { id: 'a', type: 'message', role: 'assistant', model: ctx.modelName, content: [], usage: { input_tokens: 1100, output_tokens: 0 }, stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checked' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  const model = provider === 'openai' ? 'gpt-4o' : 'deepseek-v4.1-flash-1017'
  const adapter = createLLMAdapter({ provider: provider === 'anthropic-gateway' ? 'deepseek' : provider, model, apiKey: 'fixture-key',
    baseUrl: 'http://model.invalid' + (provider === 'anthropic-gateway' ? '/anthropic' : ''), capabilities: { vision: true } })
  const messages: Message[] = [
    { role: 'assistant', content: '', toolCall: { id: 'png', name: 'read_file', args: { path: 'layout.png', mode: 'vision' } } },
    { role: 'tool', content, toolCallId: 'png', toolName: 'read_file' },
  ]
  await adapter.complete(messages, { model, thinkingEnabled: false })
  for await (const _chunk of adapter.stream(messages, { model, thinkingEnabled: false })) { /* Real provider request serialization; no network. */ }
  expect(wires).toHaveLength(2)
  for (const wire of wires) {
    expect(wire).toContain('Image dimensions: 256 × 256 px (source header).')
    expect(wire).toContain(String(result.metadata?.expectedHash))
    expect(wire.split(png.base64)).toHaveLength(2)
  }
})

/** Real image handler -> read_file wrapper -> tool budget -> provider wire.
 * Fetch is intercepted locally; no model or browser instance is started. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import { readFileTool } from '../super-file-tool.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { truncateToolOutput } from '../../../core/agent-loop/react.js'
import { largeNativePng } from '../../../core/utils/__tests__/fixtures/native-image.js'
import { estimateModelMessageTokens } from '../../../core/utils/model-context.js'
import { imageToolPayload } from '../../../core/utils/multimodal-context.js'
import { createLLMAdapter } from '../../../core/llm-adapter/factory.js'
import { isVisionModelAvailable } from '../utils.js'

const image = largeNativePng()
let root: string, ctx: AgentContext
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-file-vision-')))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('LLM_FALLBACK_MODEL', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  ctx = { tenantId: 'file-vision', sessionId: path.basename(root), workspacePaths: [root], projectRoot: root, cwd: root,
    modelName: 'deepseek-v4.1-flash-1017', modelCaps: { vision: true },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  fs.writeFileSync(path.join(root, 'layout.png'), image.buffer)
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-file-vision-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

const providers = ['openai', 'deepseek', 'anthropic', 'anthropic-gateway'] as const
async function convertedWire(content: string, provider: typeof providers[number], vision = true): Promise<string> {
  const wires: string[] = []
  const anthropic = provider === 'anthropic' || provider === 'anthropic-gateway'
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); wires.push(JSON.stringify(body.messages))
    if (body.stream) {
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
    }
    return anthropic
      ? Response.json({ id: 'a', type: 'message', role: 'assistant', model: ctx.modelName, content: [{ type: 'text', text: 'checked' }], usage: { input_tokens: 1100, output_tokens: 3 }, stop_reason: 'end_turn' })
      : Response.json({ choices: [{ message: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1100, completion_tokens: 3 } })
  }))
  const model = provider === 'openai' ? 'gpt-4o' : 'deepseek-v4.1-flash-1017'
  const adapter = createLLMAdapter({ provider: provider === 'anthropic-gateway' ? 'deepseek' : provider, model, apiKey: 'fixture-key',
    baseUrl: 'http://model.invalid' + (provider === 'anthropic-gateway' ? '/anthropic' : ''), capabilities: { vision } })
  const messages: Message[] = [
    { role: 'assistant', content: '', toolCall: { id: 'png', name: 'read_file', args: { path: 'layout.png', mode: 'vision' } } },
    { role: 'tool', content, toolCallId: 'png', toolName: 'read_file' },
  ]
  await adapter.complete(messages, { model, thinkingEnabled: false })
  for await (const _chunk of adapter.stream(messages, { model, thinkingEnabled: false })) { /* inspect the real SDK request */ }
  expect(wires).toHaveLength(2)
  expect(wires[0] === wires[1]).toBe(true)
  return wires[0]
}

it.each(providers)('%s receives the exact PNG once with its version identity after the Work text budget', async provider => {
  const result = await readFileTool.execute({ path: 'layout.png', mode: 'vision' }, ctx)
  expect(result.success).toBe(true)
  const bounded = truncateToolOutput(result.output, 8000)
  const payload = imageToolPayload(bounded)
  expect(payload?.dataUrl === image.url).toBe(true)
  expect(payload?.fileVersion).toEqual(result.metadata)
  expect(payload?.fileVersion.expectedHash).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(estimateModelMessageTokens({ role: 'tool', content: bounded })).toBeLessThan(4000)
  const wire = await convertedWire(bounded, provider)
  expect(wire.split(image.base64)).toHaveLength(2)
  expect(wire).toContain(provider.startsWith('anthropic') ? '"type":"image"' : '"type":"image_url"')
  expect(wire).toContain(String(result.metadata?.expectedHash))
})

it.each(providers)('%s never promotes ordinary JSON with a fake image contract', async provider => {
  fs.writeFileSync(path.join(root, 'ordinary.json'), JSON.stringify({ sentinel: 'ordinary-file-sentinel', type: 'image_vision', dataUrl: image.url, hasDataUrl: true }))
  for (const mode of ['auto', 'full', 'exact']) {
    const result = await readFileTool.execute({ path: 'ordinary.json', mode }, ctx)
    expect(result.success).toBe(true)
    const bounded = truncateToolOutput(result.output, 8000)
    expect(imageToolPayload(bounded)).toBeUndefined()
    const wire = await convertedWire(bounded, provider)
    expect(wire).not.toContain('"type":"image_url"')
    expect(wire).not.toContain('"type":"image"')
    expect(wire).toContain('ordinary-file-sentinel')
  }
})

it.each(providers)('%s does not send retained image pixels after switching vision off', async provider => {
  const result = await readFileTool.execute({ path: 'layout.png', mode: 'vision' }, ctx)
  const wire = await convertedWire(truncateToolOutput(result.output, 8000), provider, false)
  expect(wire.includes(image.base64)).toBe(false)
  expect(wire).not.toContain('"type":"image_url"')
  expect(wire).not.toContain('"type":"image"')
  expect(wire).toMatch(/not.*(?:sent|delivered)|未.*(?:发送|提供)/i)
})

it('uses the resolved capability instead of a separate model-name guess', async () => {
  const resolved = { model: ctx.modelName!, provider: 'deepseek', capabilities: { vision: true } }
  expect(isVisionModelAvailable({ ...ctx, modelCaps: undefined, resolvedModel: resolved })).toBe(true)
  const denied = await readFileTool.execute({ path: 'layout.png', mode: 'vision' }, { ...ctx, resolvedModel: resolved, modelCaps: { vision: false } })
  expect(denied.success).toBe(false)
  expect(denied.output).toContain('vision=false')
  expect(denied.output).not.toContain('data:image/')
})

it.each([false, true])('native Ollama does not turn retained image blocks into base64 text even with vision=%s requested', async vision => {
  const result = await readFileTool.execute({ path: 'layout.png', mode: 'vision' }, ctx)
  const wires: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); wires.push(JSON.stringify(body))
    const response = { model: 'llava', message: { content: 'checked' }, done: true, prompt_eval_count: 100, eval_count: 1 }
    return new Response(JSON.stringify(response) + (body.stream ? '\n' : ''), { headers: { 'content-type': 'application/json' } })
  }))
  const adapter = createLLMAdapter({ provider: 'ollama', model: 'llava', baseUrl: 'http://local.invalid', capabilities: { vision } })
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Retain this instruction.' }, { type: 'image_url', image_url: { url: image.url } }] },
    { role: 'tool', content: truncateToolOutput(result.output, 8000), toolCallId: 'retained-png', toolName: 'read_file' },
  ]
  await adapter.complete(messages, { model: 'llava' })
  for await (const _chunk of adapter.stream(messages, { model: 'llava' })) { /* native protocol boundary */ }
  expect(wires).toHaveLength(2)
  for (const wire of wires) {
    expect(wire.includes(image.base64)).toBe(false)
    expect(wire.length).toBeLessThan(2000)
    expect(wire).toContain('Retain this instruction.')
    expect(wire).toContain('Image pixels were not sent')
    expect(wire).toContain(String(result.metadata?.expectedHash))
  }
})

it('rejects an oversized image before base64 expansion and bounds legacy oversized image results', async () => {
  const file = path.join(root, 'huge.png')
  fs.writeFileSync(file, image.buffer); fs.truncateSync(file, 9 * 1024 * 1024 + 1)
  const result = await readFileTool.execute({ path: file, mode: 'vision' }, ctx)
  expect(result.success).toBe(false)
  expect(result.output).toMatch(/large|limit|超/i)
  expect(result.output).not.toContain('data:image/')
  const legacy = JSON.stringify({ filename: 'huge.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024 + 4), hasDataUrl: true })
  const bounded = truncateToolOutput(legacy, 8000)
  expect(bounded.length).toBeLessThanOrEqual(8000)
  expect(JSON.parse(bounded)).toMatchObject({ hasDataUrl: false, dataUrlStripped: true })
})

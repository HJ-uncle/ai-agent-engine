/** Fresh PPT page-render contract: file version -> live receipt -> image on provider wire.
 * Client pixel production is covered separately by a real Electron test. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pino } from 'pino'
import type { AgentContext, Message } from '../../../core/agent-context/index.js'
import { ToolRegistry } from '../../../core/tool-registry/registry.js'
import { truncateToolOutput } from '../../../core/agent-loop/react.js'
import { imageToolPayload } from '../../../core/utils/multimodal-context.js'
import { captureOfficeEvidence } from '../../../core/utils/tool-evidence.js'
import { createLLMAdapter } from '../../../core/llm-adapter/factory.js'
import { WorkbenchBridge, workbenchBridge, type WorkbenchCommand } from '../bridge.js'
import { workbenchRenderTool } from '../render.js'
import { createSubagentToolRegistry } from '../../subagent/subagent-tool.js'

function png(): string {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4)
    let value = 0xffffffff
    for (const byte of Buffer.concat([name, data])) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)
    }
    size.writeUInt32BE(data.length); crc.writeUInt32BE((value ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, name, data, crc])
  }
  const header = Buffer.alloc(13), pixels = Buffer.alloc((960 * 4 + 1) * 540)
  header.writeUInt32BE(960); header.writeUInt32BE(540, 4); header[8] = 8; header[9] = 6
  for (let y = 0; y < 540; y++) for (let x = 0; x < 960; x++) {
    const offset = y * (960 * 4 + 1) + 1 + x * 4
    pixels[offset] = x % 256; pixels[offset + 1] = y % 256; pixels[offset + 2] = 127; pixels[offset + 3] = 255
  }
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
const dataUrl = png()
const identity = { tenantId: 'ppt-render', userId: 'reviewer' }
let root: string, ctx: AgentContext, file: string, hash: string
const bridges: WorkbenchBridge[] = []
const create = () => { const bridge = new WorkbenchBridge({ leaseMs: 10_000, pollMs: 5, commandMs: 1000 }); bridges.push(bridge); return bridge }
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-ppt-render-')))
  file = path.join(root, 'deck.pptx'); fs.writeFileSync(file, 'original-pptx-fixture-bytes')
  hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  ctx = { ...identity, sessionId: path.basename(root), rootRunId: 'render-run',
    browserPrincipal: { ...identity, method: 'jwt' }, workspaceDir: root, workspacePaths: [root], cwd: root, projectRoot: root,
    modelName: 'deepseek-v4.1-flash-1017', modelCaps: { vision: true },
    tools: new ToolRegistry(), history: {} as AgentContext['history'], logger: pino({ level: 'silent' }) }
  vi.stubEnv('LLM_FALLBACK_MODEL', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-ppt-render-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
function receipt(command: WorkbenchCommand, changes: Record<string, unknown> = {}) {
  const format = String(command.args.format ?? path.extname(String(command.args.path)).slice(1).toLowerCase())
  return { success: true, output: JSON.stringify({ path: command.args.path, sha256: command.args.expectedHash,
    page: command.args.page, pageCount: 2, sessionId: command.sessionId,
    renderer: format === 'pptx' ? 'aether-pptx-to-html-1.1.2' : `aether-${format}-preview-1.0.0`, format, dataUrl, width: 960, height: 540, ...changes }) }
}

describe('workbench_render file and execution identity', () => {
  it('keeps verified short receipts when a render envelope exceeds the evidence parser budget', async () => {
    const bridge = create(), client = bridge.register(identity, ctx.sessionId, ['artifact.render'])
    vi.spyOn(workbenchBridge, 'execute').mockImplementation((action, args, context) => bridge.execute(action, args, context))
    const args = { path: file, page: 2, expectedHash: 'sha256:' + hash }
    const pending = workbenchRenderTool.execute(args, ctx)
    let command: WorkbenchCommand | undefined
    await vi.waitFor(async () => { [command] = await bridge.poll(identity, client.clientId, client.clientToken); expect(command).toBeDefined() })
    // Pixels are capped at 6 MiB base64 by the bridge; ancillary client fields
    // can still make an envelope larger. They must not erase the trusted receipt.
    bridge.result(identity, client.clientId, client.clientToken, command!.requestId, command!.execution,
      receipt(command!, { ignoredClientField: 'PRIVATE_PADDING'.repeat(600_000) }))
    const result = await pending
    expect(result.success).toBe(true)
    expect(result.output.length).toBeGreaterThan(7 * 1024 * 1024)
    const captured = captureOfficeEvidence({ name: 'workbench_render', args }, result)
    expect(captured).toMatchObject({ success: true, operation: 'render', evidenceScope: 'tool-receipt',
      files: [{ path: file, expectedHash: 'sha256:' + hash, page: 2, pageCount: 2, format: 'pptx', unit: 'page' }] })
    expect(JSON.stringify(captured)).not.toContain('PRIVATE_PADDING')
    expect(JSON.stringify(captured)).not.toContain(dataUrl)
  })

  it('does not ask the client to render for a model without vision', async () => {
    const dispatch = vi.spyOn(workbenchBridge, 'execute')
    expect(await workbenchRenderTool.execute({ path: file }, { ...ctx, modelCaps: { vision: false } }))
      .toMatchObject({ success: false, metadata: { code: 'WORKBENCH_VISION_UNAVAILABLE', operationPerformed: false } })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects stale expectedHash before dispatch, including the standard sha256 prefix', async () => {
    const dispatch = vi.spyOn(workbenchBridge, 'execute')
    expect(await workbenchRenderTool.execute({ path: file, expectedHash: 'sha256:' + '0'.repeat(64) }, ctx))
      .toMatchObject({ success: false, metadata: { code: 'WORKBENCH_FILE_CHANGED' } })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects a file changed while the original page was being rendered', async () => {
    vi.spyOn(workbenchBridge, 'execute').mockImplementation(async (_action, args) => {
      fs.writeFileSync(file, 'new-version')
      return { success: true, output: JSON.stringify({ ...args, dataUrl, pageCount: 2 }) }
    })
    expect(await workbenchRenderTool.execute({ path: file, expectedHash: 'sha256:' + hash }, ctx))
      .toMatchObject({ success: false, metadata: { code: 'WORKBENCH_FILE_CHANGED', operationPerformed: false } })
  })
  it('requires a live same-session client that advertised rendering', async () => {
    const bridge = create()
    expect(await bridge.execute('artifact.render', { path: file, page: 1, expectedHash: hash }, ctx))
      .toMatchObject({ success: false, metadata: { code: 'WORKBENCH_UNAVAILABLE' } })
    bridge.register(identity, ctx.sessionId, ['artifact.open'])
    expect(await bridge.execute('artifact.render', { path: file, page: 1, expectedHash: hash }, ctx))
      .toMatchObject({ success: false, metadata: { code: 'WORKBENCH_UNSUPPORTED' } })
  })
  it('allows a readonly reviewer to render its inherited workspace using its own child execution identity', async () => {
    const bridge = create(), client = bridge.register(identity, ctx.sessionId, ['artifact.render'])
    vi.spyOn(workbenchBridge, 'execute').mockImplementation((action, args, context) => bridge.execute(action, args, context))
    const registry = new ToolRegistry(); registry.register(workbenchRenderTool)
    const childTools = createSubagentToolRegistry(registry, true)
    expect(childTools.has('workbench_render')).toBe(true)
    expect(childTools.has('write_file')).toBe(false)
    const child = { ...ctx, sessionId: 'reviewer-child', rootSessionId: ctx.sessionId, runId: 'reviewer-run', tools: childTools }
    const pending = childTools.execute('workbench_render', { path: file }, child)
    let command: WorkbenchCommand | undefined
    await vi.waitFor(async () => { [command] = await bridge.poll(identity, client.clientId, client.clientToken); expect(command).toBeDefined() })
    expect(command!.execution).toEqual({ rootSessionId: ctx.sessionId, rootRunId: 'render-run', ownerRunId: 'reviewer-run' })
    bridge.result(identity, client.clientId, client.clientToken, command!.requestId, command!.execution, receipt(command!))
    expect((await pending).success).toBe(true)
    const dispatch = vi.mocked(workbenchBridge.execute); dispatch.mockClear()
    const denied = await childTools.execute('workbench_render', { path: path.join(root, '..', 'outside.pptx') }, child)
    expect(denied.success).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects wrong file/session/page and invalid PNG receipts, then accepts the exact page', async () => {
    const bridge = create(), client = bridge.register(identity, ctx.sessionId, ['artifact.render'])
    const pending = bridge.execute('artifact.render', { path: file, page: 2, expectedHash: hash }, ctx)
    const [command] = await bridge.poll(identity, client.clientId, client.clientToken)
    const submit = (value: ReturnType<typeof receipt>) => bridge.result(identity, client.clientId, client.clientToken, command.requestId, command.execution, value)
    for (const wrong of [{ path: 'other.pptx' }, { sha256: '0'.repeat(64) }, { sessionId: 'other' },
      { page: 1 }, { pageCount: 1 }, { width: 1 }, { dataUrl: 'data:image/png;base64,AAAA' }]) expect(() => submit(receipt(command, wrong))).toThrow()
    expect(() => submit({ success: true, output: 'null' })).toThrow('回执无效')
    expect(submit(receipt(command))).toBe(true)
    expect(imageToolPayload((await pending).output)?.dataUrl).toBe(dataUrl)
  })
  it.each(['docx', 'xlsx', 'pdf'] as const)('routes %s through the same version-pinned render contract', async format => {
    const target = path.join(root, `fixture.${format}`), bytes = Buffer.from(`fixture-${format}`)
    fs.writeFileSync(target, bytes)
    const targetHash = createHash('sha256').update(bytes).digest('hex')
    const bridge = create(), client = bridge.register(identity, ctx.sessionId, ['artifact.render'])
    vi.spyOn(workbenchBridge, 'execute').mockImplementation((action, args, context) => bridge.execute(action, args, context))
    const pending = workbenchRenderTool.execute({ path: target }, ctx)
    let command: WorkbenchCommand | undefined
    await vi.waitFor(async () => { [command] = await bridge.poll(identity, client.clientId, client.clientToken); expect(command).toBeDefined() })
    expect(command!.args).toMatchObject({ path: target, format, expectedHash: targetHash })
    bridge.result(identity, client.clientId, client.clientToken, command!.requestId, command!.execution, receipt(command!))
    expect(await pending).toMatchObject({ success: true })
  })
  it('revokes a delivered page request on cancellation and rejects its late result', async () => {
    const bridge = create(), client = bridge.register(identity, ctx.sessionId, ['artifact.render']), controller = new AbortController()
    const pending = bridge.execute('artifact.render', { path: file, page: 1, expectedHash: hash }, { ...ctx, signal: controller.signal })
    const [command] = await bridge.poll(identity, client.clientId, client.clientToken)
    controller.abort()
    expect(await pending).toMatchObject({ success: false, metadata: { code: 'WORKBENCH_CANCELLED' } })
    expect(bridge.active(identity, client.clientId, client.clientToken, command.requestId, command.execution)).toBe(false)
    expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, command.execution, receipt(command))).toBe(false)
  })
})

it.each(['openai', 'deepseek', 'anthropic'] as const)('%s receives original page pixels with hash and page identity after text budgeting', async provider => {
  const bridge = create(), client = bridge.register(identity, ctx.sessionId, ['artifact.render'])
  vi.spyOn(workbenchBridge, 'execute').mockImplementation((action, args, context) => bridge.execute(action, args, context))
  const pending = workbenchRenderTool.execute({ path: file, page: 2, expectedHash: 'sha256:' + hash }, ctx)
  let command: WorkbenchCommand | undefined
  await vi.waitFor(async () => { [command] = await bridge.poll(identity, client.clientId, client.clientToken); expect(command).toBeDefined() })
  expect(command!.args).toEqual({ path: file, page: 2, expectedHash: hash, format: 'pptx' })
  bridge.result(identity, client.clientId, client.clientToken, command!.requestId, command!.execution, receipt(command!))
  const result = await pending
  expect(result.success).toBe(true)
  expect(JSON.parse(result.output).expectedHash).toBe('sha256:' + hash)
  const bounded = truncateToolOutput(result.output, 8000)
  expect(imageToolPayload(bounded)?.dataUrl).toBe(dataUrl)
  expect(imageToolPayload(bounded)?.fileVersion.expectedHash).toBe('sha256:' + hash)
  const wires: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); wires.push(JSON.stringify(body.messages))
    return provider === 'anthropic'
      ? Response.json({ id: 'a', type: 'message', role: 'assistant', model: ctx.modelName, content: [{ type: 'text', text: 'reviewed' }], usage: { input_tokens: 100, output_tokens: 1 }, stop_reason: 'end_turn' })
      : Response.json({ choices: [{ message: { content: 'reviewed' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 1 } })
  }))
  const model = provider === 'openai' ? 'gpt-4o' : ctx.modelName!
  const adapter = createLLMAdapter({ provider, model, apiKey: 'fixture-key', baseUrl: 'http://model.invalid', capabilities: { vision: true } })
  const messages: Message[] = [
    { role: 'assistant', content: '', toolCall: { id: 'render', name: 'workbench_render', args: { path: file, page: 2 } } },
    { role: 'tool', content: bounded, toolCallId: 'render', toolName: 'workbench_render' },
  ]
  await adapter.complete(messages, { model, thinkingEnabled: false })
  expect(wires).toHaveLength(1)
  expect(wires[0].split(dataUrl.split(',')[1])).toHaveLength(2)
  expect(wires[0]).toContain(provider === 'anthropic' ? '"type":"image"' : '"type":"image_url"')
  expect(wires[0]).toContain('sha256:' + hash)
  expect(wires[0]).toContain('第 2/2 页')
  expect(wires[0]).toContain('截图成功不代表验收通过')
})

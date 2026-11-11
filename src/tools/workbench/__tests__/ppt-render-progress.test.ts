/** Fresh receipt regression: coverage is scoped to immutable bytes and a live
 * execution, counts only successful stable renders, and never approves a deck. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pino } from 'pino'
import type { AgentContext } from '../../../core/agent-context/types.js'
import type { BrowserExecutionContext } from '../../../core/browser-execution.js'
import { ToolRegistry } from '../../../core/tool-registry/registry.js'
import { PptRenderProgressTracker } from '../ppt-render-progress.js'
import { WorkbenchBridge, workbenchBridge, type WorkbenchCommand } from '../bridge.js'
import { workbenchRenderTool } from '../render.js'

const identity = { tenantId: 'ppt-progress', userId: 'author' }
const scope: BrowserExecutionContext = { tenantId: identity.tenantId, sessionId: 'chat', rootRunId: 'run',
  browserPrincipal: { ...identity, method: 'jwt' } }
const hash = '1'.repeat(64)

describe('bounded PPT image receipt index', () => {
  it('tracks returned pages and repeats without marking a visual verdict', () => {
    const tracker = new PptRenderProgressTracker()
    expect(tracker.record(scope, hash, 2, 3)).toEqual({ renderedPages: [2], remainingPages: [1, 3], repeatedPage: false, evidenceScope: 'images-returned-only' })
    tracker.record(scope, hash, 1, 3)
    expect(tracker.record(scope, 'sha256:' + hash, 2, 3)).toEqual({ renderedPages: [1, 2], remainingPages: [3], repeatedPage: true, evidenceScope: 'images-returned-only' })
    const complete = tracker.record(scope, hash, 3, 3)
    expect(complete).toEqual({ renderedPages: [1, 2, 3], remainingPages: [], repeatedPage: false, evidenceScope: 'images-returned-only' })
    expect(complete).not.toHaveProperty('verified')
    expect(complete).not.toHaveProperty('passed')
  })

  it.each([
    { tenantId: 'other-tenant' },
    { browserPrincipal: { ...identity, userId: 'other-user', method: 'jwt' as const } },
    { sessionId: 'other-session' },
    { rootRunId: 'other-root-run' },
    { runId: 'other-owner-run' },
    { sessionId: 'child', rootSessionId: scope.sessionId, runId: 'child-run' },
  ])('does not mix execution scopes: %j', difference => {
    const tracker = new PptRenderProgressTracker()
    tracker.record(scope, hash, 1, 2)
    expect(tracker.record({ ...scope, ...difference }, hash, 2, 2)?.renderedPages).toEqual([2])
    expect(tracker.record(scope, hash, 2, 2)?.renderedPages).toEqual([1, 2])
  })

  it('does not inherit another file version or contradictory page count', () => {
    const tracker = new PptRenderProgressTracker()
    tracker.record(scope, hash, 1, 3)
    expect(tracker.record(scope, '2'.repeat(64), 2, 3)?.renderedPages).toEqual([2])
    expect(tracker.record(scope, hash, 2, 2)?.renderedPages).toEqual([2])
  })

  it('does not accumulate without valid root and owner execution identities', () => {
    const tracker = new PptRenderProgressTracker()
    expect(tracker.record({ ...scope, rootRunId: undefined }, hash, 1, 2)).toBeUndefined()
    expect(tracker.record({ ...scope, sessionId: 'child', rootSessionId: scope.sessionId }, hash, 1, 2)).toBeUndefined()
    expect(tracker.record(scope, hash, 2, 2)?.renderedPages).toEqual([2])
    for (const [page, count] of [[0, 2], [3, 2], [1, 101], [1.5, 2]]) expect(tracker.record(scope, hash, page, count)).toBeUndefined()
  })

  it('evicts the least recently used scope at the fixed 256-entry limit', () => {
    const tracker = new PptRenderProgressTracker()
    for (let index = 0; index < 256; index++) tracker.record({ ...scope, rootRunId: 'run-' + index }, hash, 1, 2)
    tracker.record({ ...scope, rootRunId: 'run-0' }, hash, 1, 2)
    tracker.record({ ...scope, rootRunId: 'run-256' }, hash, 1, 2)
    expect(tracker.record({ ...scope, rootRunId: 'run-0' }, hash, 2, 2)?.renderedPages).toEqual([1, 2])
    expect(tracker.record({ ...scope, rootRunId: 'run-1' }, hash, 2, 2)?.renderedPages).toEqual([2])
  })
})

function pagePng(): string {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4)
    let value = 0xffffffff
    for (const byte of Buffer.concat([type, data])) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)
    }
    length.writeUInt32BE(data.length); crc.writeUInt32BE((value ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, type, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(960); header.writeUInt32BE(540, 4); header[8] = 8; header[9] = 6
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((960 * 4 + 1) * 540))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

describe('PPT progress through actual workbench transport', () => {
  const dataUrl = pagePng()
  let root: string, file: string, ctx: AgentContext, bridge: WorkbenchBridge, client: ReturnType<WorkbenchBridge['register']>
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-ppt-progress-')))
    file = path.join(root, 'deck.pptx'); fs.writeFileSync(file, 'immutable-fixture-bytes')
    ctx = { ...scope, sessionId: path.basename(root), workspaceDir: root, workspacePaths: [root], cwd: root,
      tools: new ToolRegistry(), history: {} as AgentContext['history'], logger: pino({ level: 'silent' }),
      modelName: 'deepseek-v4.1-flash-1017', modelCaps: { vision: true } }
    bridge = new WorkbenchBridge({ leaseMs: 10_000, pollMs: 5, commandMs: 1000 })
    client = bridge.register(identity, ctx.sessionId, ['artifact.render'])
    vi.spyOn(workbenchBridge, 'execute').mockImplementation((action, args, context) => bridge.execute(action, args, context))
  })
  afterEach(() => {
    bridge.dispose(); vi.restoreAllMocks()
    if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-ppt-progress-')) throw new Error('Unsafe fixture path')
    fs.rmSync(root, { recursive: true, force: true })
  })
  async function render(page: number, options: { target?: string; fail?: boolean; change?: boolean } = {}) {
    const target = options.target ?? file
    const version = createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    const pending = workbenchRenderTool.execute({ path: target, page, expectedHash: version }, ctx)
    let command: WorkbenchCommand | undefined
    await vi.waitFor(async () => { [command] = await bridge.poll(identity, client.clientId, client.clientToken); expect(command).toBeDefined() })
    if (options.change) fs.writeFileSync(target, 'changed-during-render')
    const format = String(command!.args.format)
    bridge.result(identity, client.clientId, client.clientToken, command!.requestId, command!.execution,
      options.fail ? { success: false, output: 'render failed' } : { success: true, output: JSON.stringify({
        path: command!.args.path, sha256: version, page, pageCount: 2, sessionId: command!.sessionId,
        format, renderer: `aether-${format}-preview-1.0.0`, dataUrl, width: 960, height: 540,
      }) })
    return pending
  }

  it('shares progress across renamed identical bytes and still returns repeat image pixels', async () => {
    const first = await render(1)
    expect(first.metadata?.renderProgress).toMatchObject({ renderedPages: [1], remainingPages: [2], repeatedPage: false })
    const renamed = path.join(root, 'renamed.pptx'); fs.copyFileSync(file, renamed)
    const next = await render(2, { target: renamed })
    expect(next.metadata?.renderProgress).toMatchObject({ renderedPages: [1, 2], remainingPages: [], repeatedPage: false })
    const repeated = await render(1)
    expect(repeated.metadata?.renderProgress).toMatchObject({ repeatedPage: true })
    const output = JSON.parse(repeated.output)
    expect(output.dataUrl).toBe(dataUrl)
    expect(output.description).toContain('仅统计图片返回，不表示已查看或合格')
    expect(output.description).toContain('本页重复返回：是')
  })

  it.each(['failed', 'changed'] as const)('does not count a %s render', async failure => {
    const result = await render(1, { fail: failure === 'failed', change: failure === 'changed' })
    expect(result.success).toBe(false)
    expect(result.metadata?.renderProgress).toBeUndefined()
    fs.writeFileSync(file, 'immutable-fixture-bytes')
    const next = await render(2)
    expect(next.metadata?.renderProgress).toMatchObject({ renderedPages: [2], remainingPages: [1] })
  })

  it.each(['docx', 'xlsx', 'pdf'] as const)('leaves the %s receipt unchanged', async format => {
    const target = path.join(root, `document.${format}`); fs.copyFileSync(file, target)
    const result = await render(1, { target })
    expect(result.success).toBe(true)
    expect(result.metadata?.renderProgress).toBeUndefined()
    expect(JSON.parse(result.output)).not.toHaveProperty('renderProgress')
  })
})

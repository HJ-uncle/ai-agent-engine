/** Explicit browser image saves use the real authorized broker and conditional
 * file writer. Pixel fixtures never call a model or touch production sessions. */
import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { browserBridge } from '../browser-bridge.js'
import { browserTools } from '../browser-tools.js'
import { createToolRegistry } from '../../registry-factory.js'
import { createSubagentToolRegistry } from '../../subagent/subagent-tool.js'
import { officeDocumentTool } from '../../office/index.js'
import { readOfficeZip } from '../../office/office-zip.js'
import { workspaceManager } from '../../../workspace/index.js'
import { writeFileTool } from '../../file/super-file-tool.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8k0AAAAASUVORK5CYII=', 'base64')
const tool = browserTools.find(candidate => candidate.name === 'browser_save_screenshot')!
let fixture: string, root: string, db: Client, ctx: AgentContext
beforeEach(() => {
  fs.mkdirSync(path.resolve('.e2e-tmp'), { recursive: true })
  fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/browser-save-')); root = path.join(fixture, 'project')
  fs.mkdirSync(root)
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  db = createClient({ url: 'file::memory:' }); vi.spyOn(database, 'getDb').mockReturnValue(db)
  ctx = { tenantId: 'browser-assets', sessionId: path.basename(fixture), rootSessionId: path.basename(fixture), rootRunId: 'save-run', turnId: 'save-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, modelName: 'gpt-4o', modelCaps: { vision: true }, toolProfile: 'general',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  browserBridge.dispose(); clearSecurityMode(ctx.tenantId, ctx.sessionId); db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('browser-save-')) throw new Error('Unsafe screenshot fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
const argumentsFor = (target = 'assets/product.png') => ({ tabId: 'real-tab', navigationId: 7, path: target, expectedHash: 'missing' })
function captured(bytes = png): ToolResult {
  return { success: true, output: JSON.stringify({ tab: { tabId: 'real-tab', navigationId: 7 }, width: 1, height: 1,
    mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }) }
}
async function capture(args = argumentsFor(), result = captured()): Promise<ToolResult> {
  const identity = { tenantId: ctx.tenantId }, registered = browserBridge.register(identity, ctx.sessionId)
  const pending = tool.execute(args, ctx)
  const commands = await browserBridge.poll(identity, registered.clientId, registered.clientToken)
  expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ action: 'screenshot', args: { tabId: args.tabId, navigationId: args.navigationId } })
  expect(browserBridge.result(identity, registered.clientId, registered.clientToken, commands[0].requestId, result)).toBe(true)
  return pending
}

describe('explicit save screenshot capability', () => {
  it('publishes exact received PNG bytes, a real hash and a PPT-readable image file', async () => {
    const saved = await capture(); expect(saved.success, saved.output).toBe(true)
    const receipt = JSON.parse(saved.output), file = path.join(root, 'assets/product.png')
    expect(fs.readFileSync(file)).toEqual(png)
    expect(receipt).toMatchObject({ path: file, expectedHash: hashFileContent(png), fileVersion: { path: file, expectedHash: hashFileContent(png) }, hasDataUrl: true })
    expect(saved.change).toMatchObject({ kind: 'write', isNew: true, newHash: hashFileContent(png) })
    const ppt = await officeDocumentTool.execute({ operation: 'create', path: 'with-screenshot.pptx', expectedHash: 'missing',
      presentation: { slides: [{ title: '真实页面截图', image: { path: receipt.path } }] } }, ctx)
    expect(ppt.success, ppt.output).toBe(true)
    const packageEntries = readOfficeZip(fs.readFileSync(path.join(root, 'with-screenshot.pptx')))
    expect(Object.entries(packageEntries).some(([name, bytes]) => name.startsWith('ppt/media/') && Buffer.from(bytes).equals(png))).toBe(true)
    const captures = fs.readdirSync(path.join(root, '.ae/tmp/browser-screenshots'), { recursive: true })
    expect(captures.some(name => String(name).endsWith('.png') || String(name).includes('capture-'))).toBe(false)
  })

  it('does not overwrite an existing target or leave a file after a failed capture', async () => {
    const file = path.join(root, 'existing.png'); fs.writeFileSync(file, 'keep original')
    const execute = vi.spyOn(browserBridge, 'execute')
    expect(await tool.execute(argumentsFor('existing.png'), ctx)).toMatchObject({ success: false, metadata: { code: 'WRITE_VERSION_CONFLICT', fileMutationApplied: false } })
    expect(execute).not.toHaveBeenCalled(); expect(fs.readFileSync(file, 'utf8')).toBe('keep original')
    const failed = await capture(argumentsFor(), { success: false, output: 'window hidden', metadata: { code: 'BROWSER_NEEDS_USER' } })
    expect(failed.success).toBe(false); expect(fs.existsSync(path.join(root, 'assets/product.png'))).toBe(false)
    expect(fs.existsSync(path.join(root, '.ae/tmp/browser-screenshots'))).toBe(false)
  })

  it('supports an explicitly versioned replacement through the existing writer', async () => {
    const file = path.join(root, 'existing.png'); fs.writeFileSync(file, 'previous image')
    const result = await capture({ ...argumentsFor('existing.png'), expectedHash: hashFileContent('previous image') })
    expect(result.success, result.output).toBe(true); expect(fs.readFileSync(file)).toEqual(png)
    expect(result.change).toMatchObject({ oldHash: hashFileContent('previous image'), newHash: hashFileContent(png), isNew: false })
  })

  it('rejects outside paths and symlink directories before browser dispatch', async () => {
    const external = path.join(fixture, 'outside'); fs.mkdirSync(external)
    fs.symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const execute = vi.spyOn(browserBridge, 'execute')
    for (const target of ['../outside/escaped.png', path.join(external, 'absolute.png'), 'linked/alias.png']) {
      expect(await tool.execute(argumentsFor(target), ctx)).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
    }
    expect(execute).not.toHaveBeenCalled(); expect(fs.readdirSync(external)).toEqual([])
  })

  it('refuses a redirected private staging directory without touching its target', async () => {
    const external = path.join(fixture, 'private-target'); fs.mkdirSync(external)
    fs.symlinkSync(external, path.join(root, '.ae'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await capture()
    expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
    expect(fs.readdirSync(external)).toEqual([]); expect(fs.existsSync(path.join(root, 'assets/product.png'))).toBe(false)
  })

  it('does not follow a replaced staging ancestor during cleanup or mask a successful save', async () => {
    const write = writeFileTool.execute.bind(writeFileTool), external = path.join(fixture, 'cleanup-target')
    fs.mkdirSync(external)
    let protectedFile = ''
    vi.spyOn(writeFileTool, 'execute').mockImplementation(async (args, context) => {
      const saved = await write(args, context)
      const input = args as { copyFrom: { path: string } }, captureDirectory = path.dirname(input.copyFrom.path), identityDirectory = path.dirname(captureDirectory)
      fs.renameSync(identityDirectory, `${identityDirectory}-retained`)
      fs.mkdirSync(path.join(external, path.basename(captureDirectory)))
      protectedFile = path.join(external, path.basename(captureDirectory), 'keep.txt')
      fs.writeFileSync(protectedFile, 'keep outside directory')
      fs.symlinkSync(external, identityDirectory, process.platform === 'win32' ? 'junction' : 'dir')
      return saved
    })
    const result = await capture()
    expect(result.success, result.output).toBe(true)
    expect(fs.readFileSync(path.join(root, 'assets/product.png'))).toEqual(png)
    expect(fs.readFileSync(protectedFile, 'utf8')).toBe('keep outside directory')
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.any(Object), 'Screenshot staging cleanup failed')
  })

  it('also protects the reused conditional writer staging directory from junction redirects', async () => {
    const external = path.join(fixture, 'writer-staging-target'); fs.mkdirSync(external)
    fs.mkdirSync(path.join(root, '.ae/tmp'), { recursive: true })
    fs.symlinkSync(external, path.join(root, '.ae/tmp/file-writes'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await capture()).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
    expect(fs.readdirSync(external)).toEqual([])
    expect(fs.existsSync(path.join(root, 'assets/product.png'))).toBe(false)
  })

  it.each([
    captured(png.subarray(0, 25)),
    { success: true, output: JSON.stringify({ ...JSON.parse(captured().output), width: 900 }) },
    { success: true, output: JSON.stringify({ ...JSON.parse(captured().output), tab: { tabId: 'foreign-tab', navigationId: 7 } }) },
  ])('does not publish malformed, mismatched or foreign screenshots %#', async result => {
    expect(await capture(argumentsFor(), result)).toMatchObject({ success: false, metadata: { code: 'BROWSER_INVALID_SCREENSHOT' } })
    expect(fs.existsSync(path.join(root, 'assets/product.png'))).toBe(false)
  })

  it('retains read-only screenshot behavior and excludes saves from research children', async () => {
    const registry = (await createToolRegistry({ toolProfile: 'code', allowedTools: ['browser_screenshot', 'browser_save_screenshot'] })).registry
    expect(registry.has('browser_save_screenshot')).toBe(true)
    expect(registry.executionMode('browser_save_screenshot', {})).toBe('serial')
    expect(registry.executionMode('browser_screenshot', {})).toBe('readonly')
    const research = createSubagentToolRegistry(registry, true)
    expect(research.has('browser_screenshot')).toBe(true); expect(research.has('browser_save_screenshot')).toBe(false)
    const execute = vi.spyOn(browserBridge, 'execute')
    expect(await tool.execute(argumentsFor(), { ...ctx, modelCaps: { vision: false } })).toMatchObject({ success: false, metadata: { code: 'BROWSER_VISION_UNAVAILABLE' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a binding change while awaiting the authenticated screenshot', async () => {
    const guard = workspaceManager.bindingReadGuard(ctx)
    vi.spyOn(workspaceManager, 'bindingReadGuard').mockReturnValue({ ...guard, assertCurrent: () => { throw new Error('workspace changed') } })
    expect(await capture()).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
    expect(fs.existsSync(path.join(root, 'assets/product.png'))).toBe(false)
  })

  it('requires a selected workspace rather than silently persisting to authenticated scratch', async () => {
    const guard = workspaceManager.bindingReadGuard(ctx)
    vi.spyOn(workspaceManager, 'bindingReadGuard').mockReturnValue({ ...guard, snapshot: { ...guard.snapshot, epoch: 'scratch:no-selected-workspace' } })
    const execute = vi.spyOn(browserBridge, 'execute')
    expect(await tool.execute(argumentsFor(), ctx)).toMatchObject({ success: false, metadata: { code: 'BROWSER_SCREENSHOT_WORKSPACE_REQUIRED' } })
    expect(execute).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'assets/product.png'))).toBe(false)
  })
})

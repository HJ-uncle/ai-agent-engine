/** Real filesystem preflight before any browser dispatch; model input cannot mint file authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { workspaceManager } from '../../../workspace/index.js'
import { browserBridge } from '../browser-bridge.js'
import { browserTools } from '../browser-tools.js'

const context = { tenantId: 'browser-files', sessionId: 'office-files' } as AgentContext
const tool = browserTools.find(tool => tool.name === 'browser_open')!
let fixture = '', workspace = ''
beforeEach(() => {
  mkdirSync(path.resolve('.e2e-tmp'), { recursive: true })
  fixture = mkdtempSync(path.resolve('.e2e-tmp/browser-files-')); workspace = path.join(fixture, 'workspace')
  mkdirSync(workspace)
  vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((_context, input) => {
    const resolved = path.resolve(workspace, input), relative = path.relative(workspace, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('outside bound workspace')
    return resolved
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('browser-files-')) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

describe('native local HTML preflight', () => {
  it('resolves an authorized real HTML before dispatch and preserves its fragment', async () => {
    const file = path.join(workspace, '办公 概览.html'); writeFileSync(file, '<h1>overview</h1>')
    const execute = vi.spyOn(browserBridge, 'execute').mockResolvedValue({ success: true, output: '{}' })
    expect((await tool.execute({ url: `${pathToFileURL(file).href}#section` }, context)).success).toBe(true)
    expect(workspaceManager.resolveSafePath).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledWith('open', { url: `${pathToFileURL(file).href}#section` }, context)
  })

  it('refuses missing, non-HTML, outside, UNC and symlink-escape files before dispatch', async () => {
    const outside = path.join(fixture, 'private.html'); writeFileSync(outside, '<h1>private</h1>')
    writeFileSync(path.join(workspace, 'document.txt'), 'not html')
    symlinkSync(fixture, path.join(workspace, 'linked'), 'junction')
    const execute = vi.spyOn(browserBridge, 'execute')
    for (const url of [pathToFileURL(path.join(workspace, 'missing.html')).href, pathToFileURL(path.join(workspace, 'document.txt')).href,
      pathToFileURL(outside).href, 'file://server/share/private.html', pathToFileURL(path.join(workspace, 'linked', 'private.html')).href]) {
      expect(await tool.execute({ url }, context), url).toMatchObject({ success: false, metadata: { code: 'BROWSER_LOCAL_FILE_DENIED', operationPerformed: false } })
    }
    expect(execute).not.toHaveBeenCalled()
  })
})

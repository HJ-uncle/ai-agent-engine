import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService, validatePluginInput } from '../service.js'
import { getPluginTemplate } from '../templates.js'
import { getPluginApplication } from '../application.js'
import { runPlugin } from '../runtime.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('published plugin UI contributions', () => {
  it('validates page targets, tool capabilities, duplicate IDs and package HTML paths', () => {
    const input = getPluginTemplate('desktop-timer')
    expect(validatePluginInput(input).manifest.contributes?.pages?.[0].kind).toBe('webview')
    const invalid = structuredClone(input)
    invalid.manifest.contributes!.navigation![0].page = 'missing'
    expect(() => validatePluginInput(invalid)).toThrow('页面 missing 不存在')
    const tool = structuredClone(input)
    tool.manifest.contributes!.services![0].tool = 'missing'
    expect(() => validatePluginInput(tool)).toThrow('工具 missing 不存在')
    const duplicate = structuredClone(input)
    duplicate.manifest.contributes!.pages!.push(duplicate.manifest.contributes!.pages![0])
    expect(() => validatePluginInput(duplicate)).toThrow('标识重复')
    const path = structuredClone(input)
    const page = path.manifest.contributes!.pages![0]
    if (page.kind === 'webview') page.entry = '../escape.html'
    expect(() => validatePluginInput(path)).toThrow('目录穿越')
  })
  it('loads sealed HTML, executes a real timer tool and denies disabled applications', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-contributes-')); roots.push(root)
    const service = new PluginService(root), input = getPluginTemplate('desktop-timer')
    await service.create('test', input)
    await service.publish('test', input.manifest.id, 1)
    const app = await getPluginApplication(service, 'test', input.manifest.id, 1)
    expect(app.uiDocuments?.timer).toBe(input.files['ui/index.html'])
    expect(app.manifest.contributes?.navigation?.[0].page).toBe('timer')
    const result = await runPlugin(await service.snapshot('test', input.manifest.id, 1), 'start_timer', { seconds: 2, now: 1000 })
    expect(result.result).toEqual({ status: 'running', detail: '2 秒倒计时', completesAt: 3000 })
    await service.setEnabled('test', input.manifest.id, false)
    await expect(getPluginApplication(service, 'test', input.manifest.id, 1)).rejects.toThrow()
  })
})

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { PluginService, validatePluginInput } from '../service.js'
import { getPluginTemplate } from '../templates.js'
import { getPluginApplication } from '../application.js'
import { runPlugin } from '../runtime.js'

const roots: string[] = []
const fixtureRoot = resolve('.e2e-tmp/plugin-contributions')
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== fixtureRoot || lstatSync(root).isSymbolicLink()) throw new Error('Unsafe plugin fixture cleanup')
  rmSync(root, { recursive: true, force: true })
} })
afterAll(() => { if (existsSync(fixtureRoot) && !lstatSync(fixtureRoot).isSymbolicLink() && readdirSync(fixtureRoot).length === 0) rmdirSync(fixtureRoot) })
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
  it('distinguishes missing HTML from empty content and actual size overflow so authors can repair the right file', () => {
    const missing = getPluginTemplate('desktop-timer')
    delete missing.files['ui/index.html']
    expect(() => validatePluginInput(missing)).toThrow('files 中缺少 "ui/index.html"')
    const empty = getPluginTemplate('desktop-timer')
    empty.files['ui/index.html'] = ' \n'
    expect(() => validatePluginInput(empty)).toThrow('为空')
    const oversized = getPluginTemplate('desktop-timer')
    oversized.files['ui/index.html'] = 'x'.repeat(512 * 1024 + 1)
    expect(() => validatePluginInput(oversized)).toThrow('实际为 524289 字节')
  })
  it('loads sealed HTML, executes a real timer tool and denies disabled applications', async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    const root = mkdtempSync(join(fixtureRoot, 'store-')); roots.push(root)
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

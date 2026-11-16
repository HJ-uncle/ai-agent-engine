import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { PluginService, validatePluginInput } from '../service.js'
import { getPluginTemplate } from '../templates.js'
import { getPluginApplication } from '../application.js'
import { runPlugin } from '../runtime.js'
import { PLUGIN_CONTRIBUTION_JSON_SCHEMA } from '../contributions.js'
import { Ajv } from 'ajv'

const roots: string[] = []
const fixtureRoot = resolve('.e2e-tmp/plugin-contributions')
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== fixtureRoot || lstatSync(root).isSymbolicLink()) throw new Error('Unsafe plugin fixture cleanup')
  rmSync(root, { recursive: true, force: true })
} })
afterAll(() => { if (existsSync(fixtureRoot) && !lstatSync(fixtureRoot).isSymbolicLink() && readdirSync(fixtureRoot).length === 0) rmdirSync(fixtureRoot) })
describe('published plugin UI contributions', () => {
  it('validates all workbench slots against the same advertised JSON schema and native document contract', () => {
    const input = getPluginTemplate('json-tool'), tool = input.manifest.tools[0].name
    input.manifest.permissions = { requested: ['events.subscribe', 'background.run'] }
    input.manifest.contributes = {
      pages: [{ id: 'native', title: 'Native', kind: 'native', entry: 'ui/native.json', tools: [tool] }],
      commands: [{ id: 'execute', title: 'Execute', tool }, { id: 'open', title: 'Open', page: 'native', shortcut: 'CmdOrCtrl+Shift+Y' }],
      menus: [{ id: 'message', title: 'Message', location: 'message.actions', command: 'execute' }],
      views: [{ id: 'composer', title: 'Composer', location: 'composer.panel', page: 'native', height: 120 }],
      statusBar: [{ id: 'status', title: 'Status', command: 'open' }], settings: [{ id: 'preferences', title: 'Preferences', page: 'native' }],
      editorDecorations: [{ id: 'note', title: 'Note', text: 'Workspace rule', pattern: '*.ts', severity: 'info' }],
      hooks: [{ id: 'completed', title: 'Completed', event: 'agent.completed', tool }],
      background: [{ id: 'scheduled', title: 'Scheduled', tool, intervalMs: 60_000 }],
    }
    input.files['ui/native.json'] = JSON.stringify({ version: 1, root: { type: 'stack', children: [{ type: 'input', bind: 'name', label: 'Name' },
      { type: 'button', text: 'Run', action: { tool, args: { name: { $field: 'name' } } } }] } })
    const advertised = new Ajv({ strict: false }).compile(PLUGIN_CONTRIBUTION_JSON_SCHEMA)
    expect(advertised(input.manifest.contributes), JSON.stringify(advertised.errors)).toBe(true)
    expect(validatePluginInput(input).manifest.contributes?.pages?.[0].kind).toBe('native')
    const invalid = structuredClone(input); invalid.manifest.contributes!.commands![0].page = 'native'
    expect(() => validatePluginInput(invalid)).toThrow('只能提供 tool 或 page')
    const reference = structuredClone(input); reference.manifest.contributes!.menus![0].command = 'missing'
    expect(() => validatePluginInput(reference)).toThrow('命令不存在')
    const ungranted = structuredClone(input); delete ungranted.manifest.permissions
    expect(() => validatePluginInput(ungranted)).toThrow('events.subscribe')
    const unsafe = structuredClone(input); unsafe.files['ui/native.json'] = JSON.stringify({ version: 1, root: { type: 'text', text: 'Unsafe', onClick: 'fetch(secret)' } })
    expect(() => validatePluginInput(unsafe)).toThrow('不受支持')
    const whitelist = structuredClone(input); const page = whitelist.manifest.contributes!.pages![0]; if (page.kind === 'native') delete page.tools
    expect(() => validatePluginInput(whitelist)).toThrow('未声明的工具')
  })
  it('accepts more than 256 native components and more than 12 levels without losing their structure', () => {
    const input = getPluginTemplate('json-tool')
    input.manifest.contributes = { pages: [{ id: 'native', title: 'Native', kind: 'native', entry: 'ui/native.json' }] }
    type Node = { type: string; text?: string; children?: Node[] }
    let root: Node = { type: 'text', text: 'leaf' }
    for (let depth = 1; depth < 40; depth++) root = { type: 'stack', children: [root] }
    input.files['ui/native.json'] = JSON.stringify({ version: 1, root: { type: 'stack', children: [root, ...Array.from({ length: 300 }, (_, index) => ({ type: 'text', text: String(index) }))] } })
    expect(validatePluginInput(input).files['ui/native.json']).toBe(input.files['ui/native.json'])
  })
  it('rejects duplicate native field bindings across separate branches before publication', () => {
    const input = getPluginTemplate('json-tool')
    input.manifest.contributes = { pages: [{ id: 'native', title: 'Native', kind: 'native', entry: 'ui/native.json' }] }
    const root = { type: 'row', children: [
      { type: 'card', children: [{ type: 'input', bind: 'name', value: 'Alice' }] },
      { type: 'card', children: [{ type: 'textarea', bind: 'notes', value: 'Review' }] }
    ] }
    input.files['ui/native.json'] = JSON.stringify({ version: 1, root })
    expect(() => validatePluginInput(input)).not.toThrow()
    root.children[1].children[0].bind = 'name'
    input.files['ui/native.json'] = JSON.stringify({ version: 1, root })
    expect(() => validatePluginInput(input)).toThrow('表单字段标识重复')
  })
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
  it('rejects missing or empty HTML while accepting pages above the former 512 KiB cutoff', () => {
    const missing = getPluginTemplate('desktop-timer')
    delete missing.files['ui/index.html']
    expect(() => validatePluginInput(missing)).toThrow('files 中缺少 "ui/index.html"')
    const empty = getPluginTemplate('desktop-timer')
    empty.files['ui/index.html'] = ' \n'
    expect(() => validatePluginInput(empty)).toThrow('为空')
    const oversized = getPluginTemplate('desktop-timer')
    oversized.files['ui/index.html'] = 'x'.repeat(512 * 1024 + 1)
    expect(validatePluginInput(oversized).files['ui/index.html']).toBe(oversized.files['ui/index.html'])
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

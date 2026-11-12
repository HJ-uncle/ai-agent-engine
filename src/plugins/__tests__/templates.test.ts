import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import Fastify from 'fastify'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../../core/agent-context/types.js'
import { pluginRoutes } from '../../api/http/routes/plugins.js'
import { createToolRegistry } from '../../tools/registry-factory.js'
import { getPluginTemplate, listPluginTemplates, PLUGIN_TEMPLATE_PROTOCOL } from '../templates.js'
import { PLUGIN_CONTRIBUTION_CATALOGUE } from '../contributions.js'
import { createPluginManagementTools } from '../management-tools.js'
import { PluginService, validatePluginInput } from '../service.js'
import { runPlugin } from '../runtime.js'
import { setSecurityMode, clearSecurityMode } from '../../security/policy-engine.js'

let root: string, service: PluginService
const scratch = path.resolve('.e2e-tmp/plugin-templates')
const ctx = { tenantId: 'default', sessionId: 'template-tests' } as AgentContext

beforeEach(() => {
  fs.mkdirSync(scratch, { recursive: true })
  root = fs.mkdtempSync(path.join(scratch, 'run-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('OSM_MODE', 'off')
  service = new PluginService()
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== scratch || !path.basename(resolved).startsWith('run-') || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Unsafe template fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 })
})

describe('standard plugin project templates', () => {
  it('returns discoverable summaries and independent complete projects with explicit product boundaries', () => {
    const summaries = listPluginTemplates()
    expect(summaries.map(item => item.id)).toEqual(['json-tool', 'markdown-report', 'time-calculator', 'currency-converter', 'desktop-timer'])
    expect(summaries.every(item => !Object.hasOwn(item, 'files'))).toBe(true)
    for (const { id } of summaries) {
      const template = getPluginTemplate(id)
      expect(Object.keys(template.files).sort()).toEqual(['README.md', 'aether-plugin.json', 'examples/cases.json', 'main.mjs', 'package.json', 'scripts/test.mjs', ...(id === 'desktop-timer' ? ['ui/index.html'] : [])])
      expect(JSON.parse(template.files['aether-plugin.json'])).toEqual(template.manifest)
      expect(template.protocol.ui).toContain('manifest.contributes')
      expect(template.contributions).toEqual(PLUGIN_CONTRIBUTION_CATALOGUE)
      expect(template.protocol.background).toContain('完成即退出')
      expect(() => validatePluginInput(template)).not.toThrow()
    }
    const first = getPluginTemplate('json-tool')
    first.manifest.name = 'changed'; first.files['main.mjs'] = 'changed'
    expect(getPluginTemplate('json-tool').manifest.name).not.toBe('changed')
    expect(getPluginTemplate('json-tool').files['main.mjs']).not.toBe('changed')
    expect(() => getPluginTemplate('../outside')).toThrow('插件模板不存在')
  })

  it.each(['json-tool', 'markdown-report', 'time-calculator', 'currency-converter', 'desktop-timer'])('executes every deterministic example through the actual Node protocol: %s', async id => {
    const template = getPluginTemplate(id)
    const record = await service.create('default', template)
    const snapshot = await service.snapshot('default', record.id, 1, { allowDraft: true })
    const { cases } = JSON.parse(template.files['examples/cases.json']) as { cases: Array<{ name: string; tool: string; args: unknown; expected: unknown }> }
    expect(cases.length).toBeGreaterThan(0)
    for (const example of cases) {
      const output = await runPlugin(snapshot, example.tool, example.args)
      expect(output.result, example.name).toEqual(example.expected)
      expect(output.stderr).toBe('')
      if (id === 'markdown-report') {
        expect(output.artifacts).toHaveLength(1)
        expect(output.artifacts[0].path).toBe((example.expected as { path: string }).path)
        expect(output.artifacts[0].content).toContain('# ' + (example.expected as { title: string }).title)
        expect(fs.existsSync(path.join(snapshot.directory, output.artifacts[0].path))).toBe(false)
      } else expect(output.artifacts).toEqual([])
    }
    const standalone = execFileSync(process.execPath, [path.join(snapshot.directory, 'scripts/test.mjs')], { cwd: snapshot.directory, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    expect(standalone).toContain(`${cases.length} business cases passed`)
    expect(fs.existsSync(path.join(snapshot.directory, 'reports'))).toBe(false)
  })

  it('rejects an impossible calendar date through stderr and a nonzero exit', async () => {
    const record = await service.create('default', getPluginTemplate('time-calculator'))
    const snapshot = await service.snapshot('default', record.id, 1, { allowDraft: true })
    await expect(runPlugin(snapshot, 'add_minutes', { at: '2026-02-30T08:00:00Z', minutes: 1 })).rejects.toMatchObject({ code: 'PLUGIN_EXIT', message: expect.stringContaining('Invalid calendar time') })
  })

  it('preserves the currency template precision, same-currency and numeric-range boundaries', async () => {
    const record = await service.create('default', getPluginTemplate('currency-converter'))
    const snapshot = await service.snapshot('default', record.id, 1, { allowDraft: true })
    expect((await runPlugin(snapshot, 'convert', { amount: 1.005, from: 'USD', to: 'CNY', rate: 3 })).result).toMatchObject({ converted: 3.02, formatted: '3.02 CNY' })
    for (const [args, message] of [
      [{ amount: 100, from: 'USD', to: 'USD', rate: 2 }, '相同币种的汇率必须为 1'],
      [{ amount: 1e12, from: 'USD', to: 'CNY', rate: 1e6 }, '换算金额超出可安全表示的范围'],
      [{ amount: 703687441776.64, from: 'USD', to: 'CNY', rate: 100.00000000000001 }, '换算金额无法以数字安全表示'],
    ] as const) await expect(runPlugin(snapshot, 'convert', args)).rejects.toMatchObject({ code: 'PLUGIN_EXIT', message: expect.stringContaining(message) })
  })

  it('preserves Unicode across stdin chunks for JSON input larger than 64 KiB', async () => {
    const template = getPluginTemplate('json-tool')
    template.manifest.tools[0].inputSchema = { type: 'object', properties: { text: { type: 'string', maxLength: 50000 } }, required: ['text'], additionalProperties: false }
    const record = await service.create('default', template)
    const snapshot = await service.snapshot('default', record.id, 1, { allowDraft: true })
    const text = '汉🌟'.repeat(15000)
    expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024)
    const output = await runPlugin(snapshot, 'normalize_text', { text })
    expect(output.result).toEqual({ text, characters: 30000 })
  })

  it('keeps the validated API manifest authoritative when editing an existing project', async () => {
    const template = getPluginTemplate('json-tool')
    const originalFile = template.files['aether-plugin.json']
    const record = await service.create('default', template)
    const changed = await service.update('default', record.id, { manifest: { ...record.manifest, name: 'Edited name', version: '2.0.0' }, files: record.files, expectedRevision: 1 })
    expect(JSON.parse(changed.files['aether-plugin.json'])).toEqual(changed.manifest)
    expect(changed.files['aether-plugin.json']).not.toBe(originalFile)
    expect(template.files['aether-plugin.json']).toBe(originalFile)
  })

  it('provides the same read-only AI discovery under the selected Work toolkit without widening defaults', async () => {
    const tool = createPluginManagementTools(service).find(item => item.name === 'plugin_get_template')!
    expect(tool.preflight).toBeUndefined()
    const list = await tool.execute({}, ctx)
    expect(list.success).toBe(true)
    expect(list.output.length).toBeLessThanOrEqual(4000)
    expect(JSON.parse(list.output)).toMatchObject({ mode: 'overview', templateCount: listPluginTemplates().length })
    expect(JSON.parse(list.output).protocolFields).toContain('uiBridge')
    const detail = await tool.execute({ id: 'markdown-report' }, ctx)
    expect(JSON.parse(detail.output)).toMatchObject({ mode: 'overview', id: 'markdown-report', fileCount: Object.keys(getPluginTemplate('markdown-report').files).length })
    const protocol = await tool.execute({ protocol: 'uiBridge' }, ctx)
    expect(JSON.parse(protocol.output).content).toBe(PLUGIN_TEMPLATE_PROTOCOL.uiBridge)
    expect((await tool.execute({ id: 'missing' }, ctx)).success).toBe(false)
    expect((await tool.execute({ id: 'json-tool', extra: true }, ctx)).success).toBe(false)
    expect((await tool.execute({}, { ...ctx, parentSessionId: 'parent' })).success).toBe(false)
    const options = { allowedMcpServers: [], allowedSkills: [], memoryScopes: [] }
    const normal = await createToolRegistry(options)
    const selected = await createToolRegistry({ ...options, toolkits: ['plugin-management'] })
    const code = await createToolRegistry({ ...options, toolProfile: 'code' })
    expect(normal.registry.has('plugin_get_template')).toBe(false)
    expect(code.registry.has('plugin_get_template')).toBe(false)
    expect(selected.registry.has('plugin_get_template')).toBe(true)
    expect(selected.registry.executionMode('plugin_get_template', {})).toBe('readonly')
    expect((await selected.registry.execute('plugin_get_template', { id: 'json-tool' }, ctx)).success).toBe(true)
  })

  it('serves static template routes and exports the requested immutable revision as a runnable project', async () => {
    const app = Fastify(); await app.register(pluginRoutes)
    try {
      const list = await app.inject({ method: 'GET', url: '/plugins/project/templates' })
      expect(list.statusCode).toBe(200)
      expect(list.json().data.templates).toEqual(listPluginTemplates())
      const detail = await app.inject({ method: 'GET', url: '/plugins/project/templates/markdown-report' })
      expect(detail.json().data.template).toEqual(getPluginTemplate('markdown-report'))
      expect((await app.inject({ method: 'GET', url: '/plugins/project/templates/missing' })).statusCode).toBe(404)
      const record = await service.create('default', getPluginTemplate('json-tool'))
      await service.update('default', record.id, { manifest: { ...record.manifest, version: '2.0.0' }, files: record.files, expectedRevision: 1 })
      const response = await app.inject({ method: 'GET', url: `/plugins/project/exports/${record.id}?revision=1` })
      expect(response.statusCode).toBe(200)
      const archive = response.json().data.archive as { fileName: string; base64: string; sha256: string; revision: number }
      expect(archive.fileName).toBe('my-json-tool-r1.zip'); expect(archive.revision).toBe(1)
      const bytes = Buffer.from(archive.base64, 'base64')
      expect(archive.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      const files = unzipSync(bytes)
      expect(JSON.parse(strFromU8(files['aether-plugin.json']))).toEqual(record.manifest)
      expect(strFromU8(files['main.mjs'])).toBe(record.files['main.mjs'])
      expect((await app.inject({ method: 'GET', url: `/plugins/project/exports/${record.id}?revision=0` })).statusCode).not.toBe(200)
    } finally { await app.close() }
  })

  it('keeps management authorization on template discovery and export', async () => {
    vi.stubEnv('AUTH_ENABLED', 'true')
    const app = Fastify(); await app.register(pluginRoutes)
    try {
      expect((await app.inject({ method: 'GET', url: '/plugins/project/templates' })).statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url: '/plugins/project/templates/json-tool' })).statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url: '/plugins/project/exports/my-json-tool' })).statusCode).toBe(403)
      const tool = createPluginManagementTools(service).find(item => item.name === 'plugin_get_template')!
      expect((await tool.execute({}, ctx)).success).toBe(false)
    } finally { await app.close() }
  })

  it.each(['templates', 'project', 'imports'])('keeps existing and new plugin IDs addressable alongside the project API: %s', async id => {
    const template = getPluginTemplate('json-tool')
    const app = Fastify(); await app.register(pluginRoutes)
    try {
      const created = await app.inject({ method: 'POST', url: '/plugins', payload: { ...template, manifest: { ...template.manifest, id } } })
      expect(created.statusCode).toBe(200)
      const detail = await app.inject({ method: 'GET', url: `/plugins/${id}` })
      expect(detail.json().data.plugin.id).toBe(id)
      const exported = await app.inject({ method: 'GET', url: `/plugins/project/exports/${id}` })
      expect(exported.json().data.archive.fileName).toBe(`${id}-r1.zip`)
      expect((await app.inject({ method: 'GET', url: '/plugins/project/templates' })).json().data.templates).toEqual(listPluginTemplates())
      const tested = await app.inject({ method: 'POST', url: `/plugins/${id}/test`, payload: { tool: 'normalize_text', args: { text: ' x ' } } })
      expect(tested.json().data.result).toEqual({ text: 'x', characters: 1 })
      expect((await app.inject({ method: 'DELETE', url: `/plugins/${id}` })).json().data.deleted).toBe(true)
    } finally { await app.close() }
  })
})

async function approvedTest(tool: Tool, args: Record<string, unknown>): Promise<{ context: AgentContext; pending: NonNullable<Awaited<ReturnType<NonNullable<Tool['preflight']>>>> }> {
  const context = { ...ctx, currentToolCallId: 'approved-plugin-tests' }
  const pending = (await tool.preflight!(args, context))!
  expect(pending.needsConfirmation, pending.output).toBe(true)
  Object.assign(context, { approvedToolCallId: context.currentToolCallId,
    resumeToolCall: { toolCall: { id: context.currentToolCallId, name: tool.name, args }, decision: 'approved', pendingAction: pending.pendingAction } })
  return { context, pending }
}

describe('one approved plugin test batch', () => {
  it('runs multiple expected business results under one approval and preserves the single-case contract', async () => {
    const record = await service.create('default', getPluginTemplate('json-tool'))
    const tool = createPluginManagementTools(service).find(item => item.name === 'plugin_test')!
    const args = { id: record.id, cases: [
      { name: 'whitespace', tool: 'normalize_text', args: { text: ' a  b ' }, expected: { text: 'a b', characters: 3 } },
      { name: 'empty', tool: 'normalize_text', args: { text: '' }, expected: { text: '', characters: 0 } },
    ] }
    const { context, pending } = await approvedTest(tool, args)
    expect((pending.pendingAction?.operation as { input: { revision: number } }).input.revision).toBe(1)
    const result = await tool.execute(args, context)
    expect(result.success, result.output).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ revision: 1, total: 2, passed: 2, failed: 0, cases: [{ name: 'whitespace', passed: true }, { name: 'empty', passed: true }] })
    const singleArgs = { id: record.id, tool: 'normalize_text', args: { text: ' x ' } }
    const single = await approvedTest(tool, singleArgs)
    const singleResult = await tool.execute(singleArgs, single.context)
    expect(singleResult.success).toBe(true)
    expect(JSON.parse(singleResult.output).result).toEqual({ text: 'x', characters: 1 })
  })

  it('reports assertion failures and process failures as overall failure while showing every case', async () => {
    const record = await service.create('default', getPluginTemplate('time-calculator'))
    const tool = createPluginManagementTools(service).find(item => item.name === 'plugin_test')!
    const args = { id: record.id, cases: [
      { name: 'wrong expectation', tool: 'add_minutes', args: { at: '2026-11-11T08:00:00Z', minutes: 0 }, expected: 'incorrect' },
      { name: 'invalid date', tool: 'add_minutes', args: { at: '2026-02-30T08:00:00Z', minutes: 0 } },
      { name: 'valid calculation', tool: 'add_minutes', args: { at: '2026-11-11T08:00:00Z', minutes: 90 }, expected: { atUtc: '2026-11-11T08:00:00.000Z', shiftedUtc: '2026-11-11T09:30:00.000Z', minutes: 90 } },
    ] }
    const { context } = await approvedTest(tool, args)
    const result = await tool.execute(args, context)
    expect(result.success).toBe(false)
    expect(result.error).toContain('2 个')
    const summary = JSON.parse(result.output)
    expect(summary).toMatchObject({ revision: 1, total: 3, passed: 1, failed: 2 })
    expect(summary.cases.map((item: { passed: boolean }) => item.passed)).toEqual([false, false, true])
    expect(summary.cases[0].error).toContain('expected')
    expect(summary.cases[1].error).toContain('Invalid calendar time')
  })

  it('rejects mixed, empty, oversized or schema-invalid batches before requesting approval', async () => {
    const record = await service.create('default', getPluginTemplate('json-tool'))
    const tool = createPluginManagementTools(service).find(item => item.name === 'plugin_test')!
    const one = { tool: 'normalize_text', args: { text: 'x' } }
    for (const input of [
      { cases: [one], tool: 'normalize_text', args: {} }, { cases: [] }, { cases: Array(21).fill(one) },
      { cases: [{ tool: 'missing', args: {} }] }, { cases: [{ tool: 'normalize_text', args: { text: 7 } }] },
    ]) {
      const result = await tool.preflight!({ id: record.id, ...input }, ctx)
      expect(result?.success).toBe(false)
      expect(result?.needsConfirmation).not.toBe(true)
    }
  })

  it('rejects changed revisions and changed batch arguments after approval', async () => {
    const record = await service.create('default', getPluginTemplate('json-tool'))
    const tool = createPluginManagementTools(service).find(item => item.name === 'plugin_test')!
    const args = { id: record.id, cases: [{ tool: 'normalize_text', args: { text: 'x' }, expected: { text: 'x', characters: 1 } }] }
    const { context } = await approvedTest(tool, args)
    expect((await tool.execute({ ...args, cases: [{ ...args.cases[0], expected: 'changed' }] }, context)).success).toBe(false)
    await service.update('default', record.id, { manifest: { ...record.manifest, version: '2' }, files: record.files, expectedRevision: 1 })
    const rejected = await tool.execute(args, context)
    expect(rejected.success).toBe(false)
    expect(rejected.output).toContain('批准期间插件已变化')
  })
})

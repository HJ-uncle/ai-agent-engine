import fs from 'node:fs'
import path from 'node:path'
import { Ajv } from 'ajv'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../../core/agent-context/types.js'
import { resolvePluginCreateInput } from '../create-input.js'
import { createPluginManagementTools } from '../management-tools.js'
import { runPlugin } from '../runtime.js'
import { PluginService } from '../service.js'
import * as templates from '../templates.js'
import type { CreatePluginInput, PluginRecord } from '../types.js'

let root: string, service: PluginService
const fixtures = path.resolve('.e2e-tmp/plugin-template-create-tests')
const ctx = { tenantId: 'default', sessionId: 'template-create' } as AgentContext
beforeEach(() => {
  fs.mkdirSync(fixtures, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  service = new PluginService(path.join(root, 'plugins'))
  vi.stubEnv('AUTH_ENABLED', 'false')
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-')) throw new Error('Unsafe template fixture cleanup')
  function removeOwned(directory: string): void {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Refusing linked template fixture cleanup')
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing linked template fixture cleanup')
      if (entry.isDirectory()) removeOwned(file); else fs.unlinkSync(file)
    }
    if (fs.readdirSync(directory).length) throw new Error('Template fixture directory is not empty')
    fs.rmdirSync(directory)
  }
  removeOwned(root)
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})

async function prepare(tool: Tool, args: Record<string, unknown>) {
  const context = { ...ctx, currentToolCallId: 'create-template-call' }
  const pending = await tool.preflight!(args, context)
  expect(pending?.needsConfirmation, pending?.output).toBe(true)
  Object.assign(context, { approvedToolCallId: context.currentToolCallId,
    resumeToolCall: { toolCall: { id: context.currentToolCallId, name: tool.name, args: structuredClone(args) }, decision: 'approved', pendingAction: pending!.pendingAction } })
  return { context, pending: pending!, input: (pending!.pendingAction!.operation as { input: CreatePluginInput }).input }
}

describe('host-created template source', () => {
  it('builds a complete currency project with independent template and plugin identities', () => {
    const original = templates.getPluginTemplate('currency-converter')
    const input = resolvePluginCreateInput({ templateId: 'currency-converter', id: 'office-currency', name: ' 办公换算器 ', description: ' 自用的明确汇率换算 ' })
    expect(input.manifest).toMatchObject({ id: 'office-currency', name: '办公换算器', description: '自用的明确汇率换算', version: original.manifest.version })
    expect(input.manifest.tools).toEqual(original.manifest.tools)
    expect(Object.keys(input.files)).toHaveLength(6)
    for (const file of ['main.mjs', 'examples/cases.json', 'scripts/test.mjs']) expect(input.files[file]).toBe(original.files[file])
    expect(JSON.parse(input.files['aether-plugin.json'])).toEqual(input.manifest)
    expect(JSON.parse(input.files['package.json']).name).toBe('office-currency')
    expect(input.files['README.md']).toMatch(/^# 办公换算器\n\n自用的明确汇率换算\n\n/)
    expect(templates.getPluginTemplate('currency-converter')).toEqual(original)
  })

  it.each(templates.listPluginTemplates().map(template => template.id))('preserves every %s business example without accepting source from the caller', async templateId => {
    const template = templates.getPluginTemplate(templateId)
    const input = resolvePluginCreateInput({ templateId, id: 'copy-' + templateId })
    expect(input.manifest.name).toBe(template.manifest.name)
    expect(input.manifest.description).toBe(template.manifest.description)
    for (const file of ['main.mjs', 'examples/cases.json', 'scripts/test.mjs']) expect(input.files[file]).toBe(template.files[file])
    await service.create('default', input)
    const snapshot = await service.snapshot('default', input.manifest.id, 1, { allowDraft: true })
    const examples = JSON.parse(input.files['examples/cases.json']).cases as Array<{ tool: string; args: Record<string, unknown>; expected: unknown; artifacts?: unknown[] }>
    for (const example of examples) {
      const result = await runPlugin(snapshot, example.tool, example.args)
      expect(result.result).toEqual(example.expected)
      if (example.artifacts) expect(result.artifacts).toEqual(example.artifacts)
    }
  })

  it.each([
    { templateId: 'not-a-template', id: 'new-plugin' },
    { templateId: '../currency-converter', id: 'new-plugin' },
    { templateId: 'currency-converter', id: 'Bad_ID' },
    { templateId: 'currency-converter' },
    { templateId: 'currency-converter', id: 'new-plugin', name: ' ' },
    { templateId: 'currency-converter', id: 'new-plugin', description: '' },
    { templateId: 'currency-converter', id: 'new-plugin', files: {} },
    { templateId: 'currency-converter', id: 'new-plugin', manifest: {} },
    { templateId: 'currency-converter', id: 'new-plugin', extra: 'unrecognized' },
  ])('rejects invalid or mixed input before requesting approval: %j', async args => {
    const tool = createPluginManagementTools(service).find(tool => tool.name === 'plugin_create')!
    const result = await tool.preflight!(args, ctx)
    expect(result?.success).toBe(false)
    expect(result?.needsConfirmation).not.toBe(true)
    expect(await service.list('default')).toEqual([])
  })

  it('requires an explicit choice between template metadata and full source', () => {
    const original = templates.getPluginTemplate('json-tool')
    for (const key of ['id', 'name', 'description']) {
      expect(() => resolvePluginCreateInput({ manifest: original.manifest, files: original.files, [key]: 'ambiguous' })).toThrow('仅用于模板创建')
    }
    expect(() => resolvePluginCreateInput({ templateId: 'missing', id: 'new-plugin', manifest: original.manifest, files: original.files })).toThrow('互斥')
  })
})

describe('approved template creation', () => {
  it('seals source before approval and never re-reads a changed template when resuming', async () => {
    const tool = createPluginManagementTools(service).find(tool => tool.name === 'plugin_create')!
    const args = { templateId: 'currency-converter', id: 'precise-currency', name: '精确换算器' }
    const lookup = vi.spyOn(templates, 'getPluginTemplate')
    const { context, input } = await prepare(tool, args)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(input).toHaveProperty('manifest.id', 'precise-currency')
    expect(input).not.toHaveProperty('templateId')
    expect(input.files['main.mjs']).toContain('BigInt')
    expect(await service.list('default')).toEqual([])
    const approvedSource = input.files['main.mjs']
    lookup.mockImplementation(() => { throw new Error('Template changed after approval; must not be resolved again') })
    // A durable approval can resume in a newly constructed tool after a restart.
    const resumed = createPluginManagementTools(service).find(tool => tool.name === 'plugin_create')!
    const result = await resumed.execute(args, context)
    expect(result.success, result.output).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
    const created = JSON.parse(result.output)
    expect(created).toMatchObject({ id: 'precise-currency', enabled: false, revision: 1, selectionId: null,
      globalToolNames: ['plugin_precise_currency_convert'], toolNameMap: { convert: 'plugin_precise_currency_convert' } })
    expect(created).not.toHaveProperty('files')
    expect((await service.get('default', created.id)).files['main.mjs']).toBe(approvedSource)
    const snapshot = await service.snapshot('default', created.id, 1, { allowDraft: true })
    const exact = await runPlugin(snapshot, 'convert', { amount: 1.005, from: 'USD', to: 'CNY', rate: 3 })
    expect(exact.result).toMatchObject({ converted: 3.02, formatted: '3.02 CNY' })
    await expect(runPlugin(snapshot, 'convert', { amount: 100, from: 'USD', to: 'USD', rate: 2 })).rejects.toThrow('相同币种的汇率必须为 1')
    await expect(runPlugin(snapshot, 'convert', { amount: 1e12, from: 'USD', to: 'CNY', rate: 1e6 })).rejects.toThrow('可安全表示')
    expect(result.metadata?.resourceChange).toEqual({ kind: 'plugin', action: 'create', id: created.id })
  })

  it('does not write without approval and rejects changed approved template arguments', async () => {
    const tool = createPluginManagementTools(service).find(tool => tool.name === 'plugin_create')!
    const args = { templateId: 'json-tool', id: 'approval-required' }
    const unapproved = await tool.execute(args, ctx)
    expect(unapproved.needsConfirmation).toBe(true)
    expect(await service.list('default')).toEqual([])
    const { context } = await prepare(tool, args)
    const result = await tool.execute({ ...args, id: 'changed-after-approval' }, context)
    expect(result.success).toBe(false)
    expect(result.output).toContain('有效确认记录')
    expect(await service.list('default')).toEqual([])
  })

  it('retains the approved legacy manifest/files creation path and exact tool names', async () => {
    const template = templates.getPluginTemplate('json-tool')
    const args = { manifest: template.manifest, files: template.files }
    const tool = createPluginManagementTools(service).find(tool => tool.name === 'plugin_create')!
    const { context, input } = await prepare(tool, args)
    expect(input.manifest).toEqual(args.manifest)
    for (const [name, source] of Object.entries(args.files)) {
      if (name === 'aether-plugin.json') expect(JSON.parse(input.files[name])).toEqual(JSON.parse(source))
      else expect(input.files[name]).toBe(source)
    }
    const result = await tool.execute(args, context)
    expect(result.success, result.output).toBe(true)
    const record = JSON.parse(result.output) as PluginRecord & { toolNameMap: Record<string, string> }
    expect(record.id).toBe(template.manifest.id)
    expect(record.toolNameMap).toEqual({ normalize_text: 'plugin_my_json_tool_normalize_text' })
  })

  it('describes both exclusive input shapes and only known template IDs in the tool schema', () => {
    const tool = createPluginManagementTools(service).find(tool => tool.name === 'plugin_create')!
    const validate = new Ajv({ strict: false }).compile(tool.parameters)
    const legacy = templates.getPluginTemplate('json-tool')
    expect(validate({ templateId: 'currency-converter', id: 'new-currency' })).toBe(true)
    expect(validate({ manifest: legacy.manifest, files: legacy.files })).toBe(true)
    for (const args of [
      {}, { templateId: 'currency-converter' }, { templateId: 'unknown', id: 'new-currency' },
      { templateId: 'currency-converter', id: 'new-currency', files: {} },
      { templateId: 'currency-converter', id: 'new-currency', manifest: {} },
      { manifest: legacy.manifest, files: legacy.files, name: 'mixed' },
    ]) expect(validate(args), JSON.stringify(args)).toBe(false)
    expect(tool.description).toContain('不要复录或重写源码')
    expect(tool.description).toContain('plugin_import_preview')
  })
})

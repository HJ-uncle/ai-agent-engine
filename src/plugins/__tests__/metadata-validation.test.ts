import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../../core/agent-context/types.js'
import { pluginCatalogue, pluginSummary } from '../catalogue.js'
import { createPluginManagementTools } from '../management-tools.js'
import { PluginService, validatePluginId, validatePluginInput } from '../service.js'
import type { CreatePluginInput } from '../types.js'

let root: string, service: PluginService
const ctx = { tenantId: 'default', sessionId: 'plugin-metadata' } as AgentContext
function input(): CreatePluginInput {
  return { manifest: { apiVersion: 1, id: 'currency-converter', name: 'Currency', version: '1.0.0', description: 'Convert explicit rates', runtime: 'node',
    tools: [{ name: 'convert_currency', description: 'Convert', entry: 'main.mjs', inputSchema: { type: 'object', properties: {} } }] },
  files: { 'main.mjs': 'console.log(JSON.stringify({result:1}))' } }
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-metadata-'))
  service = new PluginService(path.join(root, 'plugins'))
  vi.stubEnv('AUTH_ENABLED', 'false')
})
afterEach(() => {
  vi.unstubAllEnvs()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('plugin-metadata-')) throw new Error('Unsafe metadata fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function approved(tool: Tool, args: Record<string, unknown>) {
  const context = { ...ctx, currentToolCallId: 'metadata-' + tool.name }
  const pending = await tool.preflight!(args, context)
  expect(pending?.needsConfirmation, pending?.output).toBe(true)
  Object.assign(context, { approvedToolCallId: context.currentToolCallId,
    resumeToolCall: { toolCall: { id: context.currentToolCallId, name: tool.name, args }, decision: 'approved', pendingAction: pending!.pendingAction } })
  const result = await tool.execute(args, context)
  expect(result.success, result.output).toBe(true)
  return JSON.parse(result.output)
}

describe('actionable plugin validation diagnostics', () => {
  it('explains invalid IDs with the exact manifest field and spelling rule', async () => {
    const authored = input(); authored.manifest.id = 'currency_converter'
    try { validatePluginInput(authored); expect.fail('must reject underscore ID') }
    catch (error) {
      expect(error).toMatchObject({ code: 'PLUGIN_MANIFEST' })
      expect((error as Error).message).toContain('manifest.id:')
      expect((error as Error).message).toContain('不能使用下划线')
      expect((error as Error).message).toContain('currency-converter')
    }
    for (const id of ['currency_converter', 'currency--converter', 'currency-']) {
      expect(() => validatePluginId(id)).toThrow('id:')
      await expect(service.get('default', id)).rejects.toMatchObject({ code: 'PLUGIN_ID', message: expect.stringContaining('currency-converter') })
    }
  })

  it('identifies local tool names and missing entry/schema fields without losing stable codes', () => {
    const authored = input(); authored.manifest.tools[0].name = 'convert-currency'
    expect(() => validatePluginInput(authored)).toThrow('manifest.tools[0].name:')
    expect(() => validatePluginInput(authored)).toThrow('下划线')
    authored.manifest.tools[0].name = 'convert_currency'; authored.manifest.tools[0].entry = 'missing.mjs'
    try { validatePluginInput(authored); expect.fail('must reject missing entry') }
    catch (error) { expect(error).toMatchObject({ code: 'PLUGIN_ENTRY', message: expect.stringContaining('manifest.tools[0].entry:') }) }
    authored.manifest.tools[0].entry = 'main.mjs'; authored.manifest.tools[0].inputSchema = { type: 'object', properties: { code: { type: 'string', pattern: '[A-Z]+' } } }
    try { validatePluginInput(authored); expect.fail('must reject unsupported schema') }
    catch (error) { expect(error).toMatchObject({ code: 'PLUGIN_SCHEMA', message: expect.stringContaining('manifest.tools[0].inputSchema:') }) }
    authored.manifest.tools[0].inputSchema = { type: 'object' }
    expect(() => validatePluginInput({ ...authored, files: { '../escape.mjs': 'bad' } })).toThrow('files["../escape.mjs"]:')
  })

  it('rejects malformed authoring before asking for approval with a useful correction', async () => {
    const tools = createPluginManagementTools(service)
    const authored = input(); authored.manifest.id = 'currency_converter'
    const outcome = await tools.find(tool => tool.name === 'plugin_create')!.preflight!(authored as unknown as Record<string, unknown>, ctx)
    expect(outcome?.success).toBe(false)
    expect(outcome?.needsConfirmation).not.toBe(true)
    expect(outcome?.output).toContain('manifest.id:')
    expect(outcome?.output).toContain('currency-converter')
    expect(await service.list('default')).toEqual([])
    const detail = await tools.find(tool => tool.name === 'plugin_get')!.execute({ id: 'currency_converter' }, ctx)
    expect(detail.success).toBe(false); expect(detail.output).toContain('id:')
  })
})

describe('precise plugin invocation metadata', () => {
  it('returns exact normalized global names without persisting derived metadata', async () => {
    const authored = input(), created = await service.create('default', authored)
    expect(created).toMatchObject({ globalToolNames: ['plugin_currency_converter_convert_currency'],
      toolNameMap: { convert_currency: 'plugin_currency_converter_convert_currency' }, selectionId: null, publishedSelectionId: null })
    expect(created.invocationNote).toContain('发布不会自动')
    expect(created.invocationNote).toContain('plugin_test')
    expect(created.invocationNote).toContain('操作页')
    const recordPath = path.join(service.rootDir, 'tenant-' + createHash('sha256').update('default').digest('hex'), authored.manifest.id, 'record.json')
    const stored = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    expect(stored).not.toHaveProperty('globalToolNames')
    expect(stored).not.toHaveProperty('selectionId')
    expect(pluginSummary(stored)).toMatchObject({ globalToolNames: created.globalToolNames, toolNameMap: created.toolNameMap, selectionId: null })
    expect(pluginSummary(stored)).not.toHaveProperty('files')
    expect((await service.get('default', created.id)).globalToolNames).toEqual(created.globalToolNames)
    expect((await service.list('default'))[0].globalToolNames).toEqual(created.globalToolNames)
  })

  it('does not attach a draft tool map to the previous published selection', async () => {
    const authored = input(); await service.create('default', authored)
    const first = await service.publish('default', authored.manifest.id, 1)
    expect(first.selectionId).toBe('plugin-currency-converter--r1')
    authored.manifest.tools[0].name = 'convert_next'
    const draft = await service.update('default', authored.manifest.id, { ...authored, expectedRevision: 1 })
    expect(draft).toMatchObject({ globalToolNames: ['plugin_currency_converter_convert_next'], selectionId: null,
      publishedSelectionId: 'plugin-currency-converter--r1' })
    const catalogue = (await pluginCatalogue('default', [], service))[0]
    expect(catalogue).toMatchObject({ id: 'plugin-currency-converter--r1', selectionId: 'plugin-currency-converter--r1',
      toolNames: ['plugin_currency_converter_convert_currency'], globalToolNames: ['plugin_currency_converter_convert_currency'],
      toolNameMap: { convert_currency: 'plugin_currency_converter_convert_currency' } })
    const second = await service.publish('default', authored.manifest.id, 2)
    expect(second.selectionId).toBe('plugin-currency-converter--r2')
    expect(second.globalToolNames).toEqual(['plugin_currency_converter_convert_next'])
  })

  it('includes exact metadata in approved create/publish and directory/get responses', async () => {
    const tools = createPluginManagementTools(service), authored = input()
    const created = await approved(tools.find(tool => tool.name === 'plugin_create')!, authored as unknown as Record<string, unknown>)
    expect(created.selectionId).toBeNull()
    expect(created.globalToolNames).toEqual(['plugin_currency_converter_convert_currency'])
    const published = await approved(tools.find(tool => tool.name === 'plugin_publish')!, { id: created.id, expectedRevision: 1 })
    expect(published.selectionId).toBe('plugin-currency-converter--r1')
    const directory = await tools.find(tool => tool.name === 'plugin_list')!.execute({}, ctx)
    expect(JSON.parse(directory.output).plugins[0].selectionId).toBe(published.selectionId)
    const detail = await tools.find(tool => tool.name === 'plugin_get')!.execute({ id: created.id }, ctx)
    expect(JSON.parse(detail.output).toolNameMap).toEqual(created.toolNameMap)
    expect(tools.find(tool => tool.name === 'plugin_publish')!.description).toContain('load_tools')
    expect(tools.find(tool => tool.name === 'plugin_create')!.description).toContain('plugin_import_preview')
  })
})

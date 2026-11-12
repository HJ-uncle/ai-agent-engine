import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/types.js'
import { boundedToolContext } from '../../core/agent-loop/tool-output-limit.js'
import { createPluginManagementTools } from '../management-tools.js'
import { createSelectedPluginTools } from '../catalogue.js'
import { pluginFileChanges, pluginMutationResult } from '../mutation-receipts.js'
import { PluginService } from '../service.js'
import type { CreatePluginInput, PluginRecord } from '../types.js'

const fixtures = path.resolve('.e2e-tmp/plugin-mutation-receipt-tests')
const marker = 'PRIVATE_SOURCE_ONLY_DO_NOT_ECHO_中文'
const ctx = { tenantId: 'default', sessionId: 'mutation-receipts', toolProfile: 'general' } as AgentContext
let root: string, service: PluginService
function project(): CreatePluginInput {
  const manifest: CreatePluginInput['manifest'] = { apiVersion: 1, id: 'receipt-fixture', name: '审批回执', version: '1.0.0', description: 'Large source approval fixture', runtime: 'node',
    tools: [{ name: 'answer', description: 'Answer', entry: 'main.mjs', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
  return { manifest, files: { 'main.mjs': `console.log(JSON.stringify({ result: { value: 7 } }));\n${('// ' + marker + '\n').repeat(12000)}`,
    'keep.txt': 'untouched\n', 'obsolete.txt': 'obsolete\n', 'aether-plugin.json': JSON.stringify(manifest, null, 2) + '\n' } }
}
beforeEach(() => {
  fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-')); service = new PluginService(path.join(root, 'plugins'))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000'); vi.stubEnv('OSM_MODE', 'off')
})
function removeOwned(directory: string): void {
  const relative = path.relative(root, directory)
  if (relative !== '' && (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep))) throw new Error('Unsafe receipt test cleanup')
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Refusing linked receipt test cleanup')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing linked receipt test cleanup')
    if (entry.isDirectory()) removeOwned(file); else fs.unlinkSync(file)
  }
  if (fs.readdirSync(directory).length) throw new Error('Receipt directory is not empty')
  fs.rmdirSync(directory)
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-')) throw new Error('Unsafe receipt fixture root')
  removeOwned(root)
  if (fs.existsSync(fixtures) && !fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
function tool(name: string): Tool { return createPluginManagementTools(service).find(item => item.name === name)! }
async function prepare(name: string, args: Record<string, unknown>, context = ctx) {
  const current = { ...context, currentToolCallId: name + '-call' }
  const pending = await tool(name).preflight!(args, current)
  expect(pending?.needsConfirmation, pending?.output).toBe(true)
  // Persist the exact operation and rebuild the tool, as an approval resumed after restart does.
  const stored = path.join(root, name + '-pending.json'); fs.writeFileSync(stored, JSON.stringify(pending!.pendingAction))
  const pendingAction = JSON.parse(fs.readFileSync(stored, 'utf8')) as NonNullable<ToolResult['pendingAction']>
  const approved = { ...current, approvedToolCallId: current.currentToolCallId,
    resumeToolCall: { toolCall: { id: current.currentToolCallId, name, args: structuredClone(args) }, decision: 'approved', pendingAction } } as AgentContext
  return { pending: pending!, operation: pendingAction.operation as { input: CreatePluginInput; preview: Record<string, any> }, approved,
    apply: () => tool(name).execute(args, approved) }
}
async function mutate(name: string, args: Record<string, unknown>) { return (await prepare(name, args)).apply() }
function noSource(result: ToolResult) {
  expect(result.success, result.output).toBe(true); expect(result.output.length).toBeLessThanOrEqual(4000)
  expect(result.output).not.toContain(marker)
  const value = JSON.parse(result.output); expect(value).not.toHaveProperty('files'); expect(value).not.toHaveProperty('manifest'); expect(value).not.toHaveProperty('revisions')
  return value
}

describe('compact approved plugin mutation receipts', () => {
  it('persists and resumes exact large create source while preview and result contain only bounded metadata', async () => {
    const input = project(), { pending, operation, apply } = await prepare('plugin_create', input as unknown as Record<string, unknown>)
    expect(Buffer.byteLength(pending.output) + 128).toBeLessThanOrEqual(4000); expect(pending.output).not.toContain(marker)
    expect(operation.input.files['main.mjs']).toBe(input.files['main.mjs']); expect(operation.input).not.toHaveProperty('preview')
    expect(operation.preview).toMatchObject({ action: 'plugin_create', id: input.manifest.id, changes: { added: 4, modified: 0, deleted: 0 }, fileListComplete: true })
    const main = operation.preview.files.find((file: { path: string }) => file.path === 'main.mjs')
    expect(main).toEqual({ path: 'main.mjs', change: 'added', after: { bytes: Buffer.byteLength(input.files['main.mjs']), sha256: createHash('sha256').update(input.files['main.mjs']).digest('hex') } })
    expect(await service.list('default')).toEqual([])
    const result = await apply(), receipt = noSource(result), saved = await service.get('default', input.manifest.id)
    expect(saved.files['main.mjs']).toBe(input.files['main.mjs'])
    expect(receipt).toMatchObject({ id: saved.id, revision: 1, hash: saved.revisions[0].hash, enabled: false, publishedRevision: null,
      selectionId: null, toolNamesComplete: true, globalToolNames: ['plugin_receipt_fixture_answer'], toolNameMap: { answer: 'plugin_receipt_fixture_answer' } })
    expect(result.metadata?.resourceChange).toEqual({ kind: 'plugin', action: 'create', id: saved.id })
  })

  it('previews the actual resolved merge diff, preserves untouched source, and applies the sealed snapshot after restart', async () => {
    const created = await service.create('default', project())
    const input = { id: created.id, expectedRevision: created.revision, fileMode: 'merge', files: { 'new.txt': 'new内容', 'main.mjs': created.files['main.mjs'] + '// changed\n' }, deleteFiles: ['obsolete.txt'] }
    const { operation, pending, apply } = await prepare('plugin_update', input)
    expect(Buffer.byteLength(pending.output) + 128).toBeLessThanOrEqual(4000); expect(pending.output).not.toContain(marker)
    expect(operation.preview).toMatchObject({ changes: { added: 1, modified: 1, deleted: 1 }, changedFileCount: 3, fileListComplete: true, omittedFileChanges: 0 })
    expect(operation.preview.files.map(({ path, change }: { path: string; change: string }) => ({ path, change }))).toEqual([
      { path: 'main.mjs', change: 'modified' }, { path: 'new.txt', change: 'added' }, { path: 'obsolete.txt', change: 'deleted' }])
    expect(operation.input.files['keep.txt']).toBe(created.files['keep.txt']); expect(operation.input.files).not.toHaveProperty('obsolete.txt'); expect(operation.input).not.toHaveProperty('fileMode')
    const receipt = noSource(await apply()), saved = await service.get('default', created.id)
    expect(saved.files).toEqual(operation.input.files); expect(receipt).toMatchObject({ id: saved.id, revision: 2, hash: saved.revisions[1].hash })
  })

  it('discloses omitted preview rows and accurate full change counts without leaking source', async () => {
    const input = project()
    for (let index = 0; index < 80; index++) input.files[`docs/${index.toString().padStart(2, '0')}-说明.txt`] = marker + index
    const { operation, pending } = await prepare('plugin_create', input as unknown as Record<string, unknown>, { ...ctx, toolProfile: 'code' })
    expect(Buffer.byteLength(pending.output) + 128).toBeLessThanOrEqual(4000); expect(pending.output).not.toContain(marker)
    expect(operation.preview).toMatchObject({ changes: { added: 84, modified: 0, deleted: 0 }, changedFileCount: 84, fileCount: 84, fileListComplete: false })
    expect(operation.preview.files.length + operation.preview.omittedFileChanges).toBe(84)
    expect(Object.keys(operation.input.files)).toHaveLength(84)
  })

  it('keeps publishing, published selection, runtime behavior and enabled state accurate', async () => {
    const created = await service.create('default', project())
    const published = noSource(await mutate('plugin_publish', { id: created.id, expectedRevision: 1 }))
    expect(published).toMatchObject({ enabled: true, revision: 1, publishedRevision: 1, selectionId: 'plugin-receipt-fixture--r1' })
    const selected = await createSelectedPluginTools('default', [published.selectionId], [], service)
    const output = await selected[0].execute({}, ctx)
    expect(output.success, output.output).toBe(true); expect(JSON.parse(output.output).result).toEqual({ value: 7 })
    const disabled = noSource(await mutate('plugin_set_enabled', { id: created.id, enabled: false }))
    expect(disabled).toMatchObject({ id: created.id, enabled: false, publishedRevision: 1, selectionId: published.selectionId, hash: published.hash })
    await expect(createSelectedPluginTools('default', [published.selectionId], [], service)).rejects.toThrow('停用')
    const enabled = noSource(await mutate('plugin_set_enabled', { id: created.id, enabled: true }))
    expect(enabled).toMatchObject({ id: created.id, enabled: true, selectionId: published.selectionId })
  })

  it('keeps a newer draft unselected while preserving the prior published selection', async () => {
    const created = await service.create('default', project()); await service.publish('default', created.id, 1)
    const updated = noSource(await mutate('plugin_update', { id: created.id, expectedRevision: 1, fileMode: 'merge', files: { 'keep.txt': 'updated' } }))
    expect(updated).toMatchObject({ revision: 2, publishedRevision: 1, selectionId: null, publishedSelectionId: 'plugin-receipt-fixture--r1' })
  })

  it('installs a real local import with compact result and unchanged imported bytes', async () => {
    const input = project(), directory = path.join(root, 'import-project'); fs.mkdirSync(directory)
    for (const [file, content] of Object.entries(input.files)) fs.writeFileSync(path.join(directory, file), content)
    fs.writeFileSync(path.join(directory, 'aether-plugin.json'), JSON.stringify(input.manifest))
    const preview = await tool('plugin_import_preview').execute({ type: 'local', path: directory }, ctx)
    expect(preview.success, preview.output).toBe(true)
    const { pending, apply } = await prepare('plugin_import_install', { jobId: JSON.parse(preview.output).jobId })
    expect(Buffer.byteLength(pending.output)).toBeLessThanOrEqual(4000); expect(pending.output).not.toContain(marker)
    expect(pending.pendingAction).toHaveProperty('operation.source', { type: 'local', format: 'native', path: directory, importJobId: JSON.parse(preview.output).jobId })
    expect(pending.pendingAction).not.toHaveProperty('operation.preview')
    const receipt = noSource(await apply()), saved = await service.get('default', input.manifest.id)
    expect(saved.files['main.mjs']).toBe(input.files['main.mjs']); expect(receipt).toMatchObject({ id: saved.id, revision: 1, hash: saved.revisions[0].hash, selectionId: null })
  })

  it('returns discoverable paged metadata when exact tool maps exceed this invocation budget', async () => {
    const input = project()
    input.manifest.tools = Array.from({ length: 32 }, (_, index) => ({ ...input.manifest.tools[0], name: `operation_${index.toString().padStart(2, '0')}_with_long_name` }))
    const record = await service.create('default', input), limited = boundedToolContext(ctx, 600)
    const result = pluginMutationResult('plugin_create', record, limited), receipt = JSON.parse(result.output)
    expect(result.success).toBe(true); expect(result.output.length).toBeLessThanOrEqual(600)
    expect(receipt).toMatchObject({ id: record.id, revision: 1, toolNamesComplete: false, read: { tool: 'plugin_get', args: { id: record.id, section: 'metadata', revision: 1 } } })
    let offset = 0, content = ''
    do {
      const page = await tool('plugin_get').execute({ ...receipt.read.args, offset }, limited)
      expect(page.success, page.output).toBe(true); expect(page.output.length).toBeLessThanOrEqual(600)
      const value = JSON.parse(page.output); content += value.content; offset = value.nextOffset
    } while (offset !== null)
    const metadata = JSON.parse(content)
    expect(metadata.toolNameMap).toEqual(record.toolNameMap); expect(metadata.globalToolNames).toEqual(record.globalToolNames)
  })

  it.each([1, 2, 20, 100, 300, 1000, 4000])('never cuts mutation receipt JSON at a %i character allowance', async allowance => {
    const record = await service.create('default', project()), result = pluginMutationResult('plugin_update', record, boundedToolContext(ctx, allowance))
    expect(result.success).toBe(true); expect(result.output.length).toBeLessThanOrEqual(allowance); expect(() => JSON.parse(result.output)).not.toThrow()
    expect(result.metadata).toHaveProperty('pluginMutation.read.args', { id: record.id, section: 'metadata', revision: record.revision })
  })

  it('treats filename case changes as delete/add and measures UTF-8 rather than UTF-16', () => {
    expect(pluginFileChanges({ 'Keep.txt': 'same', 'old.txt': '前' }, { 'keep.txt': 'same', 'old.txt': '后😊' })).toMatchObject([
      { path: 'Keep.txt', change: 'deleted', before: { bytes: 4 } }, { path: 'keep.txt', change: 'added', after: { bytes: 4 } },
      { path: 'old.txt', change: 'modified', before: { bytes: 3 }, after: { bytes: 7 } }])
  })
})

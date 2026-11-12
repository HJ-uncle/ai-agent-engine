import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/types.js'
import { createPluginManagementTools } from '../management-tools.js'
import { runPlugin } from '../runtime.js'
import { PluginService } from '../service.js'
import { resolvePluginUpdateInput, type ResolvedPluginUpdateInput } from '../update-input.js'
import type { CreatePluginInput, PluginRecord } from '../types.js'

const fixtures = path.resolve('.e2e-tmp/plugin-update-merge-tests')
const ctx = { tenantId: 'default', sessionId: 'update-merge-test' } as AgentContext
let root: string, service: PluginService, record: PluginRecord, tool: Tool

function fixture(): CreatePluginInput {
  const manifest: CreatePluginInput['manifest'] = { apiVersion: 1, id: 'merge-fixture', name: 'Merge fixture', version: '1.0.0', description: 'Incremental editing fixture', runtime: 'node',
    tools: [{ name: 'answer', description: 'Returns a value from a retained module', entry: 'main.mjs', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
  return { manifest, files: {
    'main.mjs': 'import { value } from "./lib/value.mjs"; console.log(JSON.stringify({ result: { value } }));\n',
    'lib/value.mjs': 'export const value = 1;\n', 'README.md': '# Keep this documentation\n', 'obsolete.txt': 'remove only when explicitly requested\n',
    'aether-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
  } }
}

beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  service = new PluginService(path.join(root, 'plugins'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  record = await service.create(ctx.tenantId, fixture())
  tool = createPluginManagementTools(service).find(item => item.name === 'plugin_update')!
})

function removeOwnedDirectory(directory: string): void {
  const relative = path.relative(root, directory)
  if (relative !== '' && (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep))) throw new Error('Unsafe merge test cleanup')
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Refusing linked merge fixture cleanup')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing linked merge fixture cleanup')
    if (entry.isDirectory()) removeOwnedDirectory(file)
    else fs.unlinkSync(file)
  }
  if (fs.readdirSync(directory).length !== 0) throw new Error('Merge fixture is no longer empty')
  fs.rmdirSync(directory)
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (!root || path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-')) throw new Error('Unsafe merge fixture root')
  removeOwnedDirectory(root)
  if (fs.existsSync(fixtures) && fs.readdirSync(fixtures).length === 0) fs.rmdirSync(fixtures)
})

function args(edits: Record<string, unknown> = { 'lib/value.mjs': 'export const value = 42;\n' }): Record<string, unknown> {
  return { id: record.id, expectedRevision: record.revision, fileMode: 'merge', files: edits }
}
async function approve(raw: Record<string, unknown>) {
  const context = { ...ctx, currentToolCallId: 'incremental-edit-call' }
  const pending = await tool.preflight!(raw, context)
  expect(pending?.needsConfirmation, pending?.output).toBe(true)
  // JSON round-trip models a persisted approval resumed after a process restart.
  const pendingAction = JSON.parse(JSON.stringify(pending!.pendingAction)) as NonNullable<ToolResult['pendingAction']>
  Object.assign(context, { approvedToolCallId: context.currentToolCallId,
    resumeToolCall: { toolCall: { id: context.currentToolCallId, name: tool.name, args: structuredClone(raw) }, decision: 'approved', pendingAction } })
  return { context, input: (pendingAction.operation as { input: ResolvedPluginUpdateInput }).input }
}
async function rejected(raw: Record<string, unknown>, reason: string) {
  const result = await tool.preflight!(raw, ctx)
  expect(result?.success).toBe(false)
  expect(result?.needsConfirmation).not.toBe(true)
  expect(result?.output).toContain(reason)
  expect((await service.get(ctx.tenantId, record.id)).revision).toBe(record.revision)
}

describe('approved incremental plugin edits', () => {
  it('seals a validated full source revision, retains untouched files and runs the approved code', async () => {
    await service.publish(ctx.tenantId, record.id, record.revision)
    const raw = { ...args(), deleteFiles: ['obsolete.txt'] }
    const { context, input } = await approve(raw)
    expect(input).toEqual({ id: record.id, expectedRevision: 1, manifest: record.manifest,
      files: { 'main.mjs': record.files['main.mjs'], 'lib/value.mjs': 'export const value = 42;\n', 'README.md': record.files['README.md'], 'aether-plugin.json': record.files['aether-plugin.json'] } })
    expect(input).not.toHaveProperty('fileMode'); expect(input).not.toHaveProperty('deleteFiles')
    expect((await service.get(ctx.tenantId, record.id)).revision).toBe(1)
    const resumed = createPluginManagementTools(service).find(item => item.name === 'plugin_update')!
    const result = await resumed.execute(raw, context)
    expect(result.success, result.output).toBe(true)
    const updated = await service.get(ctx.tenantId, record.id)
    expect(updated.revision).toBe(2); expect(updated.files).toEqual(input.files); expect(updated.publishedRevision).toBe(1)
    const draft = await runPlugin(await service.snapshot(ctx.tenantId, record.id, 2, { allowDraft: true }), 'answer', {})
    expect(draft.result).toEqual({ value: 42 })
    const published = await runPlugin(await service.snapshot(ctx.tenantId, record.id, 1), 'answer', {})
    expect(published.result).toEqual({ value: 1 })
    expect(result.metadata?.resourceChange).toEqual({ kind: 'plugin', action: 'update', id: record.id })
  })

  it('does not merge a newly read source map when applying the sealed approval', async () => {
    const raw = args(), { context, input } = await approve(raw)
    const currentRecord = await service.get(ctx.tenantId, record.id)
    const get = vi.spyOn(service, 'get').mockResolvedValue({ ...currentRecord, files: { ...record.files, 'README.md': 'not approved', 'surprise.txt': 'not approved' } })
    const result = await createPluginManagementTools(service).find(item => item.name === 'plugin_update')!.execute(raw, context)
    expect(result.success, result.output).toBe(true)
    expect(get).toHaveBeenCalledTimes(1) // Only the existing approval metadata check; source is never merged again.
    get.mockRestore()
    const current = await service.get(ctx.tenantId, record.id)
    expect(current.files).toEqual(input.files)
    expect(current.files['README.md']).toBe('# Keep this documentation\n')
    expect(current.files).not.toHaveProperty('surprise.txt')
  })

  it('requires an actual approval and rejects changed arguments on resume', async () => {
    const raw = args()
    expect((await tool.execute(raw, ctx)).needsConfirmation).toBe(true)
    expect((await service.get(ctx.tenantId, record.id)).revision).toBe(1)
    const { context } = await approve(raw)
    const rejected = await tool.execute({ ...raw, files: { 'lib/value.mjs': 'export const value = 99' } }, context)
    expect(rejected.success).toBe(false); expect(rejected.output).toContain('有效确认记录')
    expect((await service.get(ctx.tenantId, record.id)).revision).toBe(1)
  })

  it('checks the current revision before resolving or validating an edit', async () => {
    await rejected({ ...args({ '../invalid.mjs': 7 }), expectedRevision: 2 }, '版本已变化')
    expect(() => resolvePluginUpdateInput({ ...args(), expectedRevision: 2 }, record)).toThrow('版本已变化')
  })

  it('rejects a concurrent real revision created while approval was pending', async () => {
    const raw = args(), { context } = await approve(raw)
    const concurrent = await service.update(ctx.tenantId, record.id, { manifest: record.manifest, files: { ...record.files, 'README.md': 'Concurrent author\n' }, expectedRevision: 1 })
    const result = await tool.execute(raw, context)
    expect(result.success).toBe(false); expect(result.output).toContain('批准期间插件已变化')
    const current = await service.get(ctx.tenantId, record.id)
    expect(current.revision).toBe(2); expect(current.files).toEqual(concurrent.files); expect(current.files['lib/value.mjs']).toBe(record.files['lib/value.mjs'])
  })

  it('rejects a metadata change at the same revision while approval was pending', async () => {
    const raw = args(), { context } = await approve(raw)
    vi.spyOn(Date, 'now').mockReturnValue(record.updatedAt + 1000)
    await service.publish(ctx.tenantId, record.id, 1)
    const result = await tool.execute(raw, context)
    expect(result.success).toBe(false); expect(result.output).toContain('批准期间插件已变化')
    expect((await service.get(ctx.tenantId, record.id)).revision).toBe(1)
  })

  it('retains default full replacement semantics and removes omitted files', async () => {
    const full = { id: record.id, expectedRevision: 1, manifest: record.manifest, files: { 'main.mjs': 'console.log(JSON.stringify({result:9}))' } }
    const { context } = await approve(full), result = await tool.execute(full, context)
    expect(result.success, result.output).toBe(true)
    expect((await service.get(ctx.tenantId, record.id)).files).toEqual(full.files)
  })

  it('allows manifest-only merge edits and synchronizes the manifest project file', async () => {
    const manifest = { ...record.manifest, name: 'Updated label', version: '1.0.1' }
    const raw = { ...args({}), manifest }, { context, input } = await approve(raw)
    expect(input.files['main.mjs']).toBe(record.files['main.mjs'])
    expect(JSON.parse(input.files['aether-plugin.json'])).toEqual(manifest)
    const result = await tool.execute(raw, context)
    expect(result.success, result.output).toBe(true)
    expect((await service.get(ctx.tenantId, record.id)).manifest).toEqual(manifest)
  })

  it('allows explicit deletion-only merge when the remaining full project is valid', async () => {
    const raw = { ...args({}), deleteFiles: ['obsolete.txt'] }, { context } = await approve(raw)
    const result = await tool.execute(raw, context)
    expect(result.success, result.output).toBe(true)
    const current = await service.get(ctx.tenantId, record.id)
    expect(current.files).not.toHaveProperty('obsolete.txt'); expect(current.files['main.mjs']).toBe(record.files['main.mjs'])
  })
})

describe('incremental edit input boundaries', () => {
  it.each([
    [{}, '没有实际变更'],
    [{ deleteFiles: [] }, '没有实际变更'],
    [{ files: { 'README.md': '# Keep this documentation\n' } }, '没有实际变更'],
    [{ fileMode: 'replace' }, 'manifest: replace'],
    [{ fileMode: undefined }, 'manifest: replace'],
    [{ fileMode: 'unknown' }, 'Invalid enum value'],
    [{ files: null }, 'files:'],
    [{ files: [] }, 'files:'],
    [{ files: { 'README.md': 4 } }, '源码字符串'],
    [{ files: { 'README.md': 'new', 'readme.md': 'other' } }, '大小写冲突'],
    [{ files: { 'README.md': 'new' }, deleteFiles: ['readme.md'] }, '同时删除和写入'],
    [{ deleteFiles: ['obsolete.txt', 'obsolete.txt'] }, '重复删除'],
    [{ deleteFiles: ['not-existing.txt'] }, '不存在'],
    [{ deleteFiles: ['main.mjs'] }, '已有的 .mjs 文件'],
    [{ files: { '../escape.mjs': 'bad' } }, '目录穿越'],
    [{ files: { 'CON.txt': 'bad' } }, '保留名称'],
    [{ files: { 'lib\\escape.mjs': 'bad' } }, '安全的相对路径'],
    [{ deleteFiles: ['../escape.mjs'] }, '目录穿越'],
  ])('rejects malformed or ineffective merge before approval: %j', async (change, reason) => {
    await rejected({ ...args({}), ...change }, reason)
  })

  it('requires files even for manifest-only edits and prohibits deleteFiles on replacement', async () => {
    const { files: _files, ...missingFiles } = args()
    await rejected(missingFiles, 'files:')
    await rejected({ id: record.id, expectedRevision: 1, manifest: record.manifest, files: record.files, deleteFiles: [] }, 'deleteFiles 仅可用于')
    await rejected({ id: record.id, expectedRevision: 1, manifest: record.manifest, files: record.files, fileMode: 'replace', deleteFiles: ['obsolete.txt'] }, 'deleteFiles 仅可用于')
  })

  it('validates the resolved whole project instead of validating only changed files', async () => {
    await rejected({ ...args({}), manifest: { ...record.manifest, id: 'other-id' } }, '编辑不能改变插件 ID')
    await rejected({ ...args({ 'readme.md': 'different casing' }) }, '大小写冲突')
    await rejected({ ...args({}), manifest: { ...record.manifest, contributes: { pages: [{ id: 'page', title: 'Missing page', kind: 'webview', entry: 'ui/missing.html', tools: [] }] } } }, 'files 中缺少')
    await rejected(args({ 'large.txt': 'x'.repeat(1024 * 1024 + 1) }), '1 MiB')
  })

  it('exposes explicit merge and replacement documentation without changing service inputs', () => {
    expect(tool.parameters.required).toEqual(['id', 'files', 'expectedRevision'])
    expect(tool.parameters.properties?.fileMode.enum).toEqual(['replace', 'merge'])
    expect(tool.description).toContain('默认 fileMode:"replace"')
    expect(tool.description).toContain('manifest 可省略')
    expect(tool.parameters.properties?.deleteFiles.description).toContain('仅merge可用')
    const input = resolvePluginUpdateInput(args(), record)
    expect(Object.keys(input).sort()).toEqual(['expectedRevision', 'files', 'id', 'manifest'])
  })
})

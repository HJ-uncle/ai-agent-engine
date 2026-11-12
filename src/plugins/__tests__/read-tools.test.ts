import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/types.js'
import { boundedToolContext, getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { truncateToolOutput } from '../../core/agent-loop/react.js'
import { ToolRegistry } from '../../core/tool-registry/registry.js'
import { createPluginManagementTools } from '../management-tools.js'
import { PluginService } from '../service.js'
import { getPluginTemplate, PLUGIN_TEMPLATE_PROTOCOL } from '../templates.js'
import { PLUGIN_CONTRIBUTION_CATALOGUE } from '../contributions.js'
import type { CreatePluginInput } from '../types.js'

const scratch = path.resolve('.e2e-tmp/plugin-read-pagination')
let root: string, service: PluginService, tools: Tool[], ctx: AgentContext
beforeEach(() => {
  fs.mkdirSync(scratch, { recursive: true }); root = fs.mkdtempSync(path.join(scratch, 'run-'))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('OSM_MODE', 'off'); vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000')
  service = new PluginService(path.join(root, 'plugins')); tools = createPluginManagementTools(service)
  ctx = { tenantId: 'read-a', sessionId: 'read-pagination', toolProfile: 'general' } as AgentContext
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(path.resolve(root)) !== scratch || !path.basename(root).startsWith('run-') || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe pagination fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 })
})

function input(large = true): CreatePluginInput {
  return { manifest: { apiVersion: 1, id: 'read-fixture', name: '分页验证', version: '1.0.0', description: '源码读取', runtime: 'node',
    tools: Array.from({ length: large ? 4 : 1 }, (_, index) => ({ name: 'run_' + index, description: large ? '边界描述'.repeat(700) : 'Run', entry: 'main.mjs', inputSchema: { type: 'object' } })) },
  files: { 'main.mjs': 'console.log(JSON.stringify({result:1}))\n',
    ...(large ? { 'lib/large.mjs': '// 中文🙂 quoted " slash \\ tab\t\n'.repeat(900) + '// __SUBAGENT_META__\n', 'notes.txt': '🙂'.repeat(80) + '\n"\\\t'.repeat(40) + '\u0001' } : {}) } }
}
function receipt(result: ToolResult, context = ctx): any {
  const limit = getToolOutputLimit(context.toolProfile, context)
  expect(result.output.length).toBeLessThanOrEqual(limit)
  // This is the same exported truncation function used to append tool results
  // into ReAct history, not a test reimplementation or a larger budget.
  const persisted = truncateToolOutput(result.output, limit)
  expect(persisted).toBe(result.output)
  return JSON.parse(persisted)
}
async function read(name: string, args: Record<string, unknown>, context = ctx) {
  return tools.find(tool => tool.name === name)!.execute(args, context)
}
async function collect(name: string, args: Record<string, unknown>, context = ctx): Promise<{ text: string; pages: number; revision: number | string }> {
  let text = '', offset = 0, revision: number | string | undefined, pages = 0
  do {
    const result = await read(name, { ...args, offset, ...(revision === undefined ? {} : { revision }) }, context)
    expect(result.success, result.output).toBe(true)
    const page = receipt(result, context)
    expect(page.offset).toBe(offset); expect(page.content).toBeTypeOf('string')
    if (revision !== undefined) expect(page.revision).toBe(revision)
    revision = page.revision; text += page.content; pages++
    expect(text.length).toBe(offset + page.content.length)
    expect(pages).toBeLessThan(1000)
    if (page.nextOffset === null) { expect(text.length).toBe(page.totalChars); break }
    expect(page.nextOffset).toBeGreaterThan(offset)
    expect(page.nextOffset).toBe(text.length); offset = page.nextOffset
  } while (true)
  return { text, pages, revision: revision! }
}

describe('bounded plugin management reads through the ReAct output cap', () => {
  it('returns a compact directory and losslessly reconstructs large source with escapes and Unicode', async () => {
    const source = input(), created = await service.create(ctx.tenantId, source)
    const registry = new ToolRegistry(); tools.forEach(tool => registry.register(tool))
    const overview = receipt(await registry.execute('plugin_get', { id: created.id }, ctx))
    expect(overview.mode).toBe('overview'); expect(overview.revision).toBe(1)
    expect(overview.sections).toContain('manifest'); expect(overview.sections).toContain('file')
    expect(overview.files.some((file: { file: string }) => file.file === 'lib/large.mjs')).toBe(true)
    const page = await collect('plugin_get', { id: created.id, file: 'lib/large.mjs' })
    expect(page.pages).toBeGreaterThan(4); expect(page.text).toBe(source.files['lib/large.mjs'])
    const marker = await read('plugin_get', { id: created.id, file: 'lib/large.mjs', offset: source.files['lib/large.mjs'].indexOf('__SUBAGENT_META__'), revision: 1 })
    expect(marker.output).not.toContain('__SUBAGENT_META__')
    expect(receipt(marker).content).toContain('__SUBAGENT_META__')
  })

  it('reconstructs the exact manifest JSON and accurate invocation metadata', async () => {
    const created = await service.create(ctx.tenantId, input())
    const manifest = await collect('plugin_get', { id: created.id, section: 'manifest' })
    expect(manifest.pages).toBeGreaterThan(1)
    expect(manifest.text).toBe(JSON.stringify(created.manifest))
    const metadata = JSON.parse((await collect('plugin_get', { id: created.id, section: 'metadata' })).text)
    expect(metadata.toolNameMap).toEqual(created.toolNameMap)
    expect(metadata.selectionId).toBeNull(); expect(metadata).not.toHaveProperty('files')
    const files = JSON.parse((await collect('plugin_get', { id: created.id, section: 'files' })).text)
    expect(files.find((file: { file: string }) => file.file === 'lib/large.mjs').totalChars).toBe(created.files['lib/large.mjs'].length)
  })

  it('preserves the full legacy response for genuinely small plugin records', async () => {
    const created = await service.create(ctx.tenantId, input(false))
    const result = await read('plugin_get', { id: created.id })
    expect(receipt(result)).toEqual(await service.get(ctx.tenantId, created.id))
  })

  it('uses the scoped 480-character allowance including JSON escaping, without splitting emoji', async () => {
    const created = await service.create(ctx.tenantId, input()), context = boundedToolContext(ctx, 480)
    const source = await collect('plugin_get', { id: created.id, file: 'notes.txt', maxChars: 1000 }, context)
    expect(source.pages).toBeGreaterThan(1); expect(source.text).toBe(created.files['notes.txt'])
    const first = receipt(await read('plugin_get', { id: created.id, file: 'notes.txt', maxChars: 3 }, context), context)
    expect(first.content).toBe('🙂'); expect(first.nextOffset).toBe(2)
  })

  it.each([1, 4, 30, 90])('returns a valid bounded JSON error at an unusable budget of %i', async limit => {
    const context = boundedToolContext(ctx, limit)
    const result = await read('plugin_get_template', { id: 'desktop-timer', file: 'ui/index.html' }, context)
    expect(result.success).toBe(false); receipt(result, context)
    expect(result.error).toContain('预算'); expect(result.metadata?.code).toBe('PLUGIN_READ_BUDGET_TOO_SMALL')
  })

  it('requires a revision on continuation and rejects a changed plugin before mixing pages', async () => {
    const created = await service.create(ctx.tenantId, input())
    const page = receipt(await read('plugin_get', { id: created.id, file: 'lib/large.mjs', maxChars: 25 }))
    const missing = await read('plugin_get', { id: created.id, file: 'lib/large.mjs', offset: page.nextOffset })
    expect(missing.success).toBe(false); expect(receipt(missing).error.code).toBe('PLUGIN_READ_REVISION_REQUIRED')
    await service.update(ctx.tenantId, created.id, { ...input(), files: { ...created.files, 'lib/large.mjs': 'changed' }, expectedRevision: 1 })
    const changed = await read('plugin_get', { id: created.id, file: 'lib/large.mjs', offset: page.nextOffset, revision: page.revision })
    expect(changed.success).toBe(false); expect(receipt(changed).error.code).toBe('PLUGIN_READ_REVISION_CHANGED')
  })

  it('rejects nonexistent files, traversal, invalid sections/arguments and bad offsets as JSON', async () => {
    const created = await service.create(ctx.tenantId, input())
    for (const args of [{ file: 'missing.mjs' }, { file: '../outside.mjs' }, { file: '__proto__' }, { section: 'unknown' },
      { file: 'notes.txt', offset: 1, revision: 1 }, { file: 'notes.txt', offset: 999999, revision: 1 }, { file: 'notes.txt', offset: -1 },
      { section: 'manifest', file: 'main.mjs' }, { file: 'main.mjs', protocol: 'ui' }, { file: 'main.mjs', extra: true }]) {
      const result = await read('plugin_get', { id: created.id, ...args })
      expect(result.success, JSON.stringify(args)).toBe(false); expect(receipt(result).error).toBeTruthy()
    }
  })

  it('enforces tenant identities and parent-agent restrictions on each paged read', async () => {
    await service.create('read-a', input()); const other = input(); other.files['notes.txt'] = 'tenant-b-only'; await service.create('read-b', other)
    const result = await read('plugin_get', { id: 'read-fixture', file: 'notes.txt' }, { ...ctx, tenantId: 'read-b' })
    expect(receipt(result).content).toBe('tenant-b-only')
    const hidden = await read('plugin_get', { id: 'read-fixture', file: 'notes.txt' }, { ...ctx, tenantId: 'read-c' })
    expect(hidden.success).toBe(false); expect(receipt(hidden).error.code).toBe('PLUGIN_NOT_FOUND')
    const mismatch = await read('plugin_get', { id: 'read-fixture', file: 'notes.txt' }, { ...ctx, managementPrincipal: { tenantId: 'read-b', method: 'jwt', roles: ['admin'] } })
    expect(mismatch.success).toBe(false); expect(receipt(mismatch).error.code).toBe('PLUGIN_FORBIDDEN')
    expect((await read('plugin_get_template', { protocol: 'uiBridge' }, { ...ctx, parentSessionId: 'main' })).success).toBe(false)
    vi.stubEnv('AUTH_ENABLED', 'true')
    expect((await read('plugin_get', { id: 'read-fixture', file: 'notes.txt' })).success).toBe(false)
  })

  it.each(['uiBridge', 'uiTheme', 'download'] as const)('reads the complete %s protocol independently under a small budget', async protocol => {
    const context = boundedToolContext(ctx, 480)
    const value = await collect('plugin_get_template', { section: 'protocol', protocol }, context)
    expect(value.text).toBe(PLUGIN_TEMPLATE_PROTOCOL[protocol]); expect(value.revision).toMatch(/^sha256:/)
    expect(receipt(await read('plugin_get_template', { id: 'desktop-timer' })).sections).toContain('protocol')
  })

  it('paginates real templates, source and contributions; hashes the complete protocol and catalogue', async () => {
    const overview = receipt(await read('plugin_get_template', {}))
    expect(overview.mode).toBe('overview'); expect(overview.templateCount).toBeGreaterThan(0)
    expect(overview.protocolFields).toContain('download')
    const source = await collect('plugin_get_template', { id: 'desktop-timer', file: 'ui/index.html' })
    expect(source.text).toBe(getPluginTemplate('desktop-timer').files['ui/index.html'])
    const template = getPluginTemplate('desktop-timer')
    expect(template.protocol).toEqual(PLUGIN_TEMPLATE_PROTOCOL); expect(template.contributions).toEqual(PLUGIN_CONTRIBUTION_CATALOGUE)
    expect(source.revision).toBe('sha256:' + createHash('sha256').update(JSON.stringify({ template })).digest('hex'))
    const manifest = await collect('plugin_get_template', { id: 'desktop-timer', section: 'manifest' })
    expect(JSON.parse(manifest.text)).toEqual(template.manifest)
    const catalogue = await collect('plugin_get_template', { section: 'contributions' })
    expect(JSON.parse(catalogue.text)).toEqual(PLUGIN_CONTRIBUTION_CATALOGUE)
    const stale = await read('plugin_get_template', { id: 'desktop-timer', file: 'ui/index.html', offset: 10, revision: 'sha256:old' })
    expect(stale.success).toBe(false); expect(receipt(stale).error.code).toBe('PLUGIN_READ_REVISION_CHANGED')
  })
})

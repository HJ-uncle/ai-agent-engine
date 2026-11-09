import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../agent-context/types.js'
import { workspaceManager } from '../../workspace/index.js'
import { canonicalFilePathSync } from '../../shared/file-version.js'
import { prepareCodegraphRequestContext } from '../codegraph-prompt.js'

const sdk = vi.hoisted(() => ({ isInitialized: vi.fn(), openSync: vi.fn(), init: vi.fn(), recreate: vi.fn() }))
const loadCodeGraph = vi.hoisted(() => vi.fn())
vi.mock('../../tools/codegraph/codegraph-module.js', () => ({ loadCodeGraph }))

let fixture: string, roots: string[], ctx: AgentContext, current: boolean, loaded: boolean
const temporaryParent = canonicalFilePathSync(os.tmpdir())
const graph = { name: 'codegraph', description: 'query graph', parameters: { type: 'object' as const, properties: {
  action: { type: 'string' as const, enum: ['status', 'search', 'callers', 'callees', 'impact', 'files'] },
} } }
beforeEach(() => {
  fixture = canonicalFilePathSync(fs.mkdtempSync(path.join(temporaryParent, 'aether-codegraph-context-')))
  roots = [path.join(fixture, 'project'), path.join(fixture, 'scratch')]
  roots.forEach(root => fs.mkdirSync(root))
  current = true; loaded = false
  const assertCurrent = () => { if (!current) throw new Error('Binding changed') }
  vi.spyOn(workspaceManager, 'getPaths').mockImplementation(() => [...roots])
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation(() => ({ snapshot: { root: roots[0], epoch: 'binding' }, assertCurrent }))
  vi.spyOn(workspaceManager, 'resolveSafePathForSnapshot').mockImplementation((_ctx, _snapshot, root) => {
    if (!roots.includes(root)) throw new Error('Denied')
    return root
  })
  loadCodeGraph.mockReset().mockResolvedValue(sdk)
  for (const method of Object.values(sdk)) method.mockReset()
  sdk.isInitialized.mockImplementation(root => root === roots[0])
  ctx = { tenantId: 'test', sessionId: 'session', tools: {
    has: vi.fn(name => name === 'codegraph'), list: () => [graph], listForModel: () => [graph],
    listForRequest: vi.fn(() => loaded ? [graph] : []), hasModelToolLoader: () => true,
    loadForModel: vi.fn(names => { loaded = true; return [...names] }), execute: vi.fn(),
  } } as unknown as AgentContext
})
afterEach(() => {
  vi.restoreAllMocks()
  if (path.dirname(fixture) !== temporaryParent || !path.basename(fixture).startsWith('aether-codegraph-context-') || fs.lstatSync(fixture).isSymbolicLink()) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})

describe('request-local existing codegraph discovery', () => {
  it('exposes a ready index query schema without executing a tool or opening/building its database', async () => {
    const context = await prepareCodegraphRequestContext(ctx)
    expect(ctx.tools.loadForModel).toHaveBeenCalledTimes(1)
    expect(ctx.tools.loadForModel).toHaveBeenCalledWith(['codegraph'])
    expect(ctx.tools.execute).not.toHaveBeenCalled()
    for (const method of [sdk.openSync, sdk.init, sdk.recreate]) expect(method).not.toHaveBeenCalled()
    expect(context).toContain(JSON.stringify(roots[0]))
    expect(context).not.toContain(JSON.stringify(roots[1]))
    expect(context).toContain('尚未验证索引是否完整、最新或可查询')
    expect(context).toContain('项目架构梳理、整体/深度调研')
    expect(context).toContain('AGENTS.md')
    expect(context).toContain('status/files')
    expect(context).toContain('partial/failed/stale')
    expect(context).toContain('普通聊天或与项目结构无关的任务无需')
    await prepareCodegraphRequestContext(ctx)
    expect(ctx.tools.loadForModel).toHaveBeenCalledTimes(1)
  })

  it('does not expose an unindexed workspace', async () => {
    sdk.isInitialized.mockReturnValue(false)
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
    expect(ctx.tools.loadForModel).not.toHaveBeenCalled()
  })

  it('does not probe or promote an unauthorized tool', async () => {
    vi.mocked(ctx.tools.has).mockReturnValue(false)
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
    expect(loadCodeGraph).not.toHaveBeenCalled()
    expect(ctx.tools.loadForModel).not.toHaveBeenCalled()
  })

  it('leaves minimal no-tool execution contexts unaffected', async () => {
    ctx.tools = { list: () => [] } as unknown as AgentContext['tools']
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
    expect(loadCodeGraph).not.toHaveBeenCalled()
  })

  it('scopes every indexed root and requires explicit target paths even if the default root has no index', async () => {
    sdk.isInitialized.mockReturnValue(true)
    let context = await prepareCodegraphRequestContext(ctx)
    for (const root of roots) expect(context).toContain(JSON.stringify(root))
    expect(context).toContain('绝对 path')
    sdk.isInitialized.mockImplementation(root => root === roots[1])
    context = await prepareCodegraphRequestContext(ctx)
    expect(context).not.toContain(JSON.stringify(roots[0]))
    expect(context).toContain(JSON.stringify(roots[1]))
  })

  it('never probes a root rejected by the current workspace resolver', async () => {
    vi.mocked(workspaceManager.resolveSafePathForSnapshot).mockImplementation(() => { throw new Error('Denied') })
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
    expect(sdk.isInitialized).not.toHaveBeenCalled()
    expect(ctx.tools.loadForModel).not.toHaveBeenCalled()
  })

  it('does not follow index-directory junctions outside the authorized project', async () => {
    fs.symlinkSync(roots[1], path.join(roots[0], '.ae'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
    expect(sdk.isInitialized.mock.calls.map(call => call[0])).not.toContain(roots[0])
    expect(ctx.tools.loadForModel).not.toHaveBeenCalled()
    fs.unlinkSync(path.join(roots[0], '.ae'))
  })

  it('rechecks a changed binding across async SDK loading and never advertises stale roots', async () => {
    loadCodeGraph.mockImplementation(async () => { current = false; return sdk })
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
    expect(sdk.isInitialized).not.toHaveBeenCalled()
    expect(ctx.tools.loadForModel).not.toHaveBeenCalled()
  })

  it('discovers the current root again on continuation instead of caching the previous root hint', async () => {
    const previous = roots[0]
    expect(await prepareCodegraphRequestContext(ctx)).toContain(JSON.stringify(previous))
    roots = [roots[1]]
    expect(await prepareCodegraphRequestContext(ctx)).toContain(JSON.stringify(roots[0]))
    expect(await prepareCodegraphRequestContext(ctx)).not.toContain(JSON.stringify(previous))
  })

  it.each(['sdk', 'probe', 'loader'] as const)('does not advertise availability after a %s failure', async kind => {
    if (kind === 'sdk') loadCodeGraph.mockRejectedValue(new Error('Missing SDK'))
    if (kind === 'probe') sdk.isInitialized.mockImplementation(() => { throw new Error('Unreadable index') })
    if (kind === 'loader') vi.mocked(ctx.tools.loadForModel!).mockImplementation(() => { throw new Error('Tool scope changed') })
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
    expect(ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('does not claim a loaded schema exists when the registry still withholds it', async () => {
    vi.mocked(ctx.tools.loadForModel!).mockReturnValue(['codegraph'])
    expect(await prepareCodegraphRequestContext(ctx)).toBe('')
  })

  it('retains scoped readonly schemas and supports registries where the tool is already offered', async () => {
    loaded = true
    ctx.tools.hasModelToolLoader = () => false
    const before = JSON.stringify(ctx.tools.list())
    expect(await prepareCodegraphRequestContext(ctx)).toContain('已有索引文件')
    expect(ctx.tools.loadForModel).not.toHaveBeenCalled()
    expect(JSON.stringify(ctx.tools.list())).toBe(before)
    expect(ctx.tools.list()[0].parameters.properties?.action.enum).not.toContain('index')
  })
})

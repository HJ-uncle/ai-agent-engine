import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { ToolRegistry } from '../../../core/tool-registry/registry.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { setSecurityMode, clearSecurityMode } from '../../../security/policy-engine.js'
import { WorkspaceManager, workspaceManager } from '../../../workspace/index.js'
import { createSubagentToolRegistry } from '../../subagent/subagent-tool.js'
import { codegraphTool } from '../codegraph-tool.js'
import { loadCodeGraph } from '../codegraph-module.js'
import { openReadonlyCodegraphSnapshot } from '../codegraph-readonly.js'
import * as indexing from '../index-runner.js'

let fixture: string, authorized: string, outside: string, manager: WorkspaceManager, ctx: AgentContext
const temporaryParent = fs.realpathSync(os.tmpdir())
const snapshots = () => fs.readdirSync(temporaryParent).filter(name => name.startsWith('aether-codegraph-readonly-')).sort()
function directoryState(root: string): unknown {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const name = path.join(root, entry.name), stat = fs.lstatSync(name)
    return [entry.name, stat.mtimeMs, stat.size, entry.isDirectory() ? directoryState(name) : createHash('sha256').update(fs.readFileSync(name)).digest('hex')]
  })
}
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(temporaryParent, 'aether-codegraph-permissions-'))
  authorized = path.join(fixture, 'authorized'); outside = path.join(fixture, 'outside')
  fs.mkdirSync(authorized); fs.mkdirSync(outside)
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', fixture)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(fixture, 'bindings.json'))
  manager = new WorkspaceManager(path.join(fixture, 'scratch'))
  manager.bind({ tenantId: 'cg-permission', sessionId: 'research' }, authorized)
  vi.spyOn(workspaceManager, 'getPaths').mockImplementation(scope => manager.getPaths(scope))
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((scope, expected) => manager.bindingReadGuard(scope, expected))
  vi.spyOn(workspaceManager, 'resolveSafePathForSnapshot').mockImplementation((scope, snapshot, file) => manager.resolveSafePathForSnapshot(scope, snapshot, file))
  const parent = new ToolRegistry(); parent.register(trustBuiltinTool(codegraphTool))
  ctx = { tenantId: 'cg-permission', sessionId: 'research', tools: createSubagentToolRegistry(parent, true), logger: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== temporaryParent || !path.basename(fixture).startsWith('aether-codegraph-permissions-') || fs.lstatSync(fixture).isSymbolicLink()) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})

describe('research codegraph authorization with the installed SDK', () => {
  it('queries a live WAL snapshot without changing any project file or creating gitignore', async () => {
    fs.writeFileSync(path.join(authorized, 'calc.ts'), 'export function add(a: number, b: number) { return a + b }\nexport function total() { return add(1, 2) }\n')
    const sdk = await loadCodeGraph(), source = await sdk.init(authorized, { index: true })
    source.close()
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } }
    const writer = new DatabaseSync(path.join(authorized, '.ae', 'codegraph.db'))
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE project_metadata SET value='partial' WHERE key='index_state'")
      fs.unlinkSync(path.join(authorized, '.ae', '.gitignore'))
      expect(fs.statSync(path.join(authorized, '.ae', 'codegraph.db-wal')).size).toBeGreaterThan(0)
      expect(fs.existsSync(path.join(authorized, '.ae', 'codegraph.db-shm'))).toBe(true)
      const before = directoryState(authorized), temporaryBefore = snapshots()
      for (const args of [{ action: 'status' }, { action: 'search', query: 'add' }, { action: 'callers', query: 'add' }, { action: 'callees', query: 'total' }, { action: 'impact', query: 'add' }, { action: 'files' }]) {
        const result = await ctx.tools.execute('codegraph', args, ctx)
        expect(result.success, result.output).toBe(true)
        if (args.action === 'status') expect(result.output).toContain('partial')
        if (args.action === 'search') expect(result.output).toContain('function add')
        if (args.action === 'files') expect(result.output).toContain('calc.ts')
      }
      expect(directoryState(authorized)).toEqual(before)
      expect(snapshots()).toEqual(temporaryBefore)
      expect((await ctx.tools.execute('codegraph', { action: 'index' }, ctx)).success).toBe(false)
    } finally { writer.close() }
  }, 40_000)

  it.each(['safe', 'full-access'] as const)('rejects absolute, traversal and junction escapes before SDK access in %s mode', async mode => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, mode)
    const sdk = await loadCodeGraph(), probe = vi.spyOn(sdk, 'isInitialized')
    fs.symlinkSync(outside, path.join(authorized, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const target of [outside, '../outside', 'linked']) {
      for (const tools of [ctx.tools, (() => { const parent = new ToolRegistry(); parent.register(trustBuiltinTool(codegraphTool)); return parent })()]) {
        const result = await tools.execute('codegraph', { action: 'status', path: target }, { ...ctx, tools })
        expect(result.success, result.output).toBe(false)
      }
    }
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses an index symlink escape and never exposes another project indexing progress', async () => {
    const sdk = await loadCodeGraph(), probe = vi.spyOn(sdk, 'isInitialized')
    fs.symlinkSync(outside, path.join(authorized, '.ae'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await ctx.tools.execute('codegraph', { action: 'status' }, ctx)).success).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    fs.unlinkSync(path.join(authorized, '.ae'))
    vi.spyOn(indexing, 'getIndexRunState').mockReturnValue({ root: outside, phase: 'indexing', mode: 'create', startedAt: 0, progress: { phase: 'secret', current: 1, total: 2, currentFile: 'private.ts' } })
    vi.spyOn(indexing, 'isIndexRunning').mockReturnValue(true)
    const result = await ctx.tools.execute('codegraph', { action: 'status' }, ctx)
    expect(result.success, result.output).toBe(true)
    expect(result.output).not.toContain('private.ts')
    expect(result.output).not.toContain(outside)
    vi.mocked(indexing.getIndexRunState).mockReturnValue({ root: authorized, phase: 'indexing', mode: 'create', startedAt: 0, progress: { phase: 'parsing', current: 1, total: 2, currentFile: 'allowed.ts' } })
    expect((await ctx.tools.execute('codegraph', { action: 'status' }, ctx)).output).toContain('allowed.ts')
  })

  it('fails closed for oversized or recovering snapshots and cleans up a failed SDK open', async () => {
    const sdk = await loadCodeGraph(), source = await sdk.init(authorized, { index: false }); source.close()
    const before = directoryState(authorized), temporaryBefore = snapshots()
    expect(() => openReadonlyCodegraphSnapshot(authorized, sdk, () => {}, { maxBytes: 1 })).toThrow('上限')
    expect(directoryState(authorized)).toEqual(before)
    const journal = path.join(authorized, '.ae', 'codegraph.db-journal')
    fs.writeFileSync(journal, 'recovery required')
    const result = await ctx.tools.execute('codegraph', { action: 'status' }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { code: 'CODEGRAPH_READONLY_UNAVAILABLE' } })
    fs.unlinkSync(journal)
    const afterFixtureChange = directoryState(authorized)
    const failing = { ...sdk, openSync: () => { throw new Error('SDK failed') } }
    expect(() => openReadonlyCodegraphSnapshot(authorized, failing, () => {})).toThrow('SDK failed')
    expect(snapshots()).toEqual(temporaryBefore)
    expect(directoryState(authorized)).toEqual(afterFixtureChange)
  })

  it('rejects a changed WAL during collection without opening a snapshot', async () => {
    const sdk = await loadCodeGraph(), source = await sdk.init(authorized, { index: false })
    try {
      const wal = path.join(authorized, '.ae', 'codegraph.db-wal')
      const original = fs.readFileSync(wal)
      const realRead = fs.readSync, probe = vi.spyOn(sdk, 'openSync')
      let reads = 0
      vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const count = Reflect.apply(realRead, fs, args) as number
        if (++reads === 2) fs.appendFileSync(wal, Buffer.from([1]))
        return count
      }) as typeof fs.readSync)
      try { expect(() => openReadonlyCodegraphSnapshot(authorized, sdk, () => {})).toThrow('改变') }
      finally { vi.mocked(fs.readSync).mockRestore(); fs.writeFileSync(wal, original) }
      expect(probe).not.toHaveBeenCalled()
    } finally { source.close() }
  })
})

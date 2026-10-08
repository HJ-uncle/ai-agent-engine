// Exercise the installed SDK, its SQLite database and TypeScript parser without mocks.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { projectDataPath } from '../../../core/project-storage.js'
import { codegraphRoutes } from '../../../api/http/routes/codegraph.js'
import { loadCodeGraph } from '../codegraph-module.js'
import { codegraphTool } from '../codegraph-tool.js'
import { getIndexRunState, isIndexRunning, startIndexing } from '../index-runner.js'

const previousCodeGraphDirectory = process.env.CODEGRAPH_DIR
const fixtureParent = fs.realpathSync(os.tmpdir())
let fixtureDir: string
let ctx: AgentContext
let app: FastifyInstance | undefined

async function finishIndexing(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (isIndexRunning() && Date.now() < deadline) await delay(25)
  if (isIndexRunning()) throw new Error('Codegraph fixture indexing did not settle within 30 seconds')
}

async function query(args: Record<string, unknown>) {
  const result = await codegraphTool.execute({ path: fixtureDir, ...args }, ctx)
  expect(result.success, result.output).toBe(true)
  return result.output
}

describe.sequential('codegraph installed runtime integration', () => {
  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(fixtureParent, 'aether-codegraph-runtime-'))
    fs.writeFileSync(path.join(fixtureDir, 'pricing.ts'), [
      'export function computeSubtotal(price: number, quantity: number): number {',
      '  return price * quantity',
      '}',
      'export function computeInvoice(price: number, quantity: number): number {',
      '  return computeSubtotal(price, quantity) + 10',
      '}',
      'export function renderInvoice(): string {',
      '  return String(computeInvoice(20, 3))',
      '}',
    ].join('\n'))
    // Runtime-owned files may contain source code too (attachments or generated scripts).
    // They must stay out of the project graph even without a project .gitignore.
    fs.mkdirSync(projectDataPath(fixtureDir, 'attachments'), { recursive: true })
    fs.writeFileSync(projectDataPath(fixtureDir, 'attachments', 'private.ts'), 'export function runtimeAttachmentOnly() { return 1 }\n')
    fs.writeFileSync(projectDataPath(fixtureDir, 'runtime-owned.txt'), 'preserve across rebuild')
    process.env.CODEGRAPH_DIR = '.codegraph-external-setting'
    ctx = {
      tenantId: 'codegraph-runtime-fixture', sessionId: 'codegraph-runtime-fixture',
      cwd: fixtureDir, projectRoot: fixtureDir, workspacePaths: [fixtureDir],
    } as AgentContext
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    // Never remove a directory while an asynchronous writer may still own it.
    await finishIndexing()
    const resolved = fs.realpathSync(fixtureDir)
    if (path.dirname(resolved) !== fixtureParent ||
        !path.basename(resolved).startsWith('aether-codegraph-runtime-') ||
        fs.lstatSync(fixtureDir).isSymbolicLink()) {
      throw new Error(`Unsafe codegraph fixture cleanup path: ${fixtureDir}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
    if (previousCodeGraphDirectory === undefined) delete process.env.CODEGRAPH_DIR
    else process.env.CODEGRAPH_DIR = previousCodeGraphDirectory
  }, 35_000)

  it('reports a fresh directory as unindexed through both the tool and HTTP route', async () => {
    const CodeGraph = await loadCodeGraph()
    expect(CodeGraph.isInitialized(fixtureDir)).toBe(false)
    expect(await query({ action: 'status' })).toContain('尚无 codegraph 索引')
    app = Fastify()
    await app.register(codegraphRoutes)
    const response = await app.inject({
      method: 'GET', url: `/codegraph/status?path=${encodeURIComponent(fixtureDir)}`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ code: 200, data: { root: fixtureDir, initialized: false } })
    expect(response.json().data).not.toHaveProperty('error')
  })

  it('creates a persistent index and resolves actual symbols, calls and impact through the tool', async () => {
    expect(await startIndexing(fixtureDir)).toEqual({ started: true })
    await finishIndexing()
    expect(getIndexRunState()).toMatchObject({ root: fixtureDir, mode: 'create', phase: 'complete', filesIndexed: 1 })
    expect(fs.existsSync(projectDataPath(fixtureDir, 'codegraph.db'))).toBe(true)
    expect(fs.existsSync(path.join(fixtureDir, '.codegraph'))).toBe(false)
    expect(fs.existsSync(path.join(fixtureDir, '.codegraph-external-setting'))).toBe(false)
    expect(await query({ action: 'files' })).not.toContain('private.ts')
    expect(await query({ action: 'search', query: 'runtimeAttachmentOnly' })).not.toContain('function runtimeAttachmentOnly')
    expect(await query({ action: 'status' })).toContain('状态: complete')
    expect(await query({ action: 'files' })).toContain('pricing.ts')
    expect(await query({ action: 'search', query: 'computeSubtotal' })).toContain('function computeSubtotal')
    expect(await query({ action: 'callers', query: 'computeSubtotal' })).toContain('← function computeInvoice')
    expect(await query({ action: 'callees', query: 'computeInvoice' })).toContain('→ function computeSubtotal')
    const impact = await query({ action: 'impact', query: 'computeSubtotal', depth: 3 })
    expect(impact).toContain('function computeInvoice')
    expect(impact).toContain('function renderInvoice')

    const CodeGraph = await loadCodeGraph()
    const reopened = CodeGraph.openSync(fixtureDir)
    try {
      expect(reopened.getStats()).toMatchObject({ fileCount: 1 })
      expect(reopened.searchNodes('computeSubtotal').some(hit => hit.node.name === 'computeSubtotal')).toBe(true)
    } finally {
      reopened.close()
    }
    expect(await startIndexing(fixtureDir)).toEqual({ started: false, alreadyInitialized: true })
  }, 35_000)

  it('creates a new graph under .ae without opening or replacing a legacy third-party directory', async () => {
    const legacy = path.join(fixtureDir, '.codegraph')
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, 'codegraph.db'), 'an existing third-party cache')
    fs.writeFileSync(path.join(legacy, 'keep.ts'), 'export function legacyPrivateSymbol() { return 1 }\n')
    const CodeGraph = await loadCodeGraph()
    expect(CodeGraph.isInitialized(fixtureDir)).toBe(false)
    expect(await startIndexing(fixtureDir)).toEqual({ started: true })
    await finishIndexing()
    expect(getIndexRunState()).toMatchObject({ root: fixtureDir, mode: 'create', phase: 'complete', filesIndexed: 1 })
    expect(fs.existsSync(projectDataPath(fixtureDir, 'codegraph.db'))).toBe(true)
    expect(fs.readFileSync(path.join(legacy, 'codegraph.db'), 'utf8')).toBe('an existing third-party cache')
    expect(fs.readFileSync(path.join(legacy, 'keep.ts'), 'utf8')).toContain('legacyPrivateSymbol')
    expect(await query({ action: 'files' })).not.toContain('keep.ts')
    expect(await query({ action: 'search', query: 'computeSubtotal' })).toContain('function computeSubtotal')
  }, 35_000)

  it.each([
    '# Project-specific rules\ncache/\n!preferences.json\n',
    '# CodeGraph data files — customized project rules\n*.db\n!preferences.json\n',
  ])('preserves existing .ae/.gitignore bytes through initialization, opening and rebuild: %s', async original => {
    const ignorePath = projectDataPath(fixtureDir, '.gitignore')
    fs.writeFileSync(ignorePath, original)
    const CodeGraph = await loadCodeGraph()
    const created = await CodeGraph.init(fixtureDir, { index: true })
    try {
      expect(created.getStats().fileCount).toBe(1)
      expect(fs.readFileSync(ignorePath, 'utf8')).toBe(original)
    } finally { created.close() }
    const reopened = CodeGraph.openSync(fixtureDir)
    try {
      expect(reopened.searchNodes('computeSubtotal').some(hit => hit.node.name === 'computeSubtotal')).toBe(true)
      expect(fs.readFileSync(ignorePath, 'utf8')).toBe(original)
    } finally { reopened.close() }
    const rebuilt = await CodeGraph.recreate(fixtureDir)
    try {
      expect((await rebuilt.indexAll()).success).toBe(true)
      expect(rebuilt.getStats().fileCount).toBe(1)
      expect(fs.readFileSync(ignorePath, 'utf8')).toBe(original)
    } finally { rebuilt.close() }
  }, 35_000)

  it('creates and rebuilds via HTTP and exposes newly indexed source through the shared tool', async () => {
    app = Fastify()
    await app.register(codegraphRoutes)
    const created = await app.inject({ method: 'POST', url: '/codegraph/index', payload: { path: fixtureDir } })
    expect(created.json()).toMatchObject({ code: 200, data: { started: true, root: fixtureDir, rebuild: false } })
    await finishIndexing()
    expect(getIndexRunState()).toMatchObject({ phase: 'complete', mode: 'create' })

    fs.writeFileSync(path.join(fixtureDir, 'discount.ts'), 'export function applyDiscount(total: number): number { return total * 0.9 }\n')
    const rebuilt = await app.inject({
      method: 'POST', url: '/codegraph/index', payload: { path: fixtureDir, force: true },
    })
    expect(rebuilt.json()).toMatchObject({ code: 200, data: { started: true, rebuild: true } })
    await finishIndexing()
    const status = await app.inject({
      method: 'GET', url: `/codegraph/status?path=${encodeURIComponent(fixtureDir)}`,
    })
    expect(status.json()).toMatchObject({ code: 200, data: {
      root: fixtureDir, initialized: true, indexing: false,
      run: { phase: 'complete', mode: 'rebuild', filesIndexed: 2 }, stats: { fileCount: 2 },
    } })
    expect(fs.existsSync(projectDataPath(fixtureDir, 'codegraph.db'))).toBe(true)
    expect(fs.existsSync(path.join(fixtureDir, '.codegraph'))).toBe(false)
    expect(fs.readFileSync(projectDataPath(fixtureDir, 'runtime-owned.txt'), 'utf8')).toBe('preserve across rebuild')
    expect(fs.readFileSync(projectDataPath(fixtureDir, 'attachments', 'private.ts'), 'utf8')).toContain('runtimeAttachmentOnly')
    expect(await query({ action: 'files' })).not.toContain('private.ts')
    expect(await query({ action: 'search', query: 'applyDiscount' })).toContain('function applyDiscount')
    expect(await query({ action: 'files', query: 'discount' })).toContain('discount.ts')
    expect(await query({ action: 'callers', query: 'computeSubtotal' })).toContain('← function computeInvoice')
  }, 65_000)
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { globTool } from '../glob-tool.js'
import { boundedToolContext } from '../../../core/agent-loop/tool-output-limit.js'

vi.mock('../../../security/policy-engine.js', () => ({ getSecurityMode: () => 'safe' }))
let root: string
let ctx: AgentContext
beforeEach(() => {
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('OSM_MODE', 'off')
  vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '800')
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-glob-page-'))
  ctx = { tenantId: 'glob-test', sessionId: 'glob-test', projectRoot: root,
    cwd: root, workspacePaths: [root], toolProfile: 'general' } as AgentContext
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('aether-glob-page-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('glob output budgets and lightweight counts', () => {
  it('returns every long path exactly once using actual continuation offsets within the Work allowance', async () => {
    const names = Array.from({ length: 27 }, (_, i) => `${String(i).padStart(2, '0')}-${'long-name-'.repeat(5)}.ts`)
    for (const name of names) fs.writeFileSync(path.join(root, name), '')
    const all: string[] = []
    let offset: number | null = 0, pageCount = 0
    while (offset !== null && pageCount++ < 30) {
      const result = await globTool.execute({ pattern: '*.ts', limit: 100, offset }, ctx)
      expect(result.success).toBe(true)
      expect(result.output.length).toBeLessThanOrEqual(800)
      const paths = result.output.split('\n').slice(1)
      expect(result.metadata?.count).toBe(paths.length)
      expect(result.output).toContain(`nextOffset=${result.metadata?.nextOffset}`)
      all.push(...paths)
      const next = result.metadata?.nextOffset as number | null
      if (next !== null) expect(next).toBe(offset + paths.length)
      offset = next
    }
    expect(pageCount).toBeGreaterThan(1)
    expect(all.sort()).toEqual(names.sort())
    expect(new Set(all).size).toBe(27)
  })

  it('counts matching paths without putting their names into model context', async () => {
    for (let i = 0; i < 221; i++) fs.writeFileSync(path.join(root, `synthetic-private-${i}.test.ts`), '')
    const result = await globTool.execute({ pattern: '*.test.ts', countOnly: true }, ctx)
    expect(result).toMatchObject({ success: true, metadata: { countOnly: true, count: 221, totalCount: 221, complete: true } })
    expect(result.output.length).toBeLessThan(100)
    expect(result.output).not.toContain('synthetic-private')
  })

  it('distinguishes an exhausted page and an empty search, with explicit pagination metadata', async () => {
    fs.writeFileSync(path.join(root, 'one.ts'), '')
    const exhausted = await globTool.execute({ pattern: '*.ts', offset: 20 }, ctx)
    expect(exhausted).toMatchObject({ success: true, metadata: { offset: 20, count: 0, hasMore: false, nextOffset: null } })
    expect(exhausted.output).toContain('Search page exhausted')
    const empty = await globTool.execute({ pattern: '*.absent' }, ctx)
    expect(empty.metadata).toMatchObject({ count: 0, hasMore: false, nextOffset: null })
    expect(empty.output).toContain('No files matched')
  })

  it('does not claim a partial count is an exact total when its scan deadline is reached', async () => {
    fs.writeFileSync(path.join(root, 'one.ts'), '')
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValue(4001)
    const result = await globTool.execute({ pattern: '*.ts', countOnly: true }, ctx)
    expect(result).toMatchObject({ success: true, metadata: { complete: false, lowerBound: 0, incompleteReason: 'time' } })
    expect(result.metadata).not.toHaveProperty('totalCount')
    expect(result.output).toContain('lower bound')
  })

  it('returns an explicit budget failure rather than a successful non-progressing page', async () => {
    fs.writeFileSync(path.join(root, 'one.ts'), '')
    const result = await globTool.execute({ pattern: '*.ts' }, boundedToolContext(ctx, 80))
    expect(result).toMatchObject({ success: false, metadata: { code: 'GLOB_OUTPUT_BUDGET', offset: 0 } })
    expect(result.metadata).not.toHaveProperty('nextOffset')
  })

  it('honors cancellation and workspace boundaries', async () => {
    const cancelled = new AbortController(); cancelled.abort(new Error('cancel-glob'))
    expect(await globTool.execute({ pattern: '*' }, { ...ctx, signal: cancelled.signal })).toMatchObject({ success: false, output: 'cancel-glob' })
    const outside = await globTool.execute({ pattern: '*', cwd: path.dirname(root) }, ctx)
    expect(outside.success).toBe(false)
    expect(outside.output).toMatch(/outside any bound workspace/)
  })

  it('rejects patterns that leave the workspace in both listing and count modes', async () => {
    const outside = root + '-outside-canary.txt'
    fs.writeFileSync(outside, '')
    try {
      for (const countOnly of [false, true]) {
        const result = await globTool.execute({ pattern: '../' + path.basename(outside), countOnly }, ctx)
        expect(result.success).toBe(false)
        expect(result.metadata ?? {}).not.toHaveProperty('totalCount')
        expect(result.output).toMatch(/outside any bound workspace/)
      }
    } finally { fs.unlinkSync(outside) }
  })

  it.each([null, [], {}, { pattern: 42 }, { pattern: '*' , limit: 2001 }, { pattern: '*', offset: -1 },
    { pattern: '*', countOnly: 'true' }, { pattern: '*', countOnly: true, offset: 1 }])('rejects invalid arguments %j', async args => {
    expect((await globTool.execute(args, ctx)).success).toBe(false)
  })
})

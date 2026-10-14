// Isolated real filesystem/ripgrep contracts. No model, business profile or DB is loaded.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { grepTool } from '../grep-tool.js'

vi.mock('../../../security/policy-engine.js', () => ({ getSecurityMode: () => 'safe' }))
const rgAvailable = spawnSync('rg', ['--version'], { windowsHide: true }).status === 0
const originalPath = process.env.PATH ?? ''
const fixtureRoot = path.resolve('.e2e-tmp')
let fixtureDir: string
let ctx: AgentContext

function matches(output: string): string[] { return output.split('\n').slice(1) }

beforeEach(() => {
  // This fixture exercises local caller paths through the real workspace resolver.
  vi.stubEnv('AUTH_ENABLED', 'false')
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fixtureDir = fs.mkdtempSync(path.join(fixtureRoot, 'grep-paging-'))
  fs.mkdirSync(path.join(fixtureDir, 'nested'))
  fs.writeFileSync(path.join(fixtureDir, 'file.txt'), Array.from({ length: 7 }, (_, i) => `marker single-${i}`).join('\n'))
  fs.writeFileSync(path.join(fixtureDir, 'nested/other.txt'), Array.from({ length: 5 }, (_, i) => `marker nested-${i}`).join('\n'))
  fs.writeFileSync(path.join(fixtureDir, 'nested/skip.md'), 'marker markdown\nMixedCase\n--flag\n')
  ctx = { tenantId: 'grep-paging', sessionId: 'grep-paging', projectRoot: fixtureDir,
    cwd: fixtureDir, workspacePaths: [fixtureDir] } as AgentContext
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(path.resolve(fixtureDir)) !== fixtureRoot || !path.basename(fixtureDir).startsWith('grep-paging-')) throw new Error('Unsafe fixture cleanup path')
  fs.rmSync(fixtureDir, { recursive: true, force: true })
})

describe.each(['nodejs fallback', 'ripgrep'] as const)('%s paging on synthetic files', backend => {
  beforeEach(() => {
    if (backend === 'ripgrep') { if (!rgAvailable) throw new Error('Real ripgrep is required for this regression') }
    vi.stubEnv('PATH', backend === 'nodejs fallback' ? '' : originalPath)
  })

  it('accepts a single file, pages without overlap and exposes continuation in model-visible output', async () => {
    const pages: string[] = []
    for (const [offset, count, hasMore, nextOffset] of [[0, 3, true, 3], [3, 3, true, 6], [6, 1, false, null]] as const) {
      const result = await grepTool.execute({ pattern: 'marker', path: 'file.txt', maxResults: 3, offset, timeoutMs: 0 }, ctx)
      expect(result).toMatchObject({ success: true, metadata: { backend, offset, count, maxResults: 3, hasMore, nextOffset } })
      expect(result.output).toContain(`offset=${offset} count=${count} maxResults=3 hasMore=${hasMore} nextOffset=${nextOffset}`)
      pages.push(...matches(result.output))
    }
    expect(pages).toEqual(Array.from({ length: 7 }, (_, i) => `${i + 1}:marker single-${i}`))
  })

  it('pages a directory globally with a deterministic file filter and no repeated matches', async () => {
    const all: string[] = []
    for (const offset of [0, 4, 8]) {
      const result = await grepTool.execute({ pattern: 'marker', filePattern: '*.txt', maxResults: 4, offset }, ctx)
      expect(result.success).toBe(true)
      expect(result.metadata).toMatchObject({ backend, offset, count: 4, hasMore: offset !== 8, nextOffset: offset === 8 ? null : offset + 4 })
      all.push(...matches(result.output))
    }
    expect(all).toHaveLength(12)
    expect(new Set(all).size).toBe(12)
    expect(all.join('\n')).not.toContain('markdown')
  })

  it('normalizes Windows CRLF lines consistently with ripgrep while keeping explicit-file glob semantics', async () => {
    fs.writeFileSync(path.join(fixtureDir, 'crlf.txt'), 'marker one\r\nmarker two\r\n')
    const result = await grepTool.execute({ pattern: 'marker', path: 'crlf.txt', filePattern: '*.md', maxResults: 5 }, ctx)
    expect(result).toMatchObject({ success: true, metadata: { backend, count: 2, hasMore: false, nextOffset: null } })
    // ripgrep globs filter discovered files, not a file explicitly supplied as the search target.
    expect(matches(result.output)).toEqual(['1:marker one', '2:marker two'])
  })

  it('distinguishes an exhausted later page from a globally empty search and always returns metadata', async () => {
    const exhausted = await grepTool.execute({ pattern: 'marker', path: 'file.txt', offset: 99, maxResults: 2 }, ctx)
    expect(exhausted).toMatchObject({ success: true, metadata: { backend, count: 0, offset: 99, maxResults: 2, hasMore: false, nextOffset: null } })
    expect(exhausted.output).toContain('Search page exhausted')
    expect(exhausted.output).not.toContain('No matches found')
    expect(exhausted.output).toContain('offset=99 count=0 maxResults=2 hasMore=false nextOffset=null')
    const empty = await grepTool.execute({ pattern: 'absent' }, ctx)
    expect(empty.metadata).toMatchObject({ count: 0, offset: 0, hasMore: false, nextOffset: null })
    expect(empty.output).toContain('No matches found for "absent"')
  })

  it('keeps case sensitivity and leading-hyphen patterns as supported fields', async () => {
    const insensitive = await grepTool.execute({ pattern: 'mixedcase', path: 'nested/skip.md', caseSensitive: false }, ctx)
    const sensitive = await grepTool.execute({ pattern: 'mixedcase', path: 'nested/skip.md', caseSensitive: true }, ctx)
    const hyphen = await grepTool.execute({ pattern: '--flag', path: 'nested/skip.md', caseSensitive: true }, ctx)
    expect(insensitive.metadata?.count).toBe(1)
    expect(sensitive.metadata?.count).toBe(0)
    expect(hyphen.output).toContain('3:--flag')
  })

  it('reports missing paths as failures without claiming page exhaustion', async () => {
    const result = await grepTool.execute({ pattern: 'marker', path: 'missing.txt', offset: 20 }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toContain('missing.txt')
    expect(result.metadata).toMatchObject({ status: 'failed', error: 'SEARCH_FAILED', offset: 20 })
    expect(result.metadata).not.toHaveProperty('hasMore')
  })

  it('uses the real safe workspace resolver before reading an outside path', async () => {
    const outside = path.join(fixtureRoot, 'outside-synthetic-canary.txt')
    fs.writeFileSync(outside, 'OUTSIDE_SYNTHETIC_CANARY')
    try {
      const result = await grepTool.execute({ pattern: 'CANARY', path: outside }, ctx)
      expect(result.success).toBe(false)
      expect(result.output).toMatch(/outside any bound workspace/)
      expect(result.output).not.toContain('OUTSIDE_SYNTHETIC_CANARY')
    } finally { fs.rmSync(outside) }
  })

  it('keeps abort cancellation explicit rather than returning an empty successful page', async () => {
    const controller = new AbortController()
    controller.abort(new Error('SYNTHETIC_SEARCH_CANCELLED'))
    const result = await grepTool.execute({ pattern: 'marker' }, { ...ctx, signal: controller.signal })
    expect(result.success).toBe(false)
    expect(result.output).toBe('SYNTHETIC_SEARCH_CANCELLED')
    expect(result.metadata).toMatchObject({ status: 'failed', error: 'SEARCH_FAILED' })
    expect(result.metadata).not.toHaveProperty('hasMore')
  })
})

it('the fallback does not walk directory junctions outside the bound search root', async () => {
  vi.stubEnv('PATH', '')
  const outside = fs.mkdtempSync(path.join(fixtureRoot, 'grep-synthetic-junction-'))
  fs.writeFileSync(path.join(outside, 'canary.txt'), 'JUNCTION_CANARY')
  const link = path.join(fixtureDir, 'linked')
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await grepTool.execute({ pattern: 'JUNCTION_CANARY' }, ctx)
    expect(result.success).toBe(true)
    expect(result.metadata?.count).toBe(0)
    expect(result.output).not.toContain(':JUNCTION_CANARY')
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link)
    if (path.dirname(path.resolve(outside)) !== fixtureRoot || !path.basename(outside).startsWith('grep-synthetic-junction-')) throw new Error('Unsafe junction fixture cleanup')
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

it('the fallback deadline produces a failure rather than an exhausted page', async () => {
  vi.stubEnv('PATH', '')
  vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(1002)
  const result = await grepTool.execute({ pattern: 'marker', timeoutMs: 1 }, ctx)
  expect(result).toMatchObject({ success: false, metadata: { status: 'failed', error: 'SEARCH_FAILED' } })
  expect(result.output).toBe('Search timed out')
  expect(result.metadata).not.toHaveProperty('hasMore')
})

it('an explicitly requested fallback file read failure is reported rather than swallowed as no matches', async () => {
  vi.stubEnv('PATH', '')
  const originalRead = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === path.join(fixtureDir, 'file.txt')) throw new Error('SYNTHETIC_READ_DENIED')
    return originalRead(...args)
  })
  const result = await grepTool.execute({ pattern: 'marker', path: 'file.txt' }, ctx)
  expect(result.success).toBe(false)
  expect(result.output).toBe('SYNTHETIC_READ_DENIED')
  expect(result.metadata).toMatchObject({ status: 'failed', error: 'SEARCH_FAILED' })
})

it.each([
  null, undefined, [], 'marker', {}, { pattern: 12 }, { pattern: 'marker', path: null },
  { pattern: 'marker', filePattern: 12 }, { pattern: 'marker', caseSensitive: 'false' },
  { pattern: 'marker', maxResults: '3' }, { pattern: 'marker', offset: '1' },
  { pattern: 'marker', offset: -1 }, { pattern: 'marker', offset: 1.5 },
  { pattern: 'marker', timeoutMs: '0' }, { pattern: 'marker', timeoutMs: -1 },
  { pattern: 'marker', timeoutMs: 0.5 }, { pattern: 'marker', maxResults: Number.NaN },
  { pattern: 'marker', offset: Number.MAX_SAFE_INTEGER - 1, maxResults: 1 },
])('rejects malformed arguments before filesystem search: %j', async args => {
  const result = await grepTool.execute(args, ctx)
  expect(result).toMatchObject({ success: false, metadata: { status: 'failed', error: 'INVALID_ARGUMENTS' } })
  expect(result.output).toContain('grep_search:')
})

it('returns actionable unknown-field guidance without silently changing a request', async () => {
  const result = await grepTool.execute({ pattern: 'marker', context: 3, outputMode: 'files', offset: 3 }, ctx)
  expect(result.success).toBe(false)
  expect(result.output).toContain('context, outputMode')
  expect(result.output).toContain('pattern, path, filePattern, caseSensitive, maxResults, offset, timeoutMs')
  expect(result.output).toContain('分页请使用 offset 与 maxResults')
  expect(result.metadata?.error).toBe('INVALID_ARGUMENTS')
})

it('keeps every declared argument legal and publishes a closed argument schema', async () => {
  vi.stubEnv('PATH', '')
  const result = await grepTool.execute({ pattern: 'marker', path: 'file.txt', filePattern: '*.txt', caseSensitive: true, maxResults: 2, offset: 1, timeoutMs: 0 }, ctx)
  expect(result.success).toBe(true)
  expect(result.metadata).toMatchObject({ offset: 1, count: 2, hasMore: true, nextOffset: 3 })
  expect(grepTool.parameters.additionalProperties).toBe(false)
  expect(Object.keys(grepTool.parameters.properties ?? {})).toEqual(['pattern', 'path', 'filePattern', 'caseSensitive', 'maxResults', 'offset', 'timeoutMs'])
})

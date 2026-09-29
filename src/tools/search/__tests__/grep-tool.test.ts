// Runs the actual ripgrep executable against isolated files, including global limits and command errors.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { grepTool } from '../grep-tool.js'

const rgAvailable = spawnSync('rg', ['--version'], { windowsHide: true }).status === 0
const fixtureRoot = path.resolve('.e2e-tmp')
let fixtureDir: string
let ctx: AgentContext

describe.skipIf(!rgAvailable)('grep_search with real ripgrep', () => {
  beforeEach(() => {
    fs.mkdirSync(fixtureRoot, { recursive: true })
    fixtureDir = fs.mkdtempSync(path.join(fixtureRoot, 'grep-search-'))
    for (const file of ['first.txt', 'second.txt']) {
      fs.writeFileSync(path.join(fixtureDir, file), Array.from({ length: 40 }, (_, i) => `needle ${file} ${i}`).join('\n'))
    }
    ctx = { tenantId: 'grep-fixture', sessionId: 'grep-fixture', projectRoot: fixtureDir, cwd: fixtureDir, workspacePaths: [fixtureDir] } as AgentContext
  })
  afterEach(() => {
    if (path.dirname(fixtureDir) !== fixtureRoot || !path.basename(fixtureDir).startsWith('grep-search-')) throw new Error('Unsafe fixture cleanup path')
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  })

  async function assertCount(maxResults: number | undefined, expected: number): Promise<void> {
    const result = await grepTool.execute({ pattern: 'needle', ...(maxResults === undefined ? {} : { maxResults }) }, ctx)
    expect(result.success).toBe(true)
    const [heading, ...lines] = result.output.split('\n')
    expect(heading).toBe(`Found ${expected} match(es) [ripgrep]:`)
    expect(lines).toHaveLength(expected)
    expect(lines.every((line) => /\.txt:\d+:needle /.test(line))).toBe(true)
  }

  it('defaults to 50 results across files', async () => { await assertCount(undefined, 50) })
  it.each([1, 7, 60])('limits the entire search to %s matching lines', async (maxResults) => { await assertCount(maxResults, maxResults) })
  it('returns all matches when fewer than the explicit limit exist', async () => { await assertCount(100, 80) })

  it('can return more than 1000 matches from one file when explicitly requested', async () => {
    fs.writeFileSync(path.join(fixtureDir, 'many.txt'), 'many matches\n'.repeat(1400))
    const result = await grepTool.execute({ pattern: 'many', path: 'many.txt', maxResults: 1200 }, ctx)
    expect(result.success).toBe(true)
    expect(result.output.split('\n')).toHaveLength(1201)
    expect(result.output).toContain('Found 1200 match(es) [ripgrep]')
  })

  it('stops a broad search without buffering more than a megabyte of discarded matches', async () => {
    fs.writeFileSync(path.join(fixtureDir, 'large.txt'), (`broad ${'x'.repeat(400)}\n`).repeat(5000))
    const result = await grepTool.execute({ pattern: 'broad', maxResults: 3 }, ctx)
    expect(result.success).toBe(true)
    expect(result.output.split('\n')).toHaveLength(4)
    expect(result.output).toContain('Found 3 match(es) [ripgrep]')
  })

  it('treats rg exit 1 as a successful empty search', async () => {
    const result = await grepTool.execute({ pattern: 'absent-pattern' }, ctx)
    expect(result).toEqual({ success: true, output: 'No matches found for "absent-pattern"' })
  })

  it('reports a real regex command error instead of success or no matches', async () => {
    const result = await grepTool.execute({ pattern: '[' }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toMatch(/regex parse error|unclosed character class/i)
  })

  it('reports a missing path as a command error', async () => {
    const result = await grepTool.execute({ pattern: 'needle', path: 'missing-file.txt' }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toContain('missing-file.txt')
    expect(result.output).not.toContain('No matches found')
  })

  it('passes a pattern beginning with a hyphen as data', async () => {
    fs.writeFileSync(path.join(fixtureDir, 'flags.txt'), '--marker\n')
    const result = await grepTool.execute({ pattern: '--marker' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('Found 1 match(es) [ripgrep]')
  })

  it.each([0, -1, 1.5])('rejects invalid maxResults %s explicitly', async (maxResults) => {
    const result = await grepTool.execute({ pattern: 'needle', maxResults }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toContain('maxResults 必须是正整数')
  })
})

/** Real filesystem search parity, bounded results and worker cancellation.
 * Git fixtures use real tracked/untracked files; no model or HTTP server. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchWorkspace, type WorkspaceSearchInput, type WorkspaceSearchResult } from '../core.js'
import { cancelWorkspaceSearch, runWorkspaceSearch } from '../service.js'

const marker = 'MATCH_MARKER_9'
const created: Array<{ root: string; owner: string }> = []
const options: WorkspaceSearchInput['options'] = { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' }
function input(query = marker, patch: Partial<WorkspaceSearchInput['options']> = {}, extra: Partial<Omit<WorkspaceSearchInput, 'query' | 'options'>> = {}): WorkspaceSearchInput {
  return { query, options: { ...options, ...patch }, excludes: {}, useIgnoreFiles: true, ...extra }
}
function fixture() {
  // Fixtures must not inherit this repository's Git index or .gitignore.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-workspace-search-'))
  const owner = randomUUID()
  fs.writeFileSync(path.join(root, '.fixture-owner'), owner)
  created.push({ root, owner })
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  return { root, workspace,
    write(relative: string, content: string | Buffer = marker) {
      const file = path.join(workspace, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return file
    },
    git(...args: string[]) {
      return execFileSync('git', args, { cwd: workspace, windowsHide: true, stdio: 'pipe', encoding: 'utf8' })
    }
  }
}
const hitPaths = (result: WorkspaceSearchResult): string[] => result.hits.map(hit => hit.path).sort()

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, owner } of created.splice(0)) {
    const canonical = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir())
    expect(path.dirname(canonical).toLowerCase()).toBe(parent.toLowerCase())
    expect(path.basename(canonical)).toMatch(/^aether-workspace-search-/)
    expect(fs.readFileSync(path.join(canonical, '.fixture-owner'), 'utf8')).toBe(owner)
    fs.rmSync(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('workspace search on disk', () => {
  it('finds a match after more than 2000 directories without silently dropping the tail', async () => {
    const f = fixture()
    for (let index = 0; index < 2005; index++) fs.mkdirSync(path.join(f.workspace, `directory-${String(index).padStart(4, '0')}`))
    f.write('directory-2004/deep/result.txt')
    const result = await searchWorkspace(f.workspace, input(), { timeoutMs: 30_000 })
    expect(result).toMatchObject({ strategy: 'scan', truncated: false })
    expect(result.error).toBeUndefined()
    expect(result.hits).toEqual([{ path: 'directory-2004/deep/result.txt', line: 1, text: marker, column: 1, length: marker.length }])
  }, 45_000)

  it('Git includes tracked and untracked files, including tracked files now matched by ignore rules', async () => {
    const f = fixture()
    f.git('init', '--quiet')
    f.write('tracked.txt'); f.write('tracked.generated.txt')
    f.git('add', '--', 'tracked.txt', 'tracked.generated.txt')
    f.write('.gitignore', '*.generated.txt\nignored/\n')
    f.write('untracked.txt'); f.write('new.generated.txt'); f.write('ignored/private.txt')
    const result = await searchWorkspace(f.workspace, input())
    expect(result.strategy).toBe('git')
    expect(result.truncated).toBe(false)
    expect(hitPaths(result)).toEqual(['tracked.generated.txt', 'tracked.txt', 'untracked.txt'])
    const includingIgnored = await searchWorkspace(f.workspace, input(marker, {}, { useIgnoreFiles: false }))
    expect(hitPaths(includingIgnored)).toEqual(['ignored/private.txt', 'new.generated.txt', 'tracked.generated.txt', 'tracked.txt', 'untracked.txt'])
  })

  it('non-Git scan applies nested ignore files and negations, and can include ignored files explicitly', async () => {
    const f = fixture()
    f.write('.gitignore', 'ignored/\n*.generated.txt\n!keep.generated.txt\n')
    f.write('.ignore', 'private/\n')
    f.write('nested/.gitignore', '*.txt\n!keep.txt\n')
    for (const relative of ['visible.txt', 'keep.generated.txt', 'drop.generated.txt', 'ignored/drop.txt', 'private/drop.txt', 'nested/drop.txt', 'nested/keep.txt']) f.write(relative)
    const filtered = await searchWorkspace(f.workspace, input())
    expect(filtered.strategy).toBe('scan')
    expect(filtered.error).toBeUndefined()
    expect(hitPaths(filtered)).toEqual(['keep.generated.txt', 'nested/keep.txt', 'visible.txt'])
    const unfiltered = await searchWorkspace(f.workspace, input(marker, {}, { useIgnoreFiles: false }))
    expect(hitPaths(unfiltered)).toEqual(['drop.generated.txt', 'ignored/drop.txt', 'keep.generated.txt', 'nested/drop.txt', 'nested/keep.txt', 'private/drop.txt', 'visible.txt'])
  })

  it.each([false, true])('include/exclude rules preserve parity with Git=%s and false settings do not exclude', async git => {
    const f = fixture()
    if (git) f.git('init', '--quiet')
    for (const relative of ['root.txt', 'src/keep.txt', 'src/keep.md', 'src/excluded.txt', 'src/generated/deep/drop.txt', 'src/restored/keep.txt', 'other/keep.txt']) f.write(relative)
    const result = await searchWorkspace(f.workspace, input(marker, { include: '**/*.txt', exclude: 'excluded.txt, other' }, {
      excludes: { '**/generated': true, '**/restored': false }
    }))
    expect(result.strategy).toBe(git ? 'git' : 'scan')
    expect(hitPaths(result)).toEqual(['root.txt', 'src/keep.txt', 'src/restored/keep.txt'])
    expect(result.truncated).toBe(false)
  })

  it('excluded directories are pruned before unreadable or oversized descendants can make search incomplete', async () => {
    const f = fixture()
    f.write('visible.txt')
    f.write('generated/deep/huge.txt', marker + 'x'.repeat(1024 * 1024))
    f.write('node_modules/dependency/huge.txt', marker + 'x'.repeat(1024 * 1024))
    const result = await searchWorkspace(f.workspace, input(marker, { exclude: 'generated' }, { excludes: { '**/node_modules': true } }))
    expect(hitPaths(result)).toEqual(['visible.txt'])
    expect(result.truncated).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it.each([false, true])('long lines retain original UTF-16 columns while snippets contain the match, Git=%s', async git => {
    const f = fixture()
    if (git) f.git('init', '--quiet')
    const prefix = '中😀'.repeat(200) + ' '
    f.write('long.txt', `first line\r\n${prefix}${marker}${' tail'.repeat(100)}\r\n`)
    const result = await searchWorkspace(f.workspace, input())
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({ path: 'long.txt', line: 2, column: prefix.length + 1, length: marker.length })
    expect(result.hits[0].text).toContain(marker)
    expect(result.hits[0].text.length).toBeLessThanOrEqual(240)
  })

  it.each([false, true])('literal, JS regex and whole-word boundaries have the same semantics, Git=%s', async git => {
    const f = fixture()
    if (git) f.git('init', '--quiet')
    f.write('words.txt', 'cat\nconcatenate\ncat_name\ncat-name\nSCAT\nCAT\ncat42\n中文cat中文\n[a+b]\n')
    const whole = await searchWorkspace(f.workspace, input('cat', { wholeWord: true }))
    expect(whole.hits.map(hit => hit.line)).toEqual([1, 4, 6, 8])
    const exact = await searchWorkspace(f.workspace, input('cat', { wholeWord: true, caseSensitive: true }))
    expect(exact.hits.map(hit => hit.line)).toEqual([1, 4, 8])
    const boundary = await searchWorkspace(f.workspace, input('\\bcat\\b', { useRegex: true }))
    expect(boundary.hits.map(hit => hit.line)).toEqual(whole.hits.map(hit => hit.line))
    const lookbehind = await searchWorkspace(f.workspace, input('(?<=cat)-name', { useRegex: true }))
    expect(lookbehind.hits).toEqual([{ path: 'words.txt', line: 4, text: 'cat-name', column: 4, length: 5 }])
    const literal = await searchWorkspace(f.workspace, input('[a+b]'))
    expect(literal.hits).toEqual([{ path: 'words.txt', line: 9, text: '[a+b]', column: 1, length: 5 }])
  })

  it('invalid regex reports an actionable error without pretending a complete zero-match result', async () => {
    const f = fixture()
    f.write('file.txt')
    const result = await searchWorkspace(f.workspace, input('(', { useRegex: true }))
    expect(result.hits).toEqual([])
    expect(result.error).toMatch(/正则/)
  })

  for (const git of [false, true]) it(`directory links never expose another workspace or create cycles, Git=${git}`, async context => {
    const f = fixture()
    if (git) f.git('init', '--quiet')
    f.write('visible.txt')
    const outside = path.join(f.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), marker)
    try {
      fs.symlinkSync(outside, path.join(f.workspace, 'escaped'), 'junction')
      fs.symlinkSync(f.workspace, path.join(f.workspace, 'cycle'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return context.skip()
      throw error
    }
    const result = await searchWorkspace(f.workspace, input(marker, {}, { useIgnoreFiles: false }))
    expect(hitPaths(result)).toEqual(['visible.txt'])
    expect(result.hits.every(hit => !path.isAbsolute(hit.path) && !hit.path.includes('..'))).toBe(true)
  })

  it('hit limits retain useful matches, their real positions and an explicit partial-result flag', async () => {
    const f = fixture()
    f.write('many.txt', Array.from({ length: 20 }, (_, index) => `row ${index}: ${marker}`).join('\n'))
    const progress: WorkspaceSearchResult[] = []
    const result = await searchWorkspace(f.workspace, input(), { maxHits: 3, onProgress: value => progress.push(value) })
    expect(result.truncated).toBe(true)
    expect(result.hits.map(hit => [hit.line, hit.column, hit.length])).toEqual([[1, 8, marker.length], [2, 8, marker.length], [3, 8, marker.length]])
    expect(progress.at(-1)?.hits).toEqual(result.hits)
    expect(progress.every(value => value.hits.length <= 3)).toBe(true)
  })

  it('a deadline after the first progress report retains matches and marks the result incomplete', async () => {
    const f = fixture()
    f.write('many.txt', Array.from({ length: 40 }, () => marker).join('\n'))
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const result = await searchWorkspace(f.workspace, input(), { timeoutMs: 5000,
      onProgress: progress => { if (progress.hits.length) clock.mockReturnValue(now + 6000) } })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].text).toBe(marker)
    expect(result.truncated).toBe(true)
    expect(result.error).toMatch(/时间上限/)
  })

  it('binary data is skipped and an oversized file does not hide valid partial results', async () => {
    const f = fixture()
    f.write('valid.txt')
    f.write('binary.bin', Buffer.from(`${marker}\0binary`))
    f.write('huge.txt', marker + 'x'.repeat(1024 * 1024))
    const result = await searchWorkspace(f.workspace, input())
    expect(hitPaths(result)).toEqual(['valid.txt'])
    expect(result.truncated).toBe(true)
    expect(result.error).toMatch(/无法完整搜索/)
  })

  it('large media and sampled binary files are skipped without making a complete text search partial', async () => {
    const f = fixture()
    f.write('valid.txt')
    for (const extension of ['png', 'pdf', 'woff2', 'mp4']) f.write(`large.${extension}`, Buffer.alloc(1024 * 1024 + 1, 65))
    const nul = Buffer.alloc(1024 * 1024 + 1, 65); nul[12] = 0
    f.write('nul-model.unknown', nul)
    const invalidUtf8 = Buffer.alloc(1024 * 1024 + 1, 65); invalidUtf8[12] = 255
    f.write('encoded-model.unknown', invalidUtf8)
    const result = await searchWorkspace(f.workspace, input())
    expect(hitPaths(result)).toEqual(['valid.txt'])
    expect(result.truncated).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it('AbortSignal cancels both an unstarted search and an active scan after progress', async () => {
    const f = fixture()
    f.write('many.txt', Array.from({ length: 30 }, () => marker).join('\n'))
    const controller = new AbortController()
    let reported = 0
    await expect(searchWorkspace(f.workspace, input(), { signal: controller.signal,
      onProgress: progress => { if (progress.hits.length) { reported = progress.hits.length; controller.abort(new Error('test search cancelled')) } }
    })).rejects.toThrow('test search cancelled')
    expect(reported).toBeGreaterThan(0)
    await expect(searchWorkspace(f.workspace, input(), { signal: controller.signal })).rejects.toThrow('test search cancelled')
  })
})

describe('workspace search workers', () => {
  it('loads the production TypeScript worker and returns actual filesystem results', async () => {
    const f = fixture()
    f.write('worker.txt', `prefix ${marker}`)
    const current = vi.fn()
    const result = await runWorkspaceSearch(randomUUID(), randomUUID(), f.workspace, input(), current)
    expect(result.hits).toEqual([{ path: 'worker.txt', line: 1, text: `prefix ${marker}`, column: 8, length: marker.length }])
    expect(result.truncated).toBe(false)
    expect(current.mock.calls.length).toBeGreaterThan(1)
  }, 15_000)

  it('cancels only the matching owner and request, while another owner finishes normally', async () => {
    const f = fixture()
    f.write('worker.txt')
    const ownerA = randomUUID(), ownerB = randomUUID(), requestId = randomUUID()
    const pendingA = runWorkspaceSearch(ownerA, requestId, f.workspace, input(), () => {})
    const rejectedA = expect(pendingA).rejects.toMatchObject({ name: 'AbortError', message: '工作区搜索已取消' })
    const pendingB = runWorkspaceSearch(ownerB, requestId, f.workspace, input(), () => {})
    expect(cancelWorkspaceSearch(ownerA, 'different-request')).toBe(false)
    expect(cancelWorkspaceSearch(ownerA, requestId)).toBe(true)
    await rejectedA
    expect(hitPaths(await pendingB)).toEqual(['worker.txt'])
    expect(cancelWorkspaceSearch(ownerB, requestId)).toBe(false)
  }, 15_000)

  it('a cancellation that arrives before dispatch prevents that exact request from starting', async () => {
    const f = fixture()
    f.write('worker.txt')
    const owner = randomUUID(), requestId = randomUUID()
    expect(cancelWorkspaceSearch(owner, requestId)).toBe(false)
    await expect(runWorkspaceSearch(owner, requestId, f.workspace, input(), () => {})).rejects.toMatchObject({ name: 'AbortError' })
    expect(hitPaths(await runWorkspaceSearch(owner, randomUUID(), f.workspace, input(), () => {}))).toEqual(['worker.txt'])
  }, 15_000)

  it('different request IDs from the same owner run concurrently without cancelling another panel', async () => {
    const f = fixture()
    f.write('first.txt', 'FIRST_PANEL_MATCH')
    f.write('second.txt', 'SECOND_PANEL_MATCH')
    const owner = randomUUID(), oldId = randomUUID(), newId = randomUUID()
    const old = runWorkspaceSearch(owner, oldId, f.workspace, input('FIRST_PANEL_MATCH'), () => {})
    const fresh = runWorkspaceSearch(owner, newId, f.workspace, input('SECOND_PANEL_MATCH'), () => {})
    const [firstResult, secondResult] = await Promise.all([old, fresh])
    expect(hitPaths(firstResult)).toEqual(['first.txt'])
    expect(hitPaths(secondResult)).toEqual(['second.txt'])
  }, 15_000)

  it('replacing the same owner and request ID cancels only the old worker', async () => {
    const f = fixture()
    f.write('worker.txt')
    const owner = randomUUID(), requestId = randomUUID()
    const old = runWorkspaceSearch(owner, requestId, f.workspace, input('not present'), () => {})
    const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    const fresh = runWorkspaceSearch(owner, requestId, f.workspace, input(), () => {})
    await cancelled
    expect(hitPaths(await fresh)).toEqual(['worker.txt'])
  }, 15_000)

  it('workspace rebinding during worker startup rejects results from the old owner', async () => {
    const f = fixture()
    f.write('worker.txt')
    let checks = 0
    await expect(runWorkspaceSearch(randomUUID(), randomUUID(), f.workspace, input(), () => {
      if (++checks > 1) throw new Error('workspace binding changed')
    })).rejects.toThrow('workspace binding changed')
    expect(checks).toBeGreaterThan(1)
  }, 15_000)

  it('a non-yielding regex is terminated by the service deadline without blocking the main event loop', async () => {
    const f = fixture()
    f.write('pathological.txt', `${'a'.repeat(50_000)}!`)
    let ticks = 0
    const interval = setInterval(() => ticks++, 10)
    try {
      const result = await runWorkspaceSearch(randomUUID(), randomUUID(), f.workspace,
        input('(a+)+$', { useRegex: true }), () => {}, { timeoutMs: 100 })
      expect(result.truncated).toBe(true)
      expect(result.error).toMatch(/时间上限/)
      expect(ticks).toBeGreaterThan(0)
    } finally { clearInterval(interval) }
  }, 15_000)
})

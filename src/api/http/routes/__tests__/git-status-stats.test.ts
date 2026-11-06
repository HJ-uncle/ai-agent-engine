/** Real Git + HTTP status in fresh repositories: file counters match worktree
 * and index, including the initial untracked tree before any commit exists. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gitRoutes } from '../git.js'
import type { StatusStatFile } from '../git-status-stats.js'

vi.setConfig({ testTimeout: 20_000 })
const scope = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: {
  getBindingSnapshot: () => ({ root: scope.root, epoch: 'status-stats' }),
  withBindingLease: async (_owner: unknown, _expected: unknown, action: (lease: { snapshot: { root: string; epoch: string }; assertCurrent(): void }) => Promise<unknown>) =>
    action({ snapshot: { root: scope.root, epoch: 'status-stats' }, assertCurrent() {} }),
  resolveSafePath: (_owner: unknown, file: string) => path.resolve(scope.root, file)
} }))

let fixture: string
let app: FastifyInstance
function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  return execFileSync('git', ['-C', scope.root, '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8', windowsHide: true, env })
}
function write(file: string, value: string | Buffer): void { fs.writeFileSync(path.join(scope.root, file), value) }
async function status(cwd = ''): Promise<StatusStatFile[]> {
  const response = (await app.inject({ method: 'GET', url: '/git/status?' + new URLSearchParams({ sessionId: 'session', expectedRoot: scope.root, bindingEpoch: 'status-stats', cwd }) })).json()
  expect(response).toMatchObject({ code: 200, data: { success: true, isRepo: true } })
  return response.data.files as StatusStatFile[]
}
beforeEach(async () => {
  fixture = path.resolve('.e2e-tmp', 'git-status-stats-' + randomUUID())
  scope.root = path.join(fixture, 'project'); fs.mkdirSync(scope.root, { recursive: true })
  git('init', '-b', 'main'); git('config', 'user.name', 'Stats Fixture'); git('config', 'user.email', 'stats@example.invalid')
  git('config', 'core.autocrlf', 'false')
  app = Fastify(); await app.register(gitRoutes); await app.ready()
})
afterEach(async () => {
  await app.close()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('git-status-stats-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 })
})

it('reports real additions for untracked LF/CRLF/no-final-newline text and zero for empty/binary files before first commit', async () => {
  write('lf.txt', 'one\ntwo\n'); write('crlf.txt', 'one\r\ntwo\r\n')
  write('no-final.txt', 'one\ntwo'); write('empty.txt', ''); write('中文 空格.txt', 'one\ntwo\nthree\n')
  write('binary.bin', Buffer.from([0, 10, 1, 10]))
  const files = await status()
  expect(files).toHaveLength(6)
  for (const [name, additions] of [['lf.txt', 2], ['crlf.txt', 2], ['no-final.txt', 2], ['empty.txt', 0], ['中文 空格.txt', 3]] as const)
    expect(files.find(file => file.path === name)).toMatchObject({ changeType: 'untracked', additions, deletions: 0, unstagedAdditions: additions, unstagedDeletions: 0, binary: false })
  expect(files.find(file => file.path === 'binary.bin')).toMatchObject({ binary: true, additions: 0, deletions: 0 })
  expect(files.reduce((sum, file) => sum + file.additions, 0)).toBe(9)
})

it('returns cacheable empty history before the first commit without hiding invalid refs', async () => {
  const query = new URLSearchParams({ sessionId: 'session', expectedRoot: scope.root, bindingEpoch: 'status-stats' })
  const empty = (await app.inject({ method: 'GET', url: '/git/log?' + query })).json()
  expect(empty).toMatchObject({ code: 200, data: { success: true, commits: [] } })
  query.set('refs', 'missing-branch')
  const invalid = (await app.inject({ method: 'GET', url: '/git/log?' + query })).json()
  expect(invalid.code).not.toBe(200)
})

it('combines staged and unstaged numstat without dropping untracked additions or the rename destination', async () => {
  write('tracked.txt', 'base\n'); write('old name.txt', 'rename payload\n')
  git('add', '.'); git('commit', '-m', 'initial')
  write('tracked.txt', 'staged\n'); git('add', 'tracked.txt')
  write('tracked.txt', 'worktree\nextra\n'); write('new.txt', 'new\nfile\n')
  git('mv', 'old name.txt', 'new name.txt')
  const files = await status()
  expect(files.find(file => file.path === 'tracked.txt')).toMatchObject({ additions: 3, deletions: 2, stagedAdditions: 1, stagedDeletions: 1, unstagedAdditions: 2, unstagedDeletions: 1 })
  expect(files.find(file => file.path === 'new.txt')).toMatchObject({ additions: 2, deletions: 0, unstagedAdditions: 2 })
  expect(files.find(file => file.path === 'new name.txt')).toMatchObject({ stagedAdditions: 0, stagedDeletions: 0 })
  expect(files.reduce((sum, file) => sum + file.additions, 0)).toBe(5)
  expect(files.reduce((sum, file) => sum + file.deletions, 0)).toBe(2)
})

it('normalizes nested workspace status paths and rename origins before counting or dispatching file actions', async () => {
  fs.mkdirSync(path.join(scope.root, 'packages/client'), { recursive: true })
  write('outside.txt', 'outside baseline\n'); write('packages/client/tracked.txt', 'base\n')
  write('packages/client/old name.txt', 'rename payload\n')
  git('add', '.'); git('commit', '-m', 'nested baseline')
  write('outside.txt', 'outside\nchanged\nagain\n'); write('outside-new.txt', 'not this workspace\n')
  write('packages/client/tracked.txt', 'staged\n'); git('add', 'packages/client/tracked.txt')
  write('packages/client/tracked.txt', 'worktree\nextra\n'); write('packages/client/new.txt', 'new\nfile\n')
  git('mv', 'packages/client/old name.txt', 'packages/client/new name.txt')
  const files = await status('packages/client')
  expect(files.map(file => file.path).sort()).toEqual(['new name.txt', 'new.txt', 'tracked.txt'])
  expect(files.find(file => file.path === 'tracked.txt')).toMatchObject({ additions: 3, deletions: 2, stagedAdditions: 1, stagedDeletions: 1, unstagedAdditions: 2, unstagedDeletions: 1 })
  expect(files.find(file => file.path === 'new.txt')).toMatchObject({ additions: 2, unstagedAdditions: 2, binary: false })
  expect(files.find(file => file.path === 'new name.txt')).toMatchObject({ oldPath: 'old name.txt', stagedAdditions: 0, stagedDeletions: 0 })
  expect(files.reduce((sum, file) => sum + file.additions, 0)).toBe(5)
  const staged = (await app.inject({ method: 'POST', url: '/git/action', payload: {
    sessionId: 'session', expectedRoot: scope.root, bindingEpoch: 'status-stats', cwd: 'packages/client', op: 'stage', path: 'new.txt'
  } })).json()
  expect(staged).toMatchObject({ code: 200, data: { success: true } })
  expect(git('show', ':packages/client/new.txt')).toBe('new\nfile\n')
})

it('refreshes a same-size untracked file after edits and bounds oversized files without calling them binary', async () => {
  write('changing.txt', 'abcdef')
  expect((await status()).find(file => file.path === 'changing.txt')).toMatchObject({ additions: 1 })
  write('changing.txt', 'a\nb\nc\n')
  const later = new Date(Date.now() + 2000); fs.utimesSync(path.join(scope.root, 'changing.txt'), later, later)
  write('large.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 10))
  const files = await status()
  expect(files.find(file => file.path === 'changing.txt')).toMatchObject({ additions: 3, unstagedAdditions: 3 })
  const large = files.find(file => file.path === 'large.txt')
  expect(large).toMatchObject({ binary: false, additions: 0, deletions: 0 })
  expect(large?.unstagedAdditions).toBeUndefined()
})

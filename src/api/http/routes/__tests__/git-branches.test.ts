/** Real Git/Fastify coverage for local and remote branch picker metadata. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gitRoutes } from '../git.js'

vi.setConfig({ testTimeout: 20_000 })

const scope = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: {
  getWorkingDirectory: () => scope.root,
  getBindingSnapshot: () => ({ root: scope.root, epoch: 'branch-metadata' }),
  withBindingLease: async (_owner: unknown, _expected: unknown, action: (lease: { snapshot: { root: string; epoch: string }; assertCurrent(): void }) => Promise<unknown>) =>
    action({ snapshot: { root: scope.root, epoch: 'branch-metadata' }, assertCurrent() {} }),
  resolveSafePath: (_owner: unknown, file: string) => path.resolve(scope.root, file)
} }))

let fixture: string
let app: FastifyInstance
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
function git(args: string[], cwd = scope.root, date?: string): string {
  const env = { ...environment(), ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, windowsHide: true })
}
function configure(cwd: string): void {
  for (const [key, value] of [['user.name', '分支作者'], ['user.email', 'branches@example.invalid'], ['commit.gpgSign', 'false'], ['core.autocrlf', 'false']]) git(['config', key, value], cwd)
}
function write(file: string, value: string): void { fs.writeFileSync(path.join(scope.root, file), value) }
function read(file: string): Buffer { return fs.readFileSync(path.join(scope.root, file)) }
function commit(subject: string, date: string): string {
  git(['add', '-A'])
  git(['commit', '-m', subject], scope.root, date)
  return git(['rev-parse', '--short', 'HEAD']).trim()
}
async function query(op: string, values: Record<string, string> = {}) {
  const { code, data } = (await app.inject({ method: 'GET', url: '/git/' + op + '?' + new URLSearchParams({ sessionId: 'session', ...values }) })).json()
  return { code, data }
}
function snapshot() {
  return { head: read('.git/HEAD'), index: read('.git/index'), worktree: read('tracked.txt'), refs: git(['show-ref']) }
}

beforeEach(async () => {
  fixture = path.resolve('.e2e-tmp', 'git-branch-metadata-' + randomUUID())
  scope.root = path.join(fixture, 'task')
  fs.mkdirSync(scope.root, { recursive: true })
  git(['init', '-b', 'main'])
  configure(scope.root)
  write('tracked.txt', 'baseline\n')
  commit('初始提交', '2026-01-01T12:00:00+08:00')
  app = Fastify()
  await app.register(gitRoutes)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('git-branch-metadata-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

it('returns complete local metadata in commit-date order without changing dirty repository state', async () => {
  const initialHash = git(['rev-parse', '--short', 'HEAD']).trim()
  git(['checkout', '-b', 'z-recent'])
  write('tracked.txt', 'recent\n')
  const recentHash = commit('最近一次提交', '2026-01-02T12:00:00+08:00')
  git(['checkout', '-b', 'feature/review'])
  write('tracked.txt', 'latest\n')
  const latestHash = commit('修复\t分支更多信息', '2026-01-03T12:00:00+08:00')
  write('tracked.txt', 'staged\n')
  git(['add', 'tracked.txt'])
  write('tracked.txt', 'unstaged\n')
  write('untracked.txt', 'keep this\n')
  const before = snapshot()

  expect(await query('list-branches')).toEqual({ code: 200, data: {
    success: true,
    current: 'feature/review',
    branches: ['feature/review', 'z-recent', 'main'],
    infos: [
      { name: 'feature/review', hash: latestHash, subject: '修复\t分支更多信息', author: '分支作者', date: '2026-01-03T12:00:00+08:00' },
      { name: 'z-recent', hash: recentHash, subject: '最近一次提交', author: '分支作者', date: '2026-01-02T12:00:00+08:00' },
      { name: 'main', hash: initialHash, subject: '初始提交', author: '分支作者', date: '2026-01-01T12:00:00+08:00' }
    ]
  } })
  expect(snapshot()).toEqual(before)
  expect(read('untracked.txt').toString()).toBe('keep this\n')
})

it('keeps full remote branch names and filters symbolic HEAD even when short refs are ambiguous', async () => {
  const initialHash = git(['rev-parse', '--short', 'HEAD']).trim()
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  git(['tag', 'origin/main'])
  write('tracked.txt', 'remote latest\n')
  const latestHash = commit('远端最新提交', '2026-01-02T12:00:00+08:00')
  git(['update-ref', 'refs/remotes/upstream/feature/review', 'HEAD'])
  git(['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/feature/review'])
  const before = snapshot()

  expect(await query('list-remote-branches')).toEqual({ code: 200, data: {
    success: true,
    branches: ['upstream/feature/review', 'origin/main'],
    infos: [
      { name: 'upstream/feature/review', hash: latestHash, subject: '远端最新提交', author: '分支作者', date: '2026-01-02T12:00:00+08:00' },
      { name: 'origin/main', hash: initialHash, subject: '初始提交', author: '分支作者', date: '2026-01-01T12:00:00+08:00' }
    ]
  } })
  expect(snapshot()).toEqual(before)
})

it('preserves the unborn current branch while returning empty metadata lists', async () => {
  const unborn = path.join(scope.root, 'unborn')
  fs.mkdirSync(unborn)
  git(['init', '-b', 'main'], unborn)
  expect(await query('list-branches', { cwd: 'unborn' })).toEqual({ code: 200, data: {
    success: true, current: 'main', branches: [], infos: []
  } })
  expect(await query('list-remote-branches', { cwd: 'unborn' })).toEqual({ code: 200, data: {
    success: true, branches: [], infos: []
  } })
})

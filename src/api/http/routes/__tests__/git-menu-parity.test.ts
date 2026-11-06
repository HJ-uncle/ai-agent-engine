/** Real Git/Fastify regression coverage for the full Work Git action menus. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gitRoutes } from '../git.js'

// Each route launches an audited native Git scope; multi-step menu scenarios
// legitimately exceed Vitest's 5s default on Windows even without waiting.
vi.setConfig({ testTimeout: 20_000 })

const scope = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: {
  getWorkingDirectory: () => scope.root,
  getBindingSnapshot: () => ({ root: scope.root, epoch: 'menu-parity' }),
  withBindingLease: async (_owner: unknown, _expected: unknown, action: (lease: { snapshot: { root: string; epoch: string }; assertCurrent(): void }) => Promise<unknown>) =>
    action({ snapshot: { root: scope.root, epoch: 'menu-parity' }, assertCurrent() {} }),
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
  for (const [key, value] of [['user.name', 'Menu Fixture'], ['user.email', 'menu@example.invalid'], ['commit.gpgSign', 'false'], ['core.autocrlf', 'false']]) git(['config', key, value], cwd)
}
function write(file: string, value: string, cwd = scope.root): void { fs.writeFileSync(path.join(cwd, file), value) }
function read(file: string, cwd = scope.root): string { return fs.readFileSync(path.join(cwd, file), 'utf8') }
function commit(message: string, cwd = scope.root, date?: string): string {
  git(['add', '-A'], cwd); git(['commit', '-m', message], cwd, date)
  return git(['rev-parse', 'HEAD'], cwd).trim()
}
async function action(op: string, values: Record<string, unknown> = {}) {
  return (await app.inject({ method: 'POST', url: '/git/action', payload: {
    sessionId: 'session', expectedRoot: scope.root, bindingEpoch: 'menu-parity', op, ...values
  } })).json()
}
async function ok(op: string, values: Record<string, unknown> = {}): Promise<void> {
  expect(await action(op, values)).toMatchObject({ code: 200, data: { success: true } })
}
async function query(op: string, values: Record<string, string> = {}) {
  return (await app.inject({ method: 'GET', url: '/git/' + op + '?' + new URLSearchParams({ sessionId: 'session', ...values }) })).json()
}
function remote(): string {
  const bare = path.join(fixture, 'remote.git')
  git(['init', '--bare', '-b', 'main', bare])
  git(['remote', 'add', 'origin', bare])
  return bare
}

beforeEach(async () => {
  fixture = path.resolve('.e2e-tmp', 'git-menu-parity-' + randomUUID())
  scope.root = path.join(fixture, 'task')
  fs.mkdirSync(scope.root, { recursive: true })
  git(['init', '-b', 'main']); configure(scope.root)
  write('tracked.txt', 'baseline\n'); commit('initial')
  app = Fastify(); await app.register(gitRoutes); await app.ready()
})
afterEach(async () => {
  await app.close()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('git-menu-parity-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

it('unstages initial files individually and in a batch without changing worktree bytes', async () => {
  const unborn = path.join(scope.root, 'unborn')
  fs.mkdirSync(unborn); git(['init', '-b', 'main'], unborn); configure(unborn)
  write('first.txt', 'index version\n', unborn); write('second.txt', 'second\n', unborn)
  await ok('stage-files', { cwd: 'unborn', paths: ['first.txt', 'second.txt'] })
  write('first.txt', 'new worktree version\n', unborn)
  await ok('unstage', { cwd: 'unborn', path: 'first.txt' })
  expect(git(['ls-files'], unborn)).toBe('second.txt\n')
  expect(read('first.txt', unborn)).toBe('new worktree version\n')
  await ok('stage', { cwd: 'unborn', path: 'first.txt' })
  await ok('unstage-files', { cwd: 'unborn', paths: ['first.txt', 'second.txt', 'missing.txt'] })
  expect(git(['ls-files'], unborn)).toBe('')
  expect(read('first.txt', unborn)).toBe('new worktree version\n')
  expect(read('second.txt', unborn)).toBe('second\n')
  await ok('stage-files', { cwd: 'unborn', paths: ['first.txt', 'second.txt'] })
  await ok('discard-files', { cwd: 'unborn', paths: ['first.txt', 'second.txt'] })
  expect(git(['ls-files'], unborn)).toBe('')
  expect(fs.existsSync(path.join(unborn, 'first.txt'))).toBe(false)
  expect(fs.existsSync(path.join(unborn, 'second.txt'))).toBe(false)
})

it('worktree discard preserves staged content and removes only named untracked paths', async () => {
  write('tracked.txt', 'staged\n'); await ok('stage', { path: 'tracked.txt' })
  write('tracked.txt', 'unstaged\n')
  await ok('discard-worktree', { path: 'tracked.txt' })
  expect(read('tracked.txt')).toBe('staged\n')
  expect(git(['show', ':0:tracked.txt'])).toBe('staged\n')
  write('tracked.txt', 'second unstaged\n'); write('new [1].txt', 'remove\n'); write('new 1.txt', 'keep\n')
  await ok('discard-worktree-files', { paths: ['tracked.txt', 'new [1].txt'] })
  expect(read('tracked.txt')).toBe('staged\n')
  expect(git(['show', ':0:tracked.txt'])).toBe('staged\n')
  expect(fs.existsSync(path.join(scope.root, 'new [1].txt'))).toBe(false)
  expect(read('new 1.txt')).toBe('keep\n')
  await ok('unstage-files', { paths: ['tracked.txt', 'already absent.txt'] })
  expect(git(['show', ':0:tracked.txt'])).toBe('baseline\n')
  expect(read('tracked.txt')).toBe('staged\n')
})

it('full discard restores HEAD and removes staged additions without touching neighbours or Git metadata', async () => {
  write('tracked.txt', 'staged\n'); write('new [1].txt', 'remove\n'); write('new 1.txt', 'keep\n')
  await ok('stage-files', { paths: ['tracked.txt', 'new [1].txt'] })
  write('tracked.txt', 'unstaged\n')
  await ok('discard-files', { paths: ['tracked.txt', 'new [1].txt'] })
  expect(read('tracked.txt')).toBe('baseline\n')
  expect(git(['diff', '--cached'])).toBe('')
  expect(fs.existsSync(path.join(scope.root, 'new [1].txt'))).toBe(false)
  expect(read('new 1.txt')).toBe('keep\n')
  const config = read('.git/config')
  const rejected = await action('discard-worktree', { path: '.git/config' })
  expect(rejected.data.success).toBe(false)
  expect(read('.git/config')).toBe(config)
})

it('create branch switches HEAD atomically and remote checkout creates or reuses its local tracking branch', async () => {
  remote(); await ok('push')
  await ok('create-branch', { branch: 'feature/menu' })
  expect(git(['branch', '--show-current'])).toBe('feature/menu\n')
  write('feature.txt', 'feature\n'); commit('feature')
  git(['push', '-u', 'origin', 'feature/menu'])
  git(['checkout', 'main']); git(['branch', '-D', 'feature/menu'])
  git(['config', 'branch.autoSetupMerge', 'false'])
  await ok('create-branch', { branch: 'compatibility-branch', ref: 'origin/feature/menu' })
  expect(git(['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/feature/menu\n')
  git(['checkout', 'main'])
  await ok('checkout', { branch: 'origin/feature/menu' })
  expect(git(['branch', '--show-current'])).toBe('feature/menu\n')
  expect(git(['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/feature/menu\n')
  write('local-only.txt', 'local\n'); const localHead = commit('local only')
  git(['checkout', 'main']); await ok('checkout', { branch: 'origin/feature/menu' })
  expect(git(['rev-parse', 'HEAD']).trim()).toBe(localHead)
  expect(git(['branch', '--show-current'])).toBe('feature/menu\n')
})

it('push publishes the current branch, defaults push-to, and targets exact tags or a different remote branch', async () => {
  const bare = remote()
  await ok('push')
  expect(git(['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/main\n')
  write('tracked.txt', 'published\n'); const head = commit('published')
  await ok('push-to', { remote: 'origin' })
  expect(git(['rev-parse', 'refs/heads/main'], bare).trim()).toBe(head)
  await ok('push-to-branch', { remote: 'origin', branch: 'review/target' })
  expect(git(['rev-parse', 'refs/heads/review/target'], bare).trim()).toBe(head)
  git(['branch', 'release']); git(['tag', 'release'])
  await ok('push-tag', { name: 'release' })
  expect(git(['rev-parse', 'refs/tags/release'], bare).trim()).toBe(head)
  expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/release'], bare)).toBe('')
})

it.each([false, true])('pull/sync expose divergence and remember the selected rebase=%s strategy', async (rebase) => {
  const bare = remote(); git(['push', '-u', 'origin', 'main'])
  const peer = path.join(fixture, 'peer'); git(['clone', bare, peer]); configure(peer)
  write('peer.txt', 'remote\n', peer); commit('remote change', peer); git(['push'], peer)
  write('local.txt', 'local\n'); commit('local change')
  // This deliberately requests an impossible fast-forward, independently of
  // operator defaults. Removing the override lets the explicit choice apply.
  git(['config', 'pull.ff', 'only'])
  for (const op of ['pull', 'sync']) expect(await action(op)).toMatchObject({ code: 200, data: { success: false, errorCode: 'divergent' } })
  git(['config', '--unset', 'pull.ff'])
  await ok(rebase ? 'pull-rebase' : 'pull-merge', { remember: true })
  expect(git(['config', 'pull.rebase']).trim()).toBe(String(rebase))
  expect(read('peer.txt')).toBe('remote\n'); expect(read('local.txt')).toBe('local\n')
  await ok('pull')
})

it('revert and empty commit are noninteractive even when no usable editor exists', async () => {
  git(['config', 'core.editor', 'false'])
  write('tracked.txt', 'to revert\n'); const hash = commit('change')
  await ok('revert-commit', { hash })
  expect(read('tracked.txt')).toBe('baseline\n')
  expect(git(['log', '-1', '--format=%s'])).toContain('Revert "change"')
  const before = git(['rev-parse', 'HEAD'])
  await ok('commit-empty', { message: '' })
  expect(git(['rev-parse', 'HEAD'])).not.toBe(before)
  expect(git(['log', '-1', '--format=%B']).trim()).toBe('')
})

it('batch stash deletion keeps the intended middle entry despite ascending duplicate indexes', async () => {
  for (let index = 0; index < 3; index++) {
    write('tracked.txt', `stash ${index}\n`)
    await ok('stash-push', { message: `entry ${index}` })
  }
  const middle = git(['rev-parse', 'stash@{1}']).trim()
  const shown = await query('stash-show', { index: '0' })
  expect(shown.data.content).toContain('+stash 2')
  await ok('stash-drop-batch', { indexes: [0, 2, 0] })
  expect(git(['stash', 'list', '--format=%H']).trim()).toBe(middle)
})

it('commit history retains exact paths with spaces/Unicode and both sides of renames', async () => {
  const initial = git(['rev-parse', 'HEAD']).trim()
  git(['mv', 'tracked.txt', '重命名 file.txt'])
  write('another file.txt', 'extra\n'); const hash = commit('rename with spaces')
  const detail = await query('commit-show', { hash })
  expect(detail.data.commit.fileChanges).toContainEqual({ code: 'R100', path: '重命名 file.txt', oldPath: 'tracked.txt' })
  expect(detail.data.commit.fileChanges).toContainEqual({ code: 'A', path: 'another file.txt' })
  expect((await query('show-commit-file', { hash, path: '重命名 file.txt' })).data.content).toBe('baseline\n')
  expect((await query('commit-show', { hash: initial })).data.commit.fileChanges).toEqual([{ code: 'A', path: 'tracked.txt' }])
  const history = await query('log')
  expect(history.data.commits.map((item: { hash: string }) => item.hash)).toEqual([hash, initial])
  for (const item of history.data.commits) expect((await query('commit-show', { hash: item.hash })).code).toBe(200)
})

it('merge history hashes and parent identities connect exactly across every log record', async () => {
  const initial = git(['rev-parse', 'HEAD']).trim()
  // A parent authored on a faster clock must still follow both children in
  // the graph; plain reverse-date log demonstrably violates this ordering.
  write('shared.txt', 'shared\n'); const shared = commit('shared parent', scope.root, '2020-01-01T12:00:00Z')
  git(['checkout', '-b', 'feature/graph'])
  write('side.txt', 'side\n'); const side = commit('side', scope.root, '2020-01-01T07:00:00Z')
  git(['checkout', 'main'])
  write('main.txt', 'main\n'); const main = commit('main', scope.root, '2020-01-01T08:00:00Z')
  git(['merge', '--no-ff', '--no-edit', 'feature/graph'], scope.root, '2020-01-01T09:00:00Z')
  const merged = git(['rev-parse', 'HEAD']).trim()
  const expected = new Map([[merged, [main, side]], [main, [shared]], [side, [shared]], [shared, [initial]], [initial, []]])
  const chronological = git(['log', '--format=%H']).trim().split(/\r?\n/)
  expect(chronological.indexOf(shared)).toBeLessThan(chronological.indexOf(side))
  const assertTopology = (commits: Array<{ hash: string; parents: string[] }>, size: number): void => {
    expect(commits).toHaveLength(size)
    const positions = new Map(commits.map((item, index) => [item.hash, index]))
    for (const [index, item] of commits.entries()) {
      expect(item.hash).toMatch(/^[a-f0-9]{40}$/)
      expect(item.parents).toEqual(expected.get(item.hash))
      for (const parent of item.parents) {
        const parentIndex = positions.get(parent)
        if (parentIndex !== undefined) expect(parentIndex, `parent ${parent} must follow child ${item.hash}`).toBeGreaterThan(index)
      }
    }
  }
  assertTopology((await query('log')).data.commits, expected.size)
  remote(); git(['push', '-u', 'origin', 'main'])
  git(['checkout', '-b', 'graph-before', initial]); git(['branch', '--set-upstream-to=origin/main'])
  assertTopology((await query('incoming')).data.commits, expected.size - 1)
})

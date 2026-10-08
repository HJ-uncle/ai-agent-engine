/** Real Git + Fastify tests: tenant workspace boundaries and status parity. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { gitRoutes } from '../git.js'
import { workspaceManager } from '../../../../workspace/index.js'

const scope = vi.hoisted(() => ({ base: '' }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: {
  getWorkingDirectory: () => scope.base,
  resolveSafePath: (_context: unknown, name: string) => path.resolve(scope.base, name)
} }))
let app: FastifyInstance
let fixture: string
let outside: string
let parentIndex: Buffer
function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, windowsHide: true })
}
function init(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true })
  git(cwd, ['init', '-b', 'workspace-main'])
  git(cwd, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'initial\n')
  git(cwd, ['add', '--', 'tracked.txt'])
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial'])
}
async function query(op = 'status', queryString = '') {
  return (await app.inject({ method: 'GET', url: `/git/${op}?sessionId=session${queryString}` })).json()
}
async function action(op: string, rest: Record<string, unknown> = {}) {
  return (await app.inject({ method: 'POST', url: '/git/action', payload: { sessionId: 'session', op, ...rest } })).json()
}
beforeEach(async () => {
  fixture = path.resolve('.e2e-tmp', `git-workspace-${randomUUID()}`)
  outside = path.join(fixture, 'engine')
  init(outside)
  fs.writeFileSync(path.join(outside, 'tracked.txt'), 'private engine modification\n')
  scope.base = path.join(outside, 'workspace', 'tenant', 'session')
  fs.mkdirSync(scope.base, { recursive: true })
  parentIndex = fs.readFileSync(path.join(outside, '.git', 'index'))
  app = Fastify()
  await app.register(gitRoutes)
  await app.ready()
})
afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (!fixture.startsWith(path.resolve('.e2e-tmp') + path.sep) || !path.basename(fixture).startsWith('git-workspace-')) throw new Error('Unsafe Git fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})

it('does not discover the engine parent repository from an empty tenant session', async () => {
  expect(git(scope.base, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/')).toBe(outside.replace(/\\/g, '/'))
  expect(await query()).toMatchObject({ code: 200, data: { success: true, isRepo: false, files: [] } })
  expect(await query('branch-info')).toMatchObject({ code: 200, data: { success: true, isRepo: false, info: null } })
  const history = await query('log')
  expect(history.code).not.toBe(200)
  expect(JSON.stringify(history)).not.toContain('private engine modification')
})

it.each(['stage-all-commit', 'stage', 'undo-commit', 'checkout'])('refuses %s without changing the parent repository', async op => {
  const head = git(outside, ['rev-parse', 'HEAD'])
  const result = await action(op, { path: 'tracked.txt', branch: 'workspace-main', message: 'must not change host' })
  expect(result.code).not.toBe(200)
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
  expect(git(outside, ['rev-parse', 'HEAD'])).toBe(head)
  expect(fs.readFileSync(path.join(outside, 'tracked.txt'), 'utf8')).toBe('private engine modification\n')
})

it('initializes an independent tenant repository even below an engine checkout', async () => {
  expect(await action('init')).toMatchObject({ code: 200, data: { success: true } })
  expect(fs.statSync(path.join(scope.base, '.git')).isDirectory()).toBe(true)
  expect(await query()).toMatchObject({ code: 200, data: { isRepo: true, files: [] } })
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

it('keeps untracked files only in changes and parses spaces/unicode/arrows literally', async () => {
  init(scope.base)
  const name = process.platform === 'win32' ? '中文 → spaced name.txt' : '中文 -> spaced name.txt'
  fs.writeFileSync(path.join(scope.base, name), 'new\n')
  expect((await query()).data.files).toEqual([expect.objectContaining({ path: name, staged: false, stagedChange: null, unstagedChange: 'untracked', changeType: 'untracked' })])
  expect(await action('stage', { path: name })).toMatchObject({ code: 200, data: { success: true } })
  expect((await query()).data.files).toEqual([expect.objectContaining({ path: name, staged: true, stagedChange: 'added', unstagedChange: null })])
})

it('reports staged additions and later worktree edits independently', async () => {
  init(scope.base)
  fs.writeFileSync(path.join(scope.base, 'new.txt'), 'staged\n')
  git(scope.base, ['add', '--', 'new.txt'])
  fs.appendFileSync(path.join(scope.base, 'new.txt'), 'unstaged\n')
  expect((await query()).data.files).toEqual([expect.objectContaining({ path: 'new.txt', staged: true, stagedChange: 'added', unstagedChange: 'modified' })])
})

it('preserves rename source paths without line-based parsing', async () => {
  init(scope.base)
  const renamed = process.platform === 'win32' ? 'renamed → 文件.txt' : 'renamed -> 文件.txt'
  git(scope.base, ['mv', '--', 'tracked.txt', renamed])
  expect((await query()).data.files).toEqual([expect.objectContaining({ path: renamed, oldPath: 'tracked.txt', stagedChange: 'renamed', unstagedChange: null })])
})

it('supports a repository found above cwd only when it stays inside the session workspace', async () => {
  init(scope.base)
  fs.mkdirSync(path.join(scope.base, 'sub'))
  fs.writeFileSync(path.join(scope.base, 'sub', 'new.txt'), 'new\n')
  expect((await query('status', '&cwd=sub')).data).toMatchObject({ isRepo: true, branch: 'workspace-main', files: [expect.objectContaining({ path: 'sub/new.txt' })] })
})

it('ignores inherited Git directory/worktree/index/config environment overrides', async () => {
  init(scope.base)
  fs.writeFileSync(path.join(scope.base, 'new.txt'), 'new\n')
  vi.stubEnv('GIT_DIR', path.join(outside, '.git'))
  vi.stubEnv('GIT_WORK_TREE', outside)
  vi.stubEnv('GIT_INDEX_FILE', path.join(outside, '.git', 'index'))
  vi.stubEnv('GIT_COMMON_DIR', path.join(outside, '.git'))
  vi.stubEnv('GIT_OBJECT_DIRECTORY', path.join(outside, '.git', 'objects'))
  vi.stubEnv('GIT_CONFIG_COUNT', '1')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree')
  vi.stubEnv('GIT_CONFIG_VALUE_0', outside)
  expect((await query()).data.files).toEqual([expect.objectContaining({ path: 'new.txt', stagedChange: null })])
  expect(await action('stage', { path: 'new.txt' })).toMatchObject({ code: 200, data: { success: true } })
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
  expect(git(scope.base, ['diff', '--cached', '--name-only']).trim()).toBe('new.txt')
})

it('overrides core.worktree so stored config cannot redirect outside the workspace', async () => {
  init(scope.base)
  git(scope.base, ['config', 'core.worktree', outside])
  fs.writeFileSync(path.join(scope.base, 'tenant-only.txt'), 'tenant\n')
  expect((await query()).data.files).toEqual([expect.objectContaining({ path: 'tenant-only.txt' })])
  expect(await action('stage', { path: 'tenant-only.txt' })).toMatchObject({ code: 200, data: { success: true } })
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

it('rejects .git files that point to an external repository', async () => {
  fs.writeFileSync(path.join(scope.base, '.git'), `gitdir: ${path.join(outside, '.git')}\n`)
  expect((await query()).code).not.toBe(200)
  expect((await action('stage-all-commit', { message: 'must not run' })).code).not.toBe(200)
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

it('rejects .git junctions that point to an external repository', async () => {
  fs.symlinkSync(path.join(outside, '.git'), path.join(scope.base, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
  expect((await query()).code).not.toBe(200)
  expect((await action('stage-all-commit', { message: 'must not run' })).code).not.toBe(200)
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

it('rejects linked worktree common directories outside the session', async () => {
  const linked = path.join(scope.base, 'linked')
  git(outside, ['worktree', 'add', '-b', 'isolated-link', linked])
  const pointer = fs.readFileSync(path.join(linked, '.git'), 'utf8').trim().slice('gitdir: '.length)
  const localGit = path.join(scope.base, 'metadata')
  fs.cpSync(pointer, localGit, { recursive: true })
  fs.writeFileSync(path.join(localGit, 'commondir'), path.join(outside, '.git'))
  fs.unlinkSync(path.join(linked, '.git'))
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${localGit}\n`)
  expect((await query('status', '&cwd=linked')).code).not.toBe(200)
})

it('supports linked worktrees when both gitdir and common directory are in the workspace', async () => {
  const source = path.join(scope.base, 'source'), linked = path.join(scope.base, 'linked')
  init(source)
  git(source, ['worktree', 'add', '-b', 'isolated-link', linked])
  fs.writeFileSync(path.join(linked, 'linked-only.txt'), 'linked\n')
  expect((await query('status', '&cwd=linked')).data).toMatchObject({ isRepo: true, branch: 'isolated-link', files: [expect.objectContaining({ path: 'linked-only.txt', stagedChange: null })] })
})

it('rejects object alternates outside the workspace', async () => {
  init(scope.base)
  const alternates = path.join(scope.base, '.git', 'objects', 'info', 'alternates')
  fs.writeFileSync(alternates, path.join(outside, '.git', 'objects') + '\n')
  expect((await query()).code).not.toBe(200)
  expect((await query('log')).code).not.toBe(200)
})

it('does not accept a request workspaceRoot as a replacement for authenticated session scope', async () => {
  expect((await query('status', `&workspaceRoot=${encodeURIComponent(outside)}`)).data).toMatchObject({ isRepo: false, files: [] })
  expect((await action('stage-all-commit', { workspaceRoot: outside, message: 'must not run' })).code).not.toBe(200)
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

it('rejects direct diff reads through a directory link outside the workspace', async () => {
  init(scope.base)
  fs.symlinkSync(outside, path.join(scope.base, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const response = await query('diff', '&path=escape/tracked.txt')
  expect(response.code).not.toBe(200)
  expect(JSON.stringify(response)).not.toContain('private engine modification')
  expect((await query('status', '&cwd=escape')).code).not.toBe(200)
})

it('refuses linked gitignore targets outside the workspace', async () => {
  init(scope.base)
  fs.symlinkSync(outside, path.join(scope.base, '.gitignore'), process.platform === 'win32' ? 'junction' : 'dir')
  const response = await action('append-gitignore', { path: 'new.txt' })
  expect(response.code).not.toBe(200)
  expect(response.message).toContain('outside the current workspace')
  expect(fs.readFileSync(path.join(outside, 'tracked.txt'), 'utf8')).toBe('private engine modification\n')
})

it('refuses clone destinations whose directory link leaves the workspace', async () => {
  fs.symlinkSync(outside, path.join(scope.base, 'engine'), process.platform === 'win32' ? 'junction' : 'dir')
  const response = await action('clone', { url: pathToFileURL(outside).href })
  expect(response.code).not.toBe(200)
  expect(response.message).toContain('outside the current workspace')
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

it('rejects an internal alternate chain that ultimately points outside the workspace', async () => {
  init(scope.base)
  const alternate = path.join(scope.base, 'alternate-objects')
  fs.mkdirSync(path.join(alternate, 'info'), { recursive: true })
  fs.writeFileSync(path.join(scope.base, '.git', 'objects', 'info', 'alternates'), alternate + '\n')
  fs.writeFileSync(path.join(alternate, 'info', 'alternates'), path.join(outside, '.git', 'objects') + '\n')
  const response = await query('log')
  expect(response.code).not.toBe(200)
  expect(response.message).toContain('outside the current workspace')
})

it('bounds alternate cycle traversal while permitting entirely internal object stores', async () => {
  init(scope.base)
  const objects = path.join(scope.base, '.git', 'objects')
  const alternate = path.join(scope.base, 'alternate-objects')
  fs.mkdirSync(path.join(alternate, 'info'), { recursive: true })
  fs.writeFileSync(path.join(objects, 'info', 'alternates'), alternate + '\n')
  fs.writeFileSync(path.join(alternate, 'info', 'alternates'), objects + '\n')
  expect((await query('branch-info')).data).toMatchObject({ success: true, isRepo: true, info: { branch: 'workspace-main' } })
})

it('refuses file clone sources outside the workspace', async () => {
  const response = await action('clone', { url: pathToFileURL(outside).href })
  expect(response.code).not.toBe(200)
  expect(response.message).toContain('outside the current workspace')
  expect(fs.existsSync(path.join(scope.base, 'engine'))).toBe(false)
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

it('refuses file clone sources reached through an internal link to an external path', async () => {
  const links = path.join(scope.base, 'links')
  fs.mkdirSync(links)
  const source = path.join(links, 'engine')
  fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
  const response = await action('clone', { url: pathToFileURL(source).href })
  expect(response.code).not.toBe(200)
  expect(response.message).toContain('outside the current workspace')
  expect(fs.existsSync(path.join(scope.base, 'engine'))).toBe(false)
})

it('refuses file clone URLs with a UNC host before accessing a network share', async () => {
  const response = await action('clone', { url: 'file://aether-test.invalid/shared/engine' })
  expect(response.code).not.toBe(200)
  expect(response.message).toContain('File clone sources must be local paths')
  expect(fs.existsSync(path.join(scope.base, 'engine'))).toBe(false)
})

it('permits file cloning from an internal repository with normalized drive casing', async () => {
  const source = path.join(scope.base, 'projects', 'source')
  init(source)
  let url = pathToFileURL(source).href
  if (process.platform === 'win32') url = url.replace(/^file:\/\/\/([A-Z]):/, (_match, drive: string) => `file:///${drive.toLowerCase()}:`)
  const response = await action('clone', { url })
  expect(response).toMatchObject({ code: 200, data: { success: true, finalPath: path.join(scope.base, 'source') } })
  expect(fs.readFileSync(path.join(scope.base, 'source', 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('initial\n')
  expect((await query('status', '&cwd=source')).data).toMatchObject({ isRepo: true, files: [] })
})

it('applies the real workspace root link guard even when cwd is omitted', async () => {
  const { WorkspaceManager } = await vi.importActual<typeof import('../../../../workspace/manager.js')>('../../../../workspace/manager.js')
  const privateRoot = path.join(fixture, 'private')
  scope.base = path.join(privateRoot, 'default', 'session')
  fs.mkdirSync(path.dirname(scope.base), { recursive: true })
  fs.symlinkSync(outside, scope.base, process.platform === 'win32' ? 'junction' : 'dir')
  const manager = new WorkspaceManager(privateRoot)
  vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((_context, value) => manager.resolveSafePath({ tenantId: 'default', sessionId: 'session' }, value))
  const response = await query()
  expect(response.code).not.toBe(200)
  expect(response.message).toContain('Workspace session root contains a symbolic link')
  const mutation = await action('init')
  expect(mutation.code).not.toBe(200)
  expect(mutation.message).toContain('Workspace session root contains a symbolic link')
  expect(fs.readFileSync(path.join(outside, '.git', 'index')).equals(parentIndex)).toBe(true)
})

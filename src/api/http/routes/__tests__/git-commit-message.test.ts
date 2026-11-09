/** Real Git/Fastify: multiline commit bodies and pre-dispatch validation. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gitRoutes } from '../git.js'

vi.setConfig({ testTimeout: 20_000 })

const scope = vi.hoisted(() => ({ root: '', admissions: 0 }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: {
  getWorkingDirectory: () => scope.root,
  getBindingSnapshot: () => ({ root: scope.root, epoch: 'commit-message' }),
  withBindingLease: async (_owner: unknown, _expected: unknown, action: (lease: { snapshot: { root: string; epoch: string }; assertCurrent(): void }) => Promise<unknown>) => {
    scope.admissions++
    return action({ snapshot: { root: scope.root, epoch: 'commit-message' }, assertCurrent() {} })
  },
  resolveSafePath: (_owner: unknown, file: string) => path.resolve(scope.root, file)
} }))

let fixture: string
let app: FastifyInstance
function git(args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  return execFileSync('git', ['-C', scope.root, ...args], { encoding: 'utf8', env, windowsHide: true })
}
function write(file: string, value: string): void { fs.writeFileSync(path.join(scope.root, file), value) }
async function action(op: string, message?: unknown) {
  return (await app.inject({ method: 'POST', url: '/git/action', payload: {
    sessionId: 'session', expectedRoot: scope.root, bindingEpoch: 'commit-message', op, message
  } })).json()
}
function storedMessage(): string {
  const object = git(['cat-file', 'commit', 'HEAD'])
  return object.slice(object.indexOf('\n\n') + 2)
}

beforeEach(async () => {
  fixture = path.resolve('.e2e-tmp', 'git-commit-message-' + randomUUID())
  scope.root = path.join(fixture, 'task'); scope.admissions = 0
  fs.mkdirSync(scope.root, { recursive: true })
  git(['init', '-b', 'main'])
  for (const [key, value] of [['user.name', 'Commit Fixture'], ['user.email', 'commit@example.invalid'], ['commit.gpgSign', 'false'], ['core.autocrlf', 'false'], ['core.editor', 'false']]) git(['config', key, value])
  write('tracked.txt', 'baseline\n'); git(['add', '-A']); git(['commit', '-m', 'initial'])
  app = Fastify(); await app.register(gitRoutes); await app.ready()
})

afterEach(async () => {
  await app.close()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('git-commit-message-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

it.each(['commit', 'stage-all-commit', 'commit-amend-message', 'commit-empty'])('%s records a multiline Chinese body, paragraphs and tabs', async op => {
  const before = git(['rev-parse', 'HEAD'])
  const message = 'feat(subagent): 增强子代理结果完整性\n\n1. 共享类型与引擎层：补充结果字段。\n2. Work 视图：\t展示完整结果。\n'
  write('tracked.txt', 'committed change\n')
  if (op !== 'stage-all-commit') git(['add', 'tracked.txt'])
  expect(await action(op, message)).toMatchObject({ code: 200, data: { success: true } })
  expect(git(['rev-parse', 'HEAD'])).not.toBe(before)
  expect(storedMessage()).toBe(message)
  expect(git(['show', 'HEAD:tracked.txt'])).toBe('committed change\n')
  expect(git(['diff', '--cached'])).toBe('')
})

it('accepts Windows paragraph line endings and retains empty-commit behavior', async () => {
  const message = '修复提交说明\r\n\r\n第一项\r\n第二项\t补充细节\r\n'
  expect(await action('commit-empty', message)).toMatchObject({ code: 200, data: { success: true } })
  expect(storedMessage()).toBe(message.replace(/\r\n/g, '\n'))
  expect(await action('commit-empty')).toMatchObject({ code: 200, data: { success: true } })
  expect(storedMessage()).toBe('')
})

it('rejects invalid smart-commit messages before repository admission without staging or altering files', async () => {
  write('tracked.txt', 'already staged\n'); git(['add', 'tracked.txt'])
  write('tracked.txt', 'unstaged changes\n'); write('new.txt', 'untracked changes\n')
  const index = fs.readFileSync(path.join(scope.root, '.git', 'index'))
  const head = git(['rev-parse', 'HEAD'])
  const cases: Array<[unknown, string]> = [
    ['title\nbody\0hidden', '控制字符'],
    ['title\u001bhidden', '控制字符'],
    ['title\u007fhidden', '控制字符'],
    [' \r\n\t', '不能为空'],
    ['x'.repeat(32_001), '不能超过 32000'],
    [42, '必须是文本']
  ]
  for (const [message, error] of cases) {
    expect(await action('stage-all-commit', message)).toMatchObject({ code: 50000,
      data: { success: false, executionDisposition: 'not_started', error: expect.stringContaining(error) } })
    expect(scope.admissions).toBe(0)
    expect(fs.readFileSync(path.join(scope.root, '.git', 'index'))).toEqual(index)
    expect(git(['rev-parse', 'HEAD'])).toBe(head)
    expect(fs.readFileSync(path.join(scope.root, 'tracked.txt'), 'utf8')).toBe('unstaged changes\n')
    expect(fs.readFileSync(path.join(scope.root, 'new.txt'), 'utf8')).toBe('untracked changes\n')
  }
})

it.each(['commit', 'commit-amend-message', 'commit-empty'])('%s rejects invalid text before admission', async op => {
  const head = git(['rev-parse', 'HEAD'])
  expect(await action(op, 'title\0hidden')).toMatchObject({ code: 50000,
    data: { success: false, executionDisposition: 'not_started', error: expect.stringContaining('控制字符') } })
  expect(scope.admissions).toBe(0)
  expect(git(['rev-parse', 'HEAD'])).toBe(head)
})

it('keeps a rejected real smart commit non-replayable after staging has changed the index', async () => {
  const head = git(['rev-parse', 'HEAD'])
  const index = fs.readFileSync(path.join(scope.root, '.git', 'index'))
  write('tracked.txt', 'must remain staged after hook rejection\n')
  write('new.txt', 'new staged content\n')
  git(['config', 'core.hooksPath', '.git/hooks'])
  fs.writeFileSync(path.join(scope.root, '.git', 'hooks', 'pre-commit'),
    "#!/bin/sh\nprintf '%s\\n' 'FIXTURE_PRE_COMMIT_REJECTED' >&2\nexit 1\n", { mode: 0o755 })

  expect(await action('stage-all-commit', '有效提交标题\n\n有效的多行正文')).toMatchObject({ code: 200,
    data: { success: false, executionDisposition: 'may_have_effects', error: expect.stringContaining('FIXTURE_PRE_COMMIT_REJECTED') } })
  expect(scope.admissions).toBe(1)
  expect(git(['rev-parse', 'HEAD'])).toBe(head)
  expect(fs.readFileSync(path.join(scope.root, '.git', 'index'))).not.toEqual(index)
  expect(git(['diff', '--cached', '--name-only'])).toBe('new.txt\ntracked.txt\n')
  expect(git(['show', ':0:tracked.txt'])).toBe('must remain staged after hook rejection\n')
  expect(git(['show', ':0:new.txt'])).toBe('new staged content\n')
})

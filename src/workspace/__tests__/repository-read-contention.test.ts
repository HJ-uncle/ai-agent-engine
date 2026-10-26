/** Actual Windows job closure and index writes, plus bounded admission failure. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { acquireRepositoryLease, withRepositoryLease } from '../repository-lease.js'

let fixture: string
const env = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: env(), windowsHide: true, encoding: 'utf8' })
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
beforeEach(() => { fixture = path.resolve('.e2e-tmp', 'repository-read-contention-' + randomUUID()); fs.mkdirSync(fixture, { recursive: true }) })
afterEach(() => {
  vi.restoreAllMocks()
  if (!fixture.startsWith(path.resolve('.e2e-tmp') + path.sep) || !path.basename(fixture).startsWith('repository-read-contention-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})
it.skipIf(process.platform !== 'win32')('stage waits for a native read scope and changes the index after closure', async () => {
  git(fixture, ['init']); fs.writeFileSync(path.join(fixture, 'report.txt'), 'reader then writer\n')
  const file = path.join(fixture, '.git', '.aether-operation.lock'), entered = gate(), release = gate()
  const reader = withRepositoryLease(file, async scope => {
    await scope.run('git', ['status', '--porcelain'], { cwd: fixture, env: env() })
    entered.release(); await release.promise
  }, 30_000, undefined, 'read')
  await entered.promise
  const writer = withRepositoryLease(file, scope => scope.run('git', ['add', '--', 'report.txt'], { cwd: fixture, env: env() }))
  const outcome = writer.then(value => ({ value }), error => ({ error }))
  try { expect(git(fixture, ['ls-files', '--stage'])).toBe('') } finally { release.release(); await reader }
  const result = await outcome
  expect('error' in result ? String(result.error) : '').toBe('')
  expect(git(fixture, ['show', ':report.txt'])).toBe('reader then writer\n')
  expect(fs.existsSync(file)).toBe(false)
  expect(JSON.parse(fs.readFileSync(file + '.last-audit.json', 'utf8')).proof).toMatchObject({ jobExists: false, supervisorAlive: false, empty: true })
}, 20_000)
it.skipIf(process.platform !== 'win32')('competing writes are refused before dispatch and keep the original lease', async () => {
  const file = path.join(fixture, 'writer.lock'), held = await acquireRepositoryLease(file)
  let dispatched = false
  try {
    await expect(withRepositoryLease(file, async () => { dispatched = true })).rejects.toMatchObject({ code: 'GIT_REPOSITORY_BUSY', executionDisposition: 'not_started' })
    expect(dispatched).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).generation).toBe(held.owner.generation)
  } finally { held.release() }
})
it.skipIf(process.platform !== 'win32')('reader waiting is bounded and never releases the held generation on timeout', async () => {
  const file = path.join(fixture, 'reader.lock'), held = await acquireRepositoryLease(file, 0, undefined, 'read')
  const original = fs.readFileSync(file), started = Date.now()
  const waiting = acquireRepositoryLease(file).then(value => { value.release(); return null }, error => error)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(started + 31_000)
  try {
    expect(await waiting).toMatchObject({ code: 'GIT_REPOSITORY_BUSY', executionDisposition: 'not_started' })
    expect(fs.readFileSync(file)).toEqual(original)
  } finally { clock.mockRestore(); held.release() }
})
it.skipIf(process.platform !== 'win32')('a new writer replacing a read lease is refused with its generation intact', async () => {
  const file = path.join(fixture, 'replacement.lock'), held = await acquireRepositoryLease(file, 0, undefined, 'read')
  const waiting = acquireRepositoryLease(file).then(value => { value.release(); return null }, error => error)
  const next = { ...held.owner, generation: randomUUID(), access: 'write' }
  next.jobName = 'Local\\AetherGit-' + next.generation
  fs.writeFileSync(file, JSON.stringify(next))
  try {
    expect(await waiting).toMatchObject({ code: 'GIT_REPOSITORY_BUSY', executionDisposition: 'not_started' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).generation).toBe(next.generation)
  } finally { fs.unlinkSync(file) }
})

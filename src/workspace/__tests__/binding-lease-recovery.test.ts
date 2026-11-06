/** Recovery admission must fence the check/open gap without deleting a successor. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquireResourceLease, type LeaseOwner } from '../binding-lease.js'

let fixture: string
let file: string

beforeEach(() => {
  fixture = path.resolve('.e2e-tmp', `binding-recovery-admission-${randomUUID()}`)
  fs.mkdirSync(fixture, { recursive: true })
  file = path.join(fixture, 'session.lock')
})

afterEach(() => {
  vi.restoreAllMocks()
  const resolved = path.resolve(fixture)
  if (!resolved.startsWith(path.resolve('.e2e-tmp') + path.sep) || !path.basename(resolved).startsWith('binding-recovery-admission-'))
    throw new Error('Unsafe fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
})

it('does not admit a session when recovery starts between the guard check and exclusive open', () => {
  const open = fs.openSync.bind(fs)
  let interleaved = false
  vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
    if (target === file && flags === 'wx' && !interleaved) {
      interleaved = true
      fs.writeFileSync(file + '.recovery.lock', 'active guard')
    }
    return open(target, flags, mode)
  })
  expect(() => acquireResourceLease(file, 'workspace session')).toThrow('recovery is in progress')
  expect(interleaved).toBe(true)
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.readFileSync(file + '.recovery.lock', 'utf8')).toBe('active guard')
})

it('retains a successor generation when the post-open recovery fence rejects admission', () => {
  const exists = fs.existsSync.bind(fs)
  const successor: LeaseOwner = { pid: process.pid, generation: randomUUID(), acquiredAt: new Date().toISOString(), resource: 'workspace session' }
  let guardChecks = 0
  vi.spyOn(fs, 'existsSync').mockImplementation(target => {
    if (target === file + '.recovery.lock' && ++guardChecks === 2) {
      fs.writeFileSync(file, JSON.stringify(successor))
      fs.writeFileSync(file + '.recovery.lock', 'active guard')
    }
    return exists(target)
  })
  expect(() => acquireResourceLease(file, 'workspace session')).toThrow('recovery is in progress')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(successor)
})

import Fastify, { type FastifyInstance } from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { withFileLocks } from '../../../../shared/file-version.js'
import { workspaceRoutes } from '../workspace.js'

const { resolveSafePath } = vi.hoisted(() => ({ resolveSafePath: vi.fn() }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: { resolveSafePath } }))
let app: FastifyInstance
let fixture: string
beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d2-workspace-lock-'))
  resolveSafePath.mockReset().mockImplementation((_context, name: string) => path.join(fixture, name))
  app = Fastify()
  await app.register(workspaceRoutes)
  await app.ready()
})
afterEach(async () => {
  await app.close()
  if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith('aether-d2-workspace-lock-')) throw new Error('Unsafe test cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})

it('manual REST writes wait for the same file lock as tools and rollback', async () => {
  const target = path.join(fixture, 'file.txt')
  fs.writeFileSync(target, 'initial')
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(done => { entered = done })
  const blocked = new Promise<void>(done => { release = done })
  const holder = withFileLocks([target], async () => {
    entered()
    await blocked
    fs.writeFileSync(target, 'tool operation completed')
  })
  await started
  const pending = app.inject({ method: 'POST', url: '/workspace/file', payload: {
    sessionId: 'test', path: 'file.txt', content: 'manual edit',
  } }).then(response => response)
  try {
    await vi.waitFor(() => expect(resolveSafePath).toHaveBeenCalled())
    expect(fs.readFileSync(target, 'utf8')).toBe('initial')
  } finally { release(); await holder }
  expect((await pending).json().code).toBe(200)
  expect(fs.readFileSync(target, 'utf8')).toBe('manual edit')
})

it('racing manual creates cannot truncate an existing file', async () => {
  const target = path.join(fixture, 'file.txt')
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(done => { entered = done })
  const blocked = new Promise<void>(done => { release = done })
  const holder = withFileLocks([target], async () => {
    entered(); await blocked; fs.writeFileSync(target, 'created by another operation')
  })
  await started
  const pending = app.inject({ method: 'POST', url: '/workspace/file/create', payload: {
    sessionId: 'test', path: 'file.txt',
  } }).then(response => response)
  try { await vi.waitFor(() => expect(resolveSafePath).toHaveBeenCalled()) }
  finally { release(); await holder }
  expect((await pending).json().code).toBe(40000)
  expect(fs.readFileSync(target, 'utf8')).toBe('created by another operation')
})

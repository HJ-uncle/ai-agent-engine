import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { WorkspaceManager } from '../manager.js'
import { acquireResourceLease } from '../binding-lease.js'

let fixture = ''
let root = ''
let project = ''
let bindingsFile = ''

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-bind-concurrency-'))
  root = path.join(fixture, 'private')
  project = path.join(fixture, 'project')
  bindingsFile = path.join(fixture, 'workspace-bindings.json')
  fs.mkdirSync(root)
  fs.mkdirSync(project)
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('AETHER_DESKTOP_OWNED', '1')
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', bindingsFile)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(fixture, { recursive: true, force: true })
})

describe('WorkspaceManager asynchronous binding', () => {
  it('waits for an active session bind instead of returning WORKSPACE_LEASE_BUSY', async () => {
    const manager = new WorkspaceManager(root)
    const ctx = { tenantId: 'tenant', sessionId: 'session' }
    const leaseFile = `${bindingsFile}.session-${createHash('sha256').update('tenant\u0000session').digest('hex')}.lock`
    const holder = acquireResourceLease(leaseFile, 'workspace session', ctx)

    let settled = false
    const pending = manager.bindSnapshotAsync(ctx, project, 1_000).then(result => {
      settled = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)

    holder.release()
    await expect(pending).resolves.toMatchObject({ root: fs.realpathSync(project) })
    expect(settled).toBe(true)
  })
})

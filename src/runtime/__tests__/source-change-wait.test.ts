import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../storage/sqlite/db.js'
import { RootRunStore } from '../../storage/root-runs/index.js'
import { captureSourceFiles } from '../source-change-protocol.js'
import { clearSourceChangeWaitSamples, getSourceChangeWaitStatus } from '../source-change-wait.js'

let fixture: string
let db: Client
let roots: RootRunStore

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-source-wait-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = createClient({ url: `file:${path.join(fixture, 'agent.db')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  roots = new RootRunStore(() => db)
  // Ensure the durable root schema is ready before creating fixture runs.
  // The wait helper itself only reads this table.
  await roots.initialize()
  clearSourceChangeWaitSamples()
})

afterEach(() => {
  clearSourceChangeWaitSamples()
  db.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
})

describe('source-change wait status', () => {
  it('waits for the overlapping run, then requires a stable source window', async () => {
    const file = path.join(fixture, 'source.ts')
    fs.writeFileSync(file, 'before')
    const current = await roots.create('tenant', 'current', 'model', [fixture], {})
    const foreign = await roots.create('tenant', 'foreign', 'model', [fixture], {})
    const snapshot = captureSourceFiles([file], fixture)

    const blocked = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture,
      currentSessionId: current.sessionId, currentRunId: current.runId, snapshot, now: 1_000 })
    expect(blocked).toMatchObject({ ready: false, reason: 'external-writer', blockers: [{ kind: 'run', runId: foreign.runId }] })

    await roots.update('tenant', foreign.runId, { status: 'succeeded' })
    const settling = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture,
      currentSessionId: current.sessionId, currentRunId: current.runId, snapshot: blocked.currentSnapshot, now: 1_100 })
    expect(settling).toMatchObject({ ready: false, reason: 'stable-window', blockers: [] })
    const ready = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture,
      currentSessionId: current.sessionId, currentRunId: current.runId, snapshot: settling.currentSnapshot, now: 3_000 })
    expect(ready).toMatchObject({ ready: true, reason: 'ready', blockers: [] })
  })

  it('treats a manually stopped blocking run as ended only after its durable status converges', async () => {
    const file = path.join(fixture, 'source.ts')
    fs.writeFileSync(file, 'before')
    const current = await roots.create('tenant', 'current', 'model', [fixture], {})
    const foreign = await roots.create('tenant', 'foreign', 'model', [fixture], {})
    const snapshot = captureSourceFiles([file], fixture)

    const blocked = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture,
      currentSessionId: current.sessionId, currentRunId: current.runId, snapshot, now: 1_000 })
    expect(blocked.blockers).toHaveLength(1)

    // A user stop moves the foreign RootRun out of the active writer set.
    // The waiting run still requires the normal stable window before resume.
    await roots.update('tenant', foreign.runId, { status: 'cancelled', stopReason: 'Stopped by user' })
    const settling = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture,
      currentSessionId: current.sessionId, currentRunId: current.runId, snapshot, now: 1_100 })
    expect(settling).toMatchObject({ ready: false, reason: 'stable-window', blockers: [] })
    const ready = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture,
      currentSessionId: current.sessionId, currentRunId: current.runId, snapshot, now: 3_000 })
    expect(ready).toMatchObject({ ready: true, reason: 'ready', blockers: [] })
  })

  it('resets the stable window when the source keeps changing', async () => {
    const file = path.join(fixture, 'source.ts')
    fs.writeFileSync(file, 'one')
    const snapshot = captureSourceFiles([file], fixture)
    const first = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture, snapshot, now: 1_000 })
    fs.writeFileSync(file, 'two')
    const second = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture, snapshot: first.currentSnapshot, now: 1_100 })
    expect(second).toMatchObject({ ready: false, reason: 'source-changing', sourceChanged: true })
    fs.writeFileSync(file, 'three')
    const third = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture, snapshot: second.currentSnapshot, now: 2_000 })
    expect(third).toMatchObject({ ready: false, reason: 'source-changing', sourceChanged: true })
  })

  it('settles after an external edit while the durable pending snapshot stays sealed', async () => {
    const file = path.join(fixture, 'source.ts')
    fs.writeFileSync(file, 'before')
    const snapshot = captureSourceFiles([file], fixture)

    // The first probe records the sealed version used by the pending action.
    await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture, snapshot, now: 1_000 })
    fs.writeFileSync(file, 'external edit')
    const changed = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture, snapshot, now: 1_100 })
    expect(changed).toMatchObject({ ready: false, reason: 'source-changing', sourceChanged: true })

    // Production continuation polls with the same durable `action.after`.
    // It must eventually pass the stable window instead of reporting a change
    // forever against that sealed baseline.
    const settling = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture, snapshot, now: 1_200 })
    expect(settling).toMatchObject({ ready: false, reason: 'stable-window', sourceChanged: true })
    const ready = await getSourceChangeWaitStatus({ tenantId: 'tenant', root: fixture, snapshot, now: 3_000 })
    expect(ready).toMatchObject({ ready: true, reason: 'ready', sourceChanged: true })
  })
})


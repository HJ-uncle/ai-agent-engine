import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../store.js'
import type { SubagentEvent, SubagentRun } from '../types.js'

let directory: string
let db: LocalSqliteProcessClient
let store: SubagentStore
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-child-watermark-'))
  db = new LocalSqliteProcessClient({ url: `file:${path.join(directory, 'runs.db')}` })
  store = new SubagentStore(db)
})
afterEach(async () => {
  db.close()
  await db.whenClosed()
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('aether-child-watermark-')) throw new Error('Unsafe watermark fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

function child(runId: string, seq: number, tenantId = 'tenant', tokens = 5): SubagentRun {
  return { schemaVersion: 1, runId, tenantId, rootSessionId: 'session', parentSessionId: 'session',
    parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: `tool-${runId}`,
    childSessionId: `subagent-${runId}`, task: 'review', description: 'review', modelId: 'fixture',
    status: 'running', lastSeq: seq, createdAt: 1, updatedAt: seq, usage: { totalTokens: tokens },
    toolCalls: [], transcriptRef: `session:subagent-${runId}` }
}
function insert(run: SubagentRun) {
  const event: SubagentEvent = { schemaVersion: 1, kind: 'usage.updated', runId: run.runId, seq: run.lastSeq, snapshot: run }
  return { sql: 'INSERT INTO subagent_events (tenant_id,run_id,seq,kind,event) VALUES (?,?,?,?,?)',
    args: [run.tenantId, run.runId, run.lastSeq, event.kind, JSON.stringify(event)] }
}

describe('immutable published child watermarks', () => {
  it('loads multiple SQL pages at exact delivered sequences and isolates identical foreign IDs', async () => {
    expect(await store.getSnapshotsAtSequences('tenant', [])).toEqual([])
    const watermarks = Array.from({ length: 405 }, (_, index) => ({ runId: `child-${index}`, seq: 2 }))
    await db.batch([
      ...watermarks.map(item => insert(child(item.runId, item.seq))),
      insert(child('child-0', 3, 'tenant', 10_000)), insert(child('child-0', 2, 'other-tenant', 50_000)),
    ], 'write')
    const recovered = await store.getSnapshotsAtSequences('tenant', watermarks)
    expect(recovered).toHaveLength(405)
    expect(new Set(recovered.map(run => run.runId)).size).toBe(405)
    expect(recovered.every(run => run.lastSeq === 2 && run.tenantId === 'tenant')).toBe(true)
    expect(recovered.reduce((sum, run) => sum + run.usage.totalTokens!, 0)).toBe(405 * 5)
  })
})

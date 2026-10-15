// Real native SQLite transactions prove that optional controller setup cannot
// break standalone children, while relevant damaged controller state stays closed.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../../subagent/store.js'
import { controllerDigest, ensureControllerSchema } from '../controller-origin.js'
import { ensureCollaborationSchema } from '../schema.js'
import { ensureSQLiteDeliverySchema } from '../delivery-schema.js'
import { ensureJSONLDeliverySchema } from '../jsonl-delivery-schema.js'

const cases = ['no-ledger', 'empty-ledger', 'other-tenant', 'other-invocation', 'missing-messages', 'missing-sqlite-deliveries', 'missing-jsonl-deliveries'] as const
describe.each(['modern', 'legacy'] as const)('%s terminal with partial controller setup', mode => {
  it.each(cases)('keeps the exact child boundary for %s', async setup => {
    const directory = path.resolve('.e2e-tmp', 'controller-terminal-schema-' + randomUUID())
    fs.mkdirSync(directory, { recursive: true })
    const db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
    try {
      const store = new SubagentStore(db), tenantId = 'schema-child-tenant'
      const input = { tenantId, rootSessionId: 'root', parentSessionId: 'root', parentConversationId: 'turn',
        parentMessageId: 'dispatch', parentToolCallId: 'spawn', task: 'Synthetic child task', description: 'Schema boundary', modelId: 'no-provider' }
      const run = mode === 'modern' ? (await store.createRunDelta(input)).header : (await store.createRun(input)).snapshot
      if (setup !== 'no-ledger') await ensureControllerSchema(db)
      const corrupt = setup.startsWith('missing-')
      if (setup === 'other-tenant' || setup === 'other-invocation' || corrupt) {
        const originTenant = setup === 'other-tenant' ? 'another-tenant' : tenantId
        const invocation = setup === 'other-invocation' ? 'another-invocation' : run.runId
        const body = 'Synthetic original controller instruction', subject = 'synthetic-user'
        await db.execute({ sql: 'INSERT INTO collaboration_controller_origins VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [
          originTenant, 'root-run', 'root-attempt', 'controller-message', subject, 'account', 'jwt', 'root', 'generation',
          'controller:' + subject, 'controllerinv:' + controllerDigest('synthetic-invocation'), 'request', 'child:' + run.childSessionId,
          invocation, controllerDigest(body), Buffer.byteLength(body), body, 1,
        ] })
      }
      let missingTable = 'collaboration_messages'
      if (setup === 'missing-sqlite-deliveries' || setup === 'missing-jsonl-deliveries') {
        await ensureCollaborationSchema(db)
        await ensureSQLiteDeliverySchema(db)
        await ensureJSONLDeliverySchema(db)
        missingTable = setup === 'missing-sqlite-deliveries' ? 'collaboration_deliveries' : 'collaboration_jsonl_deliveries'
        await db.execute('DROP TABLE ' + missingTable)
      }
      const state = async () => {
        const result = []
        for (const table of ['subagent_runs', 'subagent_events', 'subagent_outbox']) {
          result.push((await db.execute('SELECT * FROM ' + table)).rows)
        }
        return result
      }
      const before = await state()
      const finish = () => mode === 'modern'
        ? store.appendHeader(tenantId, run.runId, 'finished', { status: 'succeeded', finishedAt: 10 })
        : store.appendSnapshot(tenantId, run.runId, 'finished', { status: 'succeeded', finishedAt: 10 })
      if (corrupt) {
        await expect(finish()).rejects.toThrow('no such table: ' + missingTable)
        expect(await state()).toEqual(before)
        expect((await store.getRunHeader(tenantId, run.runId))?.status).toBe('queued')
        expect(Number((await db.execute('SELECT count(*) AS n FROM collaboration_controller_origins')).rows[0].n)).toBe(1)
        expect((await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [missingTable] })).rows).toHaveLength(0)
      } else {
        await finish()
        expect((await store.getRunHeader(tenantId, run.runId))?.status).toBe('succeeded')
        expect(Number((await db.execute('SELECT count(*) AS n FROM subagent_outbox')).rows[0].n)).toBe(1)
        // Optional setup must not create the collaboration main tables merely to
        // finish a child that has never received controller instructions.
        expect((await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_messages'")).rows).toHaveLength(0)
        if (setup !== 'no-ledger') expect(Number((await db.execute('SELECT count(*) AS n FROM collaboration_controller_origins')).rows[0].n)).toBe(setup === 'empty-ledger' ? 0 : 1)
      }
    } finally {
      const receipt = await db.closeWithReceipt()
      expect(receipt.healthy, JSON.stringify(receipt)).toBe(true)
      // Keep bounded failed and successful native evidence under owned scratch.
    }
  })
})

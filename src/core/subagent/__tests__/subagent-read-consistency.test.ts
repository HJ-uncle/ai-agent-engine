/** Two real WAL connections: fixed-watermark reads survive a concurrent commit; corrupt UTF-8 fails closed. */
import type { InStatement, Transaction, TransactionMode } from '@libsql/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentStore } from '../store.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import type { CreateSubagentRun } from '../types.js'

const tenant = 'read-consistency-tenant'
const runId = 'read-consistency-run'
const originalOutput = 'STABLE-界😀'
const laterOutput = 'LATER-界😀'
let fixtureDir: string
let readerDb: LocalSqliteProcessClient
let writerDb: LocalSqliteProcessClient
let reader: SubagentStore
let writer: SubagentStore
let atSeq: number

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Missing isolated fixture data')
  return value
}

beforeEach(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-read-consistency-'))
  const url = `file:${path.join(fixtureDir, 'fixture.db').replace(/\\/g, '/')}`
  readerDb = new LocalSqliteProcessClient({ url })
  await readerDb.execute('PRAGMA journal_mode=WAL')
  reader = new SubagentStore(readerDb)
  const input: CreateSubagentRun = {
    tenantId: tenant, runId, rootSessionId: 'root', parentSessionId: 'parent', parentConversationId: 'turn',
    parentMessageId: 'dispatch', parentToolCallId: 'delegate', childSessionId: 'child', task: 'Synthetic fixture',
    description: 'Read consistency', modelId: 'no-model',
  }
  await reader.createRunDelta(input)
  await reader.appendHeader(tenant, runId, 'started', { status: 'running' })
  await reader.upsertTool(tenant, runId, 'tool.started', { id: 'read-1', name: 'read_file', args: { text: '界😀' }, status: 'running' })
  atSeq = required(await reader.upsertTool(tenant, runId, 'tool.completed', {
    id: 'read-1', name: 'read_file', status: 'succeeded', output: originalOutput,
  })).header.lastSeq
  writerDb = new LocalSqliteProcessClient({ url })
  writer = new SubagentStore(writerDb)
  // Complete additive schema checks before opening the pinned reader transaction.
  expect(required(await writer.getRunHeader(tenant, runId)).lastSeq).toBe(atSeq)
})

afterEach(async () => {
  vi.restoreAllMocks()
  writerDb.close()
  readerDb.close()
  await Promise.all([writerDb.whenClosed(), readerDb.whenClosed()])
  const target = path.resolve(fixtureDir)
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('aether-subagent-read-consistency-')) {
    throw new Error('Unsafe fixture cleanup path')
  }
  // Only this checked fixture is removed after both owned native processes exit.
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function commitAfterLatestProbe() {
  const openTransaction = readerDb.transaction.bind(readerDb)
  let readTransactions = 0, commits = 0
  const transactions: Transaction[] = []
  const opened = vi.spyOn(readerDb, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
    const tx = await openTransaction(mode)
    if (mode === 'read') {
      readTransactions++
      transactions.push(tx)
      const execute = tx.execute.bind(tx)
      vi.spyOn(tx, 'execute').mockImplementation(async (statement: InStatement) => {
        const result = await execute(statement)
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (commits === 0 && sql === 'SELECT seq FROM subagent_runs WHERE tenant_id=? AND run_id=?') {
          expect(Number(result.rows[0].seq)).toBe(atSeq)
          commits++
          const mutation = required(await writer.upsertTool(tenant, runId, 'tool.completed', {
            id: 'read-1', name: 'read_file', status: 'succeeded', output: laterOutput,
          }))
          expect(mutation.header.lastSeq).toBe(atSeq + 1)
          // The second connection has committed while the first still reads A.
          expect(required(await writer.getRunView(tenant, runId)).toolCalls[0].output).toBe(laterOutput)
        }
        return result
      })
    }
    return tx
  })
  return {
    verify() {
      expect(readTransactions).toBe(1)
      expect(commits).toBe(1)
      expect(transactions.every(tx => tx.closed)).toBe(true)
      opened.mockRestore()
    },
  }
}

describe('SubagentStore read consistency', () => {
  it('keeps a summary at its captured sequence when a second connection commits after the hot watermark probe', async () => {
    const probe = commitAfterLatestProbe()
    const view = required(await reader.getRunView(tenant, runId, { atSeq }))
    probe.verify()
    expect(view.lastSeq).toBe(atSeq)
    expect(view.coverage.asOfSeq).toBe(atSeq)
    expect(view.coverage.completeness).toBe('complete')
    expect(view.toolCalls).toHaveLength(1)
    expect(view.toolCalls[0]).toMatchObject({ revisionSeq: atSeq, output: originalOutput })
    expect(required(await reader.getRunView(tenant, runId)).toolCalls[0]).toMatchObject({ revisionSeq: atSeq + 1, output: laterOutput })
  })

  it('never labels a future tool revision with an older fixed-watermark page', async () => {
    const probe = commitAfterLatestProbe()
    const page = required(await reader.listToolsPage(tenant, runId, { atSeq }))
    probe.verify()
    expect(page.asOfSeq).toBe(atSeq)
    expect(page.totalCount).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ revisionSeq: atSeq, output: originalOutput })
    expect(page.items.every(tool => tool.revisionSeq <= page.asOfSeq)).toBe(true)
    expect(required(await reader.listToolsPage(tenant, runId, { atSeq: atSeq + 1 })).items[0].output).toBe(laterOutput)
  })

  it('rejects corrupt archived UTF-8 explicitly rather than replacing bytes and claiming exact json-utf8', async () => {
    const original = required(await reader.getToolDetail(tenant, runId, 'read-1', { atSeq }))
    const bytes = Buffer.from(original.detail.text, 'utf8')
    const start = bytes.indexOf(Buffer.from(originalOutput, 'utf8'))
    expect(start).toBeGreaterThan(0)
    bytes[start] = 0xff
    await writerDb.execute({
      sql: 'UPDATE subagent_tool_versions SET detail=CAST(? AS TEXT) WHERE tenant_id=? AND run_id=? AND tool_id=? AND seq=?',
      args: [bytes, tenant, runId, 'read-1', atSeq],
    })
    await expect(reader.getToolDetail(tenant, runId, 'read-1', { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
  })
})

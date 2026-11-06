/** Real SQLite selection: one frozen profile, no historical tool-body hydration. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InStatement, TransactionMode } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../store.js'
import { SubagentPayloadCodec } from '../payload-codec.js'
import { prepareCollaborators } from '../collaborators.js'
import type { CreateSubagentRun, SubagentContinuationProfile } from '../types.js'

let directory: string, db: LocalSqliteProcessClient, store: SubagentStore
const tenant = 'bounded-selection-tenant', parent = 'parent'
const agent: NonNullable<SubagentContinuationProfile['agent']> = { id: 'configured-executor', name: 'Configured executor',
  systemPrompt: 'Frozen original role', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['read_file', 'write_file'] }
const largeBody = 'PRIVATE_TOOL_BODY_'.repeat(32_768)
type Format = 'modern' | 'legacy'

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-collaborator-bounded-'))
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  store = new SubagentStore(db)
})
afterEach(async () => {
  vi.restoreAllMocks()
  expect((await db.closeWithReceipt()).healthy).toBe(true)
  const target = path.resolve(directory)
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('aether-collaborator-bounded-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function input(runId: string, overrides: Partial<CreateSubagentRun> = {}): CreateSubagentRun {
  return { tenantId: tenant, rootSessionId: parent, parentSessionId: parent, parentConversationId: 'turn',
    parentMessageId: 'message-' + runId, parentToolCallId: 'call-' + runId, runId, childSessionId: 'child-' + runId,
    task: 'Independent fixture task', description: runId, modelId: 'fixture',
    continuation: { readOnly: false, systemPrompt: 'Frozen permission profile', agent,
      toolNames: ['read_file', 'write_file'], workspacePaths: [directory] }, ...overrides }
}

async function completed(format: Format, runId: string, createdAt: number,
  options: { body?: boolean; fallbackAgent?: boolean; input?: Partial<CreateSubagentRun> } = {}) {
  const args = input(runId, options.input)
  if (format === 'modern') {
    await store.createRunDelta(args)
    if (options.body) await store.upsertTool(args.tenantId, runId, 'tool.completed', {
      id: 'large-tool', name: 'read_file', args: { content: largeBody }, output: largeBody, status: 'succeeded' })
    await store.appendHeader(args.tenantId, runId, 'finished', { status: 'succeeded', resultSummary: 'Finished fixture' })
    if (options.fallbackAgent) await db.execute({ sql: "UPDATE subagent_records SET record=json_remove(record,'$.agentId') WHERE tenant_id=? AND run_id=?", args: [args.tenantId, runId] })
  } else {
    await store.createRun(args)
    await store.appendSnapshot(args.tenantId, runId, 'finished', { status: 'succeeded', resultSummary: 'Finished fixture',
      ...(options.body ? { toolCalls: [{ id: 'large-tool', name: 'read_file', args: { content: largeBody }, output: largeBody, status: 'succeeded' }] } : {}) })
    if (options.fallbackAgent) await db.execute({ sql: "UPDATE subagent_runs SET snapshot=json_remove(snapshot,'$.agentId') WHERE tenant_id=? AND run_id=?", args: [args.tenantId, runId] })
  }
  await db.execute({ sql: 'UPDATE subagent_runs SET created_at=? WHERE tenant_id=? AND run_id=?', args: [createdAt, args.tenantId, runId] })
  return args
}

function measureReturnedRows() {
  let bytes = 0, calls = 0
  const observe = (rows: unknown) => { bytes += Buffer.byteLength(JSON.stringify(rows)); calls++ }
  const execute = db.execute.bind(db)
  vi.spyOn(db, 'execute').mockImplementation(async (statement: InStatement) => {
    const result = await execute(statement); observe(result.rows); return result
  })
  const transaction = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
    const tx = await transaction(mode), run = tx.execute.bind(tx)
    vi.spyOn(tx, 'execute').mockImplementation(async (statement: InStatement) => {
      const result = await run(statement); observe(result.rows); return result
    })
    return tx
  })
  return () => ({ bytes, calls })
}

describe('bounded configured collaborator storage lookup', () => {
  it.each(['modern', 'legacy'] as const)('selects the latest %s configured Agent within the exact tenant and parent', async format => {
    await completed(format, 'old', 10)
    await completed(format, 'new', 20, { fallbackAgent: true })
    await completed(format, 'foreign-tenant', 100, { input: { tenantId: 'another-tenant' } })
    await completed(format, 'foreign-parent', 100, { input: { parentSessionId: 'another-parent', rootSessionId: 'another-parent' } })
    await completed(format, 'foreign-root', 100, { input: { rootSessionId: 'nested-root' } })
    await completed(format, 'different-agent', 100, { input: { continuation: { ...input('different-agent').continuation!, agent: { ...agent, id: 'other-agent' } } } })
    expect(await store.latestAgentHeader(tenant, parent, agent.id, true)).toMatchObject({ runId: 'new', continuation: { agent } })
    expect(await store.latestAgentHeader(tenant, parent, 'missing-agent')).toBeNull()
    expect(await store.latestAgentHeader('absent-tenant', parent, agent.id)).toBeNull()
    expect(await store.latestAgentHeader(tenant, 'absent-parent', agent.id)).toBeNull()
    const agents = { getById: vi.fn().mockResolvedValue(null) }
    await expect(prepareCollaborators('absent-tenant', parent, [{ resumeRunId: 'new' }], { runs: store, agents })).rejects.toMatchObject({ statusCode: 404 })
    await expect(prepareCollaborators(tenant, 'another-parent', [{ resumeRunId: 'new' }], { runs: store, agents })).rejects.toMatchObject({ statusCode: 404 })
    await expect(prepareCollaborators(tenant, parent, [{ resumeRunId: 'missing' }], { runs: store, agents })).rejects.toMatchObject({ statusCode: 404 })
  })

  it.each(['modern', 'legacy'] as const)('prepares a %s continuation without transporting or decoding large historical tool bodies', async format => {
    await completed(format, 'large-history', 20, { body: true })
    const getRun = vi.spyOn(store, 'getRun').mockRejectedValue(new Error('Full run hydration is forbidden'))
    const listRuns = vi.spyOn(store, 'listRunsForParent').mockRejectedValue(new Error('Full parent enumeration is forbidden'))
    const decode = vi.spyOn(SubagentPayloadCodec.prototype, 'decodeDetail').mockRejectedValue(new Error('Tool detail hydration is forbidden'))
    const detail = vi.spyOn(SubagentPayloadCodec.prototype, 'getDetailChunk').mockRejectedValue(new Error('Tool detail reads are forbidden'))
    const measurements = measureReturnedRows()
    const agents = { getById: vi.fn().mockResolvedValue(null) }
    const plans = await prepareCollaborators(tenant, parent, [{ agentId: agent.id }, { resumeRunId: 'large-history' }],
      { runs: store, agents, workspacePaths: [directory] })
    expect(plans).toMatchObject([{ agentId: agent.id, resumeRunId: 'large-history', agent }])
    expect(plans).toHaveLength(1)
    expect(JSON.stringify(plans)).not.toContain('PRIVATE_TOOL_BODY_')
    expect(measurements().calls).toBeLessThan(20)
    expect(measurements().bytes).toBeLessThan(32_768)
    for (const forbidden of [getRun, listRuns, decode, detail, agents.getById]) expect(forbidden).not.toHaveBeenCalled()
  })

  it.each(['queued', 'running', 'cancelling'] as const)('detects a %s invocation of the same child and refuses its completed earlier run', async status => {
    const old = await completed('modern', 'completed', 10)
    await store.createRunDelta(input('active', { childSessionId: old.childSessionId }))
    if (status !== 'queued') await store.appendHeader(tenant, 'active', status === 'running' ? 'started' : 'cancelling', { status })
    expect(await store.hasActiveChildInvocation(tenant, parent, old.childSessionId!)).toBe(true)
    expect(await store.hasActiveChildInvocation('another-tenant', parent, old.childSessionId!)).toBe(false)
    expect(await store.hasActiveChildInvocation(tenant, 'another-parent', old.childSessionId!)).toBe(false)
    expect(await store.hasActiveChildInvocation(tenant, parent, 'another-child')).toBe(false)
    await expect(prepareCollaborators(tenant, parent, [{ resumeRunId: 'completed' }], { runs: store,
      agents: { getById: vi.fn().mockResolvedValue(null) } })).rejects.toMatchObject({ statusCode: 409 })
    await store.appendHeader(tenant, 'active', 'finished', { status: 'cancelled' })
    expect(await store.hasActiveChildInvocation(tenant, parent, old.childSessionId!)).toBe(false)
  })
})

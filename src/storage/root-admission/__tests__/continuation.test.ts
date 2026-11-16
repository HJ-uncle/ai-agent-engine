import fs from 'node:fs'
import path from 'node:path'
import type { TransactionMode } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../../sqlite/db.js'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { RootRunStore, type RootRunStatus } from '../../root-runs/index.js'
import { controllerSubject } from '../../../core/collaboration/controller-origin.js'
import { getExecutionOwners } from '../../../core/collaboration/execution-owner.js'
import { prepareRootContinuation, rootContinuationDigest } from '../continuation.js'
import { readAdmissionSeed } from '../projection.js'

let directory: string, db: LocalSqliteProcessClient, roots: RootRunStore
const tenantId = 'default', sessionId = 'continuation-fixture'
const actor = () => controllerSubject({ kind: 'account', tenantId, userId: 'alice' }, 'jwt')
const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
beforeEach(async () => {
  await closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/root-continuation-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('AETHER_GLOBAL_DIR', path.join(directory, 'global')); vi.stubEnv('LOG_LEVEL', 'silent')
  db = getDb() as LocalSqliteProcessClient; await initDb(); roots = new RootRunStore(); await roots.initialize()
})
afterEach(async () => {
  vi.restoreAllMocks()
  const closed = await closeDb(); if (closed) expect(closed.healthy).toBe(true)
  await db.whenClosed(); vi.unstubAllEnvs()
  // Keep isolated evidence available without creating files at the repository root.
})
async function initial(status: RootRunStatus = 'failed', keepOwner = false) {
  const root = await roots.create(tenantId, sessionId, 'synthetic-model', [], { message: 'Original task', toolProfile: 'general', memoryScope: 'off' })
  const current = (await roots.get(tenantId, root.runId))!
  const owners = getExecutionOwners(), owner = await owners.admitRoot({ tenantId, rootRunId: root.runId, rootAttemptId: current.attemptId,
    controller: new AbortController(), controllerSubject: actor() })
  await roots.finishOwned(owner, { status, stopReason: 'fixture interruption' })
  if (!keepOwner) owners.releaseRoot(owner)
  return { run: (await roots.get(tenantId, root.runId))!, owner }
}
async function input(requestKey = 'continue-one') {
  const context = await roots.userAdmissionContext(tenantId, sessionId)
  const selector = { protocolVersion: 1 as const, namespace: context.namespace, owner: 'work' as const,
    predecessor: context.predecessor!, turnId: context.root!.turnId }
  return prepareRootContinuation({ sessionId, continuation: { ...selector, requestKey,
    bodyDigest: rootContinuationDigest({ sessionId }, transport, selector) } }, transport)!
}
const count = async (table: string) => Number((await db.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)

describe('explicit same-turn continuation admission', () => {
  it.each(['failed', 'cancelled', 'interrupted'] as const)('continues %s as a new attempt while retaining its seed, turn and previous terminal audit', async status => {
    const { run: before } = await initial(status), seed = await readAdmissionSeed(db, { tenantId, sessionId }, before.runId)
    const request = await input(), accepted = await roots.continue(tenantId, request, actor())
    expect(accepted.duplicate).toBe(false)
    expect(accepted.run).toMatchObject({ runId: before.runId, turnId: before.turnId, userMessageId: before.userMessageId, status: 'running', createdAt: before.createdAt })
    expect(accepted.run.attemptId).not.toBe(before.attemptId)
    expect(accepted.run.assistantMessageId).not.toBe(before.assistantMessageId)
    expect(accepted.run.startedAt).toBeUndefined(); expect(accepted.run.finishedAt).toBeUndefined()
    expect(accepted.receipt).toMatchObject({ previousAttemptId: before.attemptId, assistantAnchorId: seed.anchor.assistantAnchorId, assistantIdentityKind: 'continuation-segment' })
    expect((await readAdmissionSeed(db, { tenantId, sessionId }, before.runId)).seedJson).toBe(seed.seedJson)
    const audit = JSON.parse(String((await db.execute('SELECT state_json FROM root_attempt_history')).rows[0].state_json))
    expect(audit).toMatchObject({ status, attemptId: before.attemptId, stopReason: 'fixture interruption' }); expect(audit.request).toBeUndefined()
    expect(await count('root_runs')).toBe(1); expect(await count('server_root_admission_seeds')).toBe(1)
    const owner = await getExecutionOwners().admitRoot({ tenantId, rootRunId: before.runId, rootAttemptId: accepted.attemptId,
      controller: new AbortController(), controllerSubject: actor() })
    await roots.finishOwned(owner, { status: 'succeeded' }); getExecutionOwners().releaseRoot(owner)
  })

  it('deduplicates concurrent clicks and reads the exact older attempt after a later continuation', async () => {
    await initial(); const request = await input()
    const results = await Promise.all([roots.continue(tenantId, request, actor()), roots.continue(tenantId, request, actor())])
    expect(results.filter(result => !result.duplicate)).toHaveLength(1)
    expect(results[0].receipt).toEqual(results[1].receipt)
    const accepted = results[0]
    await roots.update(tenantId, accepted.run.runId, { status: 'failed', stopReason: 'Second physical attempt failed' }, accepted.attemptId)
    const secondTerminal = await roots.get(tenantId, accepted.run.runId)
    const next = await roots.continue(tenantId, await input('continue-two'), actor())
    const oldReceipt = await roots.findContinuation(tenantId, sessionId, request, actor())
    expect(oldReceipt!.run).toMatchObject({ attemptId: accepted.attemptId, status: 'failed', version: secondTerminal!.version })
    expect(oldReceipt!.run.attemptId).not.toBe(next.attemptId)
    expect((await roots.continue(tenantId, request, actor())).duplicate).toBe(true)
    expect(await count('root_continuations')).toBe(2); expect(await count('root_attempt_history')).toBe(2)
  })

  it('rejects stale targets, another account, wrong digest, namespaces and unsupported terminal states', async () => {
    const { run } = await initial(), request = await input()
    await expect(roots.continue(tenantId, request, controllerSubject({ kind: 'account', tenantId, userId: 'bob' }, 'jwt'))).rejects.toMatchObject({ statusCode: 403 })
    await expect(roots.continue(tenantId, { ...request, namespace: { ...request.namespace, generation: 'different' } }, actor())).rejects.toThrow('ENGINE_NAMESPACE_CHANGED')
    await roots.update(tenantId, run.runId, { actualModelId: 'observed-model' })
    await expect(roots.continue(tenantId, request, actor())).rejects.toThrow('CONTINUATION_PREDECESSOR_CHANGED')
    const fresh = await input(); await roots.continue(tenantId, fresh, actor())
    await expect(roots.findContinuation(tenantId, sessionId, { ...fresh, bodyDigest: 'a'.repeat(64) }, actor())).rejects.toThrow('CONTINUATION_KEY_BODY_CONFLICT')
    await expect(roots.continue(tenantId, await input('while-running'), actor())).rejects.toThrow('CONTINUATION_NOT_RESUMABLE')
    expect(await count('root_continuations')).toBe(1)
  })

  it('requires the old owner to release and refuses pending approvals even on a terminal row', async () => {
    const { run, owner } = await initial('failed', true), request = await input()
    await expect(roots.continue(tenantId, request, actor())).rejects.toThrow('CONTINUATION_OWNER_NOT_DRAINED')
    getExecutionOwners().releaseRoot(owner)
    await roots.update(tenantId, run.runId, { pending: [{ requestId: 'pending', toolCallId: 'tool', toolName: 'write_file', args: {}, kind: 'permission', status: 'pending' }] })
    await expect(roots.continue(tenantId, await input(), actor())).rejects.toThrow('CONTINUATION_REQUIRES_PENDING_RESPONSE')
    expect(await count('root_continuations')).toBe(0)
  })

  it('restores trusted admission after an actual reconnect before the first execution owner was installed', async () => {
    const before = await roots.create(tenantId, sessionId, 'synthetic-model', [], { message: 'Task accepted before power loss', toolProfile: 'general' },
      undefined, undefined, undefined, actor())
    const originalSeed = await readAdmissionSeed(db, { tenantId, sessionId }, before.runId)
    expect(Number((await db.execute('SELECT count(*) AS n FROM collaboration_controller_roots')).rows[0].n)).toBe(0)
    await closeDb(); await db.whenClosed()
    db = getDb() as LocalSqliteProcessClient; await initDb(); roots = new RootRunStore(); await roots.initialize()
    expect((await roots.latest(tenantId, sessionId))?.status).toBe('interrupted')
    const accepted = await roots.continue(tenantId, await input(), actor())
    expect(accepted.run).toMatchObject({ runId: before.runId, userMessageId: before.userMessageId, turnId: before.turnId })
    expect((await readAdmissionSeed(db, { tenantId, sessionId }, before.runId)).seedJson).toBe(originalSeed.seedJson)
  })

  it('keeps a continuation receipt on its accepted attempt after an approval creates another attempt', async () => {
    await initial(); const request = await input(), accepted = await roots.continue(tenantId, request, actor())
    await roots.pending(tenantId, accepted.run.runId, { requestId: 'approval', toolCallId: 'tool', toolName: 'write_file', args: {}, kind: 'permission' }, accepted.attemptId)
    const answer = await roots.answer(tenantId, sessionId, accepted.run.runId, 'approval', 'tool', 'write_file', 'approved')
    expect(answer.run.attemptId).not.toBe(accepted.attemptId)
    const receipt = await roots.findContinuation(tenantId, sessionId, request, actor())
    expect(receipt?.run).toMatchObject({ attemptId: accepted.attemptId, status: 'waiting', pending: [{ status: 'pending' }] })
    expect((await roots.continue(tenantId, request, actor())).duplicate).toBe(true)
  })

  it.each(['approved', 'rejected', 'question-answer'])('resumes a cancelled pending interaction only through its explicit %s response', async decision => {
    const { run } = await initial('cancelled')
    const kind = decision === 'question-answer' ? 'ask' as const : 'permission' as const
    await roots.update(tenantId, run.runId, { pending: [{ requestId: 'pending', toolCallId: 'tool', toolName: kind === 'ask' ? 'ask_user' : 'write_file', args: {}, kind, status: 'pending' }] })
    const current = (await roots.get(tenantId, run.runId))!
    await expect(roots.continue(tenantId, await input(), actor())).rejects.toThrow('CONTINUATION_REQUIRES_PENDING_RESPONSE')
    if (kind === 'permission') await expect(roots.answer(tenantId, sessionId, run.runId, 'pending', 'tool', 'write_file', 'anything', undefined, undefined, actor())).rejects.toMatchObject({ statusCode: 400 })
    const accepted = await roots.answer(tenantId, sessionId, run.runId, 'pending', 'tool', kind === 'ask' ? 'ask_user' : 'write_file', decision, undefined, undefined, actor())
    expect(accepted.run).toMatchObject({ runId: run.runId, turnId: run.turnId, status: 'running', pending: [{ status: 'answered', output: decision }] })
    expect(accepted.run.attemptId).not.toBe(current.attemptId); expect(accepted.run.finishedAt).toBeUndefined()
    expect(accepted.run.assistantMessageId).not.toBe(current.assistantMessageId)
    expect(accepted.pending.output).toBe(decision)
  })

  it('rejects a cancelled pending answer from another controller or after a newer logical turn', async () => {
    const { run } = await initial('cancelled')
    await roots.update(tenantId, run.runId, { pending: [{ requestId: 'pending', toolCallId: 'tool', toolName: 'write_file', args: {}, kind: 'permission', status: 'pending' }] })
    await expect(roots.answer(tenantId, sessionId, run.runId, 'pending', 'tool', 'write_file', 'approved', undefined, undefined,
      controllerSubject({ kind: 'account', tenantId, userId: 'bob' }, 'jwt'))).rejects.toMatchObject({ statusCode: 403 })
    await roots.create(tenantId, sessionId, 'synthetic-model', [], { message: 'New task' })
    await expect(roots.answer(tenantId, sessionId, run.runId, 'pending', 'tool', 'write_file', 'approved', undefined, undefined, actor())).rejects.toThrow('CONTINUATION_PREDECESSOR_CHANGED')
    expect((await roots.get(tenantId, run.runId))!.pending[0].status).toBe('pending')
  })

  it('rejects a superseded logical turn and a damaged canonical input before creating an audit or attempt', async () => {
    const { run } = await initial(), request = await input()
    await db.execute("UPDATE server_root_admission_seeds SET seed_json='{}'")
    await expect(roots.continue(tenantId, request, actor())).rejects.toThrow('ADMISSION_SEED_CORRUPT')
    await roots.create(tenantId, sessionId, 'synthetic-model', [], { message: 'A newer task' })
    await expect(roots.continue(tenantId, request, actor())).rejects.toThrow('CONTINUATION_PREDECESSOR_CHANGED')
    expect((await roots.get(tenantId, run.runId))!.attemptId).toBe(run.attemptId)
    expect(await count('root_attempt_history')).toBe(0)
  })

  it('reconciles a lost commit ACK without another attempt or execution', async () => {
    await initial(); const request = await input(), native = db.transaction.bind(db)
    let lost = 0
    vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
      const tx = await native(mode); let inserted = false
      return new Proxy(tx, { get(target, key) {
        if (key === 'execute') return async (...args: Parameters<typeof tx.execute>) => {
          if (typeof args[0] === 'object' && args[0].sql.startsWith('INSERT INTO root_continuations')) inserted = true
          return target.execute(...args)
        }
        if (key === 'commit') return async () => { await target.commit(); if (inserted && !lost++) throw new Error('SYNTHETIC_ACK_LOSS') }
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    const accepted = await roots.continue(tenantId, request, actor())
    expect(lost).toBe(1); expect(accepted.duplicate).toBe(false)
    expect((await roots.continue(tenantId, request, actor())).duplicate).toBe(true)
    expect(await count('root_continuations')).toBe(1); expect(await count('root_attempt_history')).toBe(1)
  })

  it('keeps cancellation atomic with the audit and new attempt', async () => {
    const { run } = await initial(), request = await input(), controller = new AbortController()
    await expect(roots.continue(tenantId, request, actor(), controller.signal, () => controller.abort())).rejects.toThrow()
    expect((await roots.get(tenantId, run.runId))!.attemptId).toBe(run.attemptId)
    expect(await count('root_continuations')).toBe(0); expect(await count('root_attempt_history')).toBe(0)
  })

  it('accepts no caller task, approval, resources or fake controller fields in the dedicated wire body', async () => {
    await initial(); const { sessionId: _session, ...continuation } = await input()
    for (const field of ['message', 'toolResponse', 'admission', 'model', 'collaborators', 'metadata', 'controllerSubject']) {
      expect(() => prepareRootContinuation({ sessionId, continuation, [field]: 'caller-controlled' }, transport)).toThrow('INVALID_CONTINUATION')
    }
    expect(() => prepareRootContinuation({ sessionId, continuation: { ...continuation, bodyDigest: '0'.repeat(64) } }, transport)).toThrow('CONTINUATION_BODY_DIGEST_MISMATCH')
    expect(() => prepareRootContinuation({ sessionId, continuation: { ...continuation, childRunId: 'unhashed-child' } }, transport)).toThrow('CONTINUATION_BODY_DIGEST_MISMATCH')
  })
})

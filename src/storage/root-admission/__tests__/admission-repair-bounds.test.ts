/** Real WAL/JSONL recovery budgets and exact HTTP receipts. No producer or provider execution. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../sqlite/db.js'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { RootRunStore } from '../../root-runs/index.js'
import { createConversationHistory } from '../../conversation/factory.js'
import { prepareUserAdmission, userAdmissionDigest } from '../index.js'
import { projectTerminalAdmissionUsers, readAdmissionSeed } from '../projection.js'
import { registerUserAdmissionRoutes } from '../../../api/http/routes/chat-admission.js'

const scope = { tenantId: 'default', sessionId: 'bounded-repair-session' }
const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
let fixture: string, db: LocalSqliteProcessClient, roots: RootRunStore, app: FastifyInstance | undefined
beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true }); fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/admission-repair-bounds-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(fixture, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db); await database.initDb(); roots = new RootRunStore(() => db)
})
afterEach(async () => {
  await app?.close(); app = undefined; database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (!path.resolve(fixture).startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
async function terminal(key: string, message = key) {
  const context = await roots.userAdmissionContext(scope.tenantId, scope.sessionId)
  const selector = { protocolVersion: 1 as const, namespace: context.namespace, predecessor: context.predecessor, owner: 'work' as const }
  const body: Record<string, unknown> = { sessionId: scope.sessionId, message, model: 'synthetic-unused', memoryScope: 'off', thinkingMode: false }
  body.admission = { ...selector, requestKey: key, bodyDigest: userAdmissionDigest(body, transport, selector) }
  const accepted = await roots.createUserAdmission(scope.tenantId, 'synthetic-unused', [], body, prepareUserAdmission(body, transport)!)
  await roots.update(scope.tenantId, accepted.run.runId, { status: 'interrupted' })
  return accepted
}
async function pending() { return Number((await db.execute('SELECT count(*) AS n FROM user_root_admission_seeds WHERE projected_at IS NULL')).rows[0].n) }
describe('Admission repair owns a finite observation budget', () => {
  it('context returns trusted tenant/session, negotiated transport and observed root state without private request data', async () => {
    app = Fastify(); await registerUserAdmissionRoutes(app, roots, createConversationHistory())
    const headers = { 'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2', 'x-tenant-id': 'spoofed-tenant' }
    const fresh = await app.inject({ url: '/chat/admission/context?sessionId=' + scope.sessionId, headers })
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().data).toMatchObject({ protocolVersion: 1, ...scope, transport, predecessor: null, root: null })
    const accepted = await terminal('observed-context')
    const next = (await app.inject({ url: '/chat/admission/context?sessionId=' + scope.sessionId, headers })).json().data
    expect(next.tenantId).toBe('default'); expect(next.sessionId).toBe(scope.sessionId)
    expect(next.root).toEqual({ runId: accepted.run.runId, attemptId: next.predecessor.attemptId, version: next.predecessor.version, status: 'interrupted', workspacePaths: [], modelId: 'synthetic-unused' })
    expect(next.root).not.toHaveProperty('request')
    // Fastify's existing AJV policy removes extra query fields; they grant no authority.
    const extra = await app.inject('/chat/admission/context?sessionId=' + scope.sessionId + '&tenantId=spoofed')
    expect(extra.statusCode).toBe(200); expect(extra.json().data.tenantId).toBe('default')
    expect((await app.inject({ url: '/chat/admission/context?sessionId=' + scope.sessionId, headers: { 'x-aether-subagent-protocol': '3' } })).statusCode).toBe(400)
  })
  it('releases the tenant lock after at most eight retained seeds and progresses on the next observation', async () => {
    const runs = []; for (let i = 0; i < 11; i++) runs.push(await terminal('budget-' + i))
    const history = createConversationHistory()
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(8)
    expect(await pending()).toBe(3)
    expect((await history.getFullHistory(scope)).filter(row => row.role === 'user')).toHaveLength(8)
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(3)
    expect(await pending()).toBe(0)
    expect((await history.getFullHistory(scope)).map(row => row.id)).toEqual(runs.map(run => run.receipt.userMessageId))
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(0)
  })
  it('bounds combined UTF-8 seed bytes while permitting one large seed to make progress', async () => {
    for (let i = 0; i < 3; i++) await terminal('bytes-' + i, '界'.repeat(32 * 1024))
    const history = createConversationHistory()
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(2)
    expect(await pending()).toBe(1)
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(1)
    await terminal('large-single', '界'.repeat(128 * 1024))
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(1)
    expect(await pending()).toBe(0)
  })
  it('an exact HTTP receipt repairs only its own root despite an unrelated corrupt pending seed', async () => {
    const older = await terminal('unrelated-corrupt'), selected = await terminal('exact-selected')
    const original = await readAdmissionSeed(db, scope, older.run.runId)
    const corrupt = JSON.stringify({ ...original.message, content: 'corrupted-seed' })
    expect(createHash('sha256').update(corrupt).digest('hex')).not.toBe(JSON.parse(original.receiptJson).userSeedDigest)
    await db.execute({ sql: 'UPDATE user_root_admission_seeds SET seed_json=? WHERE root_run_id=?', args: [corrupt, older.run.runId] })
    const history = createConversationHistory(); app = Fastify(); await registerUserAdmissionRoutes(app, roots, history)
    const response = await app.inject({ method: 'POST', url: '/chat/admission/receipt', payload: { sessionId: scope.sessionId, namespace: selected.receipt.namespace, requestKey: selected.receipt.requestKey, bodyDigest: selected.receipt.bodyDigest } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.receipt.rootRunId).toBe(selected.run.runId)
    expect(response.json().data.projection.user.state).toBe('projected')
    expect(await pending()).toBe(1)
    expect((await history.getFullHistory(scope)).map(row => row.id)).toEqual([selected.receipt.userMessageId])
    expect((await readAdmissionSeed(db, scope, selected.run.runId)).projected).toBe(true)
  })
})

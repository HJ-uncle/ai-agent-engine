/** Display-only transcript: whole turns, complete navigation, concurrent append, edits and legacy SQLite. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { JSONLConversationHistory } from '../../../../storage/conversation/jsonl-history.js'
import { SQLiteConversationHistory } from '../../../../storage/conversation/history.js'
import { initDb, closeDb } from '../../../../storage/sqlite/db.js'
import type { Message } from '../../../../core/agent-context/types.js'
import { conversationRoutes } from '../conversation.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'

vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'c4'.repeat(32) })
const fixture = path.dirname(process.env.DATA_DIR!)
let serial = 0, app: FastifyInstance | undefined
let scope: { tenantId: string; sessionId: string }, file: string
beforeAll(async () => { await initDb() })
beforeEach(() => {
  scope = { tenantId: 'display-tenant', sessionId: `display-${++serial}` }
  file = path.join(fixture, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
})
afterEach(async () => { await app?.close(); app = undefined; vi.restoreAllMocks() })
afterAll(async () => {
  await closeDb()
  const root = path.resolve('.e2e-tmp', 'vitest-runtime')
  if (path.dirname(path.resolve(fixture)) !== root) throw new Error('Unsafe display fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function row(id: string, role: Message['role'], sequence: number, content: Message['content'] = id, turn = id) {
  return { uuid: id, parentUuid: null, type: role, timestamp: '2026-11-05T00:00:00Z', ...scope,
    isSidechain: false, dbSeq: sequence, conversationId: turn,
    payload: { id, role, content, createdAt: sequence, conversationId: turn } }
}
function marker(type: string, extra: Record<string, unknown>) {
  return { uuid: `marker-${Math.random()}`, parentUuid: null, type, timestamp: '2026-11-05T00:00:00Z',
    ...scope, isSidechain: false, dbSeq: 0, ...extra }
}
function write(rows: unknown[]) { fs.writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n') }
function append(rows: unknown[]) { fs.appendFileSync(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n') }

it('returns all user navigation and entire 300-tool turn despite compaction and a 200-row boundary', async () => {
  write([row('old-user', 'user', 1), ...Array.from({ length: 300 }, (_, index) => row(`tool-${index}`, 'tool', index + 2, `evidence-${index}`, 'old-user')),
    row('old-final', 'assistant', 302, 'Final original', 'old-user'), row('middle-user', 'user', 303), row('middle-final', 'assistant', 304),
    marker('summary', { summary: 'Compact context', leafSeq: 302 }), row('new-user', 'user', 305)])
  const history = new JSONLConversationHistory()
  const latest = await history.getDisplayHistory(scope)
  expect(latest.turns.map(turn => turn.userMessageId)).toEqual(['old-user', 'middle-user', 'new-user'])
  expect(latest.loadedTurnIds).toEqual(['middle-user', 'new-user'])
  expect(latest.messages.map(message => message.id)).toEqual(['middle-user', 'middle-final', 'new-user'])
  const selected = await history.getDisplayHistory(scope, { anchorMessageId: 'old-user' })
  expect(selected.messages).toHaveLength(304)
  expect(selected.messages[0].id).toBe('old-user')
  expect(selected.messages[301].content).toBe('Final original')
  expect(selected.loadedTurnIds).toEqual(['old-user', 'middle-user'])
  expect(selected.completeness).toBe('complete')
})

it('keeps display mutations separate from append/summary, and folds original tool evidence, edits and tombstones', async () => {
  write([row('u1', 'user', 1, 'before'), row('tool', 'tool', 2, 'original evidence', 'u1'), row('a1', 'assistant', 3, 'answer', 'u1')])
  const history = new JSONLConversationHistory(), initial = await history.getDisplayHistory(scope)
  append([marker('summary', { summary: 'compressed', leafSeq: 2 }), row('u2', 'user', 4)])
  const added = await history.getDisplayHistory(scope)
  expect(added.mutationRevision).toBe(initial.mutationRevision)
  expect(added.revision).not.toBe(initial.revision)
  append([marker('update', { targetUuid: 'u1', content: 'edited question' }),
    marker('update', { targetUuid: 'tool', content: '[tool result cleared]', archiveContent: 'original evidence' }),
    marker('tombstone', { scope: 'message', targetUuid: 'a1' })])
  const edited = await history.getDisplayHistory(scope)
  expect(edited.turns[0].preview).toBe('edited question')
  expect(edited.messages.map(message => message.content)).toEqual(['edited question', 'original evidence', 'u2'])
  expect(edited.mutationRevision).not.toBe(added.mutationRevision)
  append([marker('tombstone', { scope: 'conversation', conversationId: 'u1' })])
  const deleted = await history.getDisplayHistory(scope)
  expect(deleted.turns.map(turn => turn.userMessageId)).toEqual(['u2'])
  expect(deleted.messages.map(message => message.id)).toEqual(['u2'])
  append([marker('tombstone', { scope: 'truncate', afterSeq: 2 }), row('u3', 'user', 5)])
  expect((await history.getDisplayHistory(scope)).turns.map(turn => turn.userMessageId)).toEqual(['u3'])
})

it('pins the index and bodies to one byte prefix while a live run appends between passes', async () => {
  write([row('u1', 'user', 1), row('a1', 'assistant', 2)])
  const original = fs.createReadStream
  let passes = 0
  vi.spyOn(fs, 'createReadStream').mockImplementation((candidate, options) => {
    if (String(candidate) === file && ++passes === 2) append([row('u2', 'user', 3)])
    return original(candidate, options)
  })
  const history = new JSONLConversationHistory(), first = await history.getDisplayHistory(scope)
  expect(first.turns.map(turn => turn.userMessageId)).toEqual(['u1'])
  expect(first.messages.map(message => message.id)).toEqual(['u1', 'a1'])
  const second = await history.getDisplayHistory(scope)
  expect(second.turns.map(turn => turn.userMessageId)).toEqual(['u1', 'u2'])
  expect(second.mutationRevision).toBe(first.mutationRevision)
})

it('keeps one file identity across replacement and invalidates the next display cache', async () => {
  write([row('before', 'user', 1), row('answer', 'assistant', 2)])
  const original = fs.createReadStream
  let passes = 0
  vi.spyOn(fs, 'createReadStream').mockImplementation((candidate, options) => {
    if (String(candidate) === file && ++passes === 2) { fs.renameSync(file, file + '.old'); write([row('after', 'user', 1)]) }
    return original(candidate, options)
  })
  const first = await new JSONLConversationHistory().getDisplayHistory(scope)
  const second = await new JSONLConversationHistory().getDisplayHistory(scope)
  expect(first.messages.map(message => message.id)).toEqual(['before', 'answer'])
  expect(second.turns.map(turn => turn.userMessageId)).toEqual(['after'])
  expect(second.mutationRevision).not.toBe(first.mutationRevision)
})

it('ignores foreign scope and an incomplete tail even if that line completes between scans', async () => {
  write([{ ...row('child-user', 'user', 1), isSidechain: true },
    { ...row('foreign-session', 'user', 2), sessionId: 'different-session' },
    { ...row('foreign-tenant', 'user', 3), tenantId: 'different-tenant' }])
  const pending = JSON.stringify(row('next-user', 'user', 4))
  fs.appendFileSync(file, pending.slice(0, -8))
  const original = fs.createReadStream
  let passes = 0
  vi.spyOn(fs, 'createReadStream').mockImplementation((candidate, options) => {
    if (String(candidate) === file && ++passes === 2) fs.appendFileSync(file, pending.slice(-8) + '\n')
    return original(candidate, options)
  })
  const history = new JSONLConversationHistory()
  const first = await history.getDisplayHistory(scope)
  expect(first.turns.map(turn => turn.userMessageId)).toEqual(['child-user'])
  expect(first.messages.map(message => message.id)).toEqual(['child-user'])
  expect((await history.getDisplayHistory(scope)).turns.map(turn => turn.userMessageId)).toEqual(['child-user', 'next-user'])
})

it('keeps attachment data out of index previews and reports SQLite-imported missing originals', async () => {
  const summary = row('sqlite-summary', 'system', 1, 'previous history was discarded')
  Object.assign(summary.payload, { metadata: { isCompactSummary: true } })
  write([summary, row('image-user', 'user', 2, [{ type: 'text', text: '请检查这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } }])])
  const result = await new JSONLConversationHistory().getDisplayHistory(scope)
  expect(result.turns).toEqual([{ userMessageId: 'image-user', conversationId: 'image-user', preview: '请检查这张图', createdAt: 2 }])
  expect(result.completeness).toBe('sqlite_compacted')
  expect(result.messages.map(message => message.id)).toEqual(['image-user'])
})

it('tracks SQLite mutations durably while disclosing compaction loss', async () => {
  const history = new SQLiteConversationHistory()
  await history.append({ id: 'sql-u1', role: 'user', content: 'first' }, scope)
  const first = await history.getDisplayHistory(scope)
  await history.append({ id: 'sql-a1', role: 'assistant', content: 'answer' }, scope)
  const appended = await new SQLiteConversationHistory().getDisplayHistory(scope)
  expect(appended.mutationRevision).toBe(first.mutationRevision)
  expect(appended.revision).not.toBe(first.revision)
  await history.updateMessageContent('sql-u1', scope.tenantId, 'corrected', 4)
  const edited = await history.getDisplayHistory(scope)
  expect(edited.turns[0].preview).toBe('corrected')
  expect(edited.mutationRevision).not.toBe(first.mutationRevision)
  await history.deleteMessage('sql-a1', scope.tenantId)
  expect((await history.getDisplayHistory(scope)).mutationRevision).not.toBe(edited.mutationRevision)
  await history.append({ id: 'sql-summary', role: 'system', content: 'Unavailable original turns', metadata: { isCompactSummary: true } }, scope)
  expect((await history.getDisplayHistory(scope)).completeness).toBe('sqlite_compacted')
})

it('renders legacy stringified multipart previews without exposing JSON or embedded attachment data', async () => {
  write([row('legacy-text', 'user', 1, JSON.stringify([{ type: 'text', text: '请检查旧附件' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET_ATTACHMENT' } }])),
  row('legacy-large', 'user', 2, JSON.stringify([{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } }]))])
  const result = await new JSONLConversationHistory().getDisplayHistory(scope)
  expect(result.turns.map(turn => turn.preview)).toEqual(['请检查旧附件', '附件消息'])
  expect(JSON.stringify(result.turns)).not.toContain('base64')
})

async function server() {
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: request.headers['x-tenant'] ?? scope.tenantId } }) })
  await app.register(conversationRoutes)
  return app
}

it('serves complete navigation during a running root and strips private provider snapshots', async () => {
  const prompt = row('user', 'user', 1, 'visible question')
  Object.assign(prompt.payload, { modelInputContent: 'PRIVATE_PROVIDER_PROMPT' })
  write([prompt, row('answer', 'assistant', 2, 'visible answer'), row('next', 'user', 3)])
  const run = await rootRunStore.create(scope.tenantId, scope.sessionId, 'fixture-model', [], {})
  const response = await (await server()).inject(`/conversation/display?sessionId=${scope.sessionId}&anchorMessageId=user&limit=1`)
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().data.loadedTurnIds).toEqual(['user'])
  expect(response.json().data.turns.map((turn: { userMessageId: string }) => turn.userMessageId)).toEqual(['user', 'next'])
  expect(response.json().data.messages.map((message: Message) => message.id)).toEqual(['user', 'answer'])
  expect(response.body).not.toContain('PRIVATE_PROVIDER_PROMPT')
  expect((await rootRunStore.get(scope.tenantId, run.runId))?.status).toBe('running')
})

it('rejects missing anchors and malformed limits without silently opening a different turn', async () => {
  write([row('u1', 'user', 1)])
  const http = await server()
  const missing = await http.inject(`/conversation/display?sessionId=${scope.sessionId}&anchorMessageId=deleted`)
  expect(missing.statusCode).toBe(404)
  expect(missing.json().code).toBe(40400)
  const invalid = await http.inject(`/conversation/display?sessionId=${scope.sessionId}&limit=0`)
  expect(invalid.statusCode).toBe(400)
  const isolated = await http.inject({ url: `/conversation/display?sessionId=${scope.sessionId}`, headers: { 'x-tenant': 'other-display-tenant' } })
  expect(isolated.statusCode).toBe(200)
  expect(isolated.json().data.turns).toEqual([])
})

it('opts into root followup grouping through HTTP while keeping legacy requests unchanged', async () => {
  const seed = row('root-seed', 'user', 1, 'Root request', 'root-turn')
  const follow = row('root-followup', 'user', 3, 'Exact complete continuation '.repeat(1000), 'root-turn')
  Object.assign(seed.payload, { metadata: { rootRunId: 'root-run', turnId: 'root-turn' } })
  Object.assign(follow.payload, { modelInputContent: 'PRIVATE_CONTROLLER_ENVELOPE', metadata: { rootRunId: 'root-run', turnId: 'root-turn',
    collaborationDelivery: { version: 1, source: 'user-controller', messageId: 'mail', rootRunId: 'root-run', recipientInvocationRunId: 'rootinv:fixture' } } })
  write([seed, row('before-followup', 'assistant', 2, 'before', 'root-turn'), follow,
    row('after-followup', 'assistant', 4, 'after', 'root-turn'), row('next-user', 'user', 5)])
  const http = await server(), url = `/conversation/display?sessionId=${scope.sessionId}&anchorMessageId=root-seed&limit=1`
  const legacy = await http.inject(url)
  expect(legacy.statusCode).toBe(200); expect(legacy.json().data).not.toHaveProperty('grouping')
  expect(legacy.json().data.turns.map((turn: { userMessageId: string }) => turn.userMessageId)).toEqual(['root-seed', 'root-followup', 'next-user'])
  expect(legacy.json().data.messages.map((message: Message) => message.id)).toEqual(['root-seed', 'before-followup'])
  const grouped = await http.inject(url + '&groupRootFollowups=true')
  expect(grouped.statusCode, grouped.body).toBe(200)
  expect(grouped.json().data).toMatchObject({ schemaVersion: 1, grouping: 'root', loadedTurnIds: ['root-seed'] })
  expect(grouped.json().data.turns.map((turn: { userMessageId: string }) => turn.userMessageId)).toEqual(['root-seed', 'next-user'])
  expect(grouped.json().data.messages.map((message: Message) => message.id)).toEqual(['root-seed', 'before-followup', 'root-followup', 'after-followup'])
  expect(grouped.json().data.messages[2].content).toBe(follow.payload.content)
  expect(grouped.body).not.toContain('PRIVATE_CONTROLLER_ENVELOPE')
  expect((await http.inject(url + '&groupRootFollowups=false')).json().data).toEqual(legacy.json().data)
  expect((await http.inject(url + '&groupRootFollowups=1')).statusCode).toBe(400)
})

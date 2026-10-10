import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { searchHistoryTool } from '../search-history-tool.js'
import * as database from '../../../storage/sqlite/db.js'

let fixture: string
let history: JSONLConversationHistory
const originalGetDb = database.getDb
const owned: Array<ReturnType<typeof database.getDb>> = []
const scope = { tenantId: 'history-tenant', sessionId: 'history-session' }
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-history-search-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  history = new JSONLConversationHistory()
  vi.spyOn(database, 'getDb').mockImplementation(() => {
    const client = originalGetDb(); if (!owned.includes(client)) owned.push(client); return client
  })
})
afterEach(async () => {
  database.closeDb()
  await Promise.all(owned.splice(0).map(client => (client as any).whenClosed?.()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-history-search-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
const context = () => ({ ...scope, history } as unknown as AgentContext)

it('finds exact old evidence after compaction and restart, without exposing another session or tenant', async () => {
  await history.append({ id: 'early-decision', role: 'user', content: 'Settlement reference: amber-7319; preserve integer cents.', metadata: { turnId: 'early-turn' } }, scope)
  for (let i = 0; i < 20; i++) await history.append({ id: `later-${i}`, role: 'assistant', content: 'continued development' }, scope)
  await history.compress(scope, async () => 'The project uses a settlement reference.', 4)
  await history.append({ id: 'other-session', role: 'user', content: 'Settlement reference: PRIVATE-B' }, { ...scope, sessionId: 'private-session' })
  await history.append({ id: 'other-tenant', role: 'user', content: 'Settlement reference: PRIVATE-C' }, { ...scope, tenantId: 'private-tenant' })
  const restarted = new JSONLConversationHistory()
  const result = await searchHistoryTool.execute({ query: 'settlement reference' }, { ...context(), history: restarted })
  expect(result.success).toBe(true)
  const data = JSON.parse(result.output)
  expect(data.totalMatches).toBe(1)
  expect(data.messages[0]).toMatchObject({ messageId: 'early-decision', turnId: 'early-turn', content: 'Settlement reference: amber-7319; preserve integer cents.' })
  expect(result.output).not.toContain('PRIVATE')
  expect((await restarted.getFullHistory(scope)).some(message => message.id === 'early-decision')).toBe(false)
})

it('folds explicit edits and deletions, recovers micro-compacted output, and honors clear', async () => {
  await history.append({ id: 'edited', role: 'user', content: 'old policy' }, scope)
  await history.append({ id: 'deleted', role: 'assistant', content: 'evidence removed' }, scope)
  await history.append({ id: 'tool-evidence', role: 'tool', content: 'exact evidence '.repeat(100), toolCallId: 'run' }, scope)
  for (let i = 0; i < 12; i++) await history.append({ id: `tail-${i}`, role: 'assistant', content: 'work' }, scope)
  await history.updateMessageContent('edited', scope.tenantId, 'current policy', 2)
  await history.deleteMessage('deleted', scope.tenantId)
  await history.microCompactToolResults(scope, { keepRecent: 2, maxChars: 64 })
  expect((await history.searchArchive(scope, { query: 'old policy' })).totalMatches).toBe(0)
  expect((await history.searchArchive(scope, { query: 'current policy' })).messages.map(message => message.id)).toEqual(['edited'])
  expect((await history.searchArchive(scope, { query: 'evidence' })).messages.map(message => message.id)).toEqual(['tool-evidence'])
  expect((await history.searchArchive(scope, { messageId: 'tool-evidence' })).messages[0].content).toBe('exact evidence '.repeat(100))
  await history.clear(scope)
  expect((await history.searchArchive(scope, { query: 'policy' })).messages).toEqual([])
})

it('paginates all matches and retrieves long original text in bounded output pages', async () => {
  for (let i = 0; i < 27; i++) await history.append({ id: `match-${i}`, role: 'user', content: `Milestone ${i}` }, scope)
  const ids: string[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const result = await searchHistoryTool.execute({ query: 'Milestone', offset, limit: 10 }, context())
    const data = JSON.parse(result.output)
    expect(data.totalMatches).toBe(27)
    ids.push(...data.messages.map((message: any) => message.messageId)); offset = data.nextOffset
  }
  expect(ids).toEqual(Array.from({ length: 27 }, (_, i) => `match-${i}`))
  const text = 'long original '.repeat(500) + 'TAIL_EXACT_VALUE=42'
  await history.append({ id: 'long', role: 'user', content: text }, scope)
  let contentOffset: number | null = 0, reconstructed = ''
  while (contentOffset !== null) {
    const data = JSON.parse((await searchHistoryTool.execute({ messageId: 'long', contentOffset }, context())).output)
    expect(data.messages[0].content.length).toBeLessThanOrEqual(2000)
    reconstructed += data.messages[0].content; contentOffset = data.messages[0].nextContentOffset
  }
  expect(reconstructed).toBe(text)
})

it.each([{ query: 'policy', sessionId: 'private' }, { query: 'policy', tenantId: 'private' }, { query: 'policy', limit: 0 }, { query: 'policy', offset: -1 }, { query: 'policy', offset: '0' }, {}, null])('rejects scope injection and invalid input %# before reading storage', async args => {
  const read = vi.spyOn(history, 'searchArchive')
  const result = await searchHistoryTool.execute(args, context())
  expect(result.success).toBe(false)
  expect(read).not.toHaveBeenCalled()
})

it.each(['../private-tenant/known-session', '..\\private-tenant\\known-session', 'D:\\private', '..', 'default.', 'CON', 'null\u0000suffix'])('rejects unsafe executing session identifiers without reading another tenant %#', async sessionId => {
  await history.append({ id: 'private', role: 'user', content: 'PRIVATE_TENANT_SECRET' }, { tenantId: 'private-tenant', sessionId: 'known-session' })
  const result = await searchHistoryTool.execute({ query: 'PRIVATE' }, { ...context(), sessionId })
  expect(result.success).toBe(false)
  expect(result.output).not.toContain('PRIVATE_TENANT_SECRET')
  await expect(history.getArchive({ ...scope, tenantId: sessionId })).rejects.toThrow(/path segment/)
})

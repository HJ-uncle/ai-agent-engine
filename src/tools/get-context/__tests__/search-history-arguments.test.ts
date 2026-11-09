import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import { toolArgumentsSnapshot } from '../../../core/utils/completed-write-history.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import * as database from '../../../storage/sqlite/db.js'
import { searchHistoryTool } from '../search-history-tool.js'

let fixture: string, history: JSONLConversationHistory
const originalGetDb = database.getDb, owned: Array<ReturnType<typeof database.getDb>> = []
const scope = { tenantId: 'argument-tenant', sessionId: 'argument-session' }
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-history-arguments-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  history = new JSONLConversationHistory()
  vi.spyOn(database, 'getDb').mockImplementation(() => {
    const client = originalGetDb(); if (!owned.includes(client)) owned.push(client); return client
  })
})
afterEach(async () => {
  database.closeDb()
  await Promise.all(owned.splice(0).map(client => (client as any).whenClosed?.()))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-history-arguments-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
const context = () => ({ ...scope, history } as unknown as AgentContext)

it.each(['data', 'markdown'])('recovers complete original %s argument JSON after compaction and restart', async field => {
  const args = { path: '报告文档.md', [field]: '中文🙂\r\n"quoted"\\value\n'.repeat(500), expectedHash: 'missing',
    options: { list: [1, null, true, { nested: 'preserved' }] } }
  const message: Message = { id: 'old-write', role: 'assistant', content: 'Display explanation', reasoningContent: 'PRIVATE_REASONING',
    toolCall: { id: 'old-call', name: 'write_file', args }, metadata: { turnId: 'old-turn' } }
  Object.assign(message.toolCall!, { _rawArgs: 'PRIVATE_RAW_DIAGNOSTIC' })
  await history.append(message, scope)
  for (let index = 0; index < 12; index++) await history.append({ id: `tail:${index}`, role: 'assistant', content: 'Later work.' }, scope)
  await history.compress(scope, async () => 'Summary omitting the original arguments.', 4)
  history = new JSONLConversationHistory()
  const ordinary = await searchHistoryTool.execute({ messageId: message.id }, context())
  expect(ordinary.output).toContain('Display explanation')
  expect(ordinary.output).not.toContain('中文🙂')
  const snapshot = toolArgumentsSnapshot(message.toolCall!)
  let contentOffset: number | null = 0, reconstructed = '', pageCount = 0
  while (contentOffset !== null) {
    const result = await searchHistoryTool.execute({ messageId: message.id, toolArguments: true, contentOffset, limit: 1 }, context())
    expect(result.success).toBe(true)
    expect(result.output).not.toContain('PRIVATE_')
    const page = JSON.parse(result.output).messages[0]
    expect(page).toMatchObject({ messageId: message.id, toolCallId: 'old-call', toolName: 'write_file', contentSource: 'tool_arguments',
      contentChars: snapshot.text.length, contentOffset, argumentsSha256: snapshot.sha256, hashDomain: 'tool-arguments-json-utf8' })
    expect(page.content.length).toBeLessThanOrEqual(2000)
    reconstructed += page.content; contentOffset = page.nextContentOffset; pageCount++
    expect(pageCount).toBeLessThan(30)
  }
  expect(pageCount).toBeGreaterThan(2)
  expect(reconstructed).toBe(snapshot.text)
  expect(JSON.parse(reconstructed)).toEqual(args)
  expect((await history.searchArchive(scope, { messageId: message.id })).messages[0].toolCall!.args).toEqual(args)
})

it('does not recover arguments from another scope, a deleted message or an ordinary message', async () => {
  const privateMessage: Message = { id: 'private', role: 'assistant', content: '', toolCall: { id: 'private-call', name: 'write_file', args: { data: 'PRIVATE_ARGUMENTS' } } }
  await history.append(privateMessage, { ...scope, sessionId: 'private-session' })
  await history.append({ ...privateMessage, id: 'deleted' }, scope)
  await history.deleteMessage('deleted', scope.tenantId)
  await history.append({ id: 'ordinary', role: 'user', content: 'PRIVATE_ARGUMENTS' }, scope)
  for (const messageId of ['private', 'deleted', 'ordinary']) {
    const result = await searchHistoryTool.execute({ messageId, toolArguments: true }, context())
    expect(result.success).toBe(false)
    expect(result.metadata?.code).toBe('TOOL_ARGUMENTS_NOT_FOUND')
    expect(result.output).not.toContain('PRIVATE_ARGUMENTS')
  }
})

it.each([
  { query: 'value', toolArguments: true },
  { messageId: 'old', toolArguments: true, query: 'value' },
  { messageId: 'old', toolArguments: true, imageIndex: 0 },
  { messageId: 'old', toolArguments: 'true' },
  { messageId: 'old', toolArguments: true, sessionId: 'other-session' },
])('rejects invalid or ambiguous parameter recovery before reading storage %#', async args => {
  const read = vi.spyOn(history, 'searchArchive')
  expect((await searchHistoryTool.execute(args, context())).success).toBe(false)
  expect(read).not.toHaveBeenCalled()
})

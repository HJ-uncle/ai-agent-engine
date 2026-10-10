import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import { buildCompactSummarizeFn } from '../../../core/agent-loop/compact-prompt.js'
import { searchHistoryTool } from '../../../tools/get-context/search-history-tool.js'
import * as database from '../../sqlite/db.js'
import { up as initialSchema } from '../../sqlite/migrations/001_initial.js'
import { up as messageIds } from '../../sqlite/migrations/002_add_message_id.js'
import { up as sessionSchema } from '../../sqlite/migrations/009_add_sessions.js'
import { up as modelIds } from '../../sqlite/migrations/012_add_message_model_id.js'
import { up as metadataSchema } from '../../sqlite/migrations/015_add_metadata.js'
import { SQLiteConversationHistory } from '../history.js'
import { JSONLConversationHistory } from '../jsonl-history.js'

let fixture: string, db: Client
const scope = { tenantId: 'provider-input-tenant', sessionId: 'provider-input-session' }

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-provider-input-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  db = createClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await initialSchema(db); await messageIds(db); await sessionSchema(db); await modelIds(db); await metadataSchema(db)
  await db.execute('ALTER TABLE conversations ADD COLUMN reasoning_content TEXT')
})

afterEach(() => {
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-provider-input-')) throw new Error('Unsafe fixture cleanup')
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
})

describe.each(['sqlite', 'jsonl'] as const)('%s provider input snapshot', backend => {
  const create = () => backend === 'sqlite' ? new SQLiteConversationHistory() : new JSONLConversationHistory()

  it('persists extracted and multimodal provider content while preserving UI content and clean metadata', async () => {
    const history = create()
    const messages: Message[] = [
      { id: 'text-input', role: 'user', content: 'Read the uploaded specification.', modelInputContent: 'Extracted original requirement: ACTUAL_LIMIT=43; 保留整数金额。', metadata: { attachments: [{ name: 'requirements.md' }] } },
      { id: 'image-input', role: 'user', content: [{ type: 'workspace_image', path: 'layout.png' }], modelInputContent: [{ type: 'text', text: 'Interpret the original layout.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
    ]
    for (const message of messages) await history.append(message, scope)
    const reopened = create()
    const rows = await reopened.getFullHistory(scope)
    expect(rows.map(message => ({ id: message.id, content: message.content, modelInputContent: message.modelInputContent }))).toEqual(messages.map(({ id, content, modelInputContent }) => ({ id, content, modelInputContent })))
    expect(rows[0].metadata).toEqual(messages[0].metadata)
    expect(JSON.stringify(rows[0].metadata)).not.toContain('__aetherModelInputContent')
    const result = await searchHistoryTool.execute({ query: 'ACTUAL_LIMIT=43' }, { ...scope, history: reopened } as unknown as AgentContext)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output).messages[0]).toMatchObject({ messageId: 'text-input', contentSource: 'model_input', content: messages[0].modelInputContent, displayContent: messages[0].content })
  })

  it('invalidates old extracted content after an explicit user edit and ignores metadata snapshot injection', async () => {
    const history = create()
    await history.append({ id: 'editable', role: 'user', content: 'See attachment.', modelInputContent: 'OLD_ATTACHMENT_POLICY=37' }, scope)
    await history.updateMessageContent('editable', scope.tenantId, 'NEW_POLICY=53', 3, { __aetherModelInputContent: 'OLD_ATTACHMENT_POLICY=37', editor: 'user' })
    const reopened = create()
    const edited = (await reopened.getFullHistory(scope)).find(message => message.id === 'editable')!
    expect(edited.content).toBe('NEW_POLICY=53')
    expect(edited.modelInputContent).toBeUndefined()
    const result = await searchHistoryTool.execute({ query: 'OLD_ATTACHMENT_POLICY' }, { ...scope, history: reopened } as unknown as AgentContext)
    expect(JSON.parse(result.output).totalMatches).toBe(0)
  })
})

it('recovers actual attachment facts from the real JSONL archive after an omitting summary and restart', async () => {
  let history = new JSONLConversationHistory()
  const actual = 'Extracted file contents: ' + 'ordinary development details '.repeat(600) + 'TAIL_ATTACHMENT_DECISION=7913; exact migration limit is 43.'
  await history.append({ id: 'attachment-turn', role: 'user', content: 'Read requirements.md.', modelInputContent: actual, metadata: { turnId: 'original-turn', attachments: [{ name: 'requirements.md' }] } }, scope)
  for (let index = 0; index < 6; index++) await history.append({ id: `continued-${index}`, role: 'assistant', content: 'Continued project work.' }, scope)
  const summarize = buildCompactSummarizeFn({ complete: async () => ({ content: '<summary>Continue the project. This summary omitted the attachment decision.</summary>' }) }, { archiveAvailable: true, contextWindow: 100_000 })
  await history.compress(scope, summarize, 1)
  history = new JSONLConversationHistory()
  expect((await history.getFullHistory(scope)).some(message => message.id === 'attachment-turn')).toBe(false)
  expect(JSON.stringify(await history.getFullHistory(scope))).not.toContain('TAIL_ATTACHMENT_DECISION')
  const hit = JSON.parse((await searchHistoryTool.execute({ query: 'TAIL_ATTACHMENT_DECISION' }, { ...scope, history } as unknown as AgentContext)).output)
  expect(hit.totalMatches).toBe(1)
  expect(hit.messages[0]).toMatchObject({ messageId: 'attachment-turn', turnId: 'original-turn', contentSource: 'model_input', displayContent: 'Read requirements.md.' })
  expect(hit.messages[0].content).toContain('TAIL_ATTACHMENT_DECISION=7913')
  let offset: number | null = 0, reconstructed = ''
  while (offset !== null) {
    const result = JSON.parse((await searchHistoryTool.execute({ messageId: 'attachment-turn', contentOffset: offset }, { ...scope, history } as unknown as AgentContext)).output)
    reconstructed += result.messages[0].content; offset = result.messages[0].nextContentOffset
  }
  expect(reconstructed).toBe(actual)
  expect((await history.getArchive(scope)).messages[0].content).toBe('Read requirements.md.')
  expect((await history.getMessageById('attachment-turn', scope.tenantId))?.modelInputContent).toBe(actual)
  await history.updateMessageContent('attachment-turn', scope.tenantId, 'CORRECTED_ATTACHMENT_DECISION=8091', 3)
  history = new JSONLConversationHistory()
  expect((await history.searchArchive(scope, { query: 'TAIL_ATTACHMENT_DECISION' })).totalMatches).toBe(0)
  expect((await history.getMessageById('attachment-turn', scope.tenantId))?.content).toBe('CORRECTED_ATTACHMENT_DECISION=8091')
  await history.deleteMessage('attachment-turn', scope.tenantId)
  expect((await new JSONLConversationHistory().searchArchive(scope, { query: 'CORRECTED_ATTACHMENT_DECISION' })).totalMatches).toBe(0)
})

it('keeps retained SQLite provider input during compression and carries it through lazy JSONL migration', async () => {
  const sqlite = new SQLiteConversationHistory()
  await sqlite.append({ id: 'previous', role: 'assistant', content: 'Completed earlier work.' }, scope)
  await sqlite.append({ id: 'attachment', role: 'user', content: 'See upload.', modelInputContent: 'MIGRATED_ATTACHMENT_REQUIREMENT=53' }, scope)
  await sqlite.compress(scope, async () => 'Earlier work summarized.', 1)
  const reopened = new SQLiteConversationHistory()
  expect((await reopened.getFullHistory(scope)).find(message => message.id === 'attachment')?.modelInputContent).toBe('MIGRATED_ATTACHMENT_REQUIREMENT=53')
  const jsonl = new JSONLConversationHistory()
  expect((await jsonl.searchArchive(scope, { query: 'MIGRATED_ATTACHMENT_REQUIREMENT' })).messages[0].modelInputContent).toBe('MIGRATED_ATTACHMENT_REQUIREMENT=53')
  expect((await jsonl.getFullHistory(scope)).find(message => message.id === 'attachment')?.modelInputContent).toBe('MIGRATED_ATTACHMENT_REQUIREMENT=53')
  const result = await searchHistoryTool.execute({ query: 'MIGRATED_ATTACHMENT_REQUIREMENT' }, { ...scope, history: new JSONLConversationHistory() } as unknown as AgentContext)
  expect(JSON.parse(result.output).messages[0].content).toBe('MIGRATED_ATTACHMENT_REQUIREMENT=53')
})

it('does not reimport populated legacy SQLite history after a searched JSONL session is cleared', async () => {
  const sqlite = new SQLiteConversationHistory()
  await sqlite.append({ id: 'legacy-evidence', role: 'user', content: 'Retained legacy settlement reference.' }, scope)
  const jsonl = new JSONLConversationHistory()
  expect((await jsonl.searchArchive(scope, { query: 'settlement' })).messages.map(message => message.id)).toEqual(['legacy-evidence'])
  await jsonl.clear(scope)
  expect((await sqlite.getFullHistory(scope)).some(message => message.id === 'legacy-evidence')).toBe(true)
  expect((await new JSONLConversationHistory().searchArchive(scope, { query: 'settlement' })).messages).toEqual([])
})

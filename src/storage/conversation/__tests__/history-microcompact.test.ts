import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import * as database from '../../sqlite/db.js'
import { up as initialSchema } from '../../sqlite/migrations/001_initial.js'
import { up as messageIds } from '../../sqlite/migrations/002_add_message_id.js'
import { up as sessionSchema } from '../../sqlite/migrations/009_add_sessions.js'
import { up as modelIds } from '../../sqlite/migrations/012_add_message_model_id.js'
import { up as metadataSchema } from '../../sqlite/migrations/015_add_metadata.js'
import { SQLiteConversationHistory } from '../history.js'
import { JSONLConversationHistory } from '../jsonl-history.js'
import type { Message } from '../../../core/agent-context/types.js'

type Ctx = { tenantId: string; sessionId: string }
type History = Pick<SQLiteConversationHistory, 'append' | 'getFullHistory' | 'microCompactToolResults'>

const ctx: Ctx = { tenantId: 'micro-compact-tenant', sessionId: 'micro-compact-session' }

let db: Client
let fixture: string
let savedDataDir: string | undefined

function tool(id: string, content: string): Message {
  return {
    id,
    role: 'tool',
    content,
    toolCallId: `call-${id}`,
    toolName: 'execute_cmd',
    tokens: Math.max(1, Math.ceil(content.length / 4)),
  }
}

function user(id: string): Message {
  return { id, role: 'user', content: `message-${id}`, tokens: 2 }
}

async function setupSqlite(): Promise<History> {
  db = createClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await initialSchema(db)
  await messageIds(db)
  await sessionSchema(db)
  await modelIds(db)
  await metadataSchema(db)
  await db.execute('ALTER TABLE conversations ADD COLUMN reasoning_content TEXT')
  return new SQLiteConversationHistory(1_000_000)
}

function setupJsonl(): History {
  savedDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = path.join(fixture, 'agent.db')
  return new JSONLConversationHistory(1_000_000)
}

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-microcompact-'))
})

afterEach(() => {
  db?.close()
  vi.restoreAllMocks()
  if (savedDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = savedDataDir
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-microcompact-')) {
    throw new Error('Unsafe fixture cleanup')
  }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

describe.each([
  ['sqlite', setupSqlite],
  ['jsonl', setupJsonl],
] as const)('%s micro-compaction', (_name, setup) => {
  it('保留十条以内且不超 maxChars 的工具结果', async () => {
    const history = await setup()
    // SQLite intentionally drops tool rows that precede the first user row as
    // orphaned recovery data; seed a valid conversation before the tool.
    await history.append(user('first'), ctx)
    await history.append(tool('short-tool', 'small output'), ctx)
    await history.append(user('follow-up'), ctx)
    await history.append(user('latest'), ctx)

    const result = await history.microCompactToolResults(ctx, { keepRecent: 10, maxChars: 64 })
    expect(result.cleared).toBe(0)
    expect((await history.getFullHistory(ctx)).find((message) => message.id === 'short-tool')?.content).toBe('small output')
  })

  it('清理最近十条内超出 maxChars 的结果，同时清理窗口外旧结果', async () => {
    const history = await setup()
    await history.append(user('old-user'), ctx)
    await history.append(tool('old-tool', 'old output'), ctx)
    for (let index = 0; index < 8; index += 1) await history.append(user(`context-${index}`), ctx)
    await history.append(tool('recent-huge', 'x'.repeat(200)), ctx)
    await history.append(user('latest'), ctx)

    const result = await history.microCompactToolResults(ctx, { keepRecent: 10, maxChars: 64 })
    expect(result.cleared).toBe(2)
    const messages = await history.getFullHistory(ctx)
    expect(messages.find((message) => message.id === 'old-tool')?.content).toBe('[tool result cleared]')
    expect(messages.find((message) => message.id === 'recent-huge')?.content).toBe('[tool result cleared]')
  })
})

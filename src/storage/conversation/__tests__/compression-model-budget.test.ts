import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../core/agent-context/types.js'
import { estimateModelHistoryTokens } from '../../../core/utils/model-context.js'
import { buildCompactSummarizeFn } from '../../../core/agent-loop/compact-prompt.js'
import * as database from '../../sqlite/db.js'
import { up as initialSchema } from '../../sqlite/migrations/001_initial.js'
import { up as messageIds } from '../../sqlite/migrations/002_add_message_id.js'
import { up as sessionSchema } from '../../sqlite/migrations/009_add_sessions.js'
import { up as modelIds } from '../../sqlite/migrations/012_add_message_model_id.js'
import { up as metadataSchema } from '../../sqlite/migrations/015_add_metadata.js'
import { SQLiteConversationHistory } from '../history.js'
import { JSONLConversationHistory } from '../jsonl-history.js'

let fixture: string
let db: Client
const ctx = { tenantId: 'context-budget-tenant', sessionId: 'context-budget-session' }

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-context-budget-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  db = createClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await initialSchema(db); await messageIds(db); await sessionSchema(db); await modelIds(db); await metadataSchema(db)
  await db.execute('ALTER TABLE conversations ADD COLUMN reasoning_content TEXT')
})

afterEach(() => {
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-context-budget-')) throw new Error('Unsafe fixture cleanup')
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
})

describe.each(['sqlite', 'jsonl'] as const)('%s model-input compaction', backend => {
  const create = () => backend === 'sqlite' ? new SQLiteConversationHistory() : new JSONLConversationHistory()

  it('compacts real oversized tool arguments even with zero stored token counts, preserving directives and recent UI data', async () => {
    const history = create()
    const constraint = 'Modify only the approved project; do not upload credentials.'
    const originals: Message[] = [{ id: 'request', role: 'user', content: constraint, tokens: 0 }]
    for (let index = 0; index < 3; index++) {
      originals.push({ id: `call-${index}`, role: 'assistant', content: '', tokens: 0,
        toolCall: { id: `write-${index}`, name: 'write_file', args: { path: `src/file-${index}.ts`, content: 'actual source text\n'.repeat(2_000) } } })
      originals.push({ id: `result-${index}`, role: 'tool', toolCallId: `write-${index}`, content: 'File written.', tokens: 0,
        metadata: { change: { oldContent: 'old '.repeat(10_000), newContent: 'new '.repeat(10_000) } } })
    }
    const recent = { id: 'current', role: 'user' as const, content: 'Continue and run the project tests.', tokens: 0,
      metadata: { attachments: [{ name: 'requirements.md' }], rootRunId: 'current-run' } }
    originals.push(recent)
    for (const message of originals) await history.append(message, ctx)
    const before = await history.getFullHistory(ctx)
    const complete = vi.fn(async (_messages: Message[]) => ({ content: '<summary>Wrote src/file-0.ts, src/file-1.ts, and src/file-2.ts. Run the tests next.</summary>' }))
    const summarize = buildCompactSummarizeFn({ complete }, { contextWindow: 12_000 })
    const stats = await history.compress(ctx, summarize, { keepRecentTokens: 1_000, force: true })
    const after = await history.getFullHistory(ctx)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0][0].content).toContain('Tool call write_file')
    expect(complete.mock.calls[0][0][0].content).toContain('src/file-0.ts')
    expect(after).toHaveLength(2)
    expect(after[0].content).toContain(constraint)
    expect(after[1]).toEqual(before.at(-1))
    expect(stats.preTokens).toBeGreaterThan(30_000)
    expect(stats.postTokens).toBeLessThan(1_000)
    expect(estimateModelHistoryTokens(after)).toBeLessThan(1_000)
    if (backend === 'jsonl') {
      const archive = await history.getArchive!(ctx)
      expect(archive.messages).toHaveLength(originals.length)
      expect(archive.messages.find(message => message.id === 'result-0')?.metadata.change.oldContent).toBe(originals[2].metadata.change.oldContent)
    }
  })

  it('does not split a parallel tool exchange at the retention boundary', async () => {
    const history = create()
    const originals: Message[] = [
      { id: 'task', role: 'user', content: 'inspect' },
      { id: 'call-1', role: 'assistant', content: '', toolCall: { id: 'read-1', name: 'read_file', args: { path: 'a' } } },
      { id: 'call-2', role: 'assistant', content: '', toolCall: { id: 'read-2', name: 'read_file', args: { path: 'b' } } },
      { id: 'result-1', role: 'tool', content: 'a', toolCallId: 'read-1' },
      { id: 'result-2', role: 'tool', content: 'b', toolCallId: 'read-2' },
    ]
    for (const message of originals) await history.append(message, ctx)
    const summarized: Message[][] = []
    await history.compress(ctx, async older => { summarized.push(older); return 'Inspect both project files.' }, 2)
    expect(summarized[0].map(message => message.id)).toEqual(['task'])
    expect((await history.getFullHistory(ctx)).slice(1).map(message => message.id)).toEqual(originals.slice(1).map(message => message.id))
  })

  it('forces actual progress when low-content history would otherwise silently no-op', async () => {
    const history = create()
    for (let index = 0; index < 4; index++) await history.append({ id: `m-${index}`, role: 'assistant', content: 'short', tokens: 0 }, ctx)
    const summarize = vi.fn(async () => 'Earlier work.')
    await history.compress(ctx, summarize, { keepRecentTokens: 25_600, force: true })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect((await history.getFullHistory(ctx)).map(message => message.id).slice(1)).toEqual(['m-2', 'm-3'])
  })
})

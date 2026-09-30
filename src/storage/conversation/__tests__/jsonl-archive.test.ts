import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSONLConversationHistory } from '../jsonl-history.js'

let fixture: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  if (fixture) {
    try {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  }
  fixture = undefined
})

function setup(): JSONLConversationHistory {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-jsonl-archive-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  return new JSONLConversationHistory()
}

describe('JSONL conversation archive', () => {
  it('expands messages hidden by a compaction summary without changing the model projection', async () => {
    const history = setup()
    const ctx = { tenantId: 'default', sessionId: 'archive-session' }
    for (let i = 0; i < 10; i++) {
      await history.append({ id: `m-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `message-${i}`, tokens: 10 }, ctx)
    }

    await history.compress(ctx, async () => 'older conversation summary', 4)

    const compact = await history.getFullHistory(ctx)
    const archive = await history.getArchive(ctx)
    expect(compact.some(message => message.metadata?.isCompactSummary === true)).toBe(true)
    expect(compact).toHaveLength(5)
    expect(archive.compressed).toBe(true)
    expect(archive.messages).toHaveLength(10)
    expect(archive.messages.map(message => message.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m-${i}`))
    expect(archive.summary?.content).toBe('older conversation summary')
    expect(archive.currentMessageCount).toBe(compact.length)
  })

  it('keeps tombstone and update semantics while expanding the archive', async () => {
    const history = setup()
    const ctx = { tenantId: 'default', sessionId: 'archive-tombstones' }
    await history.append({ id: 'keep', role: 'user', content: 'keep', tokens: 1 }, ctx)
    await history.append({ id: 'remove', role: 'assistant', content: 'remove', tokens: 1 }, ctx)
    await history.append({ id: 'edit', role: 'assistant', content: 'before', tokens: 1 }, ctx)
    await history.deleteMessage('remove', ctx.tenantId)
    await history.updateMessageContent('edit', ctx.tenantId, 'after', 2)

    const archive = await history.getArchive(ctx)
    expect(archive.messages.map(message => message.id)).toEqual(['keep', 'edit'])
    expect(archive.messages.find(message => message.id === 'edit')?.content).toBe('after')
  })

  it('does not read a renamed backup after clear', async () => {
    const history = setup()
    const ctx = { tenantId: 'default', sessionId: 'archive-clear' }
    await history.append({ id: 'old', role: 'user', content: 'old', tokens: 1 }, ctx)
    await history.clear(ctx)
    const archive = await history.getArchive(ctx)
    expect(archive.messages).toEqual([])
    expect(archive.compressed).toBe(false)
  })

  it('honors a fallback clear tombstone whose dbSeq is zero', async () => {
    const history = setup()
    const ctx = { tenantId: 'default', sessionId: 'archive-clear-fallback' }
    const file = path.join(fixture!, 'sessions', ctx.tenantId, `${ctx.sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const envelope = (dbSeq: number, id: string, role: 'user' | 'assistant', content: string) => ({
      uuid: id, parentUuid: null, type: role, timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId, tenantId: ctx.tenantId, isSidechain: false, dbSeq,
      payload: { id, role, content, tokens: 1 },
    })
    const clear = {
      uuid: 'clear-marker', parentUuid: null, type: 'tombstone', timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId, tenantId: ctx.tenantId, isSidechain: false, dbSeq: 0, scope: 'clear',
    }
    fs.writeFileSync(file, `${JSON.stringify(envelope(1, 'old', 'user', 'old'))}\n${JSON.stringify(clear)}\n${JSON.stringify(envelope(2, 'new', 'user', 'new'))}\n`)

    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual(['new'])
    expect((await history.getArchive(ctx)).messages.map(message => message.id)).toEqual(['new'])
  })
})

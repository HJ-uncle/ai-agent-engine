import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSONLConversationHistory } from '../jsonl-history.js'

let root: string
const ctx = { tenantId: 'storage-tenant', sessionId: 'storage-session' }
const file = () => path.join(root, 'sessions', ctx.tenantId, ctx.sessionId + '.jsonl')
const restart = () => new JSONLConversationHistory()
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-storage-optimization-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), '')
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('aether-storage-optimization-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('JSONL storage optimization preserves public history', () => {
  it('deduplicates image data and large tool output without leaking storage references to reads/search/pages', async () => {
    const history = restart(), data = 'data:image/png;base64,' + 'QUJD'.repeat(50000)
    const content = [{ type: 'text', text: 'image evidence' }, { type: 'image_url', image_url: { url: data } }]
    await history.append({ id: 'image', role: 'tool', content, modelInputContent: content, tokens: 100 }, ctx)
    const raw = fs.readFileSync(file(), 'utf8')
    expect(raw.length).toBeLessThan(2500)
    expect(raw).not.toContain(data)
    const refs = JSON.parse(raw).storageBlobs.refs
    expect(refs).toHaveLength(2); expect(refs[0].hash).toBe(refs[1].hash)
    for (const reader of [history, restart()]) {
      expect((await reader.getFullHistory(ctx))[0]).toMatchObject({ content, modelInputContent: content })
      expect((await reader.getArchive(ctx, { offset: 0, limit: 1 })).messages[0].content).toEqual(content)
      expect((await reader.searchArchive(ctx, { query: 'image evidence', limit: 1 })).messages[0].content).toEqual(content)
    }
    await history.microCompactToolResults(ctx, { keepRecent: 0 })
    const rows = fs.readFileSync(file(), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows[1].archiveContent).toBeUndefined()
    expect(rows[1].archiveReference).toMatchObject({ version: 1, messageId: 'image' })
    const current = (await restart().getFullHistory(ctx))[0]
    expect(current.content).toBe('[tool result cleared]')
    expect(String(current.metadata?.outputPreview).length).toBeLessThanOrEqual(2048)
    expect((await restart().getArchive(ctx)).messages[0].content).toEqual(content)
    expect((await restart().searchArchive(ctx, { messageId: 'image', limit: 1 })).messages[0].content).toEqual(content)
  })

  it('references the latest explicit edit, then handles repeated compaction, edit and deletion', async () => {
    const history = restart(), original = 'original '.repeat(12000), edited = 'edited evidence '.repeat(10000)
    await history.append({ id: 'tool', role: 'tool', content: original, tokens: 40000 }, ctx)
    await history.updateMessageContent('tool', ctx.tenantId, edited, 30000)
    await history.microCompactToolResults(ctx, { keepRecent: 0 })
    expect((await restart().getArchive(ctx)).messages[0].content).toBe(edited)
    expect((await restart().getArchive(ctx, { offset: 0, limit: 1 })).messages[0].content).toBe(edited)
    expect((await restart().microCompactToolResults(ctx, { keepRecent: 0 })).cleared).toBe(0)
    await history.updateMessageContent('tool', ctx.tenantId, 'corrected', 2)
    await history.microCompactToolResults(ctx, { keepRecent: 0 })
    expect((await restart().getArchive(ctx)).messages[0].content).toBe('corrected')
    await history.deleteMessage('tool', ctx.tenantId)
    expect((await restart().getArchive(ctx)).messages).toEqual([])
  })

  it('fails visibly if durable body content or a reference source is missing or changed', async () => {
    const history = restart()
    await history.append({ id: 'tool', role: 'tool', content: 'important '.repeat(10000), tokens: 500 }, ctx)
    await history.microCompactToolResults(ctx, { keepRecent: 0 })
    const rows = fs.readFileSync(file(), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    rows[1].archiveReference.contentHash = '0'.repeat(64)
    fs.writeFileSync(file(), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    await expect(restart().getArchive(ctx, { offset: 0, limit: 1 })).rejects.toThrow('archive reference')
    const ref = rows[0].storageBlobs.refs[0]
    fs.unlinkSync(path.join(root, 'blobs', rows[0].storageBlobs.tenant, ref.hash.slice(0, 2), ref.hash + '.gz'))
    await expect(restart().getFullHistory(ctx)).rejects.toThrow()
    await expect(restart().searchArchive(ctx, { messageId: 'tool' })).rejects.toThrow()
  })

  it('does not append a duplicate ID hidden behind a summary', async () => {
    const history = restart()
    for (let i = 0; i < 8; i++) await history.append({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: 'message ' + i, tokens: 10 }, ctx)
    await history.compress(ctx, async () => 'summary', 2)
    const before = fs.statSync(file()).size
    await restart().append({ id: 'm0', role: 'user', content: 'replayed input', tokens: 10 }, ctx)
    expect(fs.statSync(file()).size).toBe(before)
    expect((await restart().getArchive(ctx)).messages.filter(message => message.id === 'm0')).toHaveLength(1)
  })

  it('never resolves a foreign tenant row placed in another session file', async () => {
    const history = restart(), foreign = { tenantId: 'foreign-tenant', sessionId: 'foreign-session' }
    const foreignFile = path.join(root, 'sessions', foreign.tenantId, foreign.sessionId + '.jsonl')
    fs.mkdirSync(path.dirname(foreignFile), { recursive: true }); fs.writeFileSync(foreignFile, '')
    await history.append({ id: 'secret', role: 'user', content: 'private content '.repeat(10000) }, foreign)
    fs.appendFileSync(file(), fs.readFileSync(foreignFile))
    const reader = restart()
    expect(await reader.getFullHistory(ctx)).toEqual([])
    expect((await reader.getArchive(ctx)).messages).toEqual([])
    expect((await reader.getArchive(ctx, { offset: 0, limit: 10 })).messages).toEqual([])
    expect((await reader.searchArchive(ctx, { query: 'private' })).messages).toEqual([])
  })

  it('separates a failed partial ordinary append before the next durable write', async () => {
    const history = restart()
    await history.append({ id: 'first', role: 'user', content: 'first' }, ctx)
    fs.appendFileSync(file(), '{"uuid":"incomplete"')
    await history.append({ id: 'second', role: 'assistant', content: 'second' }, ctx)
    expect((await restart().getArchive(ctx)).messages.map(message => message.id)).toEqual(['first', 'second'])
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
  })

  it('finishes a complete JSON tail and syncs an idempotent retry without duplicating it', async () => {
    await restart().append({ id: 'once', role: 'assistant', content: 'durable result' }, ctx)
    fs.truncateSync(file(), fs.statSync(file()).size - 1)
    await restart().append({ id: 'once', role: 'assistant', content: 'retry' }, ctx)
    const raw = fs.readFileSync(file(), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.trim().split('\n')).toHaveLength(1)
    expect((await restart().getArchive(ctx)).messages[0].content).toBe('durable result')
  })
})

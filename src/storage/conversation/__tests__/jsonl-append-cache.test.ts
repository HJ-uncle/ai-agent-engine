import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSONLConversationHistory } from '../jsonl-history.js'

let root: string
const ctx = { tenantId: 'cache-tenant', sessionId: 'cache-session' }
const archiveFile = () => path.join(root, 'sessions', ctx.tenantId, `${ctx.sessionId}.jsonl`)
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-jsonl-cache-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  const file = archiveFile(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '')
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})
const message = (id: string) => ({ id, role: 'user' as const, content: `message ${id}`, tokens: 3 })
const restart = () => new JSONLConversationHistory()

describe('JSONL bounded append projection cache', () => {
  it('updates every durable field without rereading the archive and leaves prior snapshots stable', async () => {
    const history = restart()
    await history.append(message('first'), ctx)
    const snapshot = await history.getFullHistory(ctx)
    const reader = vi.spyOn(fs.promises, 'readFile')
    for (let index = 0; index < 10; index++) {
      await history.append({ ...message(`next-${index}`), modelInputContent: `provider ${index}`, metadata: { index }, conversationId: 'turn' } as never, ctx)
      expect((await history.getFullHistory(ctx)).at(-1)).toMatchObject({ id: `next-${index}`, modelInputContent: `provider ${index}`, dbId: index + 2 })
    }
    expect(reader.mock.calls.filter(args => String(args[0]) === archiveFile())).toHaveLength(0)
    expect(snapshot.map(row => row.id)).toEqual(['first'])
    expect(await history.getRawTokenCount(ctx)).toBe(33)
    expect(await history.getMessageById('next-9', ctx.tenantId)).toMatchObject({ id: 'next-9', dbId: 11, conversationId: 'turn' })
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
    expect((history as unknown as { writeQueues: Map<string, unknown> }).writeQueues.size).toBe(0)
  })

  it('does not expose caller mutations to newly persisted payloads or duplicate active messages', async () => {
    const history = restart()
    const input = { ...message('once'), content: [{ type: 'text', text: 'original' }], metadata: { state: 'original' } }
    await history.append(input, ctx)
    input.content[0].text = 'changed later'; input.metadata.state = 'changed later'
    await history.append(message('once'), ctx)
    expect(await history.getFullHistory(ctx)).toHaveLength(1)
    expect((await history.getFullHistory(ctx))[0]).toMatchObject({ content: [{ text: 'original' }], metadata: { state: 'original' } })
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
  })

  it('invalidates edits, deletions, summaries and tool micro-compaction before continuing append', async () => {
    const history = restart()
    for (let index = 0; index < 8; index++) await history.append(message(`m-${index}`), ctx)
    await history.updateMessageContent('m-2', ctx.tenantId, 'edited', 5, { changed: true })
    await history.deleteMessage('m-3', ctx.tenantId)
    await history.append({ id: 'tool', role: 'tool', content: 'x'.repeat(400), tokens: 100 }, ctx)
    await history.microCompactToolResults(ctx, { keepRecent: 0 })
    await history.compress(ctx, async () => 'Retained requirements', 3)
    await history.append(message('after-compaction'), ctx)
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
    const archive = await history.getArchive(ctx)
    expect(archive.messages.find(row => row.id === 'm-2')).toMatchObject({ content: 'edited', tokens: 5 })
    expect(archive.messages.find(row => row.id === 'm-3')).toBeUndefined()
    expect(archive.messages.find(row => row.id === 'tool')?.content).toBe('x'.repeat(400))
    expect((await history.getFullHistory(ctx)).some(row => row.metadata?.isCompactSummary)).toBe(true)
  })

  it('applies durable deletion without letting a legacy truncate hide later appended rows', async () => {
    const history = restart()
    for (let index = 0; index < 4; index++) await history.append(message(`m-${index}`), ctx)
    await history.deleteMessage('m-1', ctx.tenantId)
    await history.append(message('m-1'), ctx)
    expect((await history.getFullHistory(ctx)).some(row => row.id === 'm-1')).toBe(false)
    await history.deleteMessagesAfterId(3, ctx.sessionId, ctx.tenantId)
    await history.append(message('after-truncate'), ctx)
    expect((await history.getFullHistory(ctx)).some(row => row.id === 'after-truncate')).toBe(true)
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
  })

  it('keeps later requirements through repeated cuts, restart, archive pages and search', async () => {
    const history = restart()
    for (let index=0;index<4;index++) await history.append(message(`old-${index}`),ctx)
    await history.deleteMessagesAfterId(1,ctx.sessionId,ctx.tenantId)
    await history.append(message('new-first'),ctx)
    await history.append(message('new-discard'),ctx)
    const target = await history.getMessageById('new-first',ctx.tenantId)
    await history.deleteMessagesAfterId(target!.dbId,ctx.sessionId,ctx.tenantId)
    await history.append(message('new-last'),ctx)
    const expected=['old-0','new-first','new-last']
    for (const reader of [history,restart()]) {
      expect((await reader.getFullHistory(ctx)).map(row=>row.id)).toEqual(expected)
      expect((await reader.getArchive(ctx)).messages.map(row=>row.id)).toEqual(expected)
      const page=await reader.getArchive(ctx,{offset:0,limit:10})
      expect(page.messages.map(row=>row.id)).toEqual(expected)
      expect(page.currentMessageCount).toBe(3)
      expect((await reader.searchArchive(ctx,{limit:10})).messages.map(row=>row.id)).toEqual(expected)
    }
    await history.deleteMessagesAfterId(0,ctx.sessionId,ctx.tenantId)
    await history.append(message('fresh-after-zero'),ctx)
    expect((await restart().getFullHistory(ctx)).map(row=>row.id)).toEqual(['fresh-after-zero'])
  })

  it('removes a summary made after the cut and restores the prior surviving summary', async () => {
    const history=restart()
    for(let index=0;index<8;index++) await history.append(message(`m-${index}`),ctx)
    await history.compress(ctx,async()=> 'first summary',4)
    await history.append(message('m-8'),ctx); await history.append(message('discarded'),ctx)
    await history.compress(ctx,async()=> 'later discarded summary',2)
    const target=await history.getMessageById('m-8',ctx.tenantId)
    await history.deleteMessagesAfterId(target!.dbId,ctx.sessionId,ctx.tenantId)
    await history.append(message('after-cut'),ctx)
    const expected=Array.from({length:9},(_,index)=>`m-${index}`).concat('after-cut')
    for(const reader of [history,restart()]) {
      const active=await reader.getFullHistory(ctx)
      expect(active[0].content).toContain('first summary')
      expect(active.some(row=>String(row.content).includes('later discarded summary'))).toBe(false)
      expect(active.slice(1).map(row=>row.id)).toEqual(['m-4','m-5','m-6','m-7','m-8','after-cut'])
      const archive=await reader.getArchive(ctx)
      expect(archive.summary?.content).toBe('first summary')
      expect(archive.messages.map(row=>row.id)).toEqual(expected)
      const page=await reader.getArchive(ctx,{offset:0,limit:20})
      expect(page.messages.map(row=>row.id)).toEqual(expected)
      expect(page.summary?.content).toBe('first summary')
      expect(page.currentMessageCount).toBe(active.length)
      expect((await reader.searchArchive(ctx,{limit:20})).messages.map(row=>row.id)).toEqual(expected)
    }
  })

  it('cuts inside already summarized history without retaining discarded future facts', async () => {
    const history=restart()
    for(let index=0;index<8;index++) await history.append(message(`m-${index}`),ctx)
    await history.compress(ctx,async()=> 'summary including discarded future facts',2)
    const target=await history.getMessageById('m-1',ctx.tenantId)
    await history.deleteMessagesAfterId(target!.dbId,ctx.sessionId,ctx.tenantId)
    await history.append(message('new-task'),ctx)
    const expected=['m-0','m-1','new-task']
    for(const reader of [history,restart()]) {
      expect((await reader.getFullHistory(ctx)).map(row=>row.id)).toEqual(expected)
      const archive=await reader.getArchive(ctx)
      expect(archive.compressed).toBe(false)
      expect(archive.messages.map(row=>row.id)).toEqual(expected)
      const page=await reader.getArchive(ctx,{offset:0,limit:10})
      expect(page.compressed).toBe(false); expect(page.messages.map(row=>row.id)).toEqual(expected)
      expect((await reader.searchArchive(ctx,{limit:10})).messages.map(row=>row.id)).toEqual(expected)
    }
  })

  it('detects another instance, external tail rows, same-size rewrites with restored mtime, and replacement files', async () => {
    const history = restart(), other = restart()
    await history.append(message('first'), ctx)
    await other.append(message('external'), ctx)
    expect((await history.getFullHistory(ctx)).map(row => row.id)).toEqual(['first', 'external'])
    await history.append(message('third'), ctx)
    const oldStat = fs.statSync(archiveFile())
    const text = fs.readFileSync(archiveFile(), 'utf8').replace('message first', 'changed first')
    fs.writeFileSync(archiveFile(), text)
    fs.utimesSync(archiveFile(), oldStat.atime, oldStat.mtime)
    expect((await history.getFullHistory(ctx))[0].content).toBe('changed first')
    const replacement = archiveFile() + '.replacement'
    fs.writeFileSync(replacement, text.replace('changed first', 'replace first'))
    fs.renameSync(replacement, archiveFile())
    await history.append(message('after-replacement'), ctx)
    expect((await history.getFullHistory(ctx))[0].content).toBe('replace first')
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
  })

  it('serializes concurrent writers across instances and never advances state on a failed append', async () => {
    const history = restart(), other = restart()
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? history : other).append(message(`m-${index}`), ctx)))
    const messages = await history.getFullHistory(ctx)
    expect(messages).toHaveLength(20)
    expect(new Set(messages.map(row => (row as unknown as { dbId: number }).dbId)).size).toBe(20)
    const writer = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('isolated write failure'))
    await expect(history.append(message('failed'), ctx)).rejects.toThrow('isolated write failure')
    writer.mockRestore()
    await history.append(message('success'), ctx)
    expect((await history.getFullHistory(ctx)).at(-1)).toMatchObject({ id: 'success', dbId: 21 })
    expect((await history.getFullHistory(ctx)).some(row => row.id === 'failed')).toBe(false)
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
  })

  it('clears cache accounting and rebuilds a new session without resurrecting the old archive', async () => {
    const history = restart()
    await history.append(message('old'), ctx)
    await history.clear(ctx)
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 6_000)
    await history.append(message('fresh'), ctx)
    expect((await history.getFullHistory(ctx)).map(row => row.id)).toEqual(['fresh'])
    expect(await history.getFullHistory(ctx)).toEqual(await restart().getFullHistory(ctx))
    expect((history as unknown as { cachedBytes: number }).cachedBytes).toBeGreaterThanOrEqual(0)
  })

  it('evicts least recently used projections without dropping durable sessions', async () => {
    const history = restart()
    for(let index=0;index<70;index++) {
      const current = { ...ctx, sessionId: `many-${index}` }
      const file = path.join(root, 'sessions', ctx.tenantId, `${current.sessionId}.jsonl`)
      fs.writeFileSync(file, '')
      await history.append(message(`entry-${index}`), current)
    }
    expect((history as unknown as { states: Map<string, unknown> }).states.size).toBeLessThanOrEqual(64)
    expect((await history.getFullHistory({ ...ctx, sessionId: 'many-0' }))[0].id).toBe('entry-0')
    expect((history as unknown as { writeQueues: Map<string, unknown> }).writeQueues.size).toBe(0)
  })
})

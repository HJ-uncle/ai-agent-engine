import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSONLConversationHistory } from '../jsonl-history.js'

let fixture: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  if (fixture) {
    if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-jsonl-archive-')) throw new Error('Unsafe fixture cleanup')
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
  it('restores legacy micro-compacted tool evidence for display without expanding model content', async () => {
    const history = setup()
    const ctx = { tenantId: 'default', sessionId: 'legacy-micro' }
    await history.append({ id: 'question', role: 'user', content: 'run the test', tokens: 3 }, ctx)
    await history.append({ id: 'result', role: 'tool', toolCallId: 'run-test', toolName: 'execute_cmd',
      content: 'original output', tokens: 4, metadata: { success: false, error: 'COMMAND_EXIT_FAILED' } }, ctx)
    // A genuine update preceding compaction must win over the original row.
    await history.updateMessageContent('result', ctx.tenantId, 'Assertion failed: actual 2, expected 1', 9, { success: false, error: 'COMMAND_EXIT_FAILED' })
    const file = path.join(fixture!, 'sessions', ctx.tenantId, `${ctx.sessionId}.jsonl`)
    fs.appendFileSync(file, JSON.stringify({ uuid: 'legacy-clear', parentUuid: null, type: 'update', dbSeq: 0,
      timestamp: new Date().toISOString(), ...ctx, isSidechain: false, targetUuid: 'result', content: '[tool result cleared]', tokens: 5 }) + '\n')
    const restarted = new JSONLConversationHistory()
    const current = await restarted.getFullHistory(ctx)
    expect(current.find(message => message.id === 'result')).toMatchObject({
      content: '[tool result cleared]', tokens: 5,
      metadata: { success: false, error: 'COMMAND_EXIT_FAILED', outputPreview: 'Assertion failed: actual 2, expected 1' },
    })
    expect((await restarted.getArchive(ctx)).messages.find(message => message.id === 'result')).toMatchObject({
      content: 'Assertion failed: actual 2, expected 1', tokens: 9,
    })
    // A later explicit edit supersedes compaction, and explicit deletion must
    // still remove the tool from both user and model projections.
    await restarted.updateMessageContent('result', ctx.tenantId, 'corrected evidence', 5)
    expect((await restarted.getArchive(ctx)).messages.find(message => message.id === 'result')?.content).toBe('corrected evidence')
    await restarted.deleteMessage('result', ctx.tenantId)
    expect((await restarted.getArchive(ctx)).messages.map(message => message.id)).toEqual(['question'])
    expect((await restarted.getFullHistory(ctx)).map(message => message.id)).toEqual(['question'])
  })

  it('restores an unedited legacy tool result from the original row', async () => {
    const history = setup()
    const ctx = { tenantId: 'default', sessionId: 'legacy-original' }
    await history.append({ id: 'result', role: 'tool', content: '15 checks passed', tokens: 4 }, ctx)
    const file = path.join(fixture!, 'sessions', ctx.tenantId, `${ctx.sessionId}.jsonl`)
    fs.appendFileSync(file, JSON.stringify({ uuid: 'legacy-clear', parentUuid: null, type: 'update', dbSeq: 0,
      timestamp: new Date().toISOString(), ...ctx, isSidechain: false, targetUuid: 'result', content: '[tool result cleared]', tokens: 5 }) + '\n')
    expect((await history.getFullHistory(ctx))[0]).toMatchObject({ content: '[tool result cleared]', metadata: { outputPreview: '15 checks passed' } })
    expect((await history.getArchive(ctx)).messages[0]).toMatchObject({ content: '15 checks passed', tokens: 4 })
  })

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

  it.each(['archive', 'marker', 'tenant'] as const)('rejects existing and dangling %s links before archive reads or writes', async boundary => {
    const history = setup()
    const ctx = { tenantId: 'link-tenant', sessionId: 'link-session' }
    const directory = path.join(fixture!, 'sessions', ctx.tenantId)
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, ctx.sessionId + '.jsonl')
    const link = boundary === 'tenant' ? directory : boundary === 'archive' ? file : path.join(directory, ctx.sessionId + '.migrated')
    if (boundary === 'tenant') fs.rmdirSync(directory)
    for (const dangling of [false, true]) {
      const target = path.join(fixture!, dangling ? 'outside-missing' : 'outside-present')
      if (!dangling) {
        fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'sentinel.txt'), 'UNCHANGED')
      }
      // Junctions are available without developer-mode privileges on Windows.
      // A missing target is essential: existsSync(link) is false in that case.
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(link)).toBe(!dangling)
      await expect(history.getArchive(ctx)).rejects.toThrow(/symbolic link/)
      await expect(history.append({ id: 'unsafe-write', role: 'user', content: 'unsafe' }, ctx)).rejects.toThrow(/symbolic link/)
      await expect(history.clear(ctx)).rejects.toThrow(/symbolic link/)
      if (!dangling) expect(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8')).toBe('UNCHANGED')
      else expect(fs.existsSync(target)).toBe(false)
      // Remove only the fixture-owned link entry, never its target.
      fs.unlinkSync(link)
    }
  })

  it('rejects a linked migration marker before renaming valid history on clear', async () => {
    const history = setup()
    const ctx = { tenantId: 'clear-link-tenant', sessionId: 'clear-link-session' }
    const directory = path.join(fixture!, 'sessions', ctx.tenantId)
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, ctx.sessionId + '.jsonl')
    fs.writeFileSync(file, '')
    await history.append({ id: 'keep-history', role: 'user', content: 'keep this record' }, ctx)
    const original = fs.readFileSync(file, 'utf8'), target = path.join(fixture!, 'marker-target')
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'sentinel.txt'), 'UNCHANGED')
    const marker = path.join(directory, ctx.sessionId + '.migrated')
    fs.symlinkSync(target, marker, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(history.clear(ctx)).rejects.toThrow(/migration marker.*symbolic link/)
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8')).toBe('UNCHANGED')
    fs.unlinkSync(marker)
    // Rejection must not set the process-local clear tombstone either.
    await history.append({ id: 'after-rejected-clear', role: 'user', content: 'still writable' }, ctx)
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual(['keep-history', 'after-rejected-clear'])
  })
})

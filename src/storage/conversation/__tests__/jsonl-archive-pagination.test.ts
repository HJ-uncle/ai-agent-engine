import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JSONLConversationHistory } from '../jsonl-history.js'

let fixture: string | undefined
const scope = { tenantId: 'paged-tenant', sessionId: 'paged-history' }

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (!fixture) return
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-archive-page-')) throw new Error('Unsafe fixture cleanup')
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
  fixture = undefined
})

function setup() {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-archive-page-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  const file = path.join(fixture, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return file
}

const row = (index: number) => ({ uuid: `message-${index}`, parentUuid: null, type: index % 2 ? 'assistant' : 'user', timestamp: '2026-10-10T00:00:00Z', ...scope, isSidechain: false, dbSeq: index + 1,
  payload: { id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Original message ${index}`, tokens: 10, metadata: { turnId: `turn-${Math.floor(index / 2)}` } } })
const marker = <T extends object>(type: string, extra: T) => ({ uuid: `marker-${Math.random()}`, parentUuid: null, type, timestamp: '2026-10-10T00:00:00Z', ...scope, isSidechain: false, dbSeq: 0, ...extra })

it('pages 25,000 real archived messages without a whole-file read, gaps or duplicates on cold readers', async () => {
  const file = setup()
  const summary = marker('summary', { summary: 'Retained project history.', leafUuid: 'message-23999', leafSeq: 24000, preTokens: 250000, postTokens: 10000, transcriptPath: file })
  fs.writeFileSync(file, [...Array.from({ length: 25000 }, (_, index) => row(index)), summary].map(value => JSON.stringify(value)).join('\n') + '\n')
  const originalRead = fs.promises.readFile
  const reads = vi.spyOn(fs.promises, 'readFile').mockImplementation(((candidate: unknown, ...args: unknown[]) => {
    if (String(candidate) === file) throw new Error('Archive pagination must stream, including after restart')
    return (originalRead as any)(candidate, ...args)
  }) as any)
  const ids: string[] = []
  let revision: string | undefined
  for (let offset = 0; offset < 25000; offset += 1000) {
    const page = await new JSONLConversationHistory().getArchive(scope, { offset, limit: 1000 })
    expect(page.messages).toHaveLength(1000)
    expect(page.totalMessageCount).toBe(25000)
    expect(page.currentMessageCount).toBe(1001)
    expect(page.summary).toEqual({ content: summary.summary, leafSeq: 24000, preTokens: 250000, postTokens: 10000, transcriptPath: file })
    expect(page.compressed).toBe(true)
    expect(page.archiveRevision).toMatch(/^[a-f0-9]{32}$/)
    revision ??= page.archiveRevision
    expect(page.archiveRevision).toBe(revision)
    ids.push(...page.messages.map(message => message.id!))
  }
  expect(ids).toEqual(Array.from({ length: 25000 }, (_, index) => `message-${index}`))
  const pastEnd = await new JSONLConversationHistory().getArchive(scope, { offset: 25000, limit: 200 })
  expect(pastEnd.messages).toEqual([])
  expect(pastEnd.totalMessageCount).toBe(25000)
  expect(reads).not.toHaveBeenCalled()
}, 30000)

it('keeps both passes on the same transcript when clear replaces the file between passes', async () => {
  const file = setup()
  fs.writeFileSync(file, [row(0), row(1), row(2)].map(value => JSON.stringify(value)).join('\n') + '\n')
  const originalCreateReadStream = fs.createReadStream
  let passes = 0
  vi.spyOn(fs, 'createReadStream').mockImplementation(((candidate: unknown, options: unknown) => {
    if (String(candidate) === file && ++passes === 2) {
      fs.renameSync(file, file + '.cleared')
      fs.writeFileSync(file, JSON.stringify({ ...row(50), uuid: 'new-session-message', payload: { ...row(50).payload, id: 'new-session-message' } }) + '\n')
    }
    return originalCreateReadStream(candidate as fs.PathLike, options as any)
  }) as typeof fs.createReadStream)
  const inFlight = await new JSONLConversationHistory().getArchive(scope, { offset: 0, limit: 2 })
  expect(inFlight.totalMessageCount).toBe(3)
  expect(inFlight.messages.map(message => message.id)).toEqual(['message-0', 'message-1'])
  const afterClear = await new JSONLConversationHistory().getArchive(scope, { offset: 0, limit: 2 })
  expect(afterClear.totalMessageCount).toBe(1)
  expect(afterClear.messages.map(message => message.id)).toEqual(['new-session-message'])
  expect(afterClear.archiveRevision).not.toBe(inFlight.archiveRevision)
})

it('searches a real 25,000-message cold archive in bounded pages without loading the full file', async () => {
  const file = setup()
  const matchIndexes = Array.from({ length: 25000 }, (_, index) => index).filter(index => index % 499 === 0)
  fs.writeFileSync(file, Array.from({ length: 25000 }, (_, index) => {
    const message = row(index)
    return JSON.stringify(index % 499 === 0 ? { ...message, payload: { ...message.payload, modelInputContent: `ArchiveSearchNeedle ${index}` } } : message)
  }).join('\n') + '\n')
  const originalRead = fs.promises.readFile
  const reads = vi.spyOn(fs.promises, 'readFile').mockImplementation(((candidate: unknown, ...args: unknown[]) => {
    if (String(candidate) === file) throw new Error('Cold archive search must not read the whole file')
    return (originalRead as any)(candidate, ...args)
  }) as any)
  const ids: string[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const history = new JSONLConversationHistory()
    const activeProjection = vi.spyOn(history as any, 'loadSession').mockRejectedValue(new Error('Cold archive search must not load the active projection'))
    const page = await history.searchArchive(scope, { query: 'ArchiveSearchNeedle', offset, limit: 17 })
    expect(page.totalMatches).toBe(matchIndexes.length)
    expect(page.messages.length).toBeLessThanOrEqual(17)
    expect(activeProjection).not.toHaveBeenCalled()
    ids.push(...page.messages.map(message => message.id!))
    offset = page.nextOffset
  }
  expect(ids).toEqual(matchIndexes.map(index => `message-${index}`))
  expect(reads).not.toHaveBeenCalled()
}, 30000)

it('folds edits, deletions and micro-compaction while exposing same-count revision changes', async () => {
  const file = setup()
  const tool = { ...row(2), type: 'tool', payload: { id: 'message-2', role: 'tool', content: 'original test evidence', toolCallId: 'cmd', tokens: 8 } }
  fs.writeFileSync(file, [row(0), row(1), tool, row(3), marker('summary', { summary: 'Earlier work.', leafSeq: 2 })].map(value => JSON.stringify(value)).join('\n') + '\n')
  const first = await new JSONLConversationHistory().getArchive(scope, { offset: 0, limit: 200 })
  fs.appendFileSync(file, JSON.stringify(marker('update', { targetUuid: 'message-0', content: 'corrected same-count user evidence', modelInputContent: null, tokens: 5 })) + '\n')
  const edited = await new JSONLConversationHistory().getArchive(scope, { offset: 0, limit: 200 })
  expect(edited.totalMessageCount).toBe(first.totalMessageCount)
  expect(edited.archiveRevision).not.toBe(first.archiveRevision)
  expect(edited.messages[0].content).toBe('corrected same-count user evidence')
  fs.appendFileSync(file, [marker('tombstone', { scope: 'message', targetUuid: 'message-1' }), marker('update', { targetUuid: 'message-2', content: '[tool result cleared]', tokens: 4, archiveContent: 'original test evidence', archiveTokens: 8 })].map(value => JSON.stringify(value)).join('\n') + '\n')
  const final = await new JSONLConversationHistory().getArchive(scope, { offset: 0, limit: 200 })
  expect(final.messages.map(message => message.id)).toEqual(['message-0', 'message-2', 'message-3'])
  expect(final.messages[1].content).toBe('original test evidence')
  expect(final.totalMessageCount).toBe(3)
  expect(final.archiveRevision).not.toBe(edited.archiveRevision)
  const unpaged = await new JSONLConversationHistory().getArchive(scope)
  expect(final.messages).toEqual(unpaged.messages)
  expect(final.summary).toEqual(unpaged.summary)
  expect(final.currentMessageCount).toBe(unpaged.currentMessageCount)
})

it.each(['leaf-uuid', 'row-position'] as const)('matches the model projection for legacy summary metadata %s', async variant => {
  const file = setup()
  const summary = marker('summary', { summary: 'Legacy retained digest.', ...(variant === 'leaf-uuid' ? { leafUuid: 'message-1' } : {}) })
  fs.writeFileSync(file, [row(0), row(1), summary, row(2), row(3)].map(value => JSON.stringify(value)).join('\n') + '\n')
  const history = new JSONLConversationHistory()
  const paged = await history.getArchive(scope, { offset: 0, limit: 200 })
  expect(paged.messages.map(message => message.id)).toEqual(['message-0', 'message-1', 'message-2', 'message-3'])
  expect(paged.currentMessageCount).toBe((await history.getFullHistory(scope)).length)
  expect(paged.currentMessageCount).toBe(3)
  expect(paged.summary).toEqual((await history.getArchive(scope)).summary)
})

it('clears old summary metadata after a fallback clear and filters later tombstones before pagination', async () => {
  const file = setup()
  fs.writeFileSync(file, [row(0), marker('summary', { summary: 'Old discarded summary.', leafSeq: 1 }), marker('tombstone', { scope: 'clear' }), row(1), row(2), row(3), marker('tombstone', { scope: 'truncate', afterSeq: 3 })].map(value => JSON.stringify(value)).join('\n') + '\n')
  const history = new JSONLConversationHistory()
  const page = await history.getArchive(scope, { offset: 1, limit: 1 })
  expect(page.messages.map(message => message.id)).toEqual(['message-2'])
  expect(page.totalMessageCount).toBe(2)
  expect(page.currentMessageCount).toBe(2)
  expect(page.compressed).toBe(false)
  expect(page.summary).toBeUndefined()
  expect((await history.getArchive(scope)).compressed).toBe(false)
})

it('preserves larger existing page-size requests without introducing an arbitrary limit', async () => {
  const file = setup()
  fs.writeFileSync(file, Array.from({ length: 1200 }, (_, index) => JSON.stringify(row(index))).join('\n') + '\n')
  const page = await new JSONLConversationHistory().getArchive(scope, { offset: 0, limit: 1200 })
  expect(page.messages).toHaveLength(1200)
  expect(page.totalMessageCount).toBe(1200)
})

it.each([{ offset: -1, limit: 10 }, { offset: 0, limit: 0 }, { offset: 0, limit: Number.MAX_SAFE_INTEGER + 1 }, { offset: 0.5, limit: 10 }])('rejects invalid page arguments before opening any archive %#', async page => {
  setup()
  await expect(new JSONLConversationHistory().getArchive(scope, page)).rejects.toThrow('Invalid archive page')
})

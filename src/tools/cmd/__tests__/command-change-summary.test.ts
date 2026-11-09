import { describe, expect, it } from 'vitest'
import type { CommandChangeTracking } from '../../../core/command-jobs/types.js'
import { commandChangeSummary } from '../command-change-summary.js'

const change = Object.freeze({ id: 'change-id', path: 'D:/workspace/report.docx', kind: 'write', oldHash: 'sha256:before', newHash: 'sha256:after',
  status: 'pending', truncated: false, requiresExplicitRevert: true, sessionId: 'root-session', runId: 'run', toolCallId: 'tool',
  commandJobId: 'command-job', displayPath: 'report.docx', seq: 10, createdAt: 12345, source: 'command-observation', isNew: false })
const tracking: CommandChangeTracking = Object.freeze({ status: 'complete', root: 'D:/workspace', note: 'full UI explanation', recordedCount: 1,
  skippedCount: 0, skippedReasons: {}, skippedSamples: [], concurrentChangesExcluded: 0,
  excludedDirectories: ['node_modules', '.git'], limits: { maxFiles: 512, maxBytes: 1024, maxFileBytes: 512, maxEntries: 1000, maxDepth: 16, maxScanMs: 1500, maxChanges: 128 } })
const parse = (output: string) => JSON.parse(output.slice(output.indexOf('{')))

describe('model-facing command change summary', () => {
  it('reports recorded directory-only changes without inventing file diffs', () => {
    const data = parse(commandChangeSummary({ changes: [], changeTracking: { ...tracking, recordedCount: 0, recordedDirectoryCount: 2 } }))
    expect(data.changes).toEqual([])
    expect(data.changeTracking).toMatchObject({ recordedCount: 0, recordedDirectoryCount: 2 })
  })
  it('keeps actionable versions and rollback boundaries without repeating attribution or UI budgets', () => {
    const job = Object.freeze({ changes: [change], changeTracking: tracking }), before = JSON.stringify(job)
    const output = commandChangeSummary(job), data = parse(output)
    expect(data.changes).toEqual([{ id: change.id, path: change.path, kind: change.kind, oldHash: change.oldHash, newHash: change.newHash, status: 'pending' }])
    expect(data.changeTracking).toMatchObject({ status: 'complete', recordedCount: 1, scope: expect.stringContaining('仅 cwd 内有界'), rollback: expect.stringContaining('明确选择变更 ID') })
    expect(data.changeTracking.scope).toContain('不覆盖目录外')
    expect(data.changeTracking.rollback).toContain('外部并发编辑')
    for (const key of ['sessionId', 'runId', 'toolCallId', 'commandJobId', 'createdAt', 'seq', 'displayPath', 'limits', 'excludedDirectories']) expect(output).not.toContain(`"${key}"`)
    expect(JSON.stringify(job)).toBe(before)
  })

  it('keeps creation/deletion hashes and the binary/large preview truncation flag', () => {
    const changes = [{ ...change, id: 'created', oldHash: 'missing', truncated: true },
      { ...change, id: 'deleted', kind: 'delete', newHash: 'missing' }]
    const data = parse(commandChangeSummary({ changes, changeTracking: { ...tracking, recordedCount: 2 } }))
    expect(data.changes).toEqual([
      { id: 'created', path: change.path, kind: 'write', oldHash: 'missing', newHash: change.newHash, status: 'pending', truncated: true },
      { id: 'deleted', path: change.path, kind: 'delete', oldHash: change.oldHash, newHash: 'missing', status: 'pending' },
    ])
  })

  it('preserves all incomplete coverage reasons and samples even with no recorded changes', () => {
    const partial = { ...tracking, status: 'partial' as const, recordedCount: 0, skippedCount: 3,
      skippedReasons: { 'recording-failed': 1, 'file-size-limit': 1, 'concurrent-managed-change': 1 },
      skippedSamples: ['a: recording-failed', 'b: file-size-limit', 'c: concurrent-managed-change'], concurrentChangesExcluded: 1 }
    const data = parse(commandChangeSummary({ changes: [], changeTracking: partial }))
    expect(data.changes).toEqual([])
    expect(data.changeTracking).toMatchObject({ status: 'partial', recordedCount: 0, skippedCount: 3, skippedReasons: partial.skippedReasons,
      skippedSamples: partial.skippedSamples, concurrentChangesExcluded: 1, warning: expect.stringContaining('覆盖不完整') })
  })

  it.each(['未能建立命令文件快照：permission denied；不能保证文件变化已纳入回滚。', '命令已退出，但文件变化记录失败：datasource changed。', '引擎已重启，命令前的内存快照已丢失；未推断或自动回退其文件副作用。'])('preserves unavailable observation errors: %s', note => {
    expect(parse(commandChangeSummary({ changeTracking: { ...tracking, status: 'unavailable', note } })).changeTracking).toMatchObject({ status: 'unavailable', error: note })
  })

  it('never declares missing coverage complete, while unchanged complete probes remain byte-compatible', () => {
    expect(parse(commandChangeSummary({ changes: [change] })).changeTracking).toMatchObject({ status: 'unavailable', error: '文件观察覆盖状态未报告' })
    expect(commandChangeSummary({ changes: [], changeTracking: { ...tracking, recordedCount: 0 } })).toBe('')
    expect(commandChangeSummary({})).toBe('')
  })
})

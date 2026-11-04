import type { CommandJobSnapshot } from '../../core/command-jobs/types.js'

/** UI receipts retain their full attribution/limits. The model only needs
 * actionable file versions and honest coverage, not repeated transport IDs. */
export function commandChangeSummary(job: Pick<CommandJobSnapshot, 'changes' | 'changeTracking'>): string {
  const tracking = job.changeTracking, changes = job.changes ?? []
  if (!changes.length && tracking?.status !== 'partial' && tracking?.status !== 'unavailable') return ''
  const fields = ['id', 'path', 'kind', 'oldHash', 'newHash', 'status'] as const
  const compact = changes.map(change => ({
    ...Object.fromEntries(fields.filter(key => change[key] !== undefined).map(key => [key, change[key]])),
    ...(change.truncated === true ? { truncated: true } : {}),
  }))
  const coverage = {
    status: tracking?.status ?? 'unavailable',
    scope: '仅 cwd 内有界文件观察，不覆盖目录外或其他系统副作用',
    rollback: '可能含外部并发编辑，须审阅并明确选择变更 ID 后回退',
    ...(tracking?.status === 'partial' ? { warning: '覆盖不完整，未列出不代表未改变或可回退' } : {}),
    ...(tracking?.recordedCount !== undefined ? { recordedCount: tracking.recordedCount } : {}),
    ...(tracking?.skippedCount ? { skippedCount: tracking.skippedCount } : {}),
    ...(tracking?.skippedReasons && Object.keys(tracking.skippedReasons).length ? { skippedReasons: tracking.skippedReasons } : {}),
    ...(tracking?.skippedSamples?.length ? { skippedSamples: tracking.skippedSamples } : {}),
    ...(tracking?.concurrentChangesExcluded ? { concurrentChangesExcluded: tracking.concurrentChangesExcluded } : {}),
    ...(tracking?.status === 'unavailable' ? { error: tracking.note } : !tracking ? { error: '文件观察覆盖状态未报告' } : {}),
  }
  return `\n[文件变化观察] ${JSON.stringify({ changes: compact, changeTracking: coverage })}`
}

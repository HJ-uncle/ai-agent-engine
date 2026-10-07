import { hashFileContent } from '../../shared/file-version.js'
import type { FileChange } from './index.js'

export type ProjectionIssue = 'discontinuous-history' | 'later-change' | 'disk-diverged' | 'path-changed' | 'snapshot-unavailable' | 'unreadable'

/** A presentation of a continuous operation chain. The underlying log remains intact. */
export interface NetFileChange extends FileChange {
  changeIds: string[]
  isNew: boolean
  projectionIssue?: ProjectionIssue
}

export interface ChangeSegment {
  changes: FileChange[]
  discontinuous: boolean
}

/** Large/binary snapshots may be stored out-of-line; hashes still verify the chain. */
export function hasTrustedVersions(change: FileChange): boolean {
  const valid = (hash: string | null): hash is string => hash === 'missing' || /^sha256:[a-f0-9]{64}$/.test(hash ?? '')
  return valid(change.oldHash) && valid(change.newHash) && (change.oldSnapshotRef !== undefined || change.newSnapshotRef !== undefined || change.truncated ||
    (hashFileContent(change.oldContent) === change.oldHash && hashFileContent(change.newContent) === change.newHash))
}

/** History must contain every operation on one physical path, in insertion order. */
export function partitionChangeHistory(history: readonly FileChange[], selectedIds: ReadonlySet<string>): ChangeSegment[] {
  const segments: ChangeSegment[] = []
  let current: ChangeSegment | undefined
  for (const change of history) {
    if (!selectedIds.has(change.id)) { current = undefined; continue }
    const previous = current?.changes.at(-1)
    if (previous && hasTrustedVersions(previous) && hasTrustedVersions(change) && previous.newHash === change.oldHash) {
      current!.changes.push(change)
    } else {
      const discontinuous = Boolean(previous)
      if (discontinuous) current!.discontinuous = true
      current = { changes: [change], discontinuous }
      segments.push(current)
    }
  }
  return segments
}

export function projectSegment(segment: ChangeSegment, issue?: ProjectionIssue): NetFileChange {
  const first = segment.changes[0]
  const last = segment.changes.at(-1)!
  const truncated = segment.changes.some(change => change.truncated)
  return {
    ...last,
    oldContent: first.oldContent, oldHash: first.oldHash, oldSnapshotRef: first.oldSnapshotRef,
    kind: last.newHash === 'missing' ? 'delete' : last.kind,
    truncated,
    isNew: first.oldHash === 'missing' && last.newHash !== 'missing',
    changeIds: segment.changes.map(change => change.id),
    ...(issue ? { projectionIssue: issue } : {})
  }
}

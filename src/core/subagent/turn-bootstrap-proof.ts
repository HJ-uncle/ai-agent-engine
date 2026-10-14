import { createHash } from 'node:crypto'
import type { Transaction } from '@libsql/client'
import { requireChildRecovery } from './child-usage-authority.js'
import { lookupPublishedChild, withPublishedChildProof, PUBLISHED_CHILD_PAGE_BYTES, type PublishedChildRef, type PublishedFence, type PublicationScope } from './published-store.js'
import { recoveryVersion } from './child-usage-authority.js'
import { CHILD_RECEIPT_LOCATIONS } from './child-receipt-shapes.js'
import type { ChildProjectionReference } from './recovery-leases.js'
import { readBootstrapBody } from './turn-bootstrap-body.js'
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const ownerArgs = (scope: PublicationScope) => [scope.tenantId, scope.parentSessionId, scope.streamId]

export const bootstrapHash = (value: string): string => createHash('sha256').update(value).digest('hex')
export function barePublishedFence(fence: PublishedFence): PublishedFence {
  const { recoveryMode: _mode, bootstrapId: _id, bootstrapDigest: _digest, ...base } = fence
  return base
}
export const turnBootstrapDigest = (fence: string, snapshot: string, archive: string, originalCount: number, refsCount: number): string =>
  bootstrapHash(JSON.stringify([fence, snapshot, archive, originalCount, refsCount]))

/** A signed durable selector remains tied to the actual disk checkpoint. A lease
 * cannot retain ordinary projection bytes after that checkpoint was released. */
export async function assertTurnBootstrapProof(tx: Transaction, fence: PublishedFence) {
  if (fence.recoveryMode !== 'persisted-published' || typeof fence.bootstrapId !== 'string' || !fence.bootstrapId ||
    typeof fence.bootstrapDigest !== 'string' || !/^[a-f0-9]{64}$/.test(fence.bootstrapDigest)) requireChildRecovery('bootstrap_selector_invalid')
  const row = (await tx.execute({ sql: 'SELECT * FROM parent_turn_bootstraps WHERE checkpoint_id=? AND tenant_id=? AND parent_session_id=?',
    args: [fence.bootstrapId, fence.tenantId, fence.parentSessionId] })).rows[0]
  if (!row) requireChildRecovery('bootstrap_unavailable')
  const encoded = JSON.stringify(barePublishedFence(fence)), original = Number(row.original_count), count = Number(row.refs_count)
  if (row.fence_json !== encoded || row.stream_id !== fence.streamId || row.generation !== fence.generation ||
    Number(row.event_sequence) !== fence.eventSequence || Number(row.revision) !== fence.revision || Number(row.usage_revision) !== fence.usageRevision ||
    !Number.isSafeInteger(original) || original < 0 || original > 16384 || !Number.isSafeInteger(count) || count < 0 || count > 4096 || count > original ||
    row.digest !== fence.bootstrapDigest || typeof row.snapshot_json !== 'string' || typeof row.archive_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.archive_digest) || turnBootstrapDigest(encoded, row.snapshot_json, row.archive_digest, original, count) !== row.digest)
    requireChildRecovery('bootstrap_corrupt')
  return row
}

const entryKeys = ['projectionIndex','field','runId','atSeq','sourceAtSeq','nested','nestedLocations','toolId','toolName']
function assertTurnBootstrapEntryShape(entry: ChildProjectionReference, original: number): void {
  const locations = entry.nestedLocations ?? (entry.nested ? [entry.nested] : [])
  if (Object.keys(entry).some(key => !entryKeys.includes(key)) || !Number.isSafeInteger(entry.projectionIndex) || entry.projectionIndex < 0 || entry.projectionIndex >= original ||
    !['subagentEvent','toolEnd','toolResult'].includes(entry.field) || typeof entry.runId !== 'string' || !entry.runId || recoveryVersion(entry.atSeq) < 1 || bytes(entry) > PUBLISHED_CHILD_PAGE_BYTES ||
    (entry.field === 'subagentEvent' ? locations.length !== 0 : locations.length < 1 || locations.length > 3 || new Set(locations).size !== locations.length || locations.some(location => !CHILD_RECEIPT_LOCATIONS.includes(location))) ||
    entry.nestedLocations !== undefined && entry.nested !== undefined || entry.sourceAtSeq !== undefined && (!Number.isSafeInteger(entry.sourceAtSeq) || entry.sourceAtSeq < 1 || entry.sourceAtSeq > entry.atSeq))
    requireChildRecovery('invalid_identity')
}
async function assertTurnBootstrapEntryAt(tx: Transaction, fence: PublishedFence, entry: ChildProjectionReference, current: PublishedChildRef | null | undefined): Promise<void> {
  if (!current || current.atSeq !== entry.atSeq) requireChildRecovery('projection_prefix_mismatch')
  if (entry.sourceAtSeq !== undefined && entry.sourceAtSeq !== entry.atSeq) {
    const historical = (await tx.execute({ sql: 'SELECT 1 FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND run_id=? AND at_seq=? AND valid_from<=? LIMIT 1',
      args: [...ownerArgs(fence), entry.runId, entry.sourceAtSeq, fence.revision] })).rows[0]
    const exact = (await tx.execute({ sql: `SELECT 1 FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?
      UNION ALL SELECT 1 FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=? AND json_extract(event,'$.schemaVersion')=1 LIMIT 1`,
      args: [fence.tenantId,entry.runId,entry.sourceAtSeq,fence.tenantId,entry.runId,entry.sourceAtSeq] })).rows[0]
    if (!historical || !exact) requireChildRecovery('projection_prefix_mismatch')
  }
}
export async function assertTurnBootstrapEntry(tx: Transaction, fence: PublishedFence, entry: ChildProjectionReference, original: number): Promise<void> {
  assertTurnBootstrapEntryShape(entry, original)
  await assertTurnBootstrapEntryAt(tx, fence, entry, await lookupPublishedChild(tx, fence, entry.runId))
}

async function assertHistoricalSources(tx: Transaction, fence: PublishedFence, entries: readonly ChildProjectionReference[]): Promise<void> {
  if (entries.length > 128) throw new RangeError('Invalid historical source batch')
  const historical = entries.filter(entry => entry.sourceAtSeq !== undefined && entry.sourceAtSeq !== entry.atSeq)
  if (!historical.length) return
  // Read the actual published versions and retained source rows in this same
  // physical snapshot. One bounded query replaces two IPC round trips per ref;
  // neither a valid current checkpoint nor a different source can substitute.
  const missing = (await tx.execute({ sql: `WITH requested(run_id,at_seq) AS (VALUES ${historical.map(() => '(?,?)').join(',')})
    SELECT requested.run_id,requested.at_seq FROM requested WHERE
      NOT EXISTS(SELECT 1 FROM parent_published_child_versions v WHERE v.tenant_id=? AND v.parent_session_id=? AND v.stream_id=?
        AND v.run_id=requested.run_id AND v.at_seq=requested.at_seq AND v.valid_from<=?)
      OR (NOT EXISTS(SELECT 1 FROM subagent_checkpoints c WHERE c.tenant_id=? AND c.run_id=requested.run_id AND c.seq=requested.at_seq)
        AND NOT EXISTS(SELECT 1 FROM subagent_events e WHERE e.tenant_id=? AND e.run_id=requested.run_id AND e.seq=requested.at_seq AND json_extract(e.event,'$.schemaVersion')=1)) LIMIT 1`,
    args: [...historical.flatMap(entry => [entry.runId, entry.sourceAtSeq!]), ...ownerArgs(fence), fence.revision, fence.tenantId, fence.tenantId] })).rows[0]
  if (missing) requireChildRecovery('projection_prefix_mismatch')
}


export async function assertTurnBootstrapArchive(tx: Transaction, fence: PublishedFence, proof: Record<string, unknown>): Promise<void> {
  await withPublishedChildProof(tx, fence, async lookup => {
    const archive = createHash('sha256'); let after = -1, count = 0
    for (;;) {
      const rows = (await tx.execute({ sql: 'SELECT * FROM parent_turn_bootstrap_refs WHERE checkpoint_id=? AND projection_index>? ORDER BY projection_index LIMIT 128', args: [fence.bootstrapId!,after] })).rows
      const entries: Array<{ entry: ChildProjectionReference; encoded: string }> = []
      for (const item of rows) {
        const encoded = String(item.entry_json)
        if (bootstrapHash(encoded) !== item.entry_digest) requireChildRecovery('bootstrap_corrupt')
        let entry: ChildProjectionReference
        try { entry = JSON.parse(encoded) as ChildProjectionReference } catch { requireChildRecovery('bootstrap_corrupt') }
        if (entry.projectionIndex !== Number(item.projection_index) || entry.runId !== item.run_id || entry.atSeq !== Number(item.at_seq)) requireChildRecovery('bootstrap_corrupt')
        assertTurnBootstrapEntryShape(entry, Number(proof.original_count))
        entries.push({ entry, encoded })
      }
      // Every raw row and historical source is checked inside the same physical
      // transaction as the single full retained-prefix proof, without writes.
      const published = entries.length ? await lookup(entries.map(({ entry }) => entry.runId)) : new Map<string, PublishedChildRef>()
      for (const { entry } of entries) if (published.get(entry.runId)?.atSeq !== entry.atSeq) requireChildRecovery('projection_prefix_mismatch')
      await assertHistoricalSources(tx, fence, entries.map(({ entry }) => entry))
      for (const { entry, encoded } of entries) {
        archive.update(encoded + '\n'); after = entry.projectionIndex; count++
      }
      if (rows.length < 128) break
    }
    if (count !== Number(proof.refs_count) || archive.digest('hex') !== proof.archive_digest) requireChildRecovery('bootstrap_corrupt')
    await readBootstrapBody(tx,fence.bootstrapId!,String(proof.snapshot_json))
  })
}

/** Hash the imported prefix independently of the stream namespace. Later target
 * publications may close a version after R; clipping that boundary keeps the
 * original activation proof stable without accepting changed admitted bytes. */
export async function publishedVersionProof(tx: Transaction, scope: PublicationScope, revision: number): Promise<{ count: number; digest: string }> {
  const archive = createHash('sha256'); let runId = '', validFrom = 0, count = 0
  for (;;) {
    const rows = (await tx.execute({ sql: `SELECT run_id,first_ordinal,valid_from,
      CASE WHEN valid_to<=? THEN valid_to ELSE NULL END AS admitted_to,
      at_seq,identity,tokens,unknown,finished_at FROM parent_published_child_versions
      WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND valid_from<=?
        AND (run_id>? OR run_id=? AND valid_from>?) ORDER BY run_id,valid_from LIMIT 128`,
      args: [revision,...ownerArgs(scope),revision,runId,runId,validFrom] })).rows
    for (const row of rows) {
      archive.update(JSON.stringify([row.run_id,row.first_ordinal,row.valid_from,row.admitted_to,
        row.at_seq,row.identity,row.tokens,row.unknown,row.finished_at]) + '\n')
      runId = String(row.run_id); validFrom = Number(row.valid_from); count++
    }
    if (rows.length < 128) break
  }
  return { count, digest: archive.digest('hex') }
}

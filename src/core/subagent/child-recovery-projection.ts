import type { Transaction } from '@libsql/client'
import type { StreamSnapshot } from '../stream-pipeline/stream-bus.js'
import type { ChildProjectionReference } from './recovery-leases.js'
import { requireChildRecovery } from './child-usage-authority.js'
import { PUBLISHED_CHILD_PAGE_BYTES, withPublishedChildProof, type PublishedFence } from './published-store.js'
import { childReceiptGroup, withoutChildReceipts } from './child-receipt-shapes.js'
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
/** Every omitted child slot has a real lease-bound archive position. Ordinary
 * parent body and tool payloads remain a separate snapshot budget. */
export function childProjectionReferences(snapshot: StreamSnapshot): { projection: StreamSnapshot['projection']; projectionIndices: number[]; entries: ChildProjectionReference[] } {
  const entries: ChildProjectionReference[] = [], projection: StreamSnapshot['projection'] = [], projectionIndices: number[] = []
  snapshot.projection.forEach((payload, projectionIndex) => {
    const candidates = (['subagentEvent', 'toolEnd', 'toolResult'] as const).filter(field => payload[field] !== undefined && (field === 'subagentEvent' || childReceiptGroup(record(payload[field]) ?? {})))
    if (candidates.length > 1) requireChildRecovery('projection_shape_conflict')
    const field = candidates[0]
    const container = field ? record(payload[field]) : undefined
    const receipts = field !== 'subagentEvent' && container ? childReceiptGroup(container) : undefined
    const child = field === 'subagentEvent' ? record(container?.view ?? container?.snapshot ?? container?.identity) ?? container : receipts?.identities[0]
    if (!field) { projection.push(payload); projectionIndices.push(projectionIndex); return }
    if (!child) requireChildRecovery('invalid_identity')
    const runId = child.runId ?? container?.runId
    if (typeof runId !== 'string' || !runId) requireChildRecovery('invalid_identity')
    const sourceAtSeq = receipts?.seq ?? (typeof child.lastSeq === 'number' ? child.lastSeq : container?.seq)
    if (typeof sourceAtSeq !== 'number' || !Number.isSafeInteger(sourceAtSeq) || sourceAtSeq < 1) requireChildRecovery('invalid_identity')
    // A meta-only receipt may have no legacy in-memory watermark. Its exact raw
    // seq still must be proven in the signed prefix by retainProjection SQL.
    const atSeq = snapshot.subagentWatermarks?.find(mark => mark.runId === runId)?.seq ?? sourceAtSeq
    if (sourceAtSeq > atSeq) requireChildRecovery('projection_prefix_mismatch')
    const toolId = container?.toolCallId ?? container?.id
    const entry: ChildProjectionReference = { projectionIndex, field, runId, atSeq,
      ...(sourceAtSeq !== atSeq ? { sourceAtSeq } : {}),
      ...(receipts ? receipts.locations.length === 1 ? { nested: receipts.locations[0] } : { nestedLocations: receipts.locations } : {}),
      ...(typeof toolId === 'string' ? { toolId } : {}),
      ...(typeof container?.name === 'string' ? { toolName: container.name } : {}) }
    if (bytes(entry) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('oversized_identity')
    entries.push(entry)
    // A tool result is still a real result. Only its nested child view moves;
    // explicit original indices distinguish patching that result from inserting
    // a removed pure child slot when an archive page is restored later.
    if (field !== 'subagentEvent') {
      const outer = withoutChildReceipts(container!, receipts!.locations)
      projection.push({ ...payload, [field]: outer }); projectionIndices.push(projectionIndex)
    } else {
      const outer = { ...payload }; delete outer.subagentEvent
      if (Object.keys(outer).length) { projection.push(outer); projectionIndices.push(projectionIndex) }
    }
  })
  return { projection, projectionIndices, entries }
}

/** Resolve only bounded retained slots at the already-admitted R. The source
 * sequence remains distinct from a newer published child version; latest child
 * state and a process-local inventory cannot supply either authority. */
export async function resolvePublishedProjectionReferences(tx: Transaction, fence: PublishedFence,
  input: readonly ChildProjectionReference[]): Promise<ChildProjectionReference[]> {
  const entries = structuredClone(input)
  if (entries.length > 4096 || entries.some(entry => entry.sourceAtSeq !== undefined)) requireChildRecovery('projection_shape_conflict')
  return withPublishedChildProof(tx, fence, async lookup => {
    const resolved: ChildProjectionReference[] = []
    for (let offset = 0; offset < entries.length; offset += 128) {
      const batch = entries.slice(offset, offset + 128), current = await lookup(batch.map(entry => entry.runId))
      for (const entry of batch) {
        const atSeq = current.get(entry.runId)?.atSeq, sourceAtSeq = entry.atSeq
        if (atSeq === undefined || !Number.isSafeInteger(sourceAtSeq) || sourceAtSeq < 1 || sourceAtSeq > atSeq) requireChildRecovery('projection_prefix_mismatch')
        resolved.push({ ...entry, atSeq, ...(sourceAtSeq !== atSeq ? { sourceAtSeq } : {}) })
      }
    }
    return resolved
  })
}

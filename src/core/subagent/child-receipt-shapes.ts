import { requireChildRecovery } from './child-usage-authority.js'

export type ChildReceiptLocation = 'subagent' | 'metadata.subagent' | 'meta.subagent'
export const CHILD_RECEIPT_LOCATIONS: readonly ChildReceiptLocation[] = ['subagent', 'metadata.subagent', 'meta.subagent']
export const childRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const identityFields = ['tenantId', 'rootSessionId', 'parentSessionId', 'parentConversationId', 'parentMessageId', 'parentToolCallId', 'childSessionId', 'createdAt'] as const
export interface ChildReceiptGroup {
  runId: string; seq: number; locations: ChildReceiptLocation[]; identities: Record<string, unknown>[]
}
/** The protocol adapter accepts all three locations. Choosing the first location
 * alone leaves another child body outside the admitted parent prefix. */
export function childReceiptGroup(tool: Record<string, unknown>): ChildReceiptGroup | undefined {
  const values: Array<[ChildReceiptLocation, unknown]> = [['subagent', tool.subagent], ['metadata.subagent', childRecord(tool.metadata)?.subagent], ['meta.subagent', childRecord(tool.meta)?.subagent]]
  let group: ChildReceiptGroup | undefined
  for (const [location, value] of values) {
    if (value === undefined) continue
    const child = childRecord(value)
    if (!child || typeof child.runId !== 'string' || !child.runId || typeof child.lastSeq !== 'number' || !Number.isSafeInteger(child.lastSeq) || child.lastSeq < 1) requireChildRecovery('invalid_identity')
    if (!group) group = { runId: child.runId, seq: child.lastSeq, locations: [], identities: [] }
    if (group.runId !== child.runId || group.seq !== child.lastSeq || group.identities.some(previous => identityFields.some(key => previous[key] !== undefined && child[key] !== undefined && previous[key] !== child[key]))) requireChildRecovery('conflicting_child_receipts')
    group.locations.push(location); group.identities.push(child)
  }
  return group
}
/** Preserve ordinary outer output/status and both metadata containers. */
export function withoutChildReceipts(tool: Record<string, unknown>, locations: readonly ChildReceiptLocation[]): Record<string, unknown> {
  const result = { ...tool }
  for (const location of locations) {
    if (location === 'subagent') delete result.subagent
    else {
      const key = location === 'metadata.subagent' ? 'metadata' : 'meta', container = { ...childRecord(result[key]) }
      delete container.subagent; result[key] = container
    }
  }
  return result
}

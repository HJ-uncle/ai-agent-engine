import type { JSONLPhysicalSnapshot, JSONLScope } from './jsonl-origin.js'

export const JSONL_PHYSICAL_CACHE_LIMITS = Object.freeze({ entries: 4, estimatedBytes: 32 * 1024 * 1024 })

export interface JSONLPhysicalCacheKey extends JSONLScope {
  // A small per-history token avoids retaining the history's other caches.
  owner: object
  dataPath: string
  database: object
  databaseEpoch: number | undefined
  fileIdentity: string
  revision: string
}

interface Entry { key: JSONLPhysicalCacheKey; snapshot: JSONLPhysicalSnapshot; estimatedBytes: number }
// One process-wide budget, rather than one additional budget per history owner.
const entries: Entry[] = []
let estimatedBytes = 0

/** Conservative retained-graph estimate, not JSON file bytes or a V8 heap limit. */
export function estimateJSONLPhysicalSnapshotBytes(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  const pending: unknown[] = [value], seen = new WeakSet<object>()
  let bytes = 0
  while (pending.length && bytes <= limit) {
    const item = pending.pop()
    if (typeof item === 'string') bytes += 32 + item.length * 2
    else if (item && typeof item === 'object') {
      if (seen.has(item)) continue
      seen.add(item)
      bytes += 64
      if (Array.isArray(item)) {
        bytes += item.length * 8
        for (const child of item) pending.push(child)
      } else {
        for (const key of Object.keys(item)) {
          bytes += 32 + key.length * 2 + 16
          pending.push((item as Record<string, unknown>)[key])
        }
      }
    } else bytes += 8
  }
  // Each string occurrence is charged, including rows.message and active.
  return bytes
}

function sameScope(left: JSONLPhysicalCacheKey, right: Pick<JSONLPhysicalCacheKey, 'owner' | 'dataPath' | 'tenantId' | 'sessionId'>): boolean {
  return left.owner === right.owner && left.dataPath === right.dataPath && left.tenantId === right.tenantId && left.sessionId === right.sessionId
}

function remove(index: number): void {
  estimatedBytes -= entries[index].estimatedBytes
  entries.splice(index, 1)
}

export function invalidateJSONLPhysicalSnapshot(key: Pick<JSONLPhysicalCacheKey, 'owner' | 'dataPath' | 'tenantId' | 'sessionId'>): void {
  for (let index = entries.length - 1; index >= 0; index--) if (sameScope(entries[index].key, key)) remove(index)
}

/** Only the caller's independently validated open handle can authorize reuse. */
export function getJSONLPhysicalSnapshot(key: JSONLPhysicalCacheKey): JSONLPhysicalSnapshot | undefined {
  const index = entries.findIndex(entry => sameScope(entry.key, key))
  if (index < 0) return undefined
  const entry = entries[index]
  if (entry.key.database !== key.database || entry.key.databaseEpoch !== key.databaseEpoch
    || entry.key.fileIdentity !== key.fileIdentity || entry.key.revision !== key.revision) {
    remove(index)
    return undefined
  }
  entries.splice(index, 1); entries.push(entry)
  return structuredClone(entry.snapshot)
}

/** Call only after a complete scan and handle/path revision checks succeed. */
export function cacheJSONLPhysicalSnapshot(key: JSONLPhysicalCacheKey, snapshot: JSONLPhysicalSnapshot): void {
  invalidateJSONLPhysicalSnapshot(key)
  // Count the key's strings without traversing opaque owner/DB references.
  const keyBytes = 256 + estimateJSONLPhysicalSnapshotBytes({ dataPath: key.dataPath, tenantId: key.tenantId,
    sessionId: key.sessionId, fileIdentity: key.fileIdentity, revision: key.revision })
  const size = keyBytes + estimateJSONLPhysicalSnapshotBytes(snapshot, JSONL_PHYSICAL_CACHE_LIMITS.estimatedBytes)
  if (size > JSONL_PHYSICAL_CACHE_LIMITS.estimatedBytes) return
  while (entries.length >= JSONL_PHYSICAL_CACHE_LIMITS.entries || estimatedBytes + size > JSONL_PHYSICAL_CACHE_LIMITS.estimatedBytes) remove(0)
  // The initial result and every cache hit belong exclusively to the caller.
  const copy = structuredClone(snapshot)
  entries.push({ key: { ...key }, snapshot: copy, estimatedBytes: size }); estimatedBytes += size
}

/** Internal diagnostics for isolated resource regression tests; no snapshots exposed. */
export function jsonlPhysicalCacheStats(): Readonly<{ entries: number; estimatedBytes: number }> {
  return Object.freeze({ entries: entries.length, estimatedBytes })
}

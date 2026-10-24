import { opendir } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { throwIfAborted } from '../../core/utils/abort.js'

export interface ListingBudget {
  maxResults: number; count: number; bytes: number; startedAt: number
  truncated: boolean; reason?: 'results' | 'bytes' | 'depth' | 'time'
}
export function createListingBudget(maxResults = 500): ListingBudget {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2000) throw new Error('maxResults must be an integer between 1 and 2000')
  return { maxResults, count: 0, bytes: 0, startedAt: performance.now(), truncated: false }
}

/** Stream directory entries instead of materializing an unbounded synchronous tree.
 * One budget is shared across workspace roots. Links are leaves, never traversal roots. */
export async function listDirectoryEntries(root: string, recursive: boolean, budget: ListingBudget, signal?: AbortSignal): Promise<string[]> {
  const entries: string[] = []
  const stop = (reason: NonNullable<ListingBudget['reason']>) => { budget.truncated = true; budget.reason ??= reason }
  const visit = async (directory: string, depth: number): Promise<void> => {
    throwIfAborted(signal)
    if (performance.now() - budget.startedAt > 2000) { stop('time'); return }
    const stream = await opendir(directory)
    for await (const entry of stream) {
      throwIfAborted(signal)
      if (budget.truncated) break
      if (budget.count >= budget.maxResults) { stop('results'); break }
      if (performance.now() - budget.startedAt > 2000) { stop('time'); break }
      const full = path.join(directory, entry.name)
      const label = path.relative(root, full) + (entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : '')
      const bytes = Buffer.byteLength(label, 'utf8') + 1
      if (budget.bytes + bytes > 128 * 1024) { stop('bytes'); break }
      entries.push(label); budget.count++; budget.bytes += bytes
      if (budget.count % 64 === 0) await yieldToLoop()
      if (recursive && entry.isDirectory()) {
        if (depth >= 64) { stop('depth'); break }
        await visit(full, depth + 1)
      }
    }
  }
  await visit(root, 0)
  return entries
}

import { createHash } from 'node:crypto'
import { browserExecutionIdentity, type BrowserExecutionContext } from '../../core/browser-execution.js'

export interface PptRenderProgress {
  renderedPages: number[]
  remainingPages: number[]
  repeatedPage: boolean
  evidenceScope: 'images-returned-only'
}

const MAX_ENTRIES = 256
const MAX_PAGES = 100

/** A receipt index, never a visual verdict. Content hashes allow an unchanged
 * file to move without losing progress; execution identity prevents reuse
 * across users, tasks or independently running reviewers. */
export class PptRenderProgressTracker {
  private readonly entries = new Map<string, { pageCount: number; pages: Set<number> }>()

  record(ctx: BrowserExecutionContext, hash: string, page: number, pageCount: number): PptRenderProgress | undefined {
    const execution = browserExecutionIdentity(ctx)
    const contentHash = hash.replace(/^sha256:/, '')
    if (!execution || !/^[a-f0-9]{64}$/.test(contentHash) || !Number.isInteger(pageCount)
      || pageCount < 1 || pageCount > MAX_PAGES || !Number.isInteger(page) || page < 1 || page > pageCount) return undefined
    const key = createHash('sha256').update(JSON.stringify([
      ctx.tenantId ?? 'default', ctx.browserPrincipal?.userId ?? null, ctx.sessionId,
      execution.rootSessionId, execution.rootRunId, execution.ownerRunId, contentHash,
    ])).digest('hex')
    const previous = this.entries.get(key)
    // A contradictory page count must not silently inherit coverage.
    const entry = previous?.pageCount === pageCount ? previous : { pageCount, pages: new Set<number>() }
    const repeatedPage = entry.pages.has(page)
    entry.pages.add(page)
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
    const renderedPages = [...entry.pages].sort((a, b) => a - b)
    const remainingPages = Array.from({ length: pageCount }, (_, index) => index + 1).filter(value => !entry.pages.has(value))
    return { renderedPages, remainingPages, repeatedPage, evidenceScope: 'images-returned-only' }
  }
}

export const pptRenderProgress = new PptRenderProgressTracker()

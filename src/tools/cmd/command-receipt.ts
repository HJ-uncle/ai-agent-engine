import { commandJobs, type CommandJobManager, type CommandJobOutput, type CommandJobScope, type CommandJobSnapshot,
  type CommandOutputEntry } from '../../core/command-jobs/index.js'
import { commandChangeDetails } from './command-change-summary.js'

interface CommandFileChanges {
  count: number
  omittedCount: number
  changes: Record<string, unknown>[]
  coverage: Record<string, unknown>
  details: string
}

/** Model-facing projection. Identity, argv and change receipts remain in tool metadata. */
export interface CommandReceipt {
  type: 'command_result'
  version: 1
  jobId: string
  status: CommandJobSnapshot['status']
  exitCode: number | null
  signal: string | null
  entries: CommandOutputEntry[]
  nextCursor: number
  /** UTF-8 bytes consumed in the first entry after nextCursor; pass back unchanged. */
  nextOffset: number
  earliestCursor: number
  truncated: boolean
  hasMore: boolean
  error?: { code: string; message?: string }
  fileChanges?: CommandFileChanges
  /** Caller-provided source-change or other operational notice, included in its reserved budget. */
  notice?: string
}

export interface CommandReceiptResult {
  job: CommandJobSnapshot
  receipt?: CommandReceipt
  output: string
  error?: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL'
}

export interface CommandReceiptOptions {
  maxChars: number
  cursor?: number
  cursorOffset?: number
}

function budgetFailure(job: CommandJobSnapshot, budget: number, minimum: number): CommandReceiptResult {
  // Do not emit a success-shaped empty page or advance a cursor when there is
  // insufficient room for a real receipt. The tool error remains machine-readable.
  const alternatives = [
    `Command output budget too small. Retry command_output alone with at least ${minimum} characters; keep the same cursor and cursorOffset.`,
    `Retry command_output alone with >=${minimum} chars; keep cursor/offset.`,
    'Retry command_output alone; keep cursor/offset.', 'Retry alone.', 'Retry.', '重试', '↻',
  ]
  return { job, output: alternatives.find(text => text.length <= budget) ?? '', error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' }
}

function pageReceipt(page: CommandJobOutput): CommandReceipt {
  return { type: 'command_result', version: 1, jobId: page.job.jobId, status: page.job.status,
    exitCode: page.job.exitCode, signal: page.job.signal, entries: page.entries,
    nextCursor: page.nextCursor, nextOffset: page.nextOffset ?? 0, earliestCursor: page.earliestCursor,
    truncated: page.truncated, hasMore: page.hasMore,
    ...(page.job.error ? { error: { code: page.job.error.code, message: Array.from(page.job.error.message).slice(0, 240).join('') } } : {}),
  }
}

function fileChanges(job: CommandJobSnapshot, budget: number): { summary?: CommandFileChanges; minimum: number } {
  const details = commandChangeDetails(job)
  if (!details) return { minimum: 0 }
  const { changes, changeTracking: coverage } = details
  const summary: CommandFileChanges = { count: changes.length, omittedCount: changes.length, changes: [],
    coverage: { status: coverage.status, scope: coverage.scope, rollback: coverage.rollback,
      ...(coverage.warning ? { warning: coverage.warning } : {}),
      ...(coverage.status === 'unavailable' ? { warning: '文件观察不可用；未列出不代表没有副作用' } : {}) },
    details: '完整变更与覆盖说明请在界面查看' }
  const size = () => JSON.stringify(summary).length + '"fileChanges":,'.length
  const minimum = size()
  if (minimum > budget) return { minimum }
  // Keep diagnostics bounded as whole fields; all omitted diagnostics are still
  // available from metadata. A file version/ID is never truncated into a fake one.
  for (const [key, value] of Object.entries(coverage)) {
    if (key in summary.coverage) continue
    summary.coverage[key] = value
    if (size() > budget) delete summary.coverage[key]
  }
  for (const change of changes) {
    summary.changes.push(change); summary.omittedCount--
    if (size() > budget) { summary.changes.pop(); summary.omittedCount++; break }
  }
  return { summary, minimum }
}

function fitReceipt(page: CommandJobOutput, options: CommandReceiptOptions): CommandReceiptResult {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1) throw new Error('Command receipt budget must be a positive integer')
  const budget = options.maxChars
  const receipt = pageReceipt(page)
  const changes = fileChanges(page.job, Math.floor(budget / 3))
  if (changes.minimum && !changes.summary) return budgetFailure(page.job, budget, changes.minimum * 3)
  if (changes.summary) receipt.fileChanges = changes.summary
  const full = JSON.stringify(receipt)
  if (full.length <= budget) return { job: page.job, receipt, output: full }

  const initialCursor = Math.max(options.cursor ?? 0, page.earliestCursor)
  const initialOffset = options.cursorOffset ?? 0
  const base: CommandReceipt = { ...receipt, entries: [], nextCursor: initialCursor, nextOffset: initialOffset,
    hasMore: page.entries.length > 0 || page.hasMore }
  // Prefer useful log space over a verbose diagnostic; the complete error stays
  // in metadata. Never remove job identity/status/continuation fields to fit.
  if (base.error && JSON.stringify(base).length + 80 > budget) base.error = { code: base.error.code }
  const minimum = JSON.stringify(base).length + (page.entries.length ? 56 : 0)
  if (JSON.stringify(base).length > budget) return budgetFailure(page.job, budget, minimum)
  if (!page.entries.length) return { job: page.job, receipt: base, output: JSON.stringify(base) }

  let current = base
  for (let index = 0; index < page.entries.length; index++) {
    const entry = page.entries[index]
    const points = Array.from(entry.text)
    const offset = index === 0 ? initialOffset : 0
    const complete = index < page.entries.length - 1 || !page.nextOffset
    const candidate = (take: number): CommandReceipt => {
      const consumedEntry = take === points.length && complete
      return { ...base, entries: [...current.entries, { ...entry, text: points.slice(0, take).join('') }],
        nextCursor: consumedEntry ? entry.seq : current.nextCursor,
        nextOffset: consumedEntry ? 0 : offset + Buffer.byteLength(points.slice(0, take).join('')),
        hasMore: take < points.length || index < page.entries.length - 1 || page.hasMore }
    }
    const whole = candidate(points.length)
    if (JSON.stringify(whole).length <= budget) { current = whole; continue }
    let low = 0, high = points.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (JSON.stringify(candidate(mid)).length <= budget) low = mid
      else high = mid - 1
    }
    if (low > 0) current = candidate(low)
    break
  }
  if (!current.entries.length) return budgetFailure(page.job, budget, minimum)
  return { job: page.job, receipt: current, output: JSON.stringify(current) }
}

/** Status receipt without consuming logs (launch/cancel). The next read starts at the supplied cursor. */
export function formatCommandReceipt(job: CommandJobSnapshot, options: CommandReceiptOptions): CommandReceiptResult {
  const cursor = options.cursor ?? 0
  return fitReceipt({ job, entries: [], nextCursor: cursor, nextOffset: options.cursorOffset ?? 0,
    earliestCursor: job.earliestCursor, truncated: cursor < job.earliestCursor, hasMore: cursor < job.cursor }, options)
}

/** Read one bounded database page, then fit JSON including escaping and continuation overhead. */
export async function readCommandReceipt(scope: CommandJobScope, jobId: string,
  options: CommandReceiptOptions & { manager?: CommandJobManager }): Promise<CommandReceiptResult | null> {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1) throw new Error('Command receipt budget must be a positive integer')
  const page = await (options.manager ?? commandJobs).output(scope, jobId, {
    cursor: options.cursor, cursorOffset: options.cursorOffset ?? 0,
    maxChars: Math.max(2, Math.min(options.maxChars, 64 * 1024)),
    maxEntries: Math.max(1, Math.min(128, Math.floor(options.maxChars / 40))),
  })
  return page ? fitReceipt(page, options) : null
}

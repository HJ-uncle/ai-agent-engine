import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'

export const FULL_READ_RANGE_CONFLICT = 'FULL_READ_RANGE_CONFLICT'
export const FULL_READ_RANGE_MESSAGE = 'mode="full" starts at the beginning and cannot be combined with start_line, end_line or start_column. No files were read. For source paging, use mode="auto" with the requested range or the previous page\'s nextStartLine/nextStartColumn. Preserve end_line when continuing a bounded range.'

export function hasFullReadRangeConflict(mode: unknown, startLine?: unknown, endLine?: unknown, startColumn?: unknown): boolean {
  return mode === 'full' && [startLine, endLine, startColumn].some(value => value !== undefined)
}

/** Handlers may be called without the public tool; never silently erase their explicit range. */
export function assertFullReadRange(mode: unknown, startLine?: unknown, endLine?: unknown): void {
  if (hasFullReadRangeConflict(mode, startLine, endLine))
    throw Object.assign(new Error(FULL_READ_RANGE_MESSAGE), { code: FULL_READ_RANGE_CONFLICT })
}

/** The correction is argument data, not a second execution or a permission decision. */
export function fullReadRangeFailure(args: unknown, ctx: AgentContext, itemIndex?: number): ToolResult | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>
  if (!hasFullReadRangeConflict(input.mode, input.start_line, input.end_line, input.start_column)) return undefined
  const range = Object.fromEntries(['start_line', 'end_line', 'start_column']
    .filter(key => input[key] !== undefined).map(key => [key, input[key]]))
  const valid = typeof input.path === 'string' && input.path.trim()
    && Object.values(range).every(value => Number.isSafeInteger(value) && Number(value) > 0)
    && !(input.start_line !== undefined && input.end_line !== undefined && Number(input.end_line) < Number(input.start_line))
  const context = itemIndex === undefined ? {} : { batch: true, itemIndex }
  const code = FULL_READ_RANGE_CONFLICT
  const candidates = [
    JSON.stringify({ code, message: FULL_READ_RANGE_MESSAGE, ...context,
      ...(valid ? { retryWith: { path: input.path, mode: 'auto', ...range } } : {}) }),
    JSON.stringify({ code, message: 'Use mode="auto" for explicit ranges and continuation; full accepts no range. No files were read.', ...context }),
    JSON.stringify({ code }), '{}', '0',
  ]
  const limit = getToolOutputLimit(ctx.toolProfile, ctx)
  return { success: false, error: code, output: candidates.find(value => value.length <= limit) ?? '0',
    metadata: { code, ...context, fileMutationApplied: false } }
}

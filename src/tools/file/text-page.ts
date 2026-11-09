import type { ToolResult } from '../../core/agent-context/index.js'

interface TextPageOptions {
  text: string
  version: Record<string, unknown>
  maxChars: number
  mode: 'auto' | 'full'
  startLine?: number
  endLine?: number
  /** One-based UTF-16 column; offsets inside a surrogate pair are invalid. */
  startColumn?: number
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
}

/** Keep a whole receipt inside the runtime cap: head/tail trimming loses source lines. */
export function readTextPage(options: TextPageOptions): ToolResult {
  const { text, version, maxChars, mode } = options
  const fail = (code: string, message: string): ToolResult => {
    const full = JSON.stringify({ code, message })
    const short = JSON.stringify({ code })
    return { success: false, error: code, output: full.length <= maxChars ? full : short.length <= maxChars ? short : maxChars >= 2 ? '{}' : '0',
      metadata: { ...version, code, fileMutationApplied: false } }
  }
  if ([options.startLine, options.endLine, options.startColumn].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) {
    return fail('INVALID_READ_RANGE', 'start_line, end_line and start_column must be positive safe integers.')
  }
  const lines = text.split(/\r\n|\r|\n/)
  const totalLines = lines.length
  const startLine = mode === 'full' ? 1 : options.startLine ?? 1
  const startColumn = options.startColumn ?? 1
  const requestedEndLine = mode === 'full' ? totalLines : Math.min(options.endLine ?? totalLines, totalLines)
  if (startLine > totalLines || requestedEndLine < startLine) {
    return fail('INVALID_READ_RANGE', 'start_line is beyond the file or end_line is before start_line.')
  }
  const firstLine = lines[startLine - 1]
  if (startColumn > firstLine.length + 1 || splitsSurrogatePair(firstLine, startColumn - 1)) {
    return fail('INVALID_READ_RANGE', 'start_column is a one-based UTF-16 offset; it must be inside the selected line and cannot split a surrogate pair.')
  }

  const receipt = (endLine: number, endColumn: number, endIsPartial: boolean) => {
    const hasMore = endIsPartial || endLine < requestedEndLine
    return { ...version, totalLines, requestedEndLine, startLine, startColumn, endLine, endColumn,
      columnUnit: 'utf16', partialLine: startColumn > 1 || endIsPartial,
      hasMore, nextStartLine: hasMore ? endIsPartial ? endLine : endLine + 1 : null,
      nextStartColumn: hasMore ? endIsPartial ? endColumn + 1 : 1 : null,
      rangeIsComplete: !hasMore, contentIsComplete: startLine === 1 && startColumn === 1 && endLine === totalLines && !endIsPartial }
  }
  let selected: ReturnType<typeof receipt> | undefined
  const displayLines: string[] = []
  let escapedContentLength = 0
  for (let lineNumber = startLine; lineNumber <= requestedEndLine; lineNumber++) {
    const line = lines[lineNumber - 1]
    const column = lineNumber === startLine ? startColumn : 1
    const display = `${lineNumber} | ${line.slice(column - 1)}`
    const candidate = receipt(lineNumber, line.length, false)
    const escapedLength = JSON.stringify(display).length - 2
    const nextLength = escapedContentLength + (displayLines.length ? 2 : 0) + escapedLength
    if (JSON.stringify({ ...candidate, numberedContent: '' }).length + nextLength > maxChars) break
    displayLines.push(display)
    escapedContentLength = nextLength
    selected = candidate
  }
  if (selected) {
    return { success: true, output: JSON.stringify({ ...selected, numberedContent: displayLines.join('\n') }), metadata: selected }
  }

  // A single long source line remains readable. Columns count UTF-16 code units,
  // while every returned boundary stays outside surrogate pairs.
  const startOffset = startColumn - 1
  let low = startOffset, high = firstLine.length, best = startOffset
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const endOffset = splitsSurrogatePair(firstLine, middle) ? middle - 1 : middle
    const candidate = receipt(startLine, endOffset, endOffset < firstLine.length)
    const output = JSON.stringify({ ...candidate, numberedContent: `${startLine} | ${firstLine.slice(startOffset, endOffset)}` })
    if (output.length <= maxChars) { best = Math.max(best, endOffset); low = middle + 1 }
    else high = middle - 1
  }
  if (best <= startOffset) return fail('OUTPUT_BUDGET_TOO_SMALL', 'The output budget cannot fit file identity and one source character. Increase TOOL_OUTPUT_MAX_CHARS; retrying the same page cannot make progress.')
  const page = receipt(startLine, best, best < firstLine.length)
  return { success: true, output: JSON.stringify({ ...page, numberedContent: `${startLine} | ${firstLine.slice(startOffset, best)}` }), metadata: page }
}

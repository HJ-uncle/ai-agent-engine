/** Shared page-table sizing keeps short identifiers compact without starving
 * prose columns. It affects layout only; source text is never shortened. */
export function documentColumnWidths(rows: readonly (readonly string[])[], availableWidth: number): number[] {
  const count = rows[0]?.length ?? 0
  if (!count) return []
  const weights = Array.from({ length: count }, (_, column) => {
    const lengths = rows.map(row => Math.max(0, ...(row[column] ?? '').split(/\r\n|\r|\n/).map(line => {
      let width = 0
      for (const char of line.replace(/\*\*|`/g, '')) width += /\p{Mark}/u.test(char) ? 0 : char.codePointAt(0)! > 255 ? 2 : 1
      return width
    }))).sort((a, b) => a - b)
    // A single unusually long cell wraps instead of making every other column narrow.
    return Math.min(60, Math.max(10, lengths[Math.ceil((lengths.length - 1) * .9)] ?? 0))
  })
  const minimum = Math.min(.14, .6 / count), remainder = 1 - minimum * count
  const total = weights.reduce((sum, value) => sum + value, 0)
  return weights.map(weight => availableWidth * (minimum + remainder * weight / total))
}

export const DOCUMENT_TABLE_STYLE = {
  header: '243247', headerText: 'FFFFFF', text: '27364B', stripe: 'F7F9FC', border: 'D9D9D9',
} as const

/** The metadata title already has its own visual paragraph. Only an identical
 * leading H1 is redundant; later headings and all body content remain intact. */
export function documentBodyWithoutRepeatedTitle(markdown: string, title?: string): string {
  if (!title?.trim()) return markdown
  const firstLine = /^(?:[ \t]*(?:\r\n|\r|\n))*([ \t]*#[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?)[ \t]*(?:\r\n|\r|\n|$)/.exec(markdown)
  if (!firstLine) return markdown
  const visibleHeading = firstLine[2].replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim()
  return visibleHeading === title.trim() ? markdown.slice(firstLine[0].length) : markdown
}

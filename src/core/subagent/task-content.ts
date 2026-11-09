/** This is only an empty-task guard, not proof of intent or authorization.
 * Short instructions such as “查” and numeric answers must remain usable. */
export function hasSubagentTaskContent(value: unknown): value is string {
  return typeof value === 'string' && /[\p{L}\p{N}]/u.test(value)
}

/** Reference labels, snapshots and attachment text are context, not a request.
 * Inspect the original message before any attachment or delegation wrapper is added. */
export function collaboratorRequestText(prompt: string | unknown[] | null): string {
  const text = typeof prompt === 'string' ? prompt : (prompt ?? []).flatMap(value =>
    value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' ? [value.text] : []).join('\n')
  const footer = /\n<!--aether-refs:([^\r\n]*)-->[ \t]*(?:\r?\n)?$/.exec(text)
  if (!footer) return text
  const body = text.slice(0, footer.index)
  try {
    const refs: unknown = JSON.parse(footer[1])
    if (!Array.isArray(refs)) return body
    const ranges = refs.flatMap(ref => ref && typeof ref === 'object'
      && Number.isInteger(ref.s) && Number.isInteger(ref.e) && ref.s >= 0 && ref.e > ref.s && ref.e <= body.length
      ? [{ start: Number(ref.s), end: Number(ref.e) }] : []).sort((a, b) => a.start - b.start)
    let cursor = 0, request = ''
    for (const range of ranges) {
      if (range.start > cursor) request += body.slice(cursor, range.start)
      cursor = Math.max(cursor, range.end)
    }
    return request + body.slice(cursor)
  } catch { return body }
}

export interface ThinkingTagText {
  content?: string
  reasoningContent?: string
}

const OPEN = '<think>'
const CLOSE = '</think>'
const MAX_LEADING_SPACE = 256

/** Some compatible providers put a reasoning prefix in content instead of a
 * dedicated field. Recognize only that prefix: tags quoted later in an answer
 * or inside Markdown code are ordinary authored text and must remain intact. */
export class ThinkingTagNormalizer {
  private phase: 'prefix' | 'reasoning' | 'content' = 'prefix'
  private pending = ''

  push(text: string): ThinkingTagText {
    if (this.phase === 'content') return text ? { content: text } : {}
    this.pending += text
    if (this.phase === 'prefix') {
      const prefix = this.pending.match(/^\s*/u)![0]
      const candidate = this.pending.slice(prefix.length)
      // Four-space or tab indentation is a Markdown code block, not protocol.
      if (prefix.length > MAX_LEADING_SPACE || /(?:^|\n)(?: {4}| *\t)/u.test(prefix)) return this.asContent()
      if (!candidate || candidate.length < OPEN.length && OPEN.startsWith(candidate.toLowerCase())) return {}
      if (!candidate.toLowerCase().startsWith(OPEN)) return this.asContent()
      this.phase = 'reasoning'
      this.pending = candidate.slice(OPEN.length)
    }

    // Case folding may expand Unicode characters (İ → i + combining dot).
    // Delimiter offsets must stay in the original UTF-16 string.
    const closeAt = /<\/think>/i.exec(this.pending)?.index
    if (closeAt !== undefined) {
      const reasoningContent = this.pending.slice(0, closeAt), content = this.pending.slice(closeAt + CLOSE.length)
      this.pending = ''; this.phase = 'content'
      return { ...(reasoningContent ? { reasoningContent } : {}), ...(content ? { content } : {}) }
    }
    // Hold at most a split closing marker, never the full thinking segment.
    let retained = 0
    for (let length = Math.min(CLOSE.length - 1, this.pending.length); length > 0; length--) {
      if (CLOSE.startsWith(this.pending.slice(-length).toLowerCase())) { retained = length; break }
    }
    const reasoningContent = this.pending.slice(0, this.pending.length - retained)
    this.pending = retained ? this.pending.slice(-retained) : ''
    return reasoningContent ? { reasoningContent } : {}
  }

  finish(): ThinkingTagText {
    // An unterminated reasoning block remains reasoning on a length stop;
    // exposing it as a final answer would misrepresent an incomplete response.
    if (this.phase === 'reasoning') {
      const reasoningContent = this.pending; this.pending = ''
      return reasoningContent ? { reasoningContent } : {}
    }
    return this.asContent()
  }

  private asContent(): ThinkingTagText {
    const content = this.pending; this.pending = ''; this.phase = 'content'
    return content ? { content } : {}
  }
}

export function splitThinkingTagPrefix(text: string): { content: string; reasoningContent?: string } {
  const parser = new ThinkingTagNormalizer(), first = parser.push(text), last = parser.finish()
  const reasoningContent = (first.reasoningContent ?? '') + (last.reasoningContent ?? '')
  return { content: (first.content ?? '') + (last.content ?? ''), ...(reasoningContent ? { reasoningContent } : {}) }
}

/**
 * The tool schema calls the payload `data`. Some older clients and model
 * adapters used `content`, so normalize that alias before any filesystem work.
 * Keeping this function side-effect free lets every invocation path enforce the
 * same contract (including XML tool-call fallbacks and direct tool execution).
 */
export interface NormalizedWriteFileArgs {
  path: string
  data?: unknown
  /** Versioned source bytes; never serialized through a format handler. */
  copyFrom?: { path: string; expectedHash: string }
  /** True when the legacy `content` property supplied the payload. */
  usedContentAlias: boolean
  expectedHash?: string
  createOnly?: boolean
  /** Explicit text-only tail formatting; omission preserves every byte. */
  trailingNewline?: 'preserve' | 'LF' | 'CRLF' | 'none'
}

export interface InvalidWriteFileArgs {
  code: 'WRITE_INVALID_ARGUMENTS'
  message: string
}

export type WriteFileArgsResult =
  | { ok: true; args: NormalizedWriteFileArgs }
  | { ok: false; error: InvalidWriteFileArgs }

/** Normalize and validate the minimum arguments required by `write_file`. */
export function normalizeWriteFileArgs(rawArgs: unknown): WriteFileArgsResult {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'write_file requires an object with path and either data or copyFrom.' } }
  }

  const input = rawArgs as Record<string, unknown>
  if (typeof input.path !== 'string' || input.path.trim().length === 0) {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'write_file requires a non-empty string path.' } }
  }

  const hasData = Object.prototype.hasOwnProperty.call(input, 'data')
  const hasContent = Object.prototype.hasOwnProperty.call(input, 'content')
  const hasCopy = Object.prototype.hasOwnProperty.call(input, 'copyFrom')
  let copyFrom: NormalizedWriteFileArgs['copyFrom']
  if (hasCopy) {
    if (hasData || hasContent) return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'copyFrom is mutually exclusive with data and legacy content.' } }
    const source = input.copyFrom
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        typeof (source as Record<string, unknown>).path !== 'string' || !(source as { path: string }).path.trim() ||
        typeof (source as Record<string, unknown>).expectedHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test((source as { expectedHash: string }).expectedHash)) {
      return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'copyFrom requires a non-empty path and the source file\'s complete sha256 expectedHash.' } }
    }
    copyFrom = { path: (source as { path: string }).path, expectedHash: (source as { expectedHash: string }).expectedHash }
  }
  // Prefer the current contract when both keys are present. If a serializer
  // emitted data: undefined, the legacy value is still a safe compatibility
  // fallback; an undefined payload must never reach a file handler.
  const usedContentAlias = !hasData || input.data === undefined
  const data = usedContentAlias ? (hasContent ? input.content : undefined) : input.data
  if (!copyFrom && data === undefined) {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'write_file requires data (or legacy content); it must not be undefined.' } }
  }

  if (input.expectedHash !== undefined && (typeof input.expectedHash !== 'string' || !/^(missing|sha256:[a-f0-9]{64})$/.test(input.expectedHash))) {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'expectedHash must be the complete file version returned by a file tool, or missing for a new file.' } }
  }
  if (input.createOnly !== undefined && typeof input.createOnly !== 'boolean') {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'createOnly must be a boolean.' } }
  }
  if (input.createOnly === true && input.expectedHash !== undefined && input.expectedHash !== 'missing') {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'createOnly cannot be combined with an existing file version.' } }
  }
  if (input.trailingNewline !== undefined && !['preserve', 'LF', 'CRLF', 'none'].includes(input.trailingNewline as string)) {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'trailingNewline must be preserve, LF, CRLF or none; omission preserves data exactly.' } }
  }
  if (copyFrom && input.trailingNewline !== undefined && input.trailingNewline !== 'preserve') {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'copyFrom preserves every source byte; trailingNewline must be omitted or preserve.' } }
  }

  return { ok: true, args: { path: input.path, ...(copyFrom ? { copyFrom } : { data }), usedContentAlias: usedContentAlias && hasContent,
    ...(input.expectedHash === undefined ? copyFrom ? { expectedHash: 'missing' } : {} : { expectedHash: input.expectedHash as string }),
    ...(input.createOnly === undefined ? {} : { createOnly: input.createOnly as boolean }),
    ...(input.trailingNewline === undefined ? {} : { trailingNewline: input.trailingNewline as NormalizedWriteFileArgs['trailingNewline'] }) } }
}

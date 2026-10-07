/**
 * The tool schema calls the payload `data`. Some older clients and model
 * adapters used `content`, so normalize that alias before any filesystem work.
 * Keeping this function side-effect free lets every invocation path enforce the
 * same contract (including XML tool-call fallbacks and direct tool execution).
 */
export interface NormalizedWriteFileArgs {
  path: string
  data: unknown
  /** True when the legacy `content` property supplied the payload. */
  usedContentAlias: boolean
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
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'write_file requires an object with path and data.' } }
  }

  const input = rawArgs as Record<string, unknown>
  if (typeof input.path !== 'string' || input.path.trim().length === 0) {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'write_file requires a non-empty string path.' } }
  }

  const hasData = Object.prototype.hasOwnProperty.call(input, 'data')
  const hasContent = Object.prototype.hasOwnProperty.call(input, 'content')
  // Prefer the current contract when both keys are present. If a serializer
  // emitted data: undefined, the legacy value is still a safe compatibility
  // fallback; an undefined payload must never reach a file handler.
  const usedContentAlias = !hasData || input.data === undefined
  const data = usedContentAlias ? (hasContent ? input.content : undefined) : input.data
  if (data === undefined) {
    return { ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS', message: 'write_file requires data (or legacy content); it must not be undefined.' } }
  }

  return { ok: true, args: { path: input.path, data, usedContentAlias: usedContentAlias && hasContent } }
}

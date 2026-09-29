/** Abort reasons are preserved so deadlines and user stops retain distinct outcomes. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operation cancelled', 'AbortError')
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && /^(AbortError|APIUserAbortError)$/.test(error.name))
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new DOMException('Operation cancelled', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

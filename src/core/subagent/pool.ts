interface Waiter {
  start(): void
  signal?: AbortSignal
  abort(): void
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error(signal?.reason instanceof Error ? signal.reason.message : 'Subagent cancelled')
  error.name = 'AbortError'
  return error
}

/** Separate from the tool pool: waiting child orchestration must never occupy inner-tool slots. */
export class SubagentPool {
  private readonly groups = new Map<string, { active: number; queue: Waiter[] }>()

  constructor(readonly limit = 3) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Subagent concurrency limit must be a positive integer')
  }

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    const group = this.groups.get(key) ?? { active: 0, queue: [] }
    this.groups.set(key, group)
    return new Promise((resolve, reject) => {
      const drain = () => {
        while (group.active < this.limit && group.queue.length > 0) group.queue.shift()!.start()
        if (group.active === 0 && group.queue.length === 0) this.groups.delete(key)
      }
      const waiter: Waiter = {
        signal,
        abort: () => {
          const index = group.queue.indexOf(waiter)
          if (index >= 0) group.queue.splice(index, 1)
          signal?.removeEventListener('abort', waiter.abort)
          reject(abortError(signal))
          drain()
        },
        start: () => {
          signal?.removeEventListener('abort', waiter.abort)
          if (signal?.aborted) { reject(abortError(signal)); return }
          group.active++
          let released = false
          resolve(() => {
            if (released) return
            released = true
            group.active--
            drain()
          })
        },
      }
      group.queue.push(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      drain()
    })
  }
}

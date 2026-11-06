import { DEFAULT_SUBAGENT_CONCURRENCY } from './concurrency.js'

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
  private capacity: number

  constructor(limit = DEFAULT_SUBAGENT_CONCURRENCY) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Subagent concurrency limit must be a positive integer')
    this.capacity = limit
  }

  get limit(): number { return this.capacity }

  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Subagent concurrency limit must be a positive integer')
    this.capacity = limit
    // Shrinking never interrupts existing work. Growing wakes queued callers
    // now rather than waiting for an unrelated running child to finish.
    for (const [key, group] of this.groups) this.drain(key, group)
  }

  private drain(key: string, group: { active: number; queue: Waiter[] }): void {
    while (group.active < this.limit && group.queue.length > 0) group.queue.shift()!.start()
    if (group.active === 0 && group.queue.length === 0) this.groups.delete(key)
  }

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    const group = this.groups.get(key) ?? { active: 0, queue: [] }
    this.groups.set(key, group)
    return new Promise((resolve, reject) => {
      const drain = () => this.drain(key, group)
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

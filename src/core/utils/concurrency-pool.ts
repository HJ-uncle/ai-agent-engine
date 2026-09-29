import { throwIfAborted } from './abort.js'

export interface Pool {
  <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
  readonly size: number
  readonly active: number
  readonly pending: number
  resize(n: number): void
}

export function createPool(limit: number): Pool {
  let active = 0
  let size = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
  const queue: Array<() => void> = []
  const next = () => {
    while (active < size && queue.length > 0) { active++; queue.shift()!() }
  }
  const api = (<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError')); return }
    const abort = () => {
      const index = queue.indexOf(task)
      if (index < 0) return
      queue.splice(index, 1)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new DOMException('Operation cancelled', 'AbortError'))
    }
    const task = () => {
      signal?.removeEventListener('abort', abort)
      Promise.resolve().then(() => { throwIfAborted(signal); return fn() }).then(resolve, reject).finally(() => { active--; next() })
    }
    signal?.addEventListener('abort', abort, { once: true })
    queue.push(task)
    next()
  })) as Pool
  Object.defineProperties(api, {
    size: { get: () => size }, active: { get: () => active }, pending: { get: () => queue.length },
  })
  api.resize = n => { size = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1; next() }
  return api
}

let globalToolPool: Pool | null = null
export function getGlobalToolPool(): Pool {
  return globalToolPool ??= createPool(parseInt(process.env.TOOL_CONCURRENCY_LIMIT ?? '8', 10))
}
export function setGlobalToolPoolLimit(limit: number): void { getGlobalToolPool().resize(limit) }

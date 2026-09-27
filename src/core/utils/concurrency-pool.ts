/**
 * 轻量级并发池（零依赖 p-limit 等价实现）。
 *
 * 场景：
 * - 工具执行并发上限
 * - LSP 诊断并发上限
 * - 任何需要限流的 async 任务
 *
 * 用法：
 *   const pool = createPool(8)
 *   const res  = await pool(() => fetchSomething())
 */

export interface Pool {
  <T>(fn: () => Promise<T>): Promise<T>
  readonly size: number
  readonly active: number
  readonly pending: number
  resize(n: number): void
}

export function createPool(limit: number): Pool {
  let active = 0
  const queue: Array<() => void> = []

  const next = () => {
    if (active >= poolRef.size) return
    const run = queue.shift()
    if (run) {
      active++
      run()
    }
  }

  const exec = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const task = () => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--
            next()
          })
      }
      queue.push(task)
      next()
    })

  const poolRef = {
    size: Math.max(1, limit),
    get active() { return active },
    get pending() { return queue.length },
    resize(n: number) {
      poolRef.size = Math.max(1, n)
      // 扩容时尝试释放待运行任务
      while (active < poolRef.size && queue.length > 0) next()
    },
  }

  const api = ((fn: any) => exec(fn)) as Pool
  Object.defineProperty(api, 'size',    { get: () => poolRef.size })
  Object.defineProperty(api, 'active',  { get: () => active })
  Object.defineProperty(api, 'pending', { get: () => queue.length })
  ;(api as any).resize = (n: number) => poolRef.resize(n)
  return api
}

/**
 * 全局工具执行池（所有 Tool.execute 都会被限流）。
 * 通过 TOOL_CONCURRENCY_LIMIT 环境变量可配置，默认 8。
 */
let globalToolPool: Pool | null = null

export function getGlobalToolPool(): Pool {
  if (!globalToolPool) {
    const limit = parseInt(process.env.TOOL_CONCURRENCY_LIMIT ?? '8', 10)
    globalToolPool = createPool(limit)
  }
  return globalToolPool
}

export function setGlobalToolPoolLimit(limit: number): void {
  const pool = getGlobalToolPool()
  pool.resize(limit)
}

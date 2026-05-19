/**
 * 就绪探测模块
 *
 * 以固定间隔轮询 GET <baseUrl>/health，等待 agent-engine 启动完成。
 * ECONNREFUSED 等网络错误视为"尚未就绪"，不立即失败。
 * 超时后 reject，错误信息含 'startup timeout'。
 */

export interface ReadinessProbeOptions {
  /** agent-engine baseUrl，如 'http://127.0.0.1:12324' */
  baseUrl: string
  /** 最大等待时间（ms），默认 15000 */
  timeoutMs?: number
  /** 探测间隔（ms），默认 200 */
  intervalMs?: number
}

/**
 * 等待 agent-engine 就绪（/health 接口返回 2xx）。
 *
 * @param opts 探测选项
 * @returns resolve 表示已就绪
 * @throws 超时时 reject，错误信息含 'startup timeout'
 */
export function waitUntilReady(opts: ReadinessProbeOptions): Promise<void> {
  const { baseUrl, timeoutMs = 15000, intervalMs = 200 } = opts
  const healthUrl = `${baseUrl.replace(/\/+$/, '')}/health`

  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    let stopped = false
    let timer: NodeJS.Timeout | null = null

    const timeoutTimer = setTimeout(() => {
      stopped = true
      if (timer) clearTimeout(timer)
      reject(
        new Error(
          `agent-engine startup timeout after ${timeoutMs}ms (url: ${healthUrl})`
        )
      )
    }, timeoutMs)

    async function probe(): Promise<void> {
      if (stopped) return

      try {
        const controller = new AbortController()
        const probeTimeout = setTimeout(() => controller.abort(), intervalMs * 3)

        try {
          const resp = await fetch(healthUrl, {
            method: 'GET',
            signal: controller.signal
          })
          clearTimeout(probeTimeout)

          if (resp.ok || resp.status === 200) {
            stopped = true
            clearTimeout(timeoutTimer)
            resolve()
            return
          }
        } catch {
          clearTimeout(probeTimeout)
          // ECONNREFUSED / AbortError 等 —— 继续轮询
        }
      } catch {
        // 外层兜底
      }

      if (!stopped) {
        // 距离超时还有足够时间，继续轮询
        const elapsed = Date.now() - startTime
        if (elapsed < timeoutMs - intervalMs) {
          timer = setTimeout(probe, intervalMs)
        }
        // 否则等待 timeoutTimer 触发 reject
      }
    }

    // 立即开始第一次探测
    probe()
  })
}

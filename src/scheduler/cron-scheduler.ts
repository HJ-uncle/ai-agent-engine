/**
 * Cron Scheduler
 * 使用轻量级 cron 表达式解析（不依赖 node-cron，手动实现分钟级轮询）
 * 每分钟检查一次所有启用的定时任务，到期则向 /api/v1/chat 发起内部请求
 */
import { consumeCronStream } from './cron-stream.js'
import { CronStore, DEFAULT_CRON_TIMEOUT_SECONDS, validCronTimeoutSeconds } from '../storage/cron/index.js'
import { INSTANCE_TOKEN_HEADER } from '../auth/instance-token.js'
import { readEngineListenAddress } from '../server-listen.js'

// 简单 cron 解析：支持标准 5 字段 cron（分 时 日 月 周）
function matchCron(expr: string, now: Date): boolean {
  try {
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 5) return false
    const [min, hour, dom, mon, dow] = parts
    const check = (field: string, value: number, min: number, max: number): boolean => {
      if (field === '*') return true
      if (field.includes('/')) {
        const [, step] = field.split('/')
        return value % parseInt(step) === 0
      }
      if (field.includes(',')) {
        return field.split(',').map(Number).includes(value)
      }
      if (field.includes('-')) {
        const [lo, hi] = field.split('-').map(Number)
        return value >= lo && value <= hi
      }
      return parseInt(field) === value
    }
    return (
      check(min, now.getMinutes(), 0, 59) &&
      check(hour, now.getHours(), 0, 23) &&
      check(dom, now.getDate(), 1, 31) &&
      check(mon, now.getMonth() + 1, 1, 12) &&
      check(dow, now.getDay(), 0, 6)
    )
  } catch {
    return false
  }
}

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null
  private store = new CronStore()
  private baseUrl: string
  private running = false
  private generation = 0
  private activeJobs = new Map<string, AbortController>()

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? `http://127.0.0.1:${readEngineListenAddress().port}`
  }

  start() {
    if (this.running) return
    this.running = true
    // 每分钟整点触发一次
    const tick = () => {
      if (!this.running) return
      this.checkAndRun().catch(err => console.error('[CronScheduler] tick error:', err))
    }
    // 对齐到下一分钟整点
    const msToNextMin = 60000 - (Date.now() % 60000)
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null
      if (!this.running) return
      tick()
      this.timer = setInterval(tick, 60000)
    }, msToNextMin)
    console.log('[CronScheduler] started, first tick in', Math.round(msToNextMin / 1000), 's')
  }

  stop() {
    this.running = false
    this.generation++
    for (const controller of this.activeJobs.values()) controller.abort(new Error('Cron scheduler stopped'))
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log('[CronScheduler] stopped')
  }

  async checkAndRun() {
    const now = new Date()
    const generation = this.generation
    const jobs = await this.store.listEnabled()
    if (generation !== this.generation) return
    for (const job of jobs) {
      if (matchCron(job.cronExpr, now) && !this.activeJobs.has(job.id)) {
        console.log(`[CronScheduler] firing job "${job.name}" (${job.id})`)
        this.fireJob(job).catch(err =>
          console.error(`[CronScheduler] job "${job.name}" failed:`, err)
        )
        await this.store.updateRuntime(job.id, Date.now())
      }
    }
  }

  private async fireJob(job: { id: string; message: string; sessionId: string; agentId?: string; timeoutSeconds?: number | null; thinkingMode?: import('../storage/cron/index.js').CronThinkingMode }) {
    if (this.activeJobs.has(job.id)) return
    if (!validCronTimeoutSeconds(job.timeoutSeconds)) throw new Error('Invalid Cron timeoutSeconds')
    const timeoutSeconds = job.timeoutSeconds ?? DEFAULT_CRON_TIMEOUT_SECONDS
    const controller = new AbortController()
    this.activeJobs.set(job.id, controller)
    try {
    const body: Record<string, unknown> = {
      message: job.message,
      sessionId: job.sessionId,
      cronJobId: job.id,
      cronTimeoutSeconds: timeoutSeconds,
    }
    if (job.agentId) body.agentId = job.agentId
    if (job.thinkingMode != null) body.thinkingMode = job.thinkingMode

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Request-ID': `cron-${job.id}` }
    const instanceToken = process.env.AETHER_INSTANCE_TOKEN
    if (instanceToken) {
      const target = new URL(this.baseUrl)
      if (!['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) throw new Error('Internal cron credentials require a loopback target')
      headers[INSTANCE_TOKEN_HEADER] = instanceToken
    }

    // 内部 HTTP 调用 chat 接口（SSE），消费完流即可
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutSeconds * 1000)])
    let ownedRunId: string | undefined
    try {
    const res = await fetch(`${this.baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify(body),
      signal: requestSignal,
    })
    if (!res.ok) throw new Error(`chat request failed: ${res.status}`)
    await consumeCronStream(res, job.sessionId, runId => { ownedRunId = runId })
    console.log(`[CronScheduler] job "${job.id}" succeeded`)
    } catch (error) {
      if (ownedRunId) {
        const cancelled = await fetch(this.baseUrl + '/api/v1/chat/cancel', { method: 'POST', headers, redirect: 'error', body: JSON.stringify({ sessionId: job.sessionId, runId: ownedRunId }), signal: AbortSignal.timeout(10000) })
        if (!cancelled.ok) throw new Error('Cron cancellation failed: ' + cancelled.status, { cause: error })
        const result = await cancelled.json() as { code?: number }
        if (result.code !== 200) throw new Error('Cron cancellation rejected', { cause: error })
      }
      throw error
    }
    } finally { if (this.activeJobs.get(job.id) === controller) this.activeJobs.delete(job.id) }
  }
}

// 全局单例
export const cronScheduler = new CronScheduler()

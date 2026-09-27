import { getMemoryDb } from './db.js'

export class MemoryConsolidator {
  private timer: NodeJS.Timeout | null = null

  /**
   * 启动自动记忆反思与衰减守护进程
   */
  startDaemon(tenantId: string = 'default') {
    if (this.timer) {
      clearTimeout(this.timer)
    }

    const runAndSchedule = async () => {
      try {
        await this.runConsolidation(tenantId)
      } catch (err) {
        console.error(`[Memory] Daemon consolidation failed:`, err)
      }

      // 动态读取环境变量，默认为 24 小时
      const intervalHours = parseInt(process.env.MEMORY_CONSOLIDATION_INTERVAL_HOURS || '24', 10)
      const delay = (isNaN(intervalHours) || intervalHours <= 0 ? 1 : intervalHours) * 60 * 60 * 1000
      
      this.timer = setTimeout(runAndSchedule, delay)
    }

    // 启动时延迟 1 分钟执行首次整理，避免阻塞主进程
    this.timer = setTimeout(runAndSchedule, 60 * 1000)
  }

  /**
   * 停止守护进程
   */
  stopDaemon() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * 执行记忆图谱的反思整理 (Consolidation)
   */
  async runConsolidation(tenantId: string = 'default') {
    const db = getMemoryDb()
    console.log(`[Memory] Starting consolidation for tenant: ${tenantId}...`)

    try {
      // 1. 根据时间衰减记忆强度
      // 公式: new_strength = MAX(0, old_strength - decay_rate * days_passed)
      // 我们用 (unixepoch() - last_accessed) / 86400 计算流逝的天数
      await db.execute({
        sql: `
          UPDATE memory_nodes 
          SET 
            strength = MAX(0, strength - decay_rate * (CAST((unixepoch() - last_accessed) AS REAL) / 86400.0)),
            last_strength_update = unixepoch()
          WHERE tenant_id = ?
        `,
        args: [tenantId]
      })

      // 动态读取衰减阈值
      const threshold = parseFloat(process.env.MEMORY_DECAY_THRESHOLD || '0.05')
      const safeThreshold = isNaN(threshold) ? 0.05 : threshold

      const weakNodes = await db.execute({
        sql: `SELECT id, summary FROM memory_nodes WHERE tenant_id = ? AND strength <= ? AND type NOT IN ('preference', 'decision')`,
        args: [tenantId, safeThreshold]
      })
      
      if (weakNodes.rows.length > 0) {
        console.log(`[Memory] Found ${weakNodes.rows.length} weak memories that could be forgotten.`)
      }

      console.log(`[Memory] Consolidation completed successfully.`)
    } catch (e) {
      console.error(`[Memory] Consolidation failed:`, e)
    }
  }
}

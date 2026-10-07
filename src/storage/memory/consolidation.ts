import { getMemoryDb } from './db.js'
import type { MemoryContext, MemoryScope } from './types.js'

export class MemoryConsolidator {
  private timer: NodeJS.Timeout | null = null

  startDaemon(tenantOrContext: string | MemoryContext = 'default', scope: MemoryScope = 'global', sessionId = '') {
    const tenantId = typeof tenantOrContext === 'string' ? tenantOrContext : tenantOrContext.tenantId
    if (typeof tenantOrContext !== 'string') {
      scope = tenantOrContext.scope ?? 'global'
      sessionId = tenantOrContext.sessionId
    }
    if (this.timer) clearTimeout(this.timer)
    const runAndSchedule = async () => {
      try { await this.runConsolidation(tenantId, scope, sessionId) } catch (err) { console.error('[Memory] Daemon consolidation failed:', err) }
      const intervalHours = parseInt(process.env.MEMORY_CONSOLIDATION_INTERVAL_HOURS || '24', 10)
      const delay = (isNaN(intervalHours) || intervalHours <= 0 ? 1 : intervalHours) * 60 * 60 * 1000
      this.timer = setTimeout(runAndSchedule, delay)
    }
    this.timer = setTimeout(runAndSchedule, 60 * 1000)
  }

  stopDaemon() { if (this.timer) { clearTimeout(this.timer); this.timer = null } }

  async runConsolidation(tenantOrContext: string | MemoryContext = 'default', scope: MemoryScope = 'global', sessionId = '') {
    const tenantId = typeof tenantOrContext === 'string' ? tenantOrContext : tenantOrContext.tenantId
    if (typeof tenantOrContext !== 'string') {
      scope = tenantOrContext.scope ?? 'global'
      sessionId = tenantOrContext.sessionId
    }
    if (scope === 'session' && !sessionId.trim()) throw new Error('session scope requires a non-empty sessionId')
    const db = getMemoryDb()
    console.log(`[Memory] Starting consolidation for tenant: ${tenantId}, scope: ${scope}...`)
    try {
      // last_strength_update is the checkpoint for decay.  Using last_accessed
      // repeatedly would subtract the same elapsed period on every run.
      await db.execute({
        sql: `UPDATE memory_nodes SET strength=MAX(0, strength - decay_rate * (CAST((unixepoch() - last_strength_update) AS REAL) / 86400.0)), last_strength_update=unixepoch() WHERE tenant_id=? AND scope=? ${scope === 'session' ? 'AND session_id=?' : ''}`,
        args: scope === 'session' ? [tenantId, scope, sessionId] : [tenantId, scope],
      })
      const threshold = parseFloat(process.env.MEMORY_DECAY_THRESHOLD || '0.05'); const safeThreshold = isNaN(threshold) ? 0.05 : threshold
      const weakNodes = await db.execute({
        sql: `SELECT id,summary FROM memory_nodes WHERE tenant_id=? AND scope=? ${scope === 'session' ? 'AND session_id=?' : ''} AND strength<=? AND type NOT IN ('preference','decision')`,
        args: scope === 'session' ? [tenantId, scope, sessionId, safeThreshold] : [tenantId, scope, safeThreshold],
      })
      if (weakNodes.rows.length > 0) console.log(`[Memory] Found ${weakNodes.rows.length} weak memories that could be forgotten.`)
      console.log('[Memory] Consolidation completed successfully.')
    } catch (e) { console.error('[Memory] Consolidation failed:', e) }
  }
}

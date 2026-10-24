import type { StreamBus } from './stream-bus.js'

const reportedFailures = new WeakSet<StreamBus>()

/** Publication still owns its real barrier. Losing the observation channel
 * must neither cancel execution nor emit another warning for every token. */
export async function observePublication(bus: StreamBus, publish: () => Promise<unknown>, report?: (error: unknown) => void): Promise<void> {
  try { await publish() }
  catch (error) {
    if (bus.disconnectTimeout) { clearTimeout(bus.disconnectTimeout); bus.disconnectTimeout = null }
    if (!report || reportedFailures.has(bus)) return
    reportedFailures.add(bus)
    // Diagnostics are observers too; a broken sink cannot fail the task.
    try { report(error) } catch { /* observation diagnostics only */ }
  }
}

import fs from 'node:fs'

export function monitorReadiness(rows, enginePid, minimumSamples = 2) {
  if (rows.some(row => row.type === 'error' || row.type === 'stop')) throw new Error('resource-monitor-ended-or-failed-before-readiness')
  const starts = rows.filter(row => row.type === 'start')
  const samples = rows.filter(row => row.type === 'sample')
  if (!starts.length || samples.length < minimumSamples) return null
  if (starts.length !== 1 || starts[0].enginePid !== enginePid || !Number.isFinite(Date.parse(starts[0].engineStartTime))) throw new Error('resource-monitor-root-identity-mismatch')
  for (const [index, sample] of samples.entries()) {
    if (sample.enginePid !== enginePid || sample.sequence !== index || !Number.isFinite(Date.parse(sample.at)) || !Array.isArray(sample.processes) || sample.processCount !== sample.processes.length || !sample.processes.some(proc => proc.pid === enginePid && proc.startTime === starts[0].engineStartTime) || !Number.isFinite(sample.rssBytes) || sample.rssBytes <= 0 || !Number.isFinite(sample.privateBytes) || sample.privateBytes <= 0) throw new Error('resource-monitor-invalid-process-tree-sample')
    if ((sample.errors ?? []).some(error => error.startsWith('process-tree-enumeration:'))) throw new Error('resource-monitor-process-tree-enumeration-failed')
  }
  return { enginePid, engineStartTime: starts[0].engineStartTime, samples: samples.length, firstSampleAt: samples[0].at, lastSampleAt: samples.at(-1).at, processCount: samples.at(-1).processCount }
}

export async function awaitMonitorReadiness({ file, enginePid, monitor, timeoutMs = 30_000, guardedWait, now = Date.now }) {
  const until = now() + timeoutMs
  while (true) {
    if (monitor.closedResult) throw new Error('resource-monitor-ended-before-readiness')
    let rows = []
    try {
      const text = fs.readFileSync(file, 'utf8')
      // The writer may be between writing a JSON line and its newline.
      rows = text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('resource-monitor-invalid-record: ' + error.message) }
    const ready = monitorReadiness(rows, enginePid)
    if (ready) return ready
    if (now() >= until) throw new Error('resource-monitor-readiness-timeout')
    await guardedWait(Math.min(250, until - now()))
  }
}

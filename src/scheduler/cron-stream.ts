/** Retain only the current SSE frame; long-running jobs must not accumulate their transcript. */
export async function consumeCronStream(response: Response, sessionId: string, onRun: (runId: string) => void): Promise<void> {
  if (!response.body) throw new Error('Cron chat did not succeed: missing stream')
  if (response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Cron chat rejected: expected SSE, received JSON response')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let outcome: string | undefined
  let ownedRunId: string | undefined
  const maxFrameChars = 1024 * 1024
  function frame(block: string) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]') return
    let event: { code?: number; error?: unknown; run?: { runId?: string; sessionId?: string; status?: string } }
    try { event = JSON.parse(data) } catch { throw new Error('Cron chat did not succeed: malformed SSE') }
    if (!event || typeof event !== 'object' || event.error || (event.code != null && event.code !== 200)) throw new Error('Cron chat did not succeed: error envelope')
    if (event.run?.sessionId !== sessionId) return
    if (!event.run.runId) throw new Error('Cron chat did not succeed: missing run identity')
    if (ownedRunId && ownedRunId !== event.run.runId) throw new Error('Cron chat did not succeed: conflicting run identity')
    ownedRunId = event.run.runId
    onRun(ownedRunId)
    outcome = event.run.status
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(buffer)
        if (!separator) break
        if (separator.index > maxFrameChars) throw new Error('Cron SSE frame exceeds size limit')
        frame(buffer.slice(0, separator.index))
        buffer = buffer.slice(separator.index + separator[0].length)
      }
      if (buffer.length > maxFrameChars) throw new Error('Cron SSE frame exceeds size limit')
      if (done) break
    }
    if (buffer.trim()) frame(buffer)
    if (outcome !== 'succeeded') throw new Error('Cron chat did not succeed: ' + (outcome ?? 'missing terminal outcome'))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

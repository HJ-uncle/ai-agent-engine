/** Opt-in observer for isolated real-model evaluations. Never records headers,
 * credentials or complete prompts, and never modifies provider requests.
 * Set AETHER_CACHE_EVIDENCE to an absolute JSON output path, then preload with
 * node --import ./scripts/evals/cache-prefix-observer.mjs --import tsx ...
 * AETHER_CACHE_REPLAY_INDEX optionally repeats exactly one chosen request
 * after its response finishes; replayed tool calls are never executed.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

const output = process.env.AETHER_CACHE_EVIDENCE
if (!output || !isAbsolute(output)) throw new Error('An absolute AETHER_CACHE_EVIDENCE path is required')
mkdirSync(dirname(output), { recursive: true })
const originalFetch = globalThis.fetch
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const common = (a, b) => { let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i }
const records = []
let previous
const save = () => writeFileSync(output, JSON.stringify({ schemaVersion: 1, records }, null, 2))
const replayIndex = Number(process.env.AETHER_CACHE_REPLAY_INDEX || 0)
if (replayIndex && (!Number.isInteger(replayIndex) || replayIndex < 1 || replayIndex > 12)) throw new Error('Replay index must be 1..12')
const usageFrom = text => {
  const chunks = text.startsWith('{') ? [text] : text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.replace(/^data:\s*/, ''))
  return chunks.flatMap(chunk => { try { const value = JSON.parse(chunk); return value.usage || value.message?.usage ? [value.usage || value.message.usage] : [] } catch { return [] } })
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return originalFetch(input, init)
  let body
  try { body = JSON.parse(String(init?.body)) } catch { return originalFetch(input, init) }
  if (!Array.isArray(body.messages)) return originalFetch(input, init)
  const systems = [
    ...(body.system ? [{ role: 'system', content: body.system }] : []),
    ...body.messages.filter(m => ['system', 'developer'].includes(m.role))
  ]
  const history = body.messages.filter(m => !['system', 'developer'].includes(m.role))
  const systemText = systems.map(m => typeof m.content === 'string' ? m.content : Array.isArray(m.content)
    ? m.content.map(block => block.text ?? '').join('\n') : JSON.stringify(m.content)).join('\n')
  const current = { index: records.length + 1, systems, history, tools: body.tools ?? [], systemText }
  const record = { index: records.length + 1, startedAt: new Date().toISOString(), model: body.model,
    messageCount: body.messages.length, systemCharacters: systemText.length,
    protocol: body.system !== undefined ? 'anthropic' : 'openai-compatible',
    systemSha256: hash(systems), toolsSha256: hash(current.tools),
    messageSha256: body.messages.map(hash), usage: [] }
  if (previous) {
    const prefix = common(previous.systemText, systemText)
    const historyPrefix = common(previous.history.map(hash), history.map(hash))
    const before = previous.systemText.slice(Math.max(0, prefix - 70), prefix + 90)
    const after = systemText.slice(Math.max(0, prefix - 70), prefix + 90)
    record.comparison = { withIndex: previous.index, systemEqual: hash(previous.systems) === hash(systems),
      systemCommonPrefixCharacters: prefix, systemFirstDifference:
        /currentTime|registryVersion|toolCount/.test(before + after) ? { before, after } : { kind: 'other-system-content', offset: prefix },
      toolsEqual: hash(previous.tools) === hash(current.tools),
      historyPrefixMessages: historyPrefix, previousHistoryMessages: previous.history.length,
      previousHistoryPreserved: historyPrefix === previous.history.length,
      changedPreviousHistoryIndices: previous.history.flatMap((m, i) => i < history.length && hash(m) !== hash(history[i]) ? [i] : []) }
  }
  records.push(record)
  // Background title calls do not replace the main agent comparison baseline.
  if (current.tools.length) previous = current
  save()
  try {
    const response = await originalFetch(input, init)
    record.status = response.status
    const captured = response.clone().text().then(text => {
      record.usage = usageFrom(text)
      record.elapsedMs = Date.now() - Date.parse(record.startedAt)
      save()
    }).catch(() => { record.captureFailed = true; save() })
    if (record.index === replayIndex) {
      await captured
      const started = Date.now()
      const repeated = await originalFetch(input, init)
      record.identicalRequestReplay = { requestBodyUnchanged: true, toolCallsExecuted: false,
        status: repeated.status, usage: usageFrom(await repeated.text()), elapsedMs: Date.now() - started }
      save()
    }
    return response
  } catch (error) { record.error = error?.name || 'Error'; save(); throw error }
}

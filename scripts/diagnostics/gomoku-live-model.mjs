/** Opt-in reproduction of the original Work-mode request. No UI automation,
 * prompt rewriting, tool whitelist, injected skills, or subagent restrictions.
 * All writes and credentials belong to .e2e-tmp/gomoku-live-model/<run>/.
 * Without --run this file performs no profile reads, writes, or model calls. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PROMPT = '帮我做一个 五子棋的h5 游戏'
const HELP = `Isolated real-model Gomoku reproduction (opt-in).
Usage: node scripts/diagnostics/gomoku-live-model.mjs [--run] --source-profile <profile>
  --model <id>           Default: deepseek-v4.1-flash-1017 (root/child/utility)
  --engine-entry <file>  Default: dist/main.js; can select the desktop dev runtime
  --thinking-mode <low|off>  Default: low; off sends thinkingMode=false
  --deadline-seconds <n> Default: 200, total budget from the initial POST /chat
  --poll-ms <n>          Default: 2000; root status plus bounded snapshot evidence
  --continue-after-stop-seconds <n>  Optional: cancel n seconds after first model
                         progress, then continue the same run/turn with a new attempt
  --help                Print help only

Exact prompt: ${PROMPT}
Default assistant; general profile; toolkits=[]; workspacePaths=[] (generated workspace).
No --run: prints a plan, does not read credentials or start processes.
--run: reads only the selected model and credential envelope from the explicit profile,
uses the existing private OS bridge in a temporary Electron profile, then starts an
isolated engine. Thinking text is NOT written to evidence; only sizes and timing.
Deadline/signal cancels only this isolated task, joins shutdown, and removes credential
profile and model database. Evidence/workspace remain under .e2e-tmp/gomoku-live-model/.
Exit 0: engine reports succeeded (game behavior still requires separate verification).
Exit 2: deadline/user-input wait/interruption; exit 1: engine failure or cleanup failure.`

function options(args) {
  const valueFlags = new Set(['--source-profile', '--model', '--engine-entry', '--thinking-mode', '--deadline-seconds', '--poll-ms', '--continue-after-stop-seconds'])
  const parsed = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--run' || key === '--help') { parsed[key] = true; continue }
    assert(valueFlags.has(key), 'Unknown option: ' + key)
    assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing value: ' + key)
    assert(parsed[key] === undefined, 'Duplicate option: ' + key)
    parsed[key] = args[++i]
  }
  return parsed
}
const args = options(process.argv.slice(2))
const modelId = args['--model'] || 'deepseek-v4.1-flash-1017'
const engineEntry = resolve(args['--engine-entry'] || join(engineRoot, 'dist/main.js'))
const thinkingMode = args['--thinking-mode'] || 'low'
assert(['low', 'off'].includes(thinkingMode), '--thinking-mode must be low or off')
const deadlineMs = Number(args['--deadline-seconds'] || 200) * 1000
const pollMs = Number(args['--poll-ms'] || 2000)
const continueAfterMs = args['--continue-after-stop-seconds'] === undefined ? null : Number(args['--continue-after-stop-seconds']) * 1000
assert(Number.isFinite(deadlineMs) && deadlineMs >= 1000 && deadlineMs <= 3_600_000, 'Deadline must be 1..3600 seconds')
assert(Number.isFinite(pollMs) && pollMs >= 500 && pollMs <= 60_000, 'Poll interval must be 500..60000 ms')
assert(continueAfterMs === null || Number.isFinite(continueAfterMs) && continueAfterMs >= 1000 && continueAfterMs < deadlineMs,
  '--continue-after-stop-seconds must be at least 1 and less than the total deadline')
if (args['--help']) { console.log(HELP); process.exit(0) }
if (!args['--run']) {
  console.log(HELP)
  console.log(JSON.stringify({ mode: 'no-run', prompt: PROMPT, modelId, thinkingMode, engineEntry, deadlineMs, pollMs, continueAfterMs,
    sourceProfile: args['--source-profile'] ? resolve(args['--source-profile']) : '(required with --run)' }, null, 2))
  process.exit(0)
}
assert(args['--source-profile'], '--run requires an explicit --source-profile')
const sourceProfile = resolve(args['--source-profile'])
const root = join(engineRoot, '.e2e-tmp/gomoku-live-model', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
const profile = join(root, 'credential-profile'), database = join(root, 'state/agent.db'), workspace = join(root, 'workspace')
const electron = resolve(engineRoot, '../aether-code/node_modules/electron/dist/electron.exe')
const token = randomBytes(32).toString('hex'), secrets = [token]
const sessionId = 'gomoku-live-' + randomUUID(), requestKey = randomUUID()
const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }
const report = { schemaVersion: 1, root, sourceProfile, engineEntry, modelId, thinkingMode, prompt: PROMPT, sessionId,
  startedAt: new Date().toISOString(), status: 'starting', sourceProfileReadOnly: true, productionSessionReads: false,
  limitations: ['Engine success does not verify game behavior.', 'Thinking text and full wire history are deliberately omitted.',
    'Fresh isolated profile uses built-in assistant defaults; user custom settings are not copied.'],
  eventCounts: {}, thinking: { events: 0, characters: 0, firstAtMs: null, lastAtMs: null, maxGapMs: 0 },
  content: { events: 0, characters: 0, firstAtMs: null, lastAtMs: null }, tools: [], children: {}, wireRequests: [], streams: [],
  ...(continueAfterMs === null ? {} : { continuation: { status: 'pending', afterProgressMs: continueAfterMs } }) }
const delay = ms => new Promise(done => setTimeout(done, ms))
const stopped = new AbortController(), streamAbort = new AbortController(), pollAbort = new AbortController()
let engine, engineClosed, engineStartedAt, stopTree, base, config, sourceFingerprints, admitted, chatStartedAt, lastRun
let lastEventAt, maxIdleMs = 0, deadline, shutdownRequested = false
let firstModelProgressAtMs = null
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
function noLinks(target) {
  let current = resolve(target)
  while (true) {
    if (existsSync(current)) assert(!lstatSync(current).isSymbolicLink(), 'Path traverses a link: ' + current)
    const next = dirname(current); if (next === current) break; current = next
  }
}
function inside(target) {
  const absolute = resolve(target)
  assert(absolute.startsWith(root + sep), 'Refusing path outside owned output')
  noLinks(absolute); return absolute
}
function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text
}
function safe(value, key = '', depth = 0) {
  if (/api.?key|authorization|password|encryptionKey|encryptedTestKey|testKey|accessToken|refreshToken/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    if (/^(thinking|reasoningContent|reasoning_content|reasoning)$/i.test(key)) return { omitted: true, characters: value.length }
    const text = redact(value); return text.length > 5000 ? { preview: text.slice(0, 5000), characters: text.length, truncated: true } : text
  }
  if (depth > 18) return '[depth limit]'
  if (Array.isArray(value)) return value.slice(0, 500).map(item => safe(item, key, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v, k, depth + 1)]))
  return value
}
function save(name, value) { const path = inside(join(root, name)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(safe(value), null, 2), 'utf8') }
function record(name, value) { appendFileSync(inside(join(root, name)), JSON.stringify(safe(value)) + '\n', 'utf8') }
function elapsed() { return chatStartedAt ? Date.now() - chatStartedAt : 0 }
function progress(event, details = {}) { save('report.json', report); console.log('[gomoku-live] ' + redact({ event, elapsedMs: elapsed(), ...details })) }
function cleanEnv() {
  // Preserve OS/runtime essentials, but prevent unrelated engine configuration or credentials from entering this isolated run.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|NODE_OPTIONS|ELECTRON_|^DATA_DIR$|^PORT$|^HOST$|^AETHER_|^WORKSPACE_|^SKILLS_|^MCP_|^LLM_|^MEMORY_|^HISTORY_|^DEFAULT_SECURITY_MODE$|^AUTH_|^OSM_|^SUPERPOWER_|^ENABLE_LONG_TERM_MEMORY$|^MAX_ITERATIONS$|^QA_|^LOG_|^OPENAI_|^DEEPSEEK_|^ANTHROPIC_|^QWEN_|^OLLAMA_|^THINKING_|^REASONING_/i.test(key)))
}
const headers = () => ({ 'content-type': 'application/json', 'x-aether-tool-profile': transport.toolProfile,
  'x-aether-run-lifetime': transport.runLifetime, 'x-aether-subagent-protocol': '2', 'x-aether-instance-token': token })
async function api(method, path, body, timeout = 8000) {
  const response = await fetch(base + path, { method, headers: headers(), signal: AbortSignal.timeout(timeout),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok || value.code !== 200) throw new Error(redact(`${method} ${path}: HTTP ${response.status} ${value.message || value.code}`))
  return value.data
}
function credentialHash(path) {
  const bytes = readFileSync(path)
  return createHash('sha256').update(path.endsWith('Local State') ? JSON.stringify(JSON.parse(bytes.toString()).os_crypt) : bytes).digest('hex')
}
async function readCredential() {
  const { DatabaseSync } = await import('node:sqlite')
  const sourceDb = join(sourceProfile, 'engine/state/agent.db'), state = join(sourceProfile, 'Local State'), keyFile = join(sourceProfile, 'engine/secrets/engine-secrets.json')
  sourceFingerprints = [state, keyFile].map(path => ({ path, hash: credentialHash(path) }))
  const db = new DatabaseSync(sourceDb, { readOnly: true }); let rows
  try { rows = db.prepare('SELECT model_id,provider,api_key,base_url,api_format,capabilities FROM models WHERE model_id=? AND is_enabled=1 AND deleted_at IS NULL').all(modelId) }
  finally { db.close() }
  assert(rows.length === 1, 'Expected exactly one selected enabled model in the explicit source profile')
  const row = rows[0], keyRecord = JSON.parse(readFileSync(keyFile, 'utf8')), testKey = randomBytes(32).toString('hex')
  secrets.push(row.api_key, testKey, keyRecord.encryptionKey)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'Local State'), JSON.stringify({ os_crypt: JSON.parse(readFileSync(state, 'utf8')).os_crypt }), { flag: 'wx', mode: 0o600 })
  const started = Date.now(), bridge = spawn(electron, [join(engineRoot, 'scripts/diagnostics/plugin-real-world-credentials.cjs')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanEnv(), PLUGIN_CREDENTIAL_PROFILE: profile,
      PLUGIN_CREDENTIAL_INPUT: JSON.stringify({ keyRecord, encryptedApiKey: row.api_key, testKey }) } })
  let output = '', bridgeError = false
  bridge.stdout.on('data', bytes => { output += bytes; if (output.length > 100000) bridgeError = true })
  bridge.stderr.resume() // Never persist the private bridge output, including failures.
  const closed = new Promise((accept, reject) => { bridge.once('error', reject); bridge.once('close', code => accept(code)) })
  const timer = setTimeout(() => { void stopTree(bridge, started).catch(() => { bridgeError = true }) }, 30000)
  let code
  try { code = await closed } finally { clearTimeout(timer) }
  assert(code === 0 && !bridgeError, 'Read-only credential bridge failed')
  const line = output.split('\n').find(item => item.startsWith('PLUGIN_CREDENTIAL_RESULT:'))
  assert(line, 'Missing private credential response')
  const result = JSON.parse(line.slice('PLUGIN_CREDENTIAL_RESULT:'.length))
  secrets.push(result.apiKey, result.testKey, result.encryptedTestKey)
  rmSync(inside(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return { key: result.testKey, model: { modelId: row.model_id, provider: row.provider, apiKey: result.apiKey,
    baseUrl: row.base_url, apiFormat: row.api_format || 'auto', ...(row.capabilities ? { capabilities: JSON.parse(row.capabilities) } : {}) } }
}

/** Serialized into the isolated host. Instrumentation observes scalar fields only
 * and forwards the exact original fetch input/response and adapter arguments. */
async function isolatedHost(entry) {
  const { dirname, join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const emit = details => { if (process.connected) process.send?.({ kind: 'gomoku-diagnostic', at: Date.now(), ...details }) }
  const scalars = (value, fields) => Object.fromEntries(fields.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key])).map(key => [key, value[key]]))
  const thinking = value => value && typeof value === 'object' ? scalars(value, ['type', 'budget_tokens', 'effort', 'reasoning_effort', 'enable_thinking']) : value
  const originalFetch = globalThis.fetch
  let request = 0
  globalThis.fetch = async function (input, init) {
    let evidence
    try {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      if (body?.model && (Array.isArray(body.messages) || Array.isArray(body.input))) {
        const endpoint = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
        evidence = { kind: 'wire_request', request: ++request, endpoint: endpoint.origin + endpoint.pathname,
          ...scalars(body, ['model', 'reasoning_effort', 'enable_thinking', 'max_tokens', 'max_completion_tokens', 'temperature', 'stream']),
          thinking: thinking(body.thinking), output_config: thinking(body.output_config), reasoning: thinking(body.reasoning),
          messageCount: body.messages?.length ?? body.input?.length, toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
          toolNames: Array.isArray(body.tools) ? body.tools.map(tool => tool.function?.name || tool.name).filter(Boolean) : [] }
        emit(evidence)
      }
    } catch { /* Observation must not change execution. */ }
    const response = await originalFetch.call(this, input, init)
    if (evidence) emit({ kind: 'wire_response', request: evidence.request, status: response.status })
    return response
  }
  await import(pathToFileURL(join(dirname(entry), 'env.js')).href)
  for (const [file, exportName] of [['deepseek', 'DeepSeekAdapter'], ['openai', 'OpenAIAdapter'], ['anthropic', 'AnthropicAdapter'], ['qwen', 'QwenAdapter'], ['ollama', 'OllamaAdapter']]) {
    const Module = await import(pathToFileURL(join(dirname(entry), 'core/llm-adapter', file + '.js')).href)
    const prototype = Module[exportName]?.prototype
    for (const method of ['stream', 'complete']) {
      if (!prototype || !Object.hasOwn(prototype, method)) continue
      const original = prototype[method]
      prototype[method] = function (messages, options) {
        emit({ kind: 'adapter_enter', adapter: exportName, method, module: 'core/llm-adapter/' + file + '.js',
          ...scalars(options, ['model', 'maxTokens', 'thinkingEnabled', 'reasoningEffort', 'temperature']),
          thinkingConfig: thinking(options?.thinkingConfig), messageCount: Array.isArray(messages) ? messages.length : null })
        return original.call(this, messages, options)
      }
    }
  }
  process.on('message', message => { if (message?.command === 'shutdown') process.emit('SIGTERM') })
  await import(pathToFileURL(entry).href)
}
async function startEngine() {
  mkdirSync(workspace, { recursive: true })
  const listener = createServer()
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done) })
  const port = listener.address().port; await new Promise(done => listener.close(done))
  base = `http://127.0.0.1:${port}/api/v1`
  const host = join(root, 'engine-host.mjs')
  writeFileSync(host, `await (${isolatedHost.toString()})(${JSON.stringify(engineEntry)});\n`, { flag: 'wx' })
  engineStartedAt = Date.now()
  engine = spawn(electron, [host], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1', DATA_DIR: database, MEMORY_DB_PATH: join(root, 'state/memory.db'),
    WORKSPACE_ROOT: workspace, AETHER_GLOBAL_DIR: join(root, 'global'), SKILLS_ROOT: join(root, 'skills'), MCP_CONFIG_PATH: join(root, 'mcp.json'),
    PROGRAMDATA: join(root, 'managed-config'),
    ENCRYPTION_KEY: config.key, AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: token, AETHER_DESKTOP_OWNED: '1',
    AETHER_ENGINE_HOST: '127.0.0.1', AETHER_ENGINE_PORT: String(port), NODE_ENV: 'development',
    DEFAULT_SECURITY_MODE: 'standard', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', ENABLE_LONG_TERM_MEMORY: 'false',
    LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false', QA_LOG_DIR: join(root, 'qa'), LLM_PRIMARY_MODEL: modelId,
    LLM_MODEL: modelId, LLM_PROVIDER: config.model.provider, LLM_FALLBACK_MODEL: '' } })
  engineClosed = new Promise(done => { engine.once('error', error => done({ spawnError: error.message })); engine.once('close', (code, signal) => done({ code, signal })) })
  engine.on('message', data => {
    // Host never sends request bodies/headers. Retain exact observed adapter and wire budgets.
    if (!['wire_request', 'wire_response', 'adapter_enter'].includes(data?.kind)) return
    record('adapter-wire.jsonl', { ...data, elapsedMs: elapsed() })
    if (data.kind === 'wire_request') { report.wireRequests.push(safe({ ...data, elapsedMs: elapsed() })); progress('wire-request', { request: data.request, thinking: data.thinking, effort: data.reasoning_effort, maxTokens: data.max_tokens }) }
  })
  for (const stream of [engine.stdout, engine.stderr]) {
    let tail = ''
    stream.on('data', bytes => {
      tail = (tail + bytes.toString()).slice(-128000)
      const lines = tail.split('\n'); tail = lines.pop()
      for (const line of lines) {
        try {
          const data = JSON.parse(line)
          const allowed = ['time', 'level', 'msg', 'event', 'requestAttemptId', 'schemaVersion', 'availability', 'requestStage', 'wireMessageCount', 'systemPromptSha256', 'workflowHintPresent', 'readonlyHintPresent', 'mutationHintPresent', 'subagentRunId']
          record('engine-log-summary.jsonl', Object.fromEntries(allowed.filter(key => data[key] !== undefined).map(key => [key, key === 'msg' ? String(data[key]).slice(0, 400) : data[key]])))
        } catch { record('engine-log-summary.jsonl', { unstructuredLineOmitted: true, bytes: Buffer.byteLength(line) }) }
      }
    })
  }
  for (let i = 0; i < 90; i++) {
    assert(engine.exitCode === null && engine.signalCode === null, 'Isolated engine exited before readiness')
    try { await api('GET', '/plugins', undefined, 1000); break } catch (error) { if (i === 89) throw error; await delay(500) }
  }
  assert.deepEqual((await api('GET', '/plugins')).plugins, [], 'Isolated engine must start empty')
  const selected = await api('POST', '/models', config.model)
  assert(selected.id, 'Missing isolated model record ID')
  await api('PUT', '/models/' + encodeURIComponent(selected.id), { isEnabled: true })
  report.model = { provider: config.model.provider, apiFormat: config.model.apiFormat, capabilities: selected.resolvedCapabilities || selected.capabilities }
  const manifest = join(dirname(engineEntry), 'runtime/build-manifest.json')
  report.engineBuild = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { unavailable: true }
}
function observeRun(run) {
  if (!run || run.sessionId !== sessionId) return
  if (admitted) assert.equal(run.runId, admitted.receipt.rootRunId, 'Unexpected second root in isolated session')
  if (lastRun && run.runId !== lastRun.runId) throw new Error('Unexpected second root in isolated session')
  if (lastRun && run.version < lastRun.version) return // An old SSE prefix must not regress a continued attempt.
  if (admitted) {
    assert.equal(run.turnId, admitted.receipt.turnId, 'Logical turn changed')
    assert.equal(run.userMessageId, admitted.receipt.userMessageId, 'Original user anchor changed')
  }
  lastRun = run; report.rootRun = safe(run)
}
function observeEnvelope(envelope, id, phase) {
  const at = elapsed(), now = Date.now()
  maxIdleMs = Math.max(maxIdleMs, now - (lastEventAt ?? chatStartedAt)); lastEventAt = now
  if (firstModelProgressAtMs === null && (typeof envelope.thinking === 'string' && envelope.thinking.length
    || typeof envelope.content === 'string' && envelope.content.length || envelope.toolStart || envelope.toolCall)) {
    firstModelProgressAtMs = at
    report.firstModelProgressAtMs = at
    if (report.continuation) report.continuation.cancelDueAtMs = at + continueAfterMs
  }
  for (const [key, value] of Object.entries(envelope)) {
    report.eventCounts[key] = (report.eventCounts[key] || 0) + 1
    if ((key === 'thinking' || key === 'content') && typeof value === 'string') {
      const metric = report[key]; metric.events++; metric.characters += value.length
      if (metric.firstAtMs === null) metric.firstAtMs = at
      if (key === 'thinking' && metric.lastAtMs !== null) metric.maxGapMs = Math.max(metric.maxGapMs, at - metric.lastAtMs)
      metric.lastAtMs = at
    }
    if (key === 'run') observeRun(value)
    if (['toolStart', 'toolResult', 'toolEnd'].includes(key)) {
      const event = { event: key === 'toolStart' ? 'tool_start' : 'tool_result', atMs: at, phase, ...safe(value) }
      report.tools.push(event); record('tool-agent-events.jsonl', event)
    }
    if (key === 'subagentEvent') {
      const view = value.view && typeof value.view === 'object' ? value.view : value.snapshot || value.headerPatch || {}
      const previous = report.children[value.runId], merged = { ...previous, ...safe(view), runId: value.runId, seq: value.seq }
      report.children[value.runId] = merged
      const kind = terminal.has(merged.status) || merged.status === 'blocked' ? 'agent_end' : previous ? 'agent_progress' : 'agent_start'
      record('tool-agent-events.jsonl', { event: kind, derivedFrom: 'subagentEvent', atMs: at, phase, protocolKind: value.kind, runId: value.runId, seq: value.seq, state: merged })
    }
  }
  record('sse-events.jsonl', { atMs: at, phase, id, envelope })
}
async function consumeSse(response, phase) {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Chat did not accept SSE: HTTP ' + response.status + ' ' + redact((await response.text()).slice(0, 1000)))
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n')
      assert(buffer.length <= 16 * 1024 * 1024, 'SSE frame exceeded diagnostic bound')
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const lines = frame.split('\n'), id = lines.find(line => line.startsWith('id:'))?.slice(3).trim()
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue // Heartbeat is transport liveness, not model progress.
        if (data === '[DONE]') { report.streamDoneAtMs = elapsed(); continue }
        observeEnvelope(JSON.parse(data), id, phase)
      }
    }
  } finally { reader.releaseLock() }
}
async function snapshot() {
  const value = await api('GET', '/chat/snapshot?sessionId=' + encodeURIComponent(sessionId), undefined, 5000)
  // executionRun is the durable owner; run may only describe the published prefix.
  observeRun(value.executionRun || value.run)
  save('root-snapshot.json', value)
  record('snapshots.jsonl', { atMs: elapsed(), eventId: value.eventId, source: value.source, finished: value.finished,
    run: value.run, executionRun: value.executionRun, projectionCount: value.projection?.length, sessionUsage: value.sessionUsage,
    historyCount: value.history?.length, children: value.subagentRuns?.map(child => ({ runId: child.runId, status: child.status, lastSeq: child.lastSeq, toolCount: child.toolCount })) })
  return value
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function startStream(body, phase) {
  const controller = new AbortController(), state = { phase, startedAtMs: elapsed() }
  report.streams.push(state)
  const task = fetch(base + '/chat', { method: 'POST', headers: headers(), body: JSON.stringify(body),
    signal: AbortSignal.any([streamAbort.signal, controller.signal]) })
    .then(response => { state.httpStatus = response.status; return consumeSse(response, phase) })
    .then(() => { state.closedAtMs = elapsed() }, error => { state.closedAtMs = elapsed(); state.error = redact(error.message) })
  return { task, controller, state }
}
async function stopThenContinue(initialStream, streams) {
  assert(admitted && lastRun, 'Cannot stop an unidentified initial attempt')
  const initial = structuredClone(lastRun), metric = report.continuation
  metric.status = 'stopping'; metric.cancelStartedAtMs = elapsed()
  metric.actualProgressDelayMs = metric.cancelStartedAtMs - firstModelProgressAtMs
  metric.initial = { runId: initial.runId, turnId: initial.turnId, attemptId: initial.attemptId,
    userMessageId: initial.userMessageId, assistantMessageId: initial.assistantMessageId }
  save('continuation-before-stop.json', await snapshot())
  progress('continuation-stop', { runId: initial.runId, attemptId: initial.attemptId })
  metric.cancellation = await api('POST', '/chat/cancel', { sessionId, runId: initial.runId }, 30000)
  // Cancellation owns the producer join. Also detach the old viewer before opening
  // a new attempt so a delayed old SSE frame cannot masquerade as resumed work.
  if (!await Promise.race([initialStream.task.then(() => true), delay(3000).then(() => false)])) initialStream.controller.abort()
  await initialStream.task
  const afterStop = await snapshot(); save('continuation-after-stop.json', afterStop)
  metric.cancelFinishedAtMs = elapsed(); metric.stoppedRun = safe(lastRun)
  if (lastRun?.status === 'succeeded') {
    metric.status = 'not-exercised'; metric.reason = 'Original attempt completed before cancellation settled'
    stopped.abort('succeeded'); return
  }
  assert.equal(metric.cancellation.settled, true, 'Cancellation did not confirm producer cleanup')
  assert.equal(lastRun?.status, 'cancelled', 'Expected a durable cancelled root before continuing')
  assert.equal(lastRun.attemptId, initial.attemptId, 'Cancellation unexpectedly changed the attempt')
  if (stopped.signal.aborted) { metric.status = 'stopped-before-continuation'; return }
  const context = await api('GET', '/chat/admission/context?sessionId=' + encodeURIComponent(sessionId))
  assert.deepEqual(context.transport, transport)
  assert.equal(context.root?.runId, initial.runId); assert.equal(context.root?.turnId, initial.turnId)
  assert.equal(context.predecessor?.attemptId, initial.attemptId)
  assert.equal(context.predecessor?.version, lastRun.version)
  const body = { sessionId }, selector = { protocolVersion: 1, namespace: context.namespace, owner: 'work',
    predecessor: context.predecessor, turnId: initial.turnId }
  const bodyDigest = createHash('sha256').update(canonical({ selector, transport, body })).digest('hex')
  const continueKey = randomUUID()
  body.continuation = { ...selector, requestKey: continueKey, bodyDigest }
  save('continuation-request.json', body)
  const receiptBody = { sessionId, namespace: context.namespace, requestKey: continueKey, bodyDigest }
  if (stopped.signal.aborted) { metric.status = 'stopped-before-continuation'; return }
  metric.status = 'admitting'; metric.submittedAtMs = elapsed()
  progress('continuation-submit', { runId: initial.runId, previousAttemptId: initial.attemptId })
  // One exact continuation POST. Lost/uncertain ACKs are resolved by this receipt;
  // never resubmit the prompt, an empty user message, or a new request key.
  const continuedStream = startStream(body, 'continued'); streams.push(continuedStream)
  const receiptDeadline = Date.now() + 30000
  while (!stopped.signal.aborted && Date.now() < receiptDeadline) {
    const accepted = await api('POST', '/chat/continuation/receipt', receiptBody, 4000)
    if (accepted.status === 'accepted') {
      const receipt = accepted.receipt
      assert.equal(receipt.rootRunId, initial.runId, 'Continue created a new root')
      assert.equal(receipt.turnId, initial.turnId, 'Continue created a new turn')
      assert.equal(receipt.userMessageId, initial.userMessageId, 'Continue created a new user anchor')
      assert.equal(receipt.previousAttemptId, initial.attemptId)
      assert.notEqual(receipt.attemptId, initial.attemptId, 'Continue did not create a new attempt')
      assert.notEqual(receipt.assistantMessageId, initial.assistantMessageId, 'Continue did not create an assistant segment')
      assert.equal(accepted.run?.attemptId, receipt.attemptId)
      assert.equal(accepted.run?.assistantMessageId, receipt.assistantMessageId)
      metric.status = 'accepted'; metric.acceptedAtMs = elapsed(); metric.receipt = receipt
      observeRun(accepted.run); save('continuation-receipt.json', accepted)
      save('continuation-after-accept.json', await snapshot())
      progress('continuation-accepted', { runId: receipt.rootRunId, turnId: receipt.turnId, attemptId: receipt.attemptId })
      return
    }
    if (continuedStream.state.error) throw new Error('Continuation rejected before a receipt: ' + continuedStream.state.error)
    await delay(250)
  }
  if (stopped.signal.aborted) { metric.status = 'receipt-unknown-at-stop'; return }
  throw new Error('Continuation receipt remained absent; original request was not resubmitted')
}
async function runChat() {
  const context = await api('GET', '/chat/admission/context?sessionId=' + encodeURIComponent(sessionId))
  assert(context.predecessor === null && context.root === null, 'Isolated session is unexpectedly non-empty')
  assert.deepEqual(context.transport, transport)
  const body = { sessionId, message: PROMPT, model: modelId, subagentModel: modelId, utilityModel: modelId,
    thinkingMode: thinkingMode === 'off' ? false : 'low', toolkits: [], workspacePaths: [] }
  const selector = { protocolVersion: 1, namespace: context.namespace, owner: 'work', predecessor: null }
  const bodyDigest = createHash('sha256').update(canonical({ selector, transport, body })).digest('hex')
  body.admission = { ...selector, requestKey, bodyDigest }
  save('chat-request.json', body)
  const receiptBody = { sessionId, namespace: context.namespace, requestKey, bodyDigest }
  chatStartedAt = Date.now(); deadline = setTimeout(() => stopped.abort('deadline'), deadlineMs)
  report.status = 'running'; progress('chat-start', { deadlineMs, thinkingMode })
  // Exactly one initial POST; the optional continuation is a separate operation
  // with no user message and is tied to this original run/turn.
  const streams = [startStream(body, 'initial')]
  const pollTask = (async () => {
    while (!pollAbort.signal.aborted && !stopped.signal.aborted) {
      try {
        if (!admitted) {
          const receipt = await api('POST', '/chat/admission/receipt', receiptBody, 4000)
          if (receipt.status === 'accepted') { admitted = receipt; report.admission = receipt.receipt; observeRun(receipt.run); save('admission.json', receipt) }
        }
        const state = await api('GET', '/chat/status?sessionId=' + encodeURIComponent(sessionId), undefined, 4000)
        observeRun(state.run); record('status.jsonl', { atMs: elapsed(), ...state })
        await snapshot()
        if (lastRun && (terminal.has(lastRun.status) || lastRun.status === 'waiting')) { stopped.abort(lastRun.status); break }
      } catch (error) { record('poll-errors.jsonl', { atMs: elapsed(), error: redact(error.message) }) }
      if (report.continuation?.status === 'pending' && admitted && lastRun?.status === 'running'
        && firstModelProgressAtMs !== null && elapsed() >= firstModelProgressAtMs + continueAfterMs && !stopped.signal.aborted) {
        try { await stopThenContinue(streams[0], streams) }
        catch (error) { report.continuation.status = 'failed'; report.continuation.error = redact(error.message); stopped.abort('continuation-failed') }
      }
      await delay(pollMs)
    }
  })()
  await new Promise(done => { if (stopped.signal.aborted) done(); else stopped.signal.addEventListener('abort', done, { once: true }) })
  clearTimeout(deadline); report.stopReason = String(stopped.signal.reason); report.observedDurationMs = elapsed()
  // The coordinator may currently be joining the first attempt or checking the
  // continuation receipt. Join it before final cancellation to avoid two writers.
  pollAbort.abort(); await pollTask
  report.maxEventIdleMs = Math.max(maxIdleMs, Date.now() - (lastEventAt ?? chatStartedAt))
  report.lastEventIdleMs = Date.now() - (lastEventAt ?? chatStartedAt)
  let finalSnapshot = await snapshot().catch(error => { report.finalSnapshotError = redact(error.message) })
  save('pre-cancel-snapshot-summary.json', { stopReason: report.stopReason, run: lastRun, thinking: report.thinking, content: report.content })
  if (!lastRun || !terminal.has(lastRun.status)) {
    report.cancellation = await api('POST', '/chat/cancel', { sessionId, ...(lastRun ? { runId: lastRun.runId } : {}) }, 30000)
    finalSnapshot = await snapshot().catch(error => { report.postCancelSnapshotError = redact(error.message) })
  }
  streamAbort.abort(); await Promise.all(streams.map(stream => stream.task))
  if (report.continuation) {
    const metric = report.continuation
    if (metric.status === 'accepted') {
      const { runs } = await api('GET', '/chat/runs?sessionId=' + encodeURIComponent(sessionId))
      assert.equal(runs.length, 1, 'Stop/continue created an additional logical root')
      assert.equal(lastRun?.attemptId, metric.receipt.attemptId, 'Final root is not the continued attempt')
      const users = finalSnapshot?.history?.filter(message => message.role === 'user')
      assert(users, 'Missing final history for continuation verification')
      assert.equal(users.length, 1, 'Continue added a synthetic or duplicate user message')
      assert.equal(users[0].id, admitted.receipt.userMessageId)
      assert.equal(users[0].content, PROMPT, 'Continue rewrote the original user task')
      metric.invariants = { sameRoot: true, sameTurn: true, newAttempt: true, newAssistantSegment: true, originalUserUnchanged: true, logicalRoots: runs.length, userMessages: users.length }
      metric.finalStatus = lastRun.status
      save('continuation-verification.json', metric)
    } else if (metric.status === 'pending') { metric.status = 'not-exercised'; metric.reason = 'Task stopped before the configured progress delay' }
  }
  report.status = report.stopReason === 'succeeded' && (!report.continuation || report.continuation.status === 'accepted') ? 'succeeded'
    : ['failed', 'continuation-failed'].includes(report.stopReason) ? 'failed' : 'stopped'
  if (report.status !== 'succeeded') process.exitCode = report.status === 'failed' ? 1 : 2
}
function inventory(directory, files = []) {
  if (!existsSync(directory)) return files
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) { files.push({ path: relative(workspace, path), linkSkipped: true }); continue }
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) inventory(path, files)
    else if (entry.isFile()) files.push({ path: relative(workspace, path), bytes: lstatSync(path).size })
    if (files.length >= 10000) return files
  }
  return files
}
async function cleanup() {
  clearTimeout(deadline); pollAbort.abort(); streamAbort.abort()
  if (engine) {
    if (engine.connected) { shutdownRequested = true; engine.send({ command: 'shutdown' }) }
    let closed = await Promise.race([engineClosed, delay(12000).then(() => null)])
    if (!closed) { await stopTree(engine, engineStartedAt); closed = await Promise.race([engineClosed, delay(4000).then(() => null)]) }
    assert(closed, 'Owned isolated engine process did not close')
    report.engineExit = closed
  }
  // Delete only this script's explicit credential paths, after its process exits.
  for (const target of [profile, database, database + '-wal', database + '-shm', database + '-journal']) {
    if (existsSync(target)) rmSync(inside(target), { recursive: target === profile, force: true, maxRetries: 5, retryDelay: 100 })
  }
  report.cleanup = { shutdownRequested, engineStopped: !engine || engine.exitCode !== null || engine.signalCode !== null,
    credentialProfileRemoved: !existsSync(profile), modelDatabaseRemoved: !existsSync(database),
    sourceCredentialFilesUnchanged: sourceFingerprints?.every(item => credentialHash(item.path) === item.hash) ?? true }
  assert(report.cleanup.engineStopped && report.cleanup.credentialProfileRemoved && report.cleanup.modelDatabaseRemoved && report.cleanup.sourceCredentialFilesUnchanged, 'Cleanup or read-only credential verification failed')
  save('workspace-files.json', inventory(workspace))
}
noLinks(root); assert(existsSync(engineEntry), 'Engine entry does not exist'); assert(existsSync(electron), 'Electron runtime not found')
mkdirSync(root, { recursive: true })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopped.abort(signal))
try {
  ;({ stopCommandProcessTree: stopTree } = await import(pathToFileURL(join(dirname(engineEntry), 'core/command-jobs/process-tree.js')).href))
  config = await readCredential(); await startEngine(); await runChat()
} catch (error) {
  report.status = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1
  progress('failed', { error: report.error })
} finally {
  try { await cleanup() } catch (error) { report.cleanupError = redact(error.message); report.status = 'failed'; process.exitCode = 1 }
  report.completedAt = new Date().toISOString(); progress('completed', { status: report.status, root, cleanup: report.cleanup })
}

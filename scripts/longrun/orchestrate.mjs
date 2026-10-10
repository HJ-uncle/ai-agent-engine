// Isolated real-model load test orchestration. This file does nothing when syntax-checked.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { Transform } from 'node:stream'
import { captureBuildArtifacts, compareBuildArtifacts } from './build-artifact-identity.mjs'
import { orchestrationBudget } from './workload-budget.mjs'
import { awaitDriverFinalization } from './driver-finalization.mjs'
import { awaitMonitorReadiness } from './monitor-readiness.mjs'

const execFileAsync = promisify(execFile)
const toolsRoot = path.dirname(fileURLToPath(import.meta.url))
const engineRoot = path.resolve(toolsRoot, '../..')
const port = Number(process.env.LONGRUN_PORT || 12499)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid LONGRUN_PORT')
const base = `http://127.0.0.1:${port}`
const budget = orchestrationBudget()
const driverDeadlineMs = budget.maxMs
// Startup/model preflight precede the driver; client acceptance has its own
// ten-minute window afterwards. A separate bounded grace allows only existing
// cancellation/snapshots/report writing after model work stops.
const totalDeadlineMs = budget.totalDeadlineMs
const startedAt = Date.now()
const stamp = new Date().toISOString().replace(/[-:.]/g, '')
// mkdtemp guarantees uniqueness and never reuses or removes an earlier run.
const projectRoot = path.resolve(process.env.LONGRUN_PROJECT_ROOT || path.join(engineRoot, 'test-projects', 'longrun-20261009'))
const projectManifest = path.resolve(projectRoot, process.env.LONGRUN_MANIFEST || 'manifest.json')
if (path.relative(projectRoot, projectManifest).startsWith('..') || path.isAbsolute(path.relative(projectRoot, projectManifest))) throw new Error('Test manifest escapes retained project root')
const runsRoot = path.join(projectRoot, 'runs')
fs.mkdirSync(runsRoot, { recursive: true })
const root = fs.mkdtempSync(path.join(runsRoot, `run-${stamp}-`))
const stopFile = path.join(root, 'STOP')
const envFile = path.join(engineRoot, '.env')
const sourceDb = path.resolve(process.env.LONGRUN_MODEL_DB || path.join(engineRoot, 'data', 'agent.db'))
const targetDb = path.join(root, 'agent.db')
const driverFile = path.join(toolsRoot, 'project-driver.mjs')
const monitorFile = path.join(toolsRoot, 'monitor.ps1')
const packagedRoot = path.resolve(process.env.LONGRUN_ENGINE_ROOT || path.join(engineRoot, '..', 'aether-code', 'resources', 'engine', 'win32-x64'))
const engineFile = path.join(packagedRoot, 'dist', 'main.js')
const engineNode = path.join(packagedRoot, 'runtime', 'node.exe')
const runtimeProbeFile = path.join(toolsRoot, 'runtime-probe.mjs')
const instanceToken = randomBytes(32).toString('hex')
const instanceHeaders = { 'x-aether-instance-token': instanceToken }
const childEnv = { ...process.env }
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const equal = text.indexOf('=')
    if (equal < 1) continue
    const name = text.slice(0, equal).trim()
    if (!(name in childEnv)) childEnv[name] = text.slice(equal + 1).trim().replace(/^["']|["']$/g, '')
  }
}
const secretValues = Object.entries(childEnv)
  .filter(([key, value]) => /key|token|secret|password|credential/i.test(key) && value?.length >= 8)
  .map(([, value]) => value).sort((a, b) => b.length - a.length)
secretValues.push(instanceToken)
function redact(value) {
  let text = String(value)
  for (const secret of secretValues) text = text.split(secret).join('[REDACTED]')
  return text.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
}
const writeJson = (name, data) => fs.writeFileSync(path.join(root, name), JSON.stringify(data, null, 2))
const append = (name, data) => fs.appendFileSync(path.join(root, name), JSON.stringify(data) + '\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let phase = 'prepare'
let abortReason = null
let driver = null
let engine = null
let monitor = null
let healthLoop = null
let summaryLoop = null
let backgroundStop = false
let finalCode = 2
let enabledModelIds = []
let driverFinalization = null
let initialBuildArtifacts = null
let initialPackagedArtifacts = null
const buildArtifactObservations = []
let buildArtifactVerificationFailed = false
const verifyBuildArtifacts = stage => {
  if (!initialBuildArtifacts) return null
  const at = new Date().toISOString()
  let observation
  try {
    const current = captureBuildArtifacts(engineRoot, { requireNodePty: true, requireNodePtyPatch: true })
    observation = { at, stage, ...compareBuildArtifacts(initialBuildArtifacts, current) }
    if (initialPackagedArtifacts) {
      const packaged = captureBuildArtifacts(packagedRoot, { requireNodePty: true, requireNodePtyPatch: true })
      observation.packaged = compareBuildArtifacts(initialPackagedArtifacts, packaged)
      observation.sourceAndPackage = compareBuildArtifacts(current, packaged)
      observation.unchanged &&= observation.packaged.unchanged && observation.sourceAndPackage.unchanged
    }
    if (stage === 'final') observation.finalArtifacts = current
  } catch (error) { observation = { at, stage, unchanged: false, verificationError: redact(error.message) } }
  if (!observation.unchanged) buildArtifactVerificationFailed = true
  buildArtifactObservations.push(observation)
  append('build-artifact-checks.jsonl', observation)
  return observation
}
const spawned = []
const known = new Map()
const healthSamples = []
const mark = (name, extra = {}) => {
  phase = name
  append('lifecycle.jsonl', { at: new Date().toISOString(), phase, ...extra })
}
const requestAbort = reason => { abortReason ||= reason }
process.on('SIGINT', () => requestAbort('SIGINT'))
process.on('SIGTERM', () => requestAbort('SIGTERM'))
const deadlineTimer = setTimeout(() => requestAbort('orchestrator-hard-deadline'), totalDeadlineMs)
const guardedSleep = async ms => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (abortReason) throw new Error(abortReason)
    if (engine?.closedResult) throw new Error('engine-exited')
    await sleep(Math.min(250, until - Date.now()))
  }
}

async function powershell(script, extraEnv = {}) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...extraEnv } })
  return stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) : []
}
async function processTable() {
  const result = await powershell(`$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString();name=$_.Name} }); ConvertTo-Json -InputObject $rows -Compress`)
  return Array.isArray(result) ? result : [result]
}
const identity = row => `${row.pid}:${row.startTicks}`
async function captureOwned() {
  const all = await processTable()
  const live = new Map(all.map(row => [identity(row), row]))
  const accepted = new Map()
  for (const [key] of known) if (live.has(key)) accepted.set(key, live.get(key))
  let changed = true
  while (changed) {
    changed = false
    for (const row of all) {
      if (accepted.has(identity(row))) continue
      if ([...accepted.values()].some(parent => row.parentPid === parent.pid && BigInt(row.startTicks) >= BigInt(parent.startTicks))) {
        accepted.set(identity(row), row)
        changed = true
      }
    }
  }
  for (const [key, row] of accepted) known.set(key, row)
  writeJson('owned-processes.json', { at: new Date().toISOString(), roots: spawned.map(x => ({ role: x.role, pid: x.pid, startTicks: x.startTicks })), observed: [...known.values()], live: [...accepted.values()] })
  return [...accepted.values()]
}
function logTransform() {
  let buffer = ''
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) this.push(redact(line) + '\n')
      if (buffer.length > 1024 * 1024) { this.push(redact(buffer)); buffer = '' }
      callback()
    },
    flush(callback) { if (buffer) this.push(redact(buffer)); callback() },
  })
}
async function spawnLogged(role, command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'] })
  child.role = role
  child.closedResult = null
  child.completion = new Promise(resolve => {
    child.once('error', error => { child.closedResult = { code: null, error: redact(error.message) }; resolve(child.closedResult) })
    child.once('close', (code, signal) => { child.closedResult = { code, signal }; resolve(child.closedResult) })
  })
  child.stdout.pipe(logTransform()).pipe(fs.createWriteStream(path.join(root, `${role}.out.log`), { flags: 'a' }))
  child.stderr.pipe(logTransform()).pipe(fs.createWriteStream(path.join(root, `${role}.err.log`), { flags: 'a' }))
  spawned.push(child)
  const row = (await processTable()).find(p => p.pid === child.pid)
  if (row) {
    child.startTicks = row.startTicks
    known.set(identity(row), row)
    writeJson(`${role}.pid.json`, { pid: child.pid, startTicks: row.startTicks, at: new Date().toISOString() })
  } else {
    // A driver that fails immediately can exit before the CIM snapshot. Preserve
    // its real exit code and stderr instead of replacing them with an identity error.
    const ended = await Promise.race([child.completion, sleep(500).then(() => null)])
    if (ended) {
      append('lifecycle.jsonl', { at: new Date().toISOString(), phase, event: 'child-exited-before-identity', role, pid: child.pid, exit: ended })
      return child
    }
      throw new Error(`${role}-failed-before-identity-record`)
  }
  return child
}

async function requireFreePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', () => reject(new Error(`port-${port}-already-in-use-refusing-to-touch-existing-server`)))
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(resolve))
  })
}
async function prepareDatabase() {
  const source = new DatabaseSync(sourceDb, { readOnly: true })
  try {
    source.exec('PRAGMA busy_timeout=10000')
    await backup(source, targetDb)
  } finally { source.close() }
  const cloned = new DatabaseSync(targetDb)
  try {
    const check = cloned.prepare('PRAGMA quick_check').get()
    if (Object.values(check)[0] !== 'ok') throw new Error('database-backup-quick-check-failed')
    const columns = cloned.prepare('PRAGMA table_info(models)').all().map(x => x.name)
    const qwen = cloned.prepare('SELECT id FROM models WHERE model_id=? AND tenant_id=? AND is_enabled=1 AND deleted_at IS NULL').get('qwen3.8-flash', 'default')
    if (!qwen) {
      const proofPath = path.join(projectRoot, 'qwen-gateway-preflight.json')
      const proof = fs.existsSync(proofPath) ? JSON.parse(fs.readFileSync(proofPath, 'utf8')) : null
      const source = cloned.prepare('SELECT * FROM models WHERE model_id=? AND tenant_id=? AND is_enabled=1 AND deleted_at IS NULL').get(proof?.sourceModel, 'default')
      if (!proof?.passed || proof.model !== 'qwen3.8-flash' || !source || new URL(source.base_url).host !== proof.host) throw new Error('Qwen needs an explicit configured record or a successful same-gateway preflight')
      const record = { ...source, id: randomUUID(), model_id: 'qwen3.8-flash', provider: 'qwen', display_name: 'qwen3.8-flash', capabilities: null }
      const names = columns.filter(name => Object.hasOwn(record, name))
      cloned.prepare(`INSERT INTO models (${names.map(name => '"' + name.replaceAll('"', '""') + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(name => record[name]))
      writeJson('qwen-test-provisioning.json', { at: new Date().toISOString(), sourceReadOnly: true, destination: 'isolated run database only', modelId: record.model_id, provider: record.provider, configuredOriginMatchesProbe: true, sourceModel: proof.sourceModel })
    }
    enabledModelIds = [...new Set(cloned.prepare(`SELECT model_id FROM models WHERE is_enabled = 1${columns.includes('deleted_at') ? ' AND deleted_at IS NULL' : ''}`).all().map(row => row.model_id))]
    if (!enabledModelIds.length) throw new Error('no-enabled-model-in-database')
    // The fresh backup keeps schema + model configuration only. No copied execution,
    // approval, hooks, sessions, jobs, MCP, or user-memory rows may recover on startup.
    const tables = cloned.prepare('PRAGMA table_list').all().filter(row => row.schema === 'main' && !row.name.startsWith('sqlite_') && row.type !== 'shadow')
    const keep = new Set(['models', 'model_whitelists'])
    for (const table of tables) {
      if (/^(?:schema_migrations|migrations|_migrations|_prisma_migrations|knex_migrations(?:_lock)?|__?drizzle_migrations)$/i.test(table.name)) keep.add(table.name)
    }
    const quote = name => '"' + name.replaceAll('"', '""') + '"'
    cloned.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
    try {
      for (const table of tables) if (!keep.has(table.name) && table.type !== 'view') cloned.exec(`DELETE FROM ${quote(table.name)}`)
      cloned.exec('COMMIT')
    } catch (error) { cloned.exec('ROLLBACK'); throw error }
    cloned.exec('PRAGMA foreign_keys=ON')
    writeJson('database-preparation.json', { at: new Date().toISOString(), method: 'node:sqlite.backup', sourceReadOnly: true, walConsistent: true, quickCheck: 'ok', clearedBusinessTables: tables.filter(t => !keep.has(t.name) && t.type !== 'view').length, retained: [...keep], enabledModelIds })
  } finally { cloned.close() }
}
async function sampleHealth() {
  const begun = performance.now()
  const at = new Date().toISOString()
  const sampledPhase = phase
  let status = null
  let error = null
  try {
    const response = await fetch(`${base}/health`, { headers: instanceHeaders, signal: AbortSignal.timeout(1500), cache: 'no-store' })
    status = response.status
    await response.arrayBuffer()
  } catch (cause) { error = cause.name || 'request-error' }
  const row = { at, phase: sampledPhase, latencyMs: Math.round((performance.now() - begun) * 100) / 100, status, error }
  healthSamples.push(row)
  append('health.jsonl', row)
}
async function runHealthLoop() {
  let next = performance.now()
  while (!backgroundStop) {
    await sampleHealth()
    next += 2000
    while (next < performance.now()) next += 2000
    while (!backgroundStop && performance.now() < next) await sleep(Math.min(200, next - performance.now()))
  }
}
function summarizeHealth() {
  const groups = ['all', 'startup', 'model_preflight', 'baseline', 'active', 'finalization', 'cooldown', 'client_acceptance', 'cleanup']
  return Object.fromEntries(groups.map(group => {
    const rows = healthSamples.filter(x => group === 'all' || x.phase === group)
    const latency = rows.filter(x => x.status === 200).map(x => x.latencyMs).sort((a, b) => a - b)
    const quantile = p => latency.length ? latency[Math.min(latency.length - 1, Math.ceil(latency.length * p) - 1)] : null
    return [group, { samples: rows.length, ok: rows.filter(x => x.status === 200).length, failures: rows.filter(x => x.status !== 200).length, p50Ms: quantile(.5), p95Ms: quantile(.95), p99Ms: quantile(.99), maxMs: latency.at(-1) ?? null }]
  }))
}
async function statusSummary() {
  verifyBuildArtifacts('periodic')
  const owned = await captureOwned()
  const sessions = fs.readdirSync(root).filter(name => /^session-\d+\.json$/.test(name)).map(name => {
    try { const result = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); return { file: name, status: result.status } } catch { return { file: name, status: 'writing' } }
  })
  const row = { at: new Date().toISOString(), phase, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), root, enginePid: engine?.pid, driverPid: driver?.pid, ownedLiveProcesses: owned.length, health: summarizeHealth().all, completedSessionFiles: sessions }
  append('status.jsonl', row)
  console.log(JSON.stringify(row))
}
async function runSummaryLoop() {
  while (!backgroundStop) {
    try { await statusSummary() } catch (error) { append('orchestrator-errors.jsonl', { at: new Date().toISOString(), phase, error: redact(error.message) }) }
    for (let n = 0; n < 150 && !backgroundStop; n++) await sleep(200)
  }
}
async function cancelOwnedSessions() {
  const filename = path.join(root, 'active-start.json')
  if (!fs.existsSync(filename)) return
  let sessionIds = []
  try { const start = JSON.parse(fs.readFileSync(filename, 'utf8')); sessionIds = (start.sessions || []).map(x => x.sessionId).filter(x => typeof x === 'string') } catch { return }
  await Promise.all(sessionIds.map(async sessionId => {
    let status = null
    let code = null
    let message = null
    let ok = false
    let error = null
    try {
      const response = await fetch(`${base}/api/v1/chat/cancel`, { method: 'POST', headers: { ...instanceHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(3000) })
      status = response.status
      const envelope = await response.json()
      code = typeof envelope.code === 'number' ? envelope.code : null
      message = typeof envelope.message === 'string' ? redact(envelope.message).slice(0, 1000) : null
      ok = response.ok && code !== null && code < 40000 && envelope.success !== false
    } catch (cause) { error = redact(cause.message).slice(0, 1000) }
    append('cleanup-cancellations.jsonl', { at: new Date().toISOString(), sessionId, status, code, message, ok, error })
  }))
}
async function stopOwnedTrees() {
  try { await captureOwned() } catch {}
  const outcome = await powershell(`
$ErrorActionPreference='Stop'
$expected=ConvertFrom-Json -InputObject $env:AETHER_TEST_PROCESS_IDENTITIES
$stopped=@(); $alreadyGone=@(); $reused=@(); $errors=@()
foreach($item in ($expected | Sort-Object {[long]$_.startTicks} -Descending)) {
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$item.pid) -ErrorAction SilentlyContinue
  if(-not $current){$alreadyGone += [int]$item.pid; continue}
  if($current.CreationDate.ToUniversalTime().Ticks.ToString() -ne [string]$item.startTicks){$reused += [int]$item.pid; continue}
  try {Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop; $stopped += [int]$item.pid} catch {$errors += [pscustomobject]@{pid=[int]$item.pid;error=$_.Exception.Message}}
}
Start-Sleep -Milliseconds 700
$remaining=@();foreach($item in $expected){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$item.pid) -ErrorAction SilentlyContinue;if($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq [string]$item.startTicks){$remaining += [int]$item.pid}}
[pscustomobject]@{stopped=$stopped;alreadyGone=$alreadyGone;reusedSkipped=$reused;remaining=$remaining;errors=$errors}|ConvertTo-Json -Depth 5 -Compress
`, { AETHER_TEST_PROCESS_IDENTITIES: JSON.stringify([...known.values()]) })
  writeJson('cleanup-processes.json', { at: new Date().toISOString(), match: 'PID + Win32_Process.CreationDate ticks', ...outcome })
  return outcome
}

try {
  writeJson('test-budget.json', { at: new Date().toISOString(), ...budget })
  for (const directory of ['workspace', 'global', 'skills', 'logs', 'sessions', 'memory']) fs.mkdirSync(path.join(root, directory), { recursive: true })
  for (const filename of [sourceDb, driverFile, monitorFile, engineFile, engineNode, runtimeProbeFile, projectManifest]) if (!fs.existsSync(filename)) throw new Error(`required-file-missing:${path.relative(engineRoot, filename)}`)
  await requireFreePort()
  // Do not defeat organization-managed configuration. Refuse an incompatible setup.
  const managedFile = path.join(childEnv.PROGRAMDATA || 'C:\\ProgramData', 'Aether', 'settings.json')
  if (fs.existsSync(managedFile)) throw new Error('managed-settings-present-review-before-isolated-test')
  await prepareDatabase()
  if (!enabledModelIds.includes('qwen3.8-flash')) throw new Error('Required qwen3.8-flash is not enabled in the configured model database')
  const selectedModel = process.env.LONGRUN_OTHER_MODEL || enabledModelIds.find(id => id !== 'qwen3.8-flash')
  if (!selectedModel || !enabledModelIds.includes(selectedModel)) throw new Error('A configured second model is required for sessions 4 and 5')
  console.log(JSON.stringify({ root, projectRoot, packagedRoot, budget, enabledModelIds, models: ['qwen3.8-flash', 'qwen3.8-flash', 'qwen3.8-flash', selectedModel, selectedModel] }))
  fs.writeFileSync(path.join(root, '.instance-token'), instanceToken, { mode: 0o600 })
  fs.writeFileSync(path.join(projectRoot, 'latest-run.json'), JSON.stringify({ root, base, projectRoot, at: new Date().toISOString() }, null, 2))
  initialBuildArtifacts = captureBuildArtifacts(engineRoot, { requireNodePty: true, requireNodePtyPatch: true })
  initialPackagedArtifacts = captureBuildArtifacts(packagedRoot, { requireNodePty: true, requireNodePtyPatch: true })
  const synchronized = compareBuildArtifacts(initialBuildArtifacts, initialPackagedArtifacts)
  if (!synchronized.unchanged) throw new Error('Client packaged engine differs from the engine build')
  writeJson('two-end-build-identity.json', { at: new Date().toISOString(), sourceRoot: engineRoot, packagedRoot, source: initialBuildArtifacts, packaged: initialPackagedArtifacts, synchronized })
  let gitSha = null
  let gitDirty = null
  try {
    gitSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: engineRoot, windowsHide: true })).stdout.trim()
    gitDirty = Boolean((await execFileAsync('git', ['status', '--porcelain'], { cwd: engineRoot, windowsHide: true })).stdout.trim())
  } catch {}
  writeJson('build-identity.json', { at: new Date().toISOString(), gitSha, gitDirty, distMainSha256: initialBuildArtifacts.main.sha256, distMainModifiedAt: initialBuildArtifacts.main.modifiedAt, buildId: initialBuildArtifacts.manifest.buildId, manifestSha256: initialBuildArtifacts.manifest.sha256, sqliteProduction: initialBuildArtifacts.sqliteProduction, nodePtyProduction: initialBuildArtifacts.nodePtyProduction, artifacts: initialBuildArtifacts, node: process.version })
  try {
    const hardware = await powershell(`$c=@(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfLogicalProcessors);$o=Get-CimInstance Win32_OperatingSystem;[pscustomobject]@{cpuModels=@($c|ForEach-Object {$_.Name});logicalProcessors=($c|Measure-Object NumberOfLogicalProcessors -Sum).Sum;totalMemoryBytes=[long]$o.TotalVisibleMemorySize*1024;availableMemoryBytes=[long]$o.FreePhysicalMemory*1024}|ConvertTo-Json -Compress`)
    writeJson('hardware-baseline.json', { at: new Date().toISOString(), ...hardware, resourceMetricScope: 'engine process tree sum; not whole-machine CPU or memory use' })
  } catch { writeJson('hardware-baseline.json', { at: new Date().toISOString(), status: 'unavailable' }) }
  const env = {
    ...childEnv, PORT: String(port), HOST: '127.0.0.1', AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: instanceToken,
    DATA_DIR: targetDb, KNOWLEDGE_DATA_DIR: path.join(root, 'knowledge.db'),
    WORKSPACE_ROOT: projectRoot, AETHER_GLOBAL_DIR: path.join(root, 'global'),
    SKILLS_ROOT: path.join(root, 'skills'), MCP_CONFIG_PATH: path.join(root, 'mcp.json'),
    QA_LOG_DIR: path.join(root, 'logs'), ENABLE_LONG_TERM_MEMORY: 'true', DEFAULT_SECURITY_MODE: 'standard',
    DISABLE_TELEMETRY: 'true', HISTORY_BACKEND: 'jsonl', MAX_ITERATIONS: '96', LLM_FALLBACK_MODEL: '',
    PRESSURE_RUNTIME_METRICS_FILE: path.join(root, 'runtime.jsonl'),
  }
  fs.writeFileSync(path.join(root, 'mcp.json'), '{"mcpServers":{}}\n')
  mark('startup')
  engine = await spawnLogged('engine', engineNode, ['--import', pathToFileURL(runtimeProbeFile).href, engineFile], env, root)
  healthLoop = runHealthLoop()
  const readyUntil = Date.now() + 60_000
  while (!healthSamples.some(x => x.status === 200)) {
    if (Date.now() >= readyUntil) throw new Error('engine-health-startup-timeout')
    await guardedSleep(250)
  }
  const authProbe = await fetch(`${base}/api/v1/models`, { headers: instanceHeaders, signal: AbortSignal.timeout(5000) })
  if (authProbe.status !== 200) throw new Error(`isolated-instance-model-auth-probe-http-${authProbe.status}`)
  await authProbe.arrayBuffer()
  const modeProbe = await fetch(`${base}/api/v1/security/mode?sessionId=pressure-config-check`, { headers: instanceHeaders, signal: AbortSignal.timeout(5000) })
  if (modeProbe.status !== 200) throw new Error(`isolated-instance-mode-probe-http-${modeProbe.status}`)
  const modeBody = await modeProbe.json()
  if (modeBody?.data?.mode !== 'standard') throw new Error('isolated-instance-security-mode-is-not-standard')
  writeJson('instance-preflight.json', { at: new Date().toISOString(), modelsHttpStatus: authProbe.status, modeHttpStatus: modeProbe.status, mode: 'standard', instanceTokenEnabled: true })
  mark('model_preflight')
  const modelPreflight = await spawnLogged('model-preflight', process.execPath, [path.join(toolsRoot, 'model-agent-preflight.mjs')], { ...env, LONGRUN_BASE: base, LONGRUN_RUN_ROOT: root, LONGRUN_OTHER_MODEL: selectedModel, LONGRUN_TOKEN: instanceToken }, engineRoot)
  const modelPreflightExit = await modelPreflight.completion
  if (modelPreflightExit.code !== 0) throw new Error('Real model/tool parameter preflight failed; formal shared-project load was not started')
  monitor = await spawnLogged('monitor', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', monitorFile, '-EnginePid', String(engine.pid), '-OutputPath', path.join(root, 'monitor.jsonl'), '-StopPath', stopFile, '-MaxMinutes', String(Math.ceil(totalDeadlineMs / 60000))], process.env, engineRoot)
  const monitorReady = await awaitMonitorReadiness({ file: path.join(root, 'monitor.jsonl'), enginePid: engine.pid, monitor, guardedWait: guardedSleep })
  writeJson('monitor-readiness.json', { at: new Date().toISOString(), ...monitorReady })
  summaryLoop = runSummaryLoop()
  mark('baseline', { durationSeconds: 10 })
  await guardedSleep(10_000)
  mark('active')
  driver = await spawnLogged('driver', process.execPath, [driverFile], { ...env, LONGRUN_BASE: base, LONGRUN_RUN_ROOT: root, LONGRUN_PROJECT_ROOT: projectRoot, LONGRUN_MANIFEST: projectManifest, LONGRUN_OTHER_MODEL: selectedModel, LONGRUN_MAX_MS: String(driverDeadlineMs), LONGRUN_STAGE_TIMEOUT_MS: String(budget.stageTimeoutMs), LONGRUN_TOKEN: instanceToken }, engineRoot)
  const driverUntil = Date.now() + driverDeadlineMs
  driverFinalization = await awaitDriverFinalization({driver,workloadUntil:driverUntil,graceMs:budget.finalizationGraceMs,
    onGrace:details=>mark('finalization',details),
    guardedWait:async ms=>{if(monitor.closedResult)throw new Error('resource-monitor-ended-early');await guardedSleep(ms)},
  })
  writeJson('driver-finalization.json',driverFinalization)
  mark('cooldown', { durationSeconds: 15, driverExit: driver.closedResult })
  await guardedSleep(15_000)
  if (process.env.LONGRUN_WAIT_CLIENT === '1') {
    mark('client_acceptance', { maximumMs: 10 * 60000 })
    const until = Date.now() + 10 * 60000
    while (!fs.existsSync(path.join(root, 'client-acceptance.json'))) {
      if (Date.now() > until) throw new Error('Client acceptance did not finish before deadline')
      await guardedSleep(500)
    }
    const clientAcceptance = JSON.parse(fs.readFileSync(path.join(root, 'client-acceptance.json'), 'utf8'))
    if (!clientAcceptance.passed) throw new Error('Client acceptance failed')
  }
  finalCode = driver.closedResult.code === 0 ? 0 : 2
} catch (error) {
  append('orchestrator-errors.jsonl', { at: new Date().toISOString(), phase, error: redact(error.message) })
  finalCode = 2
} finally {
  clearTimeout(deadlineTimer)
  mark('cleanup', { abortReason })
  // Record live descendants before engine/driver shutdown can reparent them.
  try { await captureOwned() } catch {}
  await cancelOwnedSessions().catch(() => {})
  fs.writeFileSync(stopFile, new Date().toISOString())
  if (monitor && !monitor.closedResult) await Promise.race([monitor.completion, sleep(3000)])
  let cleanup = null
  try { cleanup = await stopOwnedTrees() } catch (error) { append('orchestrator-errors.jsonl', { at: new Date().toISOString(), phase, error: redact(error.message) }); finalCode = 2 }
  if (cleanup?.remaining?.length) finalCode = 2
  backgroundStop = true
  await Promise.allSettled([healthLoop, summaryLoop].filter(Boolean))
  const finalBuildCheck = verifyBuildArtifacts('final')
  const buildArtifactEvidence = { scope: 'dist/main.js + dist/runtime/build-manifest.json + recursive dist/storage/sqlite production .js + node_modules/node-pty package.json, production .js/.mjs/.cjs/.node/.dll and .aether-node-pty-patch.json verified receipt; excludes tests, fixtures, maps and declarations from production fingerprint, but patch guard verifies its declared typings target', nodePtyCoverage: Boolean(initialBuildArtifacts?.nodePtyProduction?.present && initialPackagedArtifacts?.nodePtyProduction?.present), nodePtyPatchCoverage: Boolean(initialBuildArtifacts?.nodePtyProduction?.patchReceipt?.valid && initialPackagedArtifacts?.nodePtyProduction?.patchReceipt?.valid), initialCaptured: Boolean(initialBuildArtifacts), checkedAt: new Date().toISOString(), periodicCheckCount: buildArtifactObservations.filter(item => item.stage === 'periodic').length, finalCheck: finalBuildCheck, unchangedThroughoutObservedChecks: Boolean(initialBuildArtifacts && finalBuildCheck?.unchanged && !buildArtifactVerificationFailed), detectedChangeCount: buildArtifactObservations.filter(item => !item.unchanged).length, limitation: 'Start, approximately 30-second sampling, and final hashes detect observed content changes; changes fully reverted between samples are not proven absent.' }
  if (!buildArtifactEvidence.unchangedThroughoutObservedChecks) finalCode = 2
  writeJson('build-artifact-evidence.json', buildArtifactEvidence)
  const healthSummary = summarizeHealth()
  const healthAcceptance = {
    passed: healthSummary.active.samples > 0 && healthSamples.every(sample =>
      ['startup', 'cleanup'].includes(sample.phase) || (sample.status === 200 && !sample.error)),
    timeoutMs: 1500,
    acceptedPhases: ['model_preflight', 'baseline', 'active', 'finalization', 'cooldown', 'client_acceptance'],
    startupAndCleanupExcluded: true,
  }
  if (!healthAcceptance.passed) finalCode = 2
  writeJson('health-summary.json', healthSummary)
  writeJson('health-acceptance.json', healthAcceptance)
  writeJson('orchestrator-result.json', { finishedAt: new Date().toISOString(), root, budget, exitCode: finalCode, driverExit: driver?.closedResult ?? null, driverFinalization, engineExit: engine?.closedResult ?? null, monitorExit: monitor?.closedResult ?? null, elapsedMs: Date.now() - startedAt, report: path.join(root, 'active-report.json'), cleanupConfirmed: Boolean(cleanup && !cleanup.remaining?.length), enabledModelIds, abortReason, evidence: { buildArtifacts: buildArtifactEvidence } })
  console.log(JSON.stringify({ finished: true, root, exitCode: finalCode, cleanupConfirmed: Boolean(cleanup && !cleanup.remaining?.length), report: path.join(root, 'active-report.json') }))
  process.exitCode = finalCode
}

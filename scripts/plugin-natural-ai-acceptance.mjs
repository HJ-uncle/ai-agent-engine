/**
 * Opt-in natural-language authoring acceptance. No plugin protocol, source, schema,
 * tool order or output field names are supplied to the model by this driver.
 * Review: node --check scripts/plugin-natural-ai-acceptance.mjs
 * Run only after coordinating desktop/Electron access:
 * node scripts/plugin-natural-ai-acceptance.mjs --run
 * node scripts/plugin-natural-ai-acceptance.mjs --run --currency
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildManifestPath = join(engineRoot, 'dist/runtime/build-manifest.json')
const electron = resolve(process.env.PLUGIN_ELECTRON_EXECUTABLE || join(engineRoot, '../aether-code/node_modules/electron/dist/electron.exe'))
const modelId = process.env.PLUGIN_ACCEPTANCE_MODEL || 'deepseek-v4.1-flash-1017'
const sourceProfile = process.env.PLUGIN_ACCEPTANCE_SOURCE_PROFILE || join(process.env.APPDATA || '', 'Aether Code')
const parent = resolve(process.env.PLUGIN_ACCEPTANCE_ROOT || join(engineRoot, '.tmp/plugin-acceptance'))
const runTag = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
const currencyScenario = process.argv.includes('--currency')
const root = join(parent, (currencyScenario ? 'natural-ai-currency-electron-' : 'natural-ai-electron-') + runTag)
const workspace = join(root, 'workspace'), sessionId = 'natural-plugin-author-' + runTag
const secrets = [], instanceToken = randomBytes(32).toString('hex')
secrets.push(instanceToken)
const report = {
  root, modelId, scenario: currencyScenario ? 'currency' : 'time', startedAt: new Date().toISOString(), status: 'not-started',
  promptPolicy: 'Only ordinary user requirements. No injected protocol/source/schema/tool sequence or driver repair prompts.',
  approvals: [], authoring: {}, businessCases: [], productionPluginWrites: false,
}
const requirement = currencyScenario ? '请帮我创建一个自定义插件：做一个可操作的货币换算器'
  : '请帮我创建并发布一个“时间助手”插件：支持把 1h30m 这样的时长表达式换算成秒，并计算两个 ISO 8601 时间之间相差多少秒（结束时间减开始时间，保留正负）。做好测试，完成后告诉我使用方式。'
const overallController = new AbortController(), overallLimitMs = 18 * 60_000
let overallTimer, credentialProcess, engine, engineStartedAt, engineClosed, base, managerTools, pluginId, latestAuthoringSnapshot
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
function boundedSignal(timeout) { return AbortSignal.any([overallController.signal, AbortSignal.timeout(timeout)]) }
function checkDeadline() { overallController.signal.throwIfAborted() }
function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text
}
function save(file, value) { writeFileSync(join(root, file), redact(value), 'utf8') }
function progress(value) { console.log('[natural-plugin-ai] ' + redact(value)) }
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ENCRYPTION_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|^DATA_DIR$|^PORT$|^HOST$/i.test(key)))
}
async function credential() {
  const sourceDb = new DatabaseSync(join(sourceProfile, 'engine/state/agent.db'), { readOnly: true })
  let row
  try { row = sourceDb.prepare('SELECT model_id,provider,api_key,base_url,api_format,capabilities FROM models WHERE model_id=? AND is_enabled=1 AND deleted_at IS NULL').get(modelId) }
  finally { sourceDb.close() }
  assert(row, 'Configured enabled model unavailable')
  const keyRecord = JSON.parse(readFileSync(join(sourceProfile, 'engine/secrets/engine-secrets.json'), 'utf8'))
  const localState = JSON.parse(readFileSync(join(sourceProfile, 'Local State'), 'utf8'))
  const profile = join(root, 'credential-profile'), testKey = randomBytes(32).toString('hex')
  secrets.push(testKey, row.api_key)
  mkdirSync(profile)
  // The encrypted OS-key record is copied into a new profile; the live profile stays read-only.
  writeFileSync(join(profile, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }), { mode: 0o600, flag: 'wx' })
  const result = await new Promise((resolveCredential, reject) => {
    const child = spawn(electron, [join(engineRoot, 'scripts/plugin-acceptance-credentials.cjs')], {
      env: { ...cleanEnv(), PLUGIN_CREDENTIAL_PROFILE: profile, PLUGIN_CREDENTIAL_INPUT: JSON.stringify({ keyRecord, encryptedApiKey: row.api_key, testKey }) },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', stderr = ''
    const startedAt = Date.now()
    credentialProcess = { child, startedAt }
    const deadline = setTimeout(() => {
      reject(new Error('Read-only credential bridge exceeded deadline'))
    }, 30_000)
    const abort = () => reject(overallController.signal.reason)
    overallController.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
    child.once('error', error => { clearTimeout(deadline); overallController.signal.removeEventListener('abort', abort); reject(error) })
    child.once('close', code => {
      clearTimeout(deadline)
      overallController.signal.removeEventListener('abort', abort)
      credentialProcess = undefined
      if (code !== 0) return reject(new Error('Read-only model credential bridge failed: ' + stderr))
      const line = output.split('\n').find(item => item.startsWith('PLUGIN_CREDENTIAL_RESULT:'))
      if (!line) return reject(new Error('Read-only credential bridge returned no result'))
      try { resolveCredential(JSON.parse(line.slice('PLUGIN_CREDENTIAL_RESULT:'.length))) }
      catch { reject(new Error('Read-only credential bridge returned invalid result JSON')) }
    })
  })
  secrets.push(result.apiKey)
  save('isolated-engine-key.encrypted.json', { encrypted: true, encryptionKey: result.encryptedTestKey })
  return { key: testKey, model: { modelId: row.model_id, provider: row.provider, apiKey: result.apiKey,
    baseUrl: row.base_url, apiFormat: row.api_format, ...(row.capabilities ? { capabilities: JSON.parse(row.capabilities) } : {}) } }
}
async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const port = server.address().port
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}
function headers() { return { 'content-type': 'application/json', 'x-aether-tool-profile': 'general', 'x-aether-instance-token': instanceToken } }
async function api(method, route, body) {
  checkDeadline()
  const response = await fetch(base + route, { method, headers: headers(), signal: boundedSignal(180_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  if (value.code !== 200) throw Object.assign(new Error(redact(method + ' ' + route + ': ' + value.message)), { responseCode: value.code })
  return value.data
}
async function startEngine(config) {
  const port = await freePort()
  base = 'http://127.0.0.1:' + port + '/api/v1'
  const entry = join(root, 'engine-host.mjs')
  writeFileSync(entry, [
    "process.on('message',message=>{if(message?.command==='shutdown')process.emit('SIGTERM')});",
    "process.send?.({kind:'natural-plugin-runtime',runtime:{execPath:process.execPath,electron:process.versions.electron,node:process.versions.node,asNode:process.env.ELECTRON_RUN_AS_NODE}});",
    'await import(' + JSON.stringify(pathToFileURL(join(engineRoot, 'dist/main.js')).href) + ');',
  ].join('\n'), { flag: 'wx' })
  const env = { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1', DATA_DIR: join(root, 'state/agent.db'), MEMORY_DB_PATH: join(root, 'state/memory.db'),
    WORKSPACE_ROOT: workspace, AETHER_GLOBAL_DIR: join(root, 'global'), SKILLS_ROOT: join(root, 'skills'), MCP_CONFIG_PATH: join(root, 'mcp.json'),
    ENCRYPTION_KEY: config.key, AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: instanceToken, AETHER_DESKTOP_OWNED: '1',
    AETHER_ENGINE_HOST: '127.0.0.1', AETHER_ENGINE_PORT: String(port), DEFAULT_SECURITY_MODE: 'standard',
    HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', ENABLE_LONG_TERM_MEMORY: 'false', MAX_ITERATIONS: '40', LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false',
    LLM_PRIMARY_MODEL: modelId, LLM_MODEL: modelId, LLM_PROVIDER: config.model.provider, LLM_FALLBACK_MODEL: '' }
  engineStartedAt = Date.now()
  engine = spawn(electron, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  engineClosed = new Promise(resolveClose => engine.once('close', (code, signal) => resolveClose({ code, signal })))
  engine.on('message', message => { if (message?.kind === 'natural-plugin-runtime') report.engineRuntime = message.runtime })
  engine.once('error', error => { report.engineStartupError = error.message })
  let log = ''
  for (const stream of [engine.stdout, engine.stderr]) stream.on('data', chunk => {
    log = (log + redact(chunk.toString())).slice(-400_000); save('engine.log', log)
  })
  for (let attempt = 0; attempt < 90; attempt++) {
    checkDeadline()
    if (engine.exitCode !== null || engine.signalCode !== null) throw new Error('Isolated Electron engine exited; inspect engine.log')
    try { await api('GET', '/plugins'); break }
    catch (error) { checkDeadline(); if (attempt === 89) throw error; await delay(1000) }
  }
  assert(report.engineRuntime?.electron, 'Engine must actually be hosted by Electron')
  assert.equal(report.engineRuntime.asNode, '1')
  assert.equal(resolve(report.engineRuntime.execPath).toLowerCase(), electron.toLowerCase())
  assert.equal((await api('GET', '/plugins')).plugins.length, 0, 'Isolated engine must begin with zero plugins')
  const catalogue = await api('GET', '/toolkits')
  managerTools = catalogue.toolkits.find(toolkit => toolkit.id === 'plugin-management')?.toolNames
  assert(managerTools?.includes('plugin_get_template'), 'This build must expose standard template discovery')
  await api('POST', '/models', config.model)
}
async function chat(id, fields, label, toolkits = ['plugin-management'], allowedTools = managerTools) {
  checkDeadline()
  const response = await fetch(base + '/chat', { method: 'POST', headers: headers(), signal: boundedSignal(600_000),
    body: JSON.stringify({ sessionId: id, model: modelId, thinkingMode: false, toolkits, allowedTools,
      workspacePaths: [workspace], memoryScope: 'off', skills: [], mcpServers: [], ...fields }) })
  const text = await response.text()
  save(label + '.sse.txt', text)
  if (!text.includes('data:')) throw new Error(redact(text.slice(0, 600)))
  const snapshot = await api('GET', '/chat/snapshot?sessionId=' + encodeURIComponent(id))
  save(label + '.snapshot.json', snapshot)
  return snapshot
}
const runOf = snapshot => snapshot.executionRun ?? snapshot.run ?? snapshot.runs?.at(-1)
async function author() {
  let snapshot = await chat(sessionId, { message: requirement }, 'author-initial')
  latestAuthoringSnapshot = snapshot
  for (let index = 0; index < 30; index++) {
    checkDeadline()
    const run = runOf(snapshot)
    if (run?.status !== 'waiting') {
      assert.equal(run?.status, 'succeeded', 'Natural authoring did not finish')
      return snapshot
    }
    const pending = run.pending?.find(item => item.status !== 'answered')
    assert(pending, 'Waiting run has no answerable operation')
    assert(['plugin_create', 'plugin_update', 'plugin_test', 'plugin_publish'].includes(pending.toolName), 'Unexpected mutation/interaction in natural authoring')
    const operation = pending.pendingAction?.operation
    assert.equal(operation?.tenantId, 'default')
    const target = operation.input?.id ?? operation.input?.manifest?.id
    assert(typeof target === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(target), 'Invalid approval target')
    if (!pluginId) {
      assert.equal(pending.toolName, 'plugin_create', 'First mutation must create the isolated plugin')
      pluginId = target
    }
    assert.equal(target, pluginId, 'Only the one newly created isolated plugin may be approved')
    save('approval-' + index + '.json', pending)
    report.approvals.push({ index, tool: pending.toolName, pluginId, runId: run.runId,
      toolCallId: pending.toolCallId, batchCases: operation.input?.cases?.length ?? 0 })
    save('report.json', report)
    snapshot = await chat(sessionId, { message: '', toolResponse: { runId: run.runId, requestId: pending.requestId,
      toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' } }, 'author-resume-' + index)
    latestAuthoringSnapshot = snapshot
  }
  throw new Error('Natural authoring approval limit exceeded')
}
function parsed(content) { try { return typeof content === 'string' ? JSON.parse(content) : content } catch { return undefined } }
function traces(snapshot) {
  const history = snapshot.history ?? [], requests = []
  for (const message of history) for (const call of [message.toolCall, ...(message.toolCalls ?? [])].filter(Boolean)) {
    if (requests.some(item => item.id === call.id)) continue
    const results = history.filter(item => item.role === 'tool' && item.toolCallId === call.id)
    const result = results.at(-1)
    requests.push({ id: call.id, name: call.name, args: call.args, createdAt: message.createdAt,
      status: result?.metadata?.status ?? 'missing', success: result?.metadata?.success === true,
      output: parsed(result?.content), resultText: result?.content, resultCreatedAt: result?.createdAt })
  }
  return requests
}
function auditAuthoring(snapshot, requireComplete = true) {
  const calls = traces(snapshot), templates = calls.filter(call => call.name === 'plugin_get_template')
  const tests = calls.filter(call => call.name === 'plugin_test')
  const successfulBatch = tests.filter(call => call.success && Array.isArray(call.args?.cases) && call.args.cases.length >= 2 &&
    call.output?.failed === 0 && call.output.total === call.args.cases.length && call.output.cases?.every(example => example.passed === true))
  const firstTemplate = templates.find(call => call.success && call.args?.id)
  const creation = calls.find(call => call.name === 'plugin_create' && call.success)
  const publication = calls.filter(call => call.name === 'plugin_publish' && call.success).at(-1)
  const templateId = creation?.args?.templateId
  const discovery = templates.find(call => call.success && Array.isArray(call.output?.templates) &&
    (templateId ? call.output.templates.some(template => template.id === templateId) : true))
  const hostTemplateCreation = typeof templateId === 'string'
  const templateBeforeCreate = Boolean(creation && firstTemplate && firstTemplate.createdAt <= creation.createdAt)
  const discoveryBeforeCreate = Boolean(creation && discovery && discovery.createdAt <= creation.createdAt)
  const batchBeforePublish = Boolean(publication && successfulBatch.some(call => call.resultCreatedAt <= publication.createdAt))
  const assertedBatches = successfulBatch.filter(call => call.args.cases.every(example => Object.hasOwn(example, 'expected')))
  const assertedBatchBeforePublish = Boolean(publication && assertedBatches.some(call => call.resultCreatedAt <= publication.createdAt))
  report.authoring = {
    pluginId, tools: calls.map(call => ({ id: call.id, name: call.name, status: call.status, success: call.success })),
    templateCalls: templates.map(call => ({ id: call.id, requestedTemplate: call.args?.id ?? null, status: call.status, success: call.success })),
    tests: tests.map(call => ({ id: call.id, revision: call.args?.revision, requestedCases: call.args?.cases ?? [{ tool: call.args?.tool, args: call.args?.args }],
      businessAssertions: (call.args?.cases ?? [{ tool: call.args?.tool, args: call.args?.args }]).filter(example => Object.hasOwn(example, 'expected')).length,
      status: call.status, success: call.success, output: call.output ?? call.resultText })),
    requestedTestCalls: tests.length, successfulTestCalls: tests.filter(call => call.success).length,
    creationAttempts: calls.filter(call => call.name === 'plugin_create').length,
    creationFailureCount: calls.filter(call => call.name === 'plugin_create' && !call.success).length,
    creationFailures: calls.filter(call => call.name === 'plugin_create' && !call.success).map(call => ({ id: call.id, status: call.status, error: call.output ?? call.resultText })),
    creations: calls.filter(call => call.name === 'plugin_create').map(call => ({ id: call.id,
      templateId: call.args?.templateId ?? null, requestedId: call.args?.id ?? call.args?.manifest?.id ?? null,
      suppliedSourceFiles: Object.keys(call.args?.files ?? {}), status: call.status, success: call.success })),
    interruptedTestCalls: tests.filter(call => call.status === 'interrupted').length,
    missingTestResults: tests.filter(call => call.status === 'missing').length,
    successfulBatches: successfulBatch.length,
    successfulAssertedBatches: assertedBatches.length,
    templateDiscovery: discoveryBeforeCreate ? 'covered' : discovery ? 'after-creation' : 'missing',
    templateDetailRetrieval: templateBeforeCreate ? 'covered' : firstTemplate ? 'after-creation' : 'missing',
    hostTemplateCreation: hostTemplateCreation ? { templateId, suppliedSourceFiles: Object.keys(creation.args?.files ?? {}) } : null,
    templateCoverage: hostTemplateCreation ? 'host-instantiated' : templateBeforeCreate ? 'covered' : firstTemplate ? 'retrieved-after-creation' : templates.length ? 'failed' : 'missing',
    batchCoverage: assertedBatchBeforePublish ? 'covered' : batchBeforePublish ? 'execution-only' : successfulBatch.length ? 'passed-after-publication' : tests.some(call => Array.isArray(call.args?.cases)) ? 'failed' : 'missing',
  }
  save('authoring-trace.json', calls)
  save('report.json', report)
  if (requireComplete) {
    assert(creation, 'Model did not create the plugin')
    assert(tests.some(call => call.success), 'Model did not complete a successful plugin test')
    assert(publication, 'Model did not publish the plugin')
  }
  progress({ authoringCoverage: { template: report.authoring.templateCoverage, batch: report.authoring.batchCoverage } })
}
async function auditTemplateReuse(plugin, snapshot) {
  const creation = traces(snapshot).find(call => call.name === 'plugin_create' && call.success)
  if (typeof creation?.args?.templateId !== 'string') return
  const { template } = await api('GET', '/plugins/project/templates/' + encodeURIComponent(creation.args.templateId))
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const files = Object.entries(template.files).map(([path, source]) => ({ path, templateSha256: sha256(source),
    authoredSha256: plugin.files[path] === undefined ? null : sha256(plugin.files[path]), identical: source === plugin.files[path] }))
  report.templateReuse = { templateId: template.id, referenceBuildId: report.engineBuild.buildId,
    suppliedSourceFiles: Object.keys(creation.args.files ?? {}), files,
    algorithmSourceUnmodified: files.find(file => file.path === 'main.mjs')?.identical === true,
    runtimeFilesUnmodified: files.filter(file => !['aether-plugin.json', 'package.json', 'README.md'].includes(file.path)).every(file => file.identical),
    metadataFiles: ['aether-plugin.json', 'package.json', 'README.md'],
  }
  save('template-reference.json', template); save('template-reuse-review.json', report.templateReuse); save('report.json', report)
}
function values(value) {
  if (value && typeof value === 'object') return Object.values(value).flatMap(values)
  return [value]
}
function hasDate(args, timestamp) {
  return values(args).some(value => typeof value === 'string' && Date.parse(value) === timestamp ||
    typeof value === 'number' && (value === timestamp || value * 1000 === timestamp))
}
function assertSeconds(result, expected, spec, requiredPath) {
  const candidates = []
  const semanticSeconds = /seconds?|秒/i.test(spec.description + ' ' + spec.name)
  function visit(value, keys = []) {
    const label = keys.join('.')
    const explicitSeconds = /(?:seconds?|secs?|秒)/i.test(label) && !/(?:milli|毫秒|micro|nano)/i.test(label)
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (!keys.length || explicitSeconds || semanticSeconds && !/(?:milli|毫秒|minutes?|hours?|days?|分钟|小时|天)/i.test(label))
        candidates.push({ path: label || '(scalar)', keys, value })
    } else if (typeof value === 'string' && /^-?\d+(?:\.\d+)?\s*(?:s|seconds?|秒)?$/i.test(value.trim())) {
      if (!keys.length || explicitSeconds || semanticSeconds) candidates.push({ path: label || '(scalar)', keys, value: Number(value.replace(/[^\d.+-]/g, '')) })
    } else if (value && typeof value === 'object' && keys.length < 16) {
      Object.entries(value).slice(0, 1000).forEach(([key, child]) => visit(child, [...keys, key]))
    }
  }
  visit(result)
  const matched = candidates.find(candidate => (requiredPath === undefined || JSON.stringify(candidate.keys) === JSON.stringify(requiredPath)) && Math.abs(candidate.value - expected) < 1e-9)
  assert(matched, 'No correctly labeled seconds result matches independent oracle ' + expected + '; candidates=' + JSON.stringify(candidates))
  return matched
}
function mapValues(value, replace) {
  if (Array.isArray(value)) return value.map(item => mapValues(item, replace))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapValues(child, replace)]))
  return replace(value)
}
async function naturalUse(plugin, label, message, expectation, inputCheck, assertResult = assertSeconds) {
  const selection = 'plugin-' + plugin.id + '--r' + plugin.publishedRevision
  const names = plugin.manifest.tools.map(tool => 'plugin_' + plugin.id.replace(/-/g, '_') + '_' + tool.name)
  const snapshot = await chat('natural-use-' + label + '-' + runTag, { message }, 'use-' + label, [selection], names)
  assert.equal(runOf(snapshot)?.status, 'succeeded')
  const invoked = traces(snapshot).filter(call => names.includes(call.name) && call.success)
  assert(invoked.length, 'The model did not actually invoke the selected plugin for ' + label)
  const actual = invoked.find(call => inputCheck(call.args))
  assert(actual, 'The selected tool did not receive the original business inputs for ' + label)
  const localName = actual.name.slice(('plugin_' + plugin.id.replace(/-/g, '_') + '_').length)
  const spec = plugin.manifest.tools.find(tool => tool.name === localName)
  assert(spec, 'Invocation does not correspond to the published manifest')
  assert(actual.output && Object.hasOwn(actual.output, 'result'), 'Invocation returned no business result')
  const matched = assertResult(actual.output.result, expectation, spec)
  report.businessCases.push({ kind: 'natural-ai-selected-invocation', label, message, tool: localName, args: actual.args,
    ...(currencyScenario ? { independentExpectedAmount: expectation, currency: 'CNY' } : { independentExpectedSeconds: expectation }), matched, result: actual.output.result, status: 'passed' })
  save('report.json', report)
  return { args: actual.args, spec, resultPath: matched.keys }
}
async function directCase(plugin, source, label, args, expected) {
  const output = await api('POST', '/plugins/' + plugin.id + '/test', { revision: plugin.publishedRevision, tool: source.spec.name, args })
  const matched = assertSeconds(output.result, expected, source.spec, source.resultPath)
  report.businessCases.push({ kind: 'independent-heldout-host-execution', label, tool: source.spec.name, args,
    independentExpectedSeconds: expected, matched, result: output.result, status: 'passed' })
  save('report.json', report)
}

function numericBusinessValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  // A displayed amount is acceptable. An equation containing inputs and rates is not a result field.
  const match = value.trim().match(/^(?:(?:CNY|人民币|¥|￥)\s*)?(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:CNY|人民币|元)?$/i)
  return match ? Number(match[1].replace(/,/g, '')) : undefined
}
function assertCurrencyAmount(result, expected, _spec, requiredPath) {
  const candidates = []
  function visit(value, keys = []) {
    const label = keys.join('.')
    if (/(?:input|request|args|rate|quote|inverse|precision|decimal|fee|sourceAmount|originalAmount)/i.test(label)) return
    const amount = numericBusinessValue(value)
    if (amount !== undefined) candidates.push({ path: label || '(scalar)', keys, value: amount })
    else if (value && typeof value === 'object' && keys.length < 16) Object.entries(value).slice(0, 1000).forEach(([key, child]) => visit(child, [...keys, key]))
  }
  visit(result)
  const matched = candidates.find(candidate => (requiredPath === undefined || JSON.stringify(candidate.keys) === JSON.stringify(requiredPath)) && Math.abs(candidate.value - expected) < 1e-8)
  assert(matched, 'No business amount field matches independent oracle ' + expected + ' CNY; candidates=' + JSON.stringify(candidates))
  return matched
}
function hasNumber(args, expected) {
  return values(args).some(value => typeof value === 'number' && value === expected || typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) && Number(value) === expected)
}
function replaceNumber(value, from, to) {
  if (typeof value === 'number' && value === from) return to
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) && Number(value) === from) return String(to)
  return value
}
function currencyUiStatements(statements) {
  return {
    saysOnlyChatOperation: statements.some(line => !/(?:不是只能|并非只能|不只|不仅)/.test(line) && /(?:只能|仅能|只支持|仅支持|仅可)[^。\n]{0,40}(?:聊天|对话)/.test(line)),
    mentionsNativeApplication: statements.some(line => /(?:插件列表|打开使用|操作页|表单|运行页面)/.test(line)),
    authorCustomUIUnsupported: statements.some(line => /(?:不支持|不能)[^。\n]{0,30}(?:作者|自定义)[^。\n]{0,50}(?:HTML|React|页面|UI)/i.test(line)),
  }
}
function auditCurrencyDelivery(snapshot, plugin) {
  const text = (snapshot.history ?? []).filter(message => message.role === 'assistant').map(message => typeof message.content === 'string' ? message.content : '').join('\n')
  const statements = text.split(/\n|[。！？]/).map(line => line.trim()).filter(line => /(?:页面|界面|操作页|表单|UI|实时|汇率|快照|示例)/i.test(line)).slice(-50)
  const source = Object.entries(plugin.files ?? {}).filter(([name]) => /\.(?:mjs|js|json|md)$/.test(name))
  const runtimeSource = source.filter(([name]) => /\.(?:mjs|js|json)$/.test(name) && !/^(?:scripts\/|examples\/|aether-plugin\.json$|package\.json$)/.test(name))
  const embedded = runtimeSource.flatMap(([name, content]) => [...content.matchAll(/(?:["']?\b(?:USD|CNY|EUR|JPY|GBP|HKD)["']?\s*:\s*\d+(?:\.\d+)?|(?:perUsd|ratePerUsd)\s*:\s*\d+(?:\.\d+)?)/g)].slice(0, 40).map(match => ({ file: name, excerpt: content.slice(Math.max(0, match.index - 80), match.index + match[0].length + 100) })))
  const provenanceDeclarations = source.flatMap(([name, content]) => content.split('\n').filter(line => /(?:https?:\/\/|示例|参考|非实时|来源|实时|snapshot|as.?of|sample|reference)/i.test(line)).slice(0, 30).map(line => ({ file: name, line: line.slice(0, 800) }))).slice(0, 100)
  const calls = traces(snapshot)
  report.currencyDelivery = {
    userFacingStatements: statements,
    ...currencyUiStatements(statements),
    rateProvenance: {
      embeddedRateEvidence: embedded,
      declarations: provenanceDeclarations,
      externalRateRetrievalToolCalls: calls.filter(call => /(?:search|browse|fetch|http|web)/i.test(call.name)).map(call => ({ name: call.name, success: call.success })),
      classification: embedded.length ? 'embedded-rate-values-require-source-review' : 'no-hardcoded-rate-table-detected',
      sourceReviewRequired: true,
      limitation: 'Static evidence is recorded for source review. No live-rate accuracy or source authenticity is inferred from a URL or model claim.',
    },
  }
  save('currency-delivery-audit.json', report.currencyDelivery)
  save('report.json', report)
}
async function currencyBusiness(plugin, authored) {
  auditCurrencyDelivery(authored, plugin)
  const source = await naturalUse(plugin, 'currency', '按我提供的汇率 1 USD = 7.28 CNY，将 100 美元换成人民币，使用插件实际执行。', 728,
    args => hasNumber(args, 100) && hasNumber(args, 7.28) && /(?:^|[^a-z])USD(?:[^a-z]|$)/i.test(JSON.stringify(args)) && /(?:^|[^a-z])CNY(?:[^a-z]|$)/i.test(JSON.stringify(args)), assertCurrencyAmount)
  const { application } = await api('GET', '/plugins/runtime/apps/' + plugin.id + '?revision=' + plugin.publishedRevision)
  assert.equal(application.id, plugin.id); assert.equal(application.revision, plugin.publishedRevision)
  assert.equal(application.hash, report.plugin.hash); assert.equal(application.execution.allowed, true)
  assert(!Object.hasOwn(application, 'files') && !Object.hasOwn(application, 'directory'), 'Application metadata must not expose plugin source or host directory')
  assert(application.manifest.tools.some(tool => tool.name === source.spec.name), 'Application must expose the tool actually selected by the model')
  report.application = { id: application.id, revision: application.revision, hash: application.hash, execution: application.execution,
    tools: application.manifest.tools.map(tool => tool.name), exampleCount: application.examples?.length ?? 0 }
  save('application.json', application)
  const cases = [
    { label: 'published application matches real AI invocation', args: source.args, expected: 728 },
    { label: 'independent 250 USD at 7.2', args: mapValues(source.args, value => replaceNumber(replaceNumber(value, 100, 250), 7.28, 7.2)), expected: 1800 },
    { label: 'independent zero amount', args: mapValues(source.args, value => replaceNumber(value, 100, 0)), expected: 0 },
    { label: 'independent decimal half-up: 1.005 at 3', args: mapValues(source.args, value => replaceNumber(replaceNumber(value, 100, 1.005), 7.28, 3)), expected: 3.02 },
  ]
  const failures = []
  for (const example of cases) {
    let output
    try {
      output = await api('POST', '/plugins/runtime/apps/' + plugin.id + '/invoke', { revision: plugin.publishedRevision, tool: source.spec.name, args: example.args })
      assert.deepEqual(output.plugin, { id: plugin.id, revision: plugin.publishedRevision, hash: application.hash })
      const matched = assertCurrencyAmount(output.result, example.expected, source.spec, source.resultPath)
      report.businessCases.push({ kind: 'published-application-invocation', label: example.label, tool: source.spec.name, args: example.args,
        independentExpectedAmount: example.expected, currency: 'CNY', matched, result: output.result, plugin: output.plugin, status: 'passed' })
    } catch (failure) {
      const error = redact(failure?.message || String(failure)); failures.push(example.label + ': ' + error)
      report.businessCases.push({ kind: 'published-application-invocation', label: example.label, tool: source.spec.name, args: example.args,
        independentExpectedAmount: example.expected, currency: 'CNY', result: output?.result, error, status: 'failed' })
    }
    save('report.json', report)
  }
  const rejections = [
    { label: 'reject inconsistent rate for identical currencies', args: mapValues(source.args, value => typeof value === 'string' && value.toUpperCase() === 'CNY' ? 'USD' : replaceNumber(replaceNumber(value, 100, 1), 7.28, 2)) },
    { label: 'reject unsafe precision in extreme result', args: mapValues(source.args, value => replaceNumber(replaceNumber(value, 100, 1e12), 7.28, 1e6)) },
    { label: 'reject minor units that change when converted back to Number', args: mapValues(source.args, value => replaceNumber(replaceNumber(value, 100, 703687441776.64), 7.28, 100.00000000000001)) },
  ]
  for (const example of rejections) {
    let rejected = false, error, output, responseCode
    try { output = await api('POST', '/plugins/runtime/apps/' + plugin.id + '/invoke', { revision: plugin.publishedRevision, tool: source.spec.name, args: example.args }) }
    catch (failure) {
      responseCode = failure?.responseCode; error = redact(failure?.message || String(failure))
      // A network failure, authorization block or server error is not proof of business validation.
      rejected = responseCode === 400 && /(?:插件进程退出|插件报告错误|参数不符合|相同|汇率|范围|amount|rate|precision)/i.test(error)
    }
    report.businessCases.push({ kind: 'published-application-invalid-business-input', label: example.label, tool: source.spec.name, args: example.args,
      expected: 'explicit rejection', rejected, responseCode, error, result: output?.result, status: rejected ? 'passed' : 'failed' })
    save('report.json', report)
    if (!rejected) failures.push('Published application did not explicitly reject invalid business input: ' + example.label)
  }
  assert.equal(failures.length, 0, 'Currency business validation failed: ' + failures.join('; '))
}

try {
  // This guard precedes every directory creation, profile/credential read and child process.
  if (!process.argv.includes('--run')) throw new Error('Review only: use --run after coordinating Electron access to execute the paid-model experiment')
  assert(existsSync(electron), 'Electron executable is unavailable')
  assert(existsSync(join(engineRoot, 'dist/main.js')), 'Build the current engine before this experiment')
  assert(existsSync(buildManifestPath), 'Current engine must have a build identity before this experiment')
  assert(!existsSync(root), 'Evidence directory must be new')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(root, 'skills'))
  report.status = 'running'
  report.engineBuild = JSON.parse(readFileSync(buildManifestPath, 'utf8'))
  report.driverSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  report.overallLimitMs = overallLimitMs
  overallTimer = setTimeout(() => overallController.abort(new Error('Overall natural AI experiment exceeded 18-minute deadline')), overallLimitMs)
  save('user-requirement.txt', requirement); save('engine-build-manifest.json', report.engineBuild); save('report.json', report)
  const config = await credential()
  await startEngine(config)
  progress('Isolated Electron engine ready; submitting ordinary user requirement')
  const authored = await author()
  auditAuthoring(authored)
  const { plugins } = await api('GET', '/plugins')
  assert.equal(plugins.length, 1, 'Natural task must create exactly one isolated plugin')
  assert.equal(plugins[0].id, pluginId)
  const { plugin } = await api('GET', '/plugins/' + pluginId)
  assert.equal(plugin.enabled, true)
  assert.equal(plugin.publishedRevision, plugin.revision)
  save('authored-plugin.json', plugin)
  report.plugin = { id: plugin.id, revision: plugin.revision, hash: plugin.revisions.find(item => item.revision === plugin.publishedRevision)?.hash,
    tools: plugin.manifest.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }
  await auditTemplateReuse(plugin, authored)
  if (currencyScenario) await currencyBusiness(plugin, authored)
  else {
  const duration = await naturalUse(plugin, 'duration', '请使用这个时间插件，把 2h15m 换算成秒。', 8100,
    args => values(args).some(value => typeof value === 'string' && value.replace(/\s/g, '').toLowerCase() === '2h15m'))
  for (const [text, seconds] of [['1h30m', 5400], ['45m', 2700]]) {
    const args = mapValues(duration.args, value => typeof value === 'string' && value.replace(/\s/g, '').toLowerCase() === '2h15m' ? text : value)
    await directCase(plugin, duration, 'parse ' + text, args, seconds)
  }
  const start = '2026-11-11T08:00:00Z', end = '2026-11-11T09:30:15Z'
  const startMs = Date.parse(start), endMs = Date.parse(end)
  const difference = await naturalUse(plugin, 'difference', '请使用这个时间插件，计算从 ' + start + ' 到 ' + end + ' 相差多少秒，以结束时间减开始时间为准。',
    (endMs - startMs) / 1000, args => hasDate(args, startMs) && hasDate(args, endMs))
  const rewriteDate = (value, first, last) => {
    if (typeof value === 'string' && Date.parse(value) === startMs) return first
    if (typeof value === 'string' && Date.parse(value) === endMs) return last
    if (typeof value === 'number' && value === startMs) return Date.parse(first)
    if (typeof value === 'number' && value === endMs) return Date.parse(last)
    if (typeof value === 'number' && value * 1000 === startMs) return Date.parse(first) / 1000
    if (typeof value === 'number' && value * 1000 === endMs) return Date.parse(last) / 1000
    return value
  }
  await directCase(plugin, difference, 'negative ISO difference', mapValues(difference.args, value => rewriteDate(value, end, start)), -5415)
  await directCase(plugin, difference, 'zero ISO difference', mapValues(difference.args, value => rewriteDate(value, start, start)), 0)
  }
  assert.equal(JSON.parse(readFileSync(buildManifestPath, 'utf8')).buildId, report.engineBuild.buildId,
    'Engine build changed during the experiment; a single reproducible build is required')
  report.status = 'passed'
  report.completedAt = new Date().toISOString()
  save('report.json', report)
  progress('PASS: natural authoring/publication and ' + report.businessCases.length + ' independently verified business cases; template=' + report.authoring.templateCoverage + ', batch=' + report.authoring.batchCoverage)
} catch (error) {
  if (existsSync(root)) {
    if (currencyScenario && latestAuthoringSnapshot) {
      try { auditAuthoring(latestAuthoringSnapshot, false) } catch (auditError) { report.authoringAuditError = redact(auditError?.message || String(auditError)) }
    }
    report.status = 'failed'; report.error = redact(error?.stack || String(error)); save('report.json', report)
  }
  progress(error?.message || String(error))
  process.exitCode = 1
} finally {
  clearTimeout(overallTimer)
  if (credentialProcess) {
    try {
      const { stopCommandProcessTree } = await import('../dist/core/command-jobs/process-tree.js')
      await stopCommandProcessTree(credentialProcess.child, credentialProcess.startedAt)
      report.credentialCleanup = 'stopped isolated credential process tree'
    } catch (error) {
      report.credentialCleanup = { error: redact(error?.message || String(error)) }
      report.status = 'failed'; process.exitCode = 1
    }
  }
  if (engine) {
    try {
      if (engine.exitCode === null && engine.signalCode === null) {
        if (engine.connected) engine.send({ command: 'shutdown' }, () => {})
        const closed = await Promise.race([engineClosed, delay(10_000).then(() => null)])
        if (!closed) {
          const { stopCommandProcessTree } = await import('../dist/core/command-jobs/process-tree.js')
          await stopCommandProcessTree(engine, engineStartedAt)
          report.cleanup = 'forced isolated process-tree shutdown'
        } else report.cleanup = { kind: 'graceful isolated engine shutdown', ...closed }
      } else report.cleanup = { kind: 'engine already exited', code: engine.exitCode, signal: engine.signalCode }
    } catch (error) {
      report.cleanup = { error: redact(error?.message || String(error)) }
      report.status = 'failed'; process.exitCode = 1
    }
  }
  if (existsSync(root)) {
    report.finishedAt = new Date().toISOString()
    save('report.json', report)
    progress('Evidence ' + root)
  }
}

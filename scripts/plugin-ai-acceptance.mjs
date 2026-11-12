/** Opt-in real model acceptance: no mock model, no generated plugin source in this driver. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const acceptedRoot = resolve(process.env.PLUGIN_ACCEPTANCE_ROOT || join(engineRoot, '.tmp/plugin-acceptance'))
const root = join(acceptedRoot, 'ai-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
const port = Number(process.env.PLUGIN_ACCEPTANCE_PORT || 12543), base = `http://127.0.0.1:${port}/api/v1`
const modelId = process.env.PLUGIN_ACCEPTANCE_MODEL || 'deepseek-v4.1-flash-1017'
const sourceRoot = process.env.PLUGIN_ACCEPTANCE_SOURCE_PROFILE || join(process.env.APPDATA, 'Aether Code')
const secrets = [], report = { root, modelId, startedAt: new Date().toISOString(), status: 'running', rounds: [], cases: [] }
let engine, engineStartedAt
mkdirSync(root, { recursive: true }); mkdirSync(join(root, 'workspace'), { recursive: true })
function redact(value) { let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]'); return text }
function save(file, data) { writeFileSync(join(root, file), redact(data), 'utf8') }
function progress(text) { console.log('[plugin-ai] ' + redact(text)) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function cleanEnv() { return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_?KEY|TOKEN|SECRET|ENCRYPTION_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|^DATA_DIR$|^PORT$|^HOST$/i.test(key))) }

async function credential() {
  const db = new DatabaseSync(join(sourceRoot, 'engine/state/agent.db'), { readOnly: true })
  let row
  try { row = db.prepare('SELECT model_id,provider,api_key,base_url,api_format,capabilities FROM models WHERE model_id=? AND is_enabled=1 AND deleted_at IS NULL').get(modelId) }
  finally { db.close() }
  assert.ok(row, 'Configured enabled model unavailable')
  const testKey = randomBytes(32).toString('hex'); secrets.push(testKey)
  const keyRecord = JSON.parse(readFileSync(join(sourceRoot, 'engine/secrets/engine-secrets.json'), 'utf8'))
  // Chromium protects its AES key in Local State with the current Windows account.
  // Copy only that encrypted key record, never open or write the user's live profile.
  const localState = JSON.parse(readFileSync(join(sourceRoot, 'Local State'), 'utf8'))
  mkdirSync(join(root, 'credential-profile'), { recursive: true })
  writeFileSync(join(root, 'credential-profile/Local State'), JSON.stringify({ os_crypt: localState.os_crypt }), { mode: 0o600 })
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(join(engineRoot, '../aether-code/node_modules/electron/dist/electron.exe'), [join(engineRoot, 'scripts/plugin-acceptance-credentials.cjs')], {
      env: { ...cleanEnv(), PLUGIN_CREDENTIAL_PROFILE: join(root, 'credential-profile'), PLUGIN_CREDENTIAL_INPUT: JSON.stringify({ keyRecord, encryptedApiKey: row.api_key, testKey }) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-2000) })
    child.once('error', reject); child.once('close', code => {
      if (code !== 0) return reject(new Error('Read-only model credential bridge failed: ' + errors.replace(/Unable to decrypt[^\n]*/g, 'Credential decryption failed')))
      const line = output.split('\n').find(line => line.startsWith('PLUGIN_CREDENTIAL_RESULT:'))
      if (!line) return reject(new Error('No credential bridge result'))
      resolveResult(JSON.parse(line.slice('PLUGIN_CREDENTIAL_RESULT:'.length)))
    })
  })
  secrets.push(result.apiKey)
  save('engine-key.encrypted.json', { encrypted: true, encryptionKey: result.encryptedTestKey })
  return { key: testKey, model: { modelId: row.model_id, provider: row.provider, apiKey: result.apiKey, baseUrl: row.base_url, apiFormat: row.api_format,
    ...(row.capabilities ? { capabilities: JSON.parse(row.capabilities) } : {}) } }
}
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-aether-tool-profile': 'general' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) })
  const value = await response.json()
  if (value.code !== 200) throw new Error(redact(`${method} ${path}: ${value.message}`))
  return value.data
}
const managerTools = ['plugin_get_template','plugin_list','plugin_get','plugin_create','plugin_update','plugin_publish','plugin_set_enabled','plugin_delete','plugin_test','plugin_import_preview','plugin_import_install']
async function chat(sessionId, fields, label) {
  const response = await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aether-tool-profile': 'general' },
    body: JSON.stringify({ sessionId, model: modelId, thinkingMode: false, toolkits: ['plugin-management'], allowedTools: managerTools,
      workspacePaths: [join(root, 'workspace')], memoryScope: 'off', skills: [], mcpServers: [], ...fields }), signal: AbortSignal.timeout(600_000) })
  const text = await response.text(); save(label + '.sse.txt', text)
  if (!text.includes('data:')) throw new Error(redact(text.slice(0, 600)))
  return api('GET', '/chat/snapshot?sessionId=' + encodeURIComponent(sessionId))
}
async function round(scenario, index, prompt) {
  const label = `${scenario.id}-${index}`, sessionId = `plugin-ai-${scenario.id}`
  progress(label + ': requesting actual AI')
  let snapshot = await chat(sessionId, { message: prompt }, label + '-initial')
  for (let approval = 0; approval < 20; approval++) {
    const run = snapshot.executionRun ?? snapshot.run ?? snapshot.runs?.at(-1)
    const pending = run?.pending?.find(item => item.status !== 'answered')
    if (run?.status !== 'waiting') {
      if (run?.status !== 'succeeded') throw new Error(`${label}: run ended ${run?.status}`)
      save(label + '-snapshot.json', snapshot)
      const row = { id: scenario.id, iteration: index, sessionId, runId: run.runId, status: run.status,
        tools: snapshot.history.filter(message => message.role === 'tool').map(message => message.toolName) }
      report.rounds.push(row); save('report.json', report); return snapshot
    }
    assert.ok(pending, 'Waiting run lacks pending operation')
    assert.ok(['plugin_create','plugin_update','plugin_publish','plugin_test'].includes(pending.toolName), 'Unexpected model mutation')
    const operation = pending.pendingAction?.operation
    const target = operation?.input?.id ?? operation?.input?.manifest?.id
    assert.equal(target, scenario.id, 'Approval must target this synthetic plugin only')
    save(label + `-approval-${approval}.json`, pending)
    snapshot = await chat(sessionId, { message: '', toolResponse: { runId: run.runId, requestId: pending.requestId,
      toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' } }, label + `-resume-${approval}`)
  }
  throw new Error('Approval loop exceeded limit')
}

const scenarios = [
  { id: 'invoice-helper', requirement: '财务报价：工具 run 输入 items:[{quantity,unitPrice}] 与 taxRate(小数税率，缺省0)，输出 result:{subtotal,tax,total}，金额统一四舍五入到分。',
    cases: [{ args: { items: [{ quantity: 2, unitPrice: 19.99 }, { quantity: 1, unitPrice: 10 }], taxRate: 0.1 }, expected: { subtotal: 49.98, tax: 5, total: 54.98 } }],
    iterations: [
      { requirement: '新增 discountPercent（百分数，缺省0）。折扣作用于subtotal，新增 discount、afterDiscount，tax按afterDiscount计算。保持老接口结果不变。', args: { items: [{ quantity: 2, unitPrice: 50 }], taxRate: 0.1, discountPercent: 20 }, expected: { subtotal: 100, discount: 20, afterDiscount: 80, tax: 8, total: 88 } },
      { requirement: '新增 shipping（缺省0），在税后总额加运费；输出 shipping，保留之前所有功能。', args: { items: [{ quantity: 2, unitPrice: 50 }], taxRate: 0.1, discountPercent: 20, shipping: 12 }, expected: { discount: 20, tax: 8, shipping: 12, total: 100 } },
      { requirement: '新增 currency（缺省CNY）与 formattedTotal，固定格式为 currency + 空格 + total.toFixed(2)，例如 USD 100.00。保留之前全部功能。', args: { items: [{ quantity: 2, unitPrice: 50 }], taxRate: 0.1, discountPercent: 20, shipping: 12, currency: 'USD' }, expected: { total: 100, formattedTotal: 'USD 100.00' } },
    ] },
  { id: 'log-inspector', requirement: '运维日志分析：工具run输入logs:[{level:"INFO"|"WARN"|"ERROR",service?,durationMs?}]，返回 result:{total,counts:{INFO,WARN,ERROR}}，空输入返回0。',
    cases: [{ args: { logs: [{ level: 'INFO' }, { level: 'ERROR' }, { level: 'ERROR' }] }, expected: { total: 3, counts: { INFO: 1, WARN: 0, ERROR: 2 } } }],
    iterations: [
      { requirement: '新增 byService，按照service计数，缺省unknown，值为数字。保持counts与total。', args: { logs: [{ level: 'INFO', service: 'api' }, { level: 'ERROR', service: 'api' }, { level: 'WARN', service: 'db' }] }, expected: { byService: { api: 2, db: 1 }, total: 3 } },
      { requirement: '新增 p95Ms，忽略无durationMs条目，只对有限非负数字排序，nearest-rank ceil(n*0.95)-1取值，空时null。保留旧功能。', args: { logs: [1,2,3,4,5,6,7,8,9,10].map(durationMs => ({ level: 'INFO', durationMs })) }, expected: { p95Ms: 10, total: 10 } },
      { requirement: '新增 minLevel（缺省INFO），严重度INFO<WARN<ERROR，先过滤再统计所有指标。保留旧接口和byService/p95Ms。', args: { logs: [{ level: 'INFO' }, { level: 'WARN' }, { level: 'ERROR' }], minLevel: 'WARN' }, expected: { total: 2, counts: { INFO: 0, WARN: 1, ERROR: 1 } } },
    ] },
  { id: 'meeting-report', requirement: '办公文档：工具run输入 title 与 tasks:[{owner,text}]，返回result:{markdown}，含#标题和每条任务负责人/文字，并返回artifacts:[{path:"meeting-report.md",content:同markdown}]。不直接操作文件系统。',
    cases: [{ args: { title: '项目例会', tasks: [{ owner: '小林', text: '完成审查' }] }, check: value => { assert.ok(value.result.markdown.includes('项目例会')); assert.ok(value.result.markdown.includes('小林')); assert.equal(value.artifacts[0].content, value.result.markdown) } }] },
  { id: 'privacy-redactor', requirement: '隐私文本处理：工具run输入text，将邮箱替换成[EMAIL]，中国大陆11位手机号替换成[PHONE]，返回result:{text,emailCount,phoneCount}，保留其他Unicode文字换行。',
    cases: [{ args: { text: '联系 alice@example.com，手机13800138000\n保留中文。' }, expected: { text: '联系 [EMAIL]，手机[PHONE]\n保留中文。', emailCount: 1, phoneCount: 1 } }] },
  { id: 'dependency-planner', requirement: '研发任务规划：工具run输入tasks:[{id,dependsOn:string[]}]，返回result:{order:string[],hasCycle:boolean}，拓扑序必须依赖先于使用者，循环时hasCycle=true且order:[]，无依赖按原输入顺序。',
    cases: [{ args: { tasks: [{ id: 'ship', dependsOn: ['test'] }, { id: 'test', dependsOn: ['build'] }, { id: 'build', dependsOn: [] }] }, expected: { order: ['build','test','ship'], hasCycle: false } }, { args: { tasks: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }] }, expected: { order: [], hasCycle: true } }] },
]
function subset(actual, expected) { for (const [key, value] of Object.entries(expected)) { if (value && typeof value === 'object' && !Array.isArray(value)) subset(actual[key], value); else assert.deepEqual(actual[key], value, key) } }
async function verify(scenario, stage) {
  const { plugin } = await api('GET', '/plugins/' + scenario.id)
  assert.equal(plugin.enabled, true); assert.equal(plugin.publishedRevision, plugin.revision)
  const cases = [...scenario.cases, ...(scenario.iterations ?? []).slice(0, stage).map(item => ({ args: item.args, expected: item.expected }))]
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index], output = await api('POST', `/plugins/${scenario.id}/test`, { tool: 'run', args: test.args, revision: plugin.publishedRevision })
    save(`${scenario.id}-${stage}-case-${index}-latest.json`, { args: test.args, expected: test.expected, output, revision: plugin.revision })
    if (test.expected) subset(output.result, test.expected)
    if (test.check) test.check(output)
    report.cases.push({ plugin: scenario.id, stage, case: index, revision: plugin.revision, hash: plugin.revisions.find(item => item.revision === plugin.revision).hash, args: test.args, output, status: 'passed' })
  }
  save(`${scenario.id}-${stage}-plugin.json`, plugin); save('report.json', report)
  progress(`${scenario.id} stage ${stage}: ${cases.length} assertions passed, revision ${plugin.revision}`)
}
const protocol = '请直接使用 @插件管理 的真实工具创建、测试并发布插件，不要只解释或给代码。只允许此任务指定ID。不要使用shell/外部依赖。代码自己设计，使用Node内置库，入口main.mjs：从process.stdin读取全部JSON {tool,args}，stdout最后一行输出JSON {result,artifacts?}，非export default。manifest apiVersion=1,runtime=node,tools=[{name:"run",description,inputSchema:{type:"object",properties:...},entry:"main.mjs"}]，files是路径到完整源码。plugin_test验证后plugin_publish。变更待批准时等待自动恢复，不另开会话；完成必须真实发布且启用。'
async function verifyOrRepair(scenario, stage) {
  for (let attempt = 0; ; attempt++) {
    try { return await verify(scenario, stage) } catch (error) {
      report.rounds.push({ id: scenario.id, stage, validation: 'failed', error: redact(error.stack || String(error)) }); save('report.json', report)
      if (attempt >= 2) throw error
      await round(scenario, `${stage}-repair-${attempt + 1}`, `${protocol}\n插件${scenario.id}未通过独立回归，请你读取当前代码并修复，然后测试和发布。失败：${error.message}\n基本需求：${scenario.requirement}\n已要求功能：${(scenario.iterations ?? []).slice(0, stage).map(item => item.requirement).join('\n')}\n完整验收输入输出：${JSON.stringify([...scenario.cases, ...(scenario.iterations ?? []).slice(0, stage)].map(item => ({args:item.args,expected:item.expected})))}`)
    }
  }
}
try {
  if (process.argv.includes('--check-credentials')) {
    await credential(); report.status = 'credentials-available'; save('report.json', report)
    progress(`Credential bridge passed without a model request. Evidence ${root}`); process.exit(0)
  }
  if (!process.argv.includes('--run')) throw new Error('Pass --run for the authorized paid-model experiment')
  const config = await credential(); progress('Configured model credential available; isolated engine starting')
  const env = { ...cleanEnv(), DATA_DIR: join(root, 'state/agent.db'), MEMORY_DB_PATH: join(root, 'state/memory.db'), WORKSPACE_ROOT: join(root, 'workspace'),
    AETHER_GLOBAL_DIR: join(root, 'global'), SKILLS_ROOT: join(root, 'skills'), MCP_CONFIG_PATH: join(root, 'mcp.json'), ENCRYPTION_KEY: config.key,
    AUTH_ENABLED: 'false', AETHER_ENGINE_HOST: '127.0.0.1', AETHER_ENGINE_PORT: String(port), DEFAULT_SECURITY_MODE: 'full-access',
    HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', ENABLE_LONG_TERM_MEMORY: 'false', MAX_ITERATIONS: '40', LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false',
    LLM_PRIMARY_MODEL: modelId, LLM_MODEL: modelId, LLM_PROVIDER: config.model.provider, LLM_FALLBACK_MODEL: '' }
  engineStartedAt = Date.now()
  engine = spawn(process.execPath, [join(engineRoot, 'scripts/plugin-acceptance-engine.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'] })
  let engineLog = ''; for (const stream of [engine.stdout, engine.stderr]) stream.on('data', chunk => { engineLog = (engineLog + redact(chunk.toString())).slice(-400_000); save('engine.log', engineLog) })
  engine.once('error', error => { report.startupError = error.message })
  let ready = false
  for (let retry = 0; retry < 90; retry++) { try { await api('GET', '/plugins'); ready = true; break } catch { if (engine.exitCode !== null) throw new Error('Isolated engine exited; see engine.log'); await delay(1000) } }
  assert.ok(ready, 'Engine not ready'); await api('POST', '/models', config.model)
  for (const scenario of scenarios) {
    await round(scenario, 0, `${protocol}\n创建插件ID=${scenario.id}，中文显示名按用途自行起名，version=1.0.0。需求：${scenario.requirement}`)
    await verifyOrRepair(scenario, 0)
  }
  for (const scenario of scenarios.filter(s => s.iterations)) {
    for (let index = 0; index < scenario.iterations.length; index++) {
      await round(scenario, index + 1, `${protocol}\n继续编辑现有插件 ${scenario.id}。这是第${index + 1}次功能迭代，先plugin_get读取源码和revision，然后plugin_update增加新功能，测试并发布。需求：${scenario.iterations[index].requirement}`)
      await verifyOrRepair(scenario, index + 1)
    }
  }
  for (const scenario of scenarios) {
    const { plugin } = await api('GET', '/plugins/' + scenario.id)
    const name = `plugin_${scenario.id.replace(/-/g, '_')}_run`
    const selection = `plugin-${scenario.id}--r${plugin.publishedRevision}`
    const snapshot = await chat(`plugin-use-${scenario.id}`, {
      message: `请实际调用工具 ${name}，参数严格为 ${JSON.stringify(scenario.cases[0].args)}。然后用一句话报告结果。不要给模拟结果。`,
      allowedTools: [name], toolkits: [selection],
    }, `${scenario.id}-actual-use`)
    const invoked = snapshot.history.filter(message => message.role === 'tool' && message.toolName === name)
    assert.ok(invoked.length, `${scenario.id}: actual selected tool was not invoked`)
    const output = JSON.parse(invoked.at(-1).content)
    if (scenario.cases[0].expected) subset(output.result, scenario.cases[0].expected)
    if (scenario.id === 'meeting-report') assert.ok(readFileSync(join(root, 'workspace/meeting-report.md'), 'utf8').includes('项目例会'))
    report.cases.push({ plugin: scenario.id, kind: 'actual-ai-session-invocation', tool: name, revision: plugin.publishedRevision, status: 'passed', output })
    mkdirSync(join(root, 'exported-plugins'), { recursive: true })
    const archive = Object.fromEntries(Object.entries({ ...plugin.files, 'aether-plugin.json': JSON.stringify(plugin.manifest, null, 2) }).map(([name, content]) => [name, strToU8(content)]))
    writeFileSync(join(root, 'exported-plugins', scenario.id + '.zip'), zipSync(archive))
    save(`${scenario.id}-use-snapshot.json`, snapshot); save('report.json', report)
  }
  report.status = 'passed'; report.completedAt = new Date().toISOString(); save('report.json', report); progress(`PASS: 5 AI-created plugins, 6 feature iterations, ${report.cases.length} regression cases. Evidence ${root}`)
} catch (error) { report.status = 'failed'; report.error = redact(error?.stack || String(error)); save('report.json', report); progress(report.error); process.exitCode = 1 }
finally {
  if (engine && engine.exitCode === null) {
    engine.send({ command: 'shutdown' })
    await Promise.race([new Promise(resolve => engine.once('close', resolve)), delay(10000)])
    if (engine.exitCode === null) {
      const { stopCommandProcessTree } = await import('../dist/core/command-jobs/process-tree.js')
      await stopCommandProcessTree(engine, engineStartedAt)
      report.cleanup = 'forced isolated process-tree shutdown'
    } else report.cleanup = 'graceful engine shutdown'
    save('report.json', report)
  }
  progress(`Evidence ${root}`)
}

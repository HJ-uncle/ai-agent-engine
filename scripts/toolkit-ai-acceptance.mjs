/** Opt-in real-model A-create / restart / B-use acceptance. All mutations stay in a fresh fixture. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(engineRoot, '.tmp/toolkit-acceptance', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
const workspace = join(root, 'workspace'), otherWorkspace = join(root, 'other-workspace')
const sourceRoot = process.env.TOOLKIT_SOURCE_PROFILE || join(process.env.APPDATA, 'Aether Code')
const modelId = process.env.TOOLKIT_MODEL || 'deepseek-v4.1-flash-1017'
const basePort = Number(process.env.TOOLKIT_PORT || 12547), base = `http://127.0.0.1:${basePort}/api/v1`
const secrets = [], report = { root, modelId, startedAt: new Date().toISOString(), status: 'running', cases: [], rounds: [], lifecycle: [] }
const markers = { agent: 'AGENT_' + randomUUID(), skill: 'SKILL_' + randomUUID(), knowledge: 'KB_' + randomUUID(), mcp: 'MCP_' + randomUUID(), cron: 'CRON_' + randomUUID() }
let engine, engineStartedAt, config
for (const directory of [root, workspace, otherWorkspace]) mkdirSync(directory, { recursive: true })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function redact(value) { let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]'); return text }
function save(name, value) { writeFileSync(join(root, name), redact(value), 'utf8') }
function progress(message) { console.log('[toolkit-ai] ' + redact(message)) }
function record(name, details = {}) { report.cases.push({ name, status: 'passed', ...details }); save('report.json', report); progress('PASS ' + name) }
function cleanEnv() { return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_?KEY|TOKEN|SECRET|ENCRYPTION_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|^DATA_DIR$|^PORT$|^HOST$|^VITEST$|^KNOWLEDGE_/i.test(key))) }
async function credentials() {
  const db = new DatabaseSync(join(sourceRoot, 'engine/state/agent.db'), { readOnly: true })
  let row
  try { row = db.prepare('SELECT model_id,provider,api_key,base_url,api_format,capabilities FROM models WHERE model_id=? AND is_enabled=1 AND deleted_at IS NULL').get(modelId) }
  finally { db.close() }
  assert.ok(row, 'Configured enabled model unavailable')
  const key = randomBytes(32).toString('hex'); secrets.push(key)
  const keyRecord = JSON.parse(readFileSync(join(sourceRoot, 'engine/secrets/engine-secrets.json'), 'utf8'))
  const localState = JSON.parse(readFileSync(join(sourceRoot, 'Local State'), 'utf8'))
  mkdirSync(join(root, 'credential-profile'), { recursive: true })
  writeFileSync(join(root, 'credential-profile/Local State'), JSON.stringify({ os_crypt: localState.os_crypt }))
  const decrypted = await new Promise((resolveResult, reject) => {
    const child = spawn(join(engineRoot, '../aether-code/node_modules/electron/dist/electron.exe'), [join(engineRoot, 'scripts/plugin-acceptance-credentials.cjs')], {
      env: { ...cleanEnv(), PLUGIN_CREDENTIAL_PROFILE: join(root, 'credential-profile'), PLUGIN_CREDENTIAL_INPUT: JSON.stringify({ keyRecord, encryptedApiKey: row.api_key, testKey: key }) },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''; child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', () => {})
    child.once('error', reject); child.once('close', code => {
      if (code !== 0) return reject(new Error('Read-only OS credential bridge failed'))
      const line = output.split('\n').find(line => line.startsWith('PLUGIN_CREDENTIAL_RESULT:'))
      if (!line) return reject(new Error('Credential bridge returned no result'))
      resolveResult(JSON.parse(line.slice('PLUGIN_CREDENTIAL_RESULT:'.length)))
    })
  })
  secrets.push(decrypted.apiKey)
  save('engine-key.encrypted.json', { encrypted: true, encryptionKey: decrypted.encryptedTestKey })
  return { key, model: { modelId: row.model_id, provider: row.provider, apiKey: decrypted.apiKey, baseUrl: row.base_url, apiFormat: row.api_format,
    ...(row.capabilities ? { capabilities: JSON.parse(row.capabilities) } : {}) } }
}
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-aether-tool-profile': 'general' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  const value = await response.json()
  if (value.code !== 200) throw new Error(redact(`${method} ${path}: ${value.message}`))
  return value.data
}
async function start() {
  engineStartedAt = Date.now()
  engine = spawn(process.execPath, [join(engineRoot, 'scripts/plugin-acceptance-engine.mjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...cleanEnv(), DATA_DIR: join(root, 'state/agent.db'), MEMORY_DB_PATH: join(root, 'state/memory.db'), KNOWLEDGE_DATA_DIR: join(root, 'state/knowledge.db'),
      WORKSPACE_ROOT: workspace, AETHER_GLOBAL_DIR: join(root, 'global'), SKILLS_ROOT: join(root, 'skills'), MCP_CONFIG_PATH: '', ENCRYPTION_KEY: config.key,
      AUTH_ENABLED: 'false', AETHER_ENGINE_HOST: '127.0.0.1', AETHER_ENGINE_PORT: String(basePort), DEFAULT_SECURITY_MODE: 'standard',
      HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', ENABLE_LONG_TERM_MEMORY: 'false', MAX_ITERATIONS: '25', LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false',
      LLM_PRIMARY_MODEL: modelId, LLM_MODEL: modelId, LLM_PROVIDER: config.model.provider, LLM_FALLBACK_MODEL: '',
    } })
  let log = ''
  for (const stream of [engine.stdout, engine.stderr]) stream.on('data', chunk => { log = (log + redact(chunk.toString())).slice(-250000); save('engine-' + engineStartedAt + '.log', log) })
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await api('GET', '/toolkits'); ready = true; break } catch { if (engine.exitCode !== null) throw new Error('Isolated engine exited'); await delay(500) }
  }
  assert.ok(ready, 'Isolated engine did not become ready')
  report.lifecycle.push({ event: 'start', pid: engine.pid, at: new Date().toISOString() }); save('report.json', report)
}
async function stop() {
  if (!engine || engine.exitCode !== null) return
  engine.send({ command: 'shutdown' })
  await Promise.race([new Promise(resolve => engine.once('close', resolve)), delay(10000)])
  if (engine.exitCode === null) {
    const { stopCommandProcessTree } = await import('../dist/core/command-jobs/process-tree.js')
    await stopCommandProcessTree(engine, engineStartedAt)
    report.lifecycle.push({ event: 'forced-stop', pid: engine.pid })
  } else report.lifecycle.push({ event: 'graceful-stop', pid: engine.pid, exitCode: engine.exitCode })
  save('report.json', report)
}
const toolkits = {
  'agent-management': ['agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete'],
  'skill-management': ['skill_list', 'skill_get', 'skill_create', 'skill_update', 'skill_set_enabled', 'skill_delete'],
  'knowledge-management': ['knowledge_list', 'knowledge_get', 'knowledge_create', 'knowledge_update', 'knowledge_delete', 'knowledge_documents', 'knowledge_document_get', 'knowledge_import', 'knowledge_document_update', 'knowledge_document_delete', 'knowledge_search'],
  automation: ['cron_capabilities', 'cron_list', 'cron_preview', 'cron_create', 'cron_update', 'cron_delete'],
  'mcp-management': ['mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_set_enabled', 'mcp_server_delete', 'mcp_server_test'],
}
const tools = (...packages) => packages.flatMap(name => toolkits[name])
const currentRun = snapshot => snapshot.executionRun ?? snapshot.run ?? snapshot.runs?.at(-1)
const historyTools = snapshot => snapshot.history.filter(message => message.role === 'tool' && message.metadata?.rootRunId === currentRun(snapshot)?.runId)
const hasTool = (snapshot, name) => assert.ok(historyTools(snapshot).some(message => message.toolName === name && message.metadata?.success === true), `AI never successfully called ${name}`)
const answer = snapshot => snapshot.history.filter(message => message.role === 'assistant' && message.metadata?.finalResult?.runId === currentRun(snapshot)?.runId).map(message => message.metadata.finalResult.text).join('\n')
function jsonAnswer(snapshot) {
  const text = answer(snapshot).trim(), fenced = /^```(?:json)?\s*([\s\S]+?)\s*```$/.exec(text)
  return JSON.parse(fenced ? fenced[1] : text)
}
async function chat(sessionId, fields, label) {
  const response = await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aether-tool-profile': 'general' },
    body: JSON.stringify({ sessionId, model: modelId, thinkingMode: false, toolkits: [], allowedTools: [], workspacePaths: [workspace], memoryScope: 'off', skills: [], mcpServers: [], ...fields }),
    signal: AbortSignal.timeout(240_000) })
  const sse = await response.text(); save(label + '.sse.txt', sse)
  if (!response.ok || !sse.includes('data:')) throw new Error(redact(sse.slice(0, 500)))
  return api('GET', '/chat/snapshot?sessionId=' + encodeURIComponent(sessionId))
}
async function round(sessionId, label, fields, approvedNames = []) {
  progress(label + ': real model running')
  let snapshot = await chat(sessionId, fields, label + '-initial')
  for (let index = 0; index < 12; index++) {
    const run = snapshot.executionRun ?? snapshot.run ?? snapshot.runs?.at(-1)
    if (run?.status !== 'waiting') {
      save(label + '-snapshot.json', snapshot)
      assert.equal(run?.status, 'succeeded', `${label}: execution failed`)
      report.rounds.push({ sessionId, label, runId: run.runId, status: run.status,
        tools: historyTools(snapshot).filter(item => item.metadata?.success === true).map(item => item.toolName),
        failedAttempts: historyTools(snapshot).filter(item => item.metadata?.success === false).map(item => ({ tool: item.toolName, error: item.metadata?.error ?? item.content })) })
      save('report.json', report); return snapshot
    }
    const pending = run.pending?.find(item => item.status !== 'answered')
    assert.ok(pending && approvedNames.includes(pending.toolName), `${label}: unexpected approval ${pending?.toolName}`)
    // Only our fresh database and workspace exist in this process. No model gets source-profile paths or credentials.
    assert.equal(pending.pendingAction?.type, pending.toolName)
    save(label + '-approval-' + index + '.json', pending)
    snapshot = await chat(sessionId, { ...fields, message: '', toolResponse: { runId: run.runId, requestId: pending.requestId,
      toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' } }, label + '-resume-' + index)
  }
  throw new Error('Too many approvals in ' + label)
}
const direct = '请实际调用已提供工具完成，不要只描述方案或输出伪造结果。修改进入批准等待后由验收驱动恢复；不要调用ask_user或自行编造确认。'
function fixtureMcp() {
  const file = join(workspace, 'acceptance-mcp.cjs')
  writeFileSync(file, `const readline=require('node:readline');\nconst rl=readline.createInterface({input:process.stdin});\nrl.on('line',line=>{let q;try{q=JSON.parse(line)}catch{return}if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'acceptance',version:'1'}};else if(q.method==='tools/list')result={tools:[{name:'lookup',description:'Read the acceptance inventory marker and calculate price.',inputSchema:{type:'object',properties:{quantity:{type:'number'}},required:['quantity']}}]};else if(q.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({marker:${JSON.stringify(markers.mcp)},total:q.params.arguments.quantity*17})}]};else if(q.method==='ping')result={};else return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Unknown method'}})+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});\n`)
  return file
}

try {
  if (!process.argv.includes('--run')) throw new Error('Use --run to invoke the configured paid model')
  config = await credentials(); await start(); await api('POST', '/models', config.model)
  save('build-manifest.json', JSON.parse(readFileSync(join(engineRoot, 'dist/runtime/build-manifest.json'), 'utf8')))
  const aSkill = await round('A-skill', 'A-create-skill', { toolkits: ['skill-management'], allowedTools: tools('skill-management'),
    message: `${direct} 创建项目技能 cross-session-format，description 为跨会话报告格式。正文要求：收到销量数据时计算总额，最终只返回 JSON {"receipt":"${markers.skill}","total":数量乘以单价}。保存后读取核对。` }, ['skill_create'])
  hasTool(aSkill, 'skill_create')
  const skillFile = readFileSync(join(workspace, '.ae/skills/cross-session-format/SKILL.md'), 'utf8'); assert.ok(skillFile.includes(markers.skill))
  record('A AI creates skill on disk')
  if (process.argv.includes('--skill-only')) {
    assert.equal((skillFile.match(/^name:\s*cross-session-format\s*$/gm) ?? []).length, 1, 'Skill must have exactly one metadata header')
    const managed = JSON.parse(historyTools(aSkill).find(item => item.toolName === 'skill_create' && item.metadata?.success)?.content).skill
    assert.equal(managed.executionId, 'cross-session-format')
    const combinedCreate = await round('A-combined', 'A-bind-created-skill-to-agent', { toolkits: ['skill-management', 'agent-management'], allowedTools: tools('skill-management', 'agent-management'),
      message: `${direct} 从skill_list/get读取cross-session-format，创建Agent cross-session-combined，skills绑定使用回执的executionId，allowedTools=["list_skills","get_skill"]，model=${modelId}，mcpServers=[]，knowledgeBases=[]；systemPrompt仅要求读取并遵循绑定技能，不能复制技能正文。` }, ['agent_create'])
    hasTool(combinedCreate, 'agent_create')
    const combined = (await api('GET', '/agents')).find(item => item.name === 'cross-session-combined')
    assert.ok(combined); assert.deepEqual(combined.skills, [managed.executionId]); assert.ok(!combined.systemPrompt.includes(markers.skill))
    await stop(); await start()
    const use = await round('B-combined', 'B-use-agent-with-A-skill', { agentId: combined.id, skills: undefined, allowedTools: undefined,
      message: '实际读取绑定技能并处理数量3、单价11，输出技能规定的JSON。' })
    hasTool(use, 'get_skill'); assert.deepEqual(jsonAnswer(use), { receipt: markers.skill, total: 33 })
    record('Final skill build: single metadata header and AI-created Agent binding survives restart')
  } else {
  const aAgent = await round('A-agent', 'A-create-agent', { toolkits: ['agent-management'], allowedTools: tools('agent-management'),
    message: `${direct} 创建持久Agent，名称 cross-session-agent，model=${modelId}，allowedTools=[]，skills=[]，mcpServers=[]，knowledgeBases=[]。systemPrompt精确设置：用户问回执时，只回答 ${markers.agent} 。保存后核对配置。` }, ['agent_create'])
  hasTool(aAgent, 'agent_create')
  const agent = (await api('GET', '/agents')).find(item => item.name === 'cross-session-agent'); assert.ok(agent)
  record('A AI creates persistent Agent', { id: agent.id })
  const aKnowledge = await round('A-knowledge', 'A-create-knowledge', { toolkits: ['knowledge-management'], allowedTools: tools('knowledge-management'),
    message: `${direct} 创建知识库 cross-session-knowledge，并导入一份文本文件 acceptance.md。内容必须包含：项目验收口令为 ${markers.knowledge} ，项目代号是雪松，负责人数为7。使用创建工具返回的真实库ID导入，完成后读取文档核对。` }, ['knowledge_create', 'knowledge_import'])
  hasTool(aKnowledge, 'knowledge_create'); hasTool(aKnowledge, 'knowledge_import')
  const kb = (await api('GET', '/knowledge/bases')).find(item => item.name === 'cross-session-knowledge'); assert.ok(kb)
  record('A AI creates knowledge base and imports document', { id: kb.id })
  const aCron = await round('A-automation', 'A-create-automation', { toolkits: ['automation'], allowedTools: tools('automation'),
    message: `${direct} 先检查能力，然后创建名称 cross-session-automation 的暂停任务（enabled=false）。message精确为：只回答 ${markers.cron} ，不调用任何工具。配置version2，interval everyMinutes=1 anchorAt=${Date.now()}，target standalone，notificationPolicy=silent，toolProfile=general，使用Agent ${agent.id}，thinkingMode=false。保存后读取核对。` }, ['cron_create'])
  hasTool(aCron, 'cron_create')
  const job = (await api('GET', '/cron')).find(item => item.name === 'cross-session-automation'); assert.equal(job?.enabled, false)
  record('A AI creates paused automation', { id: job.id })
  const mcpFile = fixtureMcp()
  const aMcp = await round('A-mcp', 'A-create-mcp', { toolkits: ['mcp-management'], allowedTools: tools('mcp-management'),
    message: `${direct} 创建项目级MCP服务 id=cross-session-mcp，transportType=stdio，command=${JSON.stringify(process.execPath)}，args=${JSON.stringify([mcpFile])}。先保持默认停用，使用工具测试连接发现lookup，之后读取最新expectedRevision并启用此服务，供其他会话使用。` }, ['mcp_server_create', 'mcp_server_test', 'mcp_server_set_enabled'])
  hasTool(aMcp, 'mcp_server_create'); hasTool(aMcp, 'mcp_server_test'); hasTool(aMcp, 'mcp_server_set_enabled')
  record('A AI creates, tests and enables MCP service')

  await stop(); assert.equal(report.lifecycle.at(-1).event, 'graceful-stop'); await start()
  record('Independent engine restart preserves A resources')
  const bAgent = await round('B-agent', 'B-use-agent', { agentId: agent.id, message: '请提供回执。' })
  assert.ok(answer(bAgent).includes(markers.agent)); assert.ok(!JSON.stringify(bAgent.history.filter(item => item.role === 'user')).includes(markers.agent))
  record('B uses A-created Agent after restart', { sessionId: 'B-agent' })
  const available = await api('GET', '/skills?available=1&path=' + encodeURIComponent(workspace))
  const skill = (Array.isArray(available) ? available : available.list).find(item => item.name === 'cross-session-format'); assert.ok(skill)
  const bSkill = await round('B-skill', 'B-use-skill', { skills: [skill.id], allowedTools: ['list_skills', 'get_skill'],
    message: '请实际读取已选择的 cross-session-format 技能并按它的格式处理：数量6，单价13。结果必须遵循该技能，不需要解释。' })
  hasTool(bSkill, 'get_skill'); assert.deepEqual(jsonAnswer(bSkill), { receipt: markers.skill, total: 78 })
  record('B selects A-created skill through public catalogue and applies it', { executionId: skill.id })
  const bKnowledge = await round('B-knowledge', 'B-use-knowledge', { knowledgeBases: [kb.id],
    message: '根据本次所选知识库，请实际调用knowledge_documents和knowledge_document_get读取文档，告诉我项目代号、负责人数和验收口令。不要猜测。' })
  hasTool(bKnowledge, 'knowledge_document_get'); assert.ok(answer(bKnowledge).includes(markers.knowledge))
  record('B reads A-created knowledge without management toolkit')
  const bMcp = await round('B-mcp', 'B-use-mcp', { mcpServers: ['cross-session-mcp'], allowedTools: ['mcp_cross-session-mcp_lookup'],
    message: '使用已选择的MCP服务查询数量4的库存报价，返回服务给出的marker和total。实际调用，不要猜测。' })
  hasTool(bMcp, 'mcp_cross-session-mcp_lookup'); assert.ok(answer(bMcp).includes(markers.mcp))
  assert.deepEqual(JSON.parse(historyTools(bMcp).find(item => item.toolName === 'mcp_cross-session-mcp_lookup' && item.metadata?.success).content), { marker: markers.mcp, total: 68 })
  record('B calls A-configured MCP business tool without management toolkit')
  const bCron = await round('B-automation', 'B-use-automation', { toolkits: ['automation'], allowedTools: tools('automation'),
    message: `${direct} 找到现有 cross-session-automation，用cron_list读取后把它启用，不得新建第二个任务，不更改消息与Agent。` }, ['cron_update'])
  hasTool(bCron, 'cron_list'); hasTool(bCron, 'cron_update')
  assert.equal((await api('GET', '/cron/' + job.id)).enabled, true)
  record('B finds and enables A-created automation')
  let completed
  for (let attempt = 0; attempt < 50; attempt++) {
    const runs = await api('GET', `/cron/${job.id}/runs`)
    completed = runs.items.find(item => item.status === 'succeeded')
    if (completed) break
    if (attempt % 10 === 0) progress('Waiting for actual scheduler tick and model completion')
    await delay(3000)
  }
  assert.ok(completed, 'Automation did not actually dispatch and complete')
  const scheduled = await api('GET', '/chat/snapshot?sessionId=' + encodeURIComponent(completed.sessionId)); save('scheduled-run-snapshot.json', scheduled)
  assert.ok(answer(scheduled).includes(markers.cron))
  record('Real scheduler executes A-created, B-enabled automation with real model', { runId: completed.id, sessionId: completed.sessionId })
  const stopped = await round('B-automation', 'B-pause-automation', { toolkits: ['automation'], allowedTools: tools('automation'), message: `${direct} 现在暂停 cross-session-automation，保留记录。` }, ['cron_update'])
  hasTool(stopped, 'cron_update'); assert.equal((await api('GET', '/cron/' + job.id)).enabled, false)
  record('B pauses automation after verified run')

  // The manager must choose a usable skill binding itself; the driver never rewrites its Agent config.
  const combo = await round('A-combined', 'A-bind-created-skill-to-agent', { toolkits: ['skill-management', 'agent-management'], allowedTools: tools('skill-management', 'agent-management'),
    message: `${direct} 先用skill_list和skill_get查找已有cross-session-format，再创建Agent cross-session-combined，使它绑定这个技能，allowedTools=["list_skills","get_skill"]，model=${modelId}，mcpServers=[]，knowledgeBases=[]。systemPrompt要求始终读取并遵循所绑定技能，不能在systemPrompt复制技能正文。正确选择技能执行绑定字段。` }, ['agent_create'])
  hasTool(combo, 'skill_list'); hasTool(combo, 'agent_create')
  const combined = (await api('GET', '/agents')).find(item => item.name === 'cross-session-combined'); assert.ok(combined)
  const combinedUse = await round('B-combined', 'B-use-agent-with-A-skill', { agentId: combined.id, skills: undefined, allowedTools: undefined,
    message: '请按你绑定的技能处理：数量3，单价11。请实际读取技能，再输出所要求的JSON。' })
  hasTool(combinedUse, 'get_skill'); assert.deepEqual(jsonAnswer(combinedUse), { receipt: markers.skill, total: 33 })
  record('AI binds managed skill to Agent; B uses it without driver ID conversion', { bindings: combined.skills })
  const outside = await api('GET', '/skills?available=1&path=' + encodeURIComponent(otherWorkspace))
  assert.ok(!(Array.isArray(outside) ? outside : outside.list).some(item => item.name === skill.name))
  record('Project skill does not leak into another workspace')
  if (process.argv.includes('--extended')) {
    const changedAgent = await round('B-agent-manager', 'B-update-agent', { toolkits: ['agent-management'], allowedTools: tools('agent-management'),
      message: `${direct} 查询Agent cross-session-agent，读取详情后更新它的systemPrompt为：用户问回执时，只回答 ${markers.agent}_UPDATED 。其他字段保留，禁止新建。` }, ['agent_update'])
    hasTool(changedAgent, 'agent_update')
    const cAgent = await round('C-agent', 'C-use-updated-agent', { agentId: agent.id, message: '请提供回执。' })
    assert.ok(answer(cAgent).includes(markers.agent + '_UPDATED'))
    record('C observes Agent configuration updated by B')
    const changedSkill = await round('B-skill-manager', 'B-update-skill', { toolkits: ['skill-management'], allowedTools: tools('skill-management'),
      message: `${direct} 查找并读取cross-session-format，使用真实hash更新它，保留frontmatter和原receipt，把total规则改为数量乘单价再加1。不要重建。` }, ['skill_update'])
    hasTool(changedSkill, 'skill_update')
    const cSkill = await round('C-skill', 'C-use-updated-skill', { skills: [skill.id], allowedTools: ['get_skill'],
      message: '读取已选择的cross-session-format技能，并处理数量6、单价13，按技能输出JSON。' })
    hasTool(cSkill, 'get_skill'); assert.deepEqual(jsonAnswer(cSkill), { receipt: markers.skill, total: 79 })
    record('C uses skill revision updated by B')
    const disabledSkill = await round('B-skill-manager', 'B-disable-skill', { toolkits: ['skill-management'], allowedTools: tools('skill-management'),
      message: `${direct} 现在停用cross-session-format，保留目录。` }, ['skill_set_enabled'])
    hasTool(disabledSkill, 'skill_set_enabled')
    const disabledCatalogue = await api('GET', '/skills?available=1&path=' + encodeURIComponent(workspace))
    assert.ok(!(Array.isArray(disabledCatalogue) ? disabledCatalogue : disabledCatalogue.list).some(item => item.name === skill.name))
    record('Disabled skill disappears from B/C execution catalogue')
    const removedSkill = await round('B-skill-manager', 'B-delete-skill', { toolkits: ['skill-management'], allowedTools: tools('skill-management'),
      message: `${direct} 删除已停用的cross-session-format，再用skill_list核对它不再存在。` }, ['skill_delete'])
    hasTool(removedSkill, 'skill_delete')
    const { existsSync } = await import('node:fs'); assert.equal(existsSync(join(workspace, '.ae/skills/cross-session-format')), false)
    record('B deletes A-created skill directory')
    const kbLife = await round('B-knowledge-manager', 'B-update-search-delete-knowledge', { toolkits: ['knowledge-management'], allowedTools: tools('knowledge-management'),
      message: `${direct} 用knowledge_list查找cross-session-knowledge，用knowledge_get读取库，将描述更新为“B已维护”。列出文档，将原文档内容通过knowledge_document_update替换为“跨会话更新检索凭据 cedaruniqueupdated ${markers.knowledge}_UPDATED”。读取核对，再用knowledge_search查询cedaruniqueupdated并确认命中，然后删除该文档，最后删除空知识库。不得新建资源。` },
      ['knowledge_update', 'knowledge_document_update', 'knowledge_document_delete', 'knowledge_delete'])
    for (const name of ['knowledge_list', 'knowledge_get', 'knowledge_update', 'knowledge_document_update', 'knowledge_search', 'knowledge_document_delete', 'knowledge_delete']) hasTool(kbLife, name)
    const searchResult = historyTools(kbLife).find(item => item.toolName === 'knowledge_search')
    assert.ok(JSON.stringify(searchResult).includes('cedaruniqueupdated'))
    assert.ok(!(await api('GET', '/knowledge/bases')).some(item => item.id === kb.id))
    record('B updates, searches and deletes A-created knowledge and document')
    const mcpLife = await round('B-mcp-manager', 'B-update-disable-delete-mcp', { toolkits: ['mcp-management'], allowedTools: tools('mcp-management'),
      message: `${direct} 用mcp_server_list和get读取项目服务cross-session-mcp，修改description为“B已维护”，读取新版expectedRevision后停用，再读取最新版本删除，最后list核对不存在。保留原command和args直到删除，不新建。` }, ['mcp_server_update', 'mcp_server_set_enabled', 'mcp_server_delete'])
    for (const name of ['mcp_server_list', 'mcp_server_get', 'mcp_server_update', 'mcp_server_set_enabled', 'mcp_server_delete']) hasTool(mcpLife, name)
    assert.ok(!(await api('GET', '/mcp/servers?path=' + encodeURIComponent(workspace))).some(item => item.id === 'cross-session-mcp'))
    record('B updates, disables and deletes A-configured MCP service')
    const cronLife = await round('B-automation', 'B-preview-delete-automation', { toolkits: ['automation'], allowedTools: tools('automation'),
      message: `${direct} 使用cron_list读取cross-session-automation，用cron_preview预览它未来3次时间，再删除已暂停的计划，保留运行历史。` }, ['cron_delete'])
    hasTool(cronLife, 'cron_preview'); hasTool(cronLife, 'cron_delete')
    assert.ok(!(await api('GET', '/cron')).some(item => item.id === job.id))
    assert.ok((await api('GET', `/cron/${job.id}/runs`)).items.some(item => item.id === completed.id))
    record('B previews and deletes automation while keeping actual run history')
    const removeAgent = await round('B-agent-manager', 'B-delete-agent', { toolkits: ['agent-management'], allowedTools: tools('agent-management'),
      message: `${direct} 删除cross-session-agent，保留其他Agent；用列表核对。` }, ['agent_delete'])
    hasTool(removeAgent, 'agent_delete'); assert.ok(!(await api('GET', '/agents')).some(item => item.id === agent.id))
    record('B deletes A-created Agent')
    const invoked = new Set(report.rounds.flatMap(item => item.tools))
    report.managementToolCoverage = Object.fromEntries(Object.entries(toolkits).map(([name, list]) => [name, { invoked: list.filter(tool => invoked.has(tool)), missing: list.filter(tool => !invoked.has(tool)) }]))
    for (const [name, coverage] of Object.entries(report.managementToolCoverage)) assert.deepEqual(coverage.missing, [], name + ' has untested tools')
    record('Every management tool across five packages invoked by the real model')
  }
  }
  report.status = 'passed'; report.completedAt = new Date().toISOString(); save('report.json', report)
  progress(`PASS ${report.cases.length} checks; evidence ${root}`)
} catch (error) {
  report.status = 'failed'; report.error = redact(error.stack || String(error)); save('report.json', report); progress(report.error); process.exitCode = 1
} finally { await stop(); progress(`Evidence ${root}`) }

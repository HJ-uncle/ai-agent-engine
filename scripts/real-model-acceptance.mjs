/**
 * Opt-in, paid real-model acceptance through the real Electron composer.
 * node scripts/real-model-acceptance.mjs --check-credentials
 * node scripts/real-model-acceptance.mjs --run
 * Build both repositories first; run Electron suites serially.
 * Only synthetic project data is sent to the configured external model.
 */
import assert from 'node:assert/strict'
import { createHash, createDecipheriv, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ideRoot = resolve(process.env.AETHER_ACCEPTANCE_IDE_ROOT || join(engineRoot, '..', 'aether-code'))
const sourceDb = resolve(process.env.AETHER_ACCEPTANCE_SOURCE_DB || join(engineRoot, 'data', 'agent.db'))
const modelId = process.env.AETHER_ACCEPTANCE_MODEL || 'deepseek-v4.1-flash'
const runEnabled = process.argv.includes('--run')
const credentialCheck = process.argv.includes('--check-credentials')
const turnTimeout = Number(process.env.AETHER_ACCEPTANCE_TURN_TIMEOUT_MS || 600_000)
const secrets = []
let fixture, app, page, expect, electron, phase = 'preflight'
const report = { modelId, startedAt: new Date().toISOString(), status: 'running', phases: [], rounds: [] }

function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
}
function save(name, value) { writeFileSync(join(fixture, name), redact(value), 'utf8') }
function progress(value) { console.log(`[real-model] ${redact(value)}`) }
function fail(message) { throw new Error(message) }
function sha(value) { return createHash('sha256').update(value).digest('hex') }

function loadModelReadOnly() {
  const db = new DatabaseSync(sourceDb, { readOnly: true })
  let row
  try {
    row = db.prepare('SELECT provider,model_id,api_key,base_url,display_name,capabilities FROM models WHERE model_id=? AND is_enabled=1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get(modelId)
  } finally { db.close() }
  if (!row) fail(`No enabled model ${modelId} in the read-only source DB`)
  // Match the existing development fallback without loading .env or initializing its DB.
  const source = readFileSync(join(engineRoot, 'src', 'utils', 'encryption.ts'), 'utf8')
  const fallback = source.match(/ENCRYPTION_KEY_HEX\s*=\s*'([0-9a-f]+)'/i)?.[1]
  const key = process.env.AETHER_ACCEPTANCE_SOURCE_KEY || process.env.ENCRYPTION_KEY || fallback
  secrets.push(key)
  let apiKey
  try {
    const [iv, tag, data] = String(row.api_key).split(':')
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key || '', 'hex'), Buffer.from(iv, 'hex'))
    cipher.setAuthTag(Buffer.from(tag, 'hex'))
    apiKey = Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString('utf8')
    if (!apiKey) throw new Error('empty')
  } catch { fail('Source credential could not be decrypted. Set AETHER_ACCEPTANCE_SOURCE_KEY in memory to the source encryption key; no source data was changed.') }
  secrets.push(apiKey)
  const endpoint = new URL(row.base_url)
  assert.equal(endpoint.protocol, 'https:', 'Real-model acceptance requires the configured HTTPS provider')
  return { provider: row.provider, modelId: row.model_id, apiKey, baseUrl: row.base_url, displayName: row.display_name || row.model_id,
    isEnabled: true, tenantId: 'default', capabilities: row.capabilities ? JSON.parse(row.capabilities) : null }
}

function cleanEnvironment() {
  const result = { ...process.env }
  for (const name of Object.keys(result)) {
    if (/API_?KEY|TOKEN|SECRET|ENCRYPTION_KEY|AETHER_ACCEPTANCE_SOURCE_KEY|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS/i.test(name)) delete result[name]
  }
  return result
}

function launchEnvironment() {
  return { ...cleanEnvironment(), AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist', 'main.js'), AUTH_ENABLED: 'false',
    HISTORY_BACKEND: 'jsonl', LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: modelId, LLM_MODEL: modelId, LLM_FALLBACK_MODEL: '',
    DEFAULT_SECURITY_MODE: 'full-access', OSM_MODE: 'methodology', MAX_ITERATIONS: '32', ENABLE_LONG_TERM_MEMORY: 'false',
    AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'),
    MCP_CONFIG_PATH: join(fixture, 'workspace', '.aether', 'mcp.json'), SKILLS_ROOT: join(fixture, 'builtin-skills'),
    QA_LOG_DIR: join(fixture, 'qa'), LOG_LEVEL: 'warn' }
}

async function launch() {
  app = await electron.launch({ args: ['.', `--user-data-dir=${join(fixture, 'profile')}`], cwd: ideRoot, env: launchEnvironment(), timeout: 90_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await expect(page.locator('.status-bar')).toBeVisible()
}

async function seedIsolatedModel(model) {
  const key = randomBytes(32).toString('hex')
  secrets.push(key)
  // Persist only OS-encrypted key material. Refuse a plaintext safeStorage fallback.
  const encryptedKey = await app.evaluate(({ safeStorage }, value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable')
    return safeStorage.encryptString(value).toString('base64')
  }, key)
  const keyDir = join(fixture, 'profile', 'engine', 'secrets')
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'engine-secrets.json'), JSON.stringify({ encrypted: true, encryptionKey: encryptedKey }))
  const previousData = process.env.DATA_DIR, previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = join(fixture, 'profile', 'engine', 'state', 'agent.db')
  process.env.ENCRYPTION_KEY = key
  const module = path => import(pathToFileURL(join(engineRoot, 'dist', path)).href)
  try {
    const { initDb, closeDb } = await module('storage/sqlite/db.js')
    const { ModelsStore } = await module('storage/sqlite/models.js')
    const { systemConfigStore } = await module('storage/sqlite/system-config.js')
    await initDb()
    await new ModelsStore().createModel(model)
    for (const [name, value] of Object.entries({ LLM_PROVIDER: model.provider, LLM_PRIMARY_MODEL: modelId, LLM_MODEL: modelId,
      LLM_FALLBACK_MODEL: '', DEFAULT_SECURITY_MODE: 'full-access', OSM_MODE: 'methodology', MAX_ITERATIONS: '32', HISTORY_BACKEND: 'jsonl' })) {
      await systemConfigStore.set(name, value, false)
    }
    closeDb()
  } finally {
    if (previousData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousData
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = previousKey
  }
}

async function request(method, path, body, query) {
  const result = await page.evaluate(input => window.aether.engine.request(input), { method, path, ...(body === undefined ? {} : { body }), ...(query ? { query } : {}) })
  if (!result.ok) fail(`Engine ${method} ${path} failed: ${redact(result.error || result.message || 'unknown error')}`)
  return result.data
}

async function openSettings(tab) {
  if (!await page.locator('.app-settings').isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}

async function installResources(skillPath, policy, sessionId) {
  phase = 'skill-import-ui'
  await openSettings('技能')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择文件…', exact: true }).click()
  await (await chooser).setFiles(skillPath)
  await expect(page.locator('.skills-import-status')).toHaveClass(/is-imported/, { timeout: 60_000 })
  await expect(page.locator('.skills-card').filter({ hasText: 'Acceptance Checkout' })).toBeVisible()
  const skills = await request('GET', '/skills', undefined, { path: join(fixture, 'workspace'), reload: 1 })
  assert.ok(skills.list.some(item => item.name === 'Acceptance Checkout' && item.enabled !== false))
  report.phases.push({ name: phase, status: 'passed' })

  phase = 'mcp-config-ui'
  await openSettings('MCP')
  await page.getByRole('button', { name: '新增服务器', exact: true }).click()
  await page.getByLabel('MCP id', { exact: true }).fill('acceptance-catalog')
  await page.getByLabel('MCP 名称', { exact: true }).fill('Acceptance Catalog')
  await page.getByLabel('MCP 命令', { exact: true }).fill(process.execPath)
  await page.getByLabel('MCP 参数', { exact: true }).fill(JSON.stringify([join(fixture, 'catalog-mcp.cjs')]))
  await page.locator('.mcp-form').getByRole('button', { name: '保存', exact: true }).click()
  const server = page.locator('.mcp-server-block').filter({ hasText: 'Acceptance Catalog' })
  await expect(server).toBeVisible()
  await server.getByRole('button', { name: '测试', exact: true }).click()
  await expect(page.locator('.mcp-notice')).toContainText('发现 1 个工具', { timeout: 60_000 })
  const config = JSON.parse(readFileSync(join(fixture, 'workspace', '.aether', 'mcp.json'), 'utf8'))
  assert.equal(config.mcpServers['acceptance-catalog'].enabled, true)
  report.phases.push({ name: phase, status: 'passed' })

  phase = 'knowledge-create-and-bind-ui'
  await openSettings('知识库')
  await page.getByLabel('知识库名称', { exact: true }).fill('Acceptance Checkout Policy')
  await page.getByLabel('知识库描述', { exact: true }).fill('Synthetic checkout pricing rules for real-model development acceptance')
  await page.getByRole('button', { name: '新建知识库', exact: true }).click()
  await expect(page.locator('#knowledge-base-select')).toContainText('Acceptance Checkout Policy')
  await page.locator('#knowledge-base-select').selectOption({ label: 'Acceptance Checkout Policy' })
  await page.getByLabel('文档文件名', { exact: true }).fill('checkout-policy.md')
  await page.getByLabel('文档内容', { exact: true }).fill(policy)
  await page.getByRole('button', { name: '上传并索引', exact: true }).click()
  await expect(page.locator('.knowledge-document').filter({ hasText: 'checkout-policy.md' })).toBeVisible()
  const picker = page.getByRole('button', { name: '选择知识库', exact: true })
  await picker.click()
  await page.getByRole('menu', { name: '知识库选择', exact: true }).getByRole('menuitemcheckbox', { name: /Acceptance Checkout Policy/ }).click()
  await expect(picker).toContainText('知识库：1 个')
  await page.keyboard.press('Escape')
  const bases = await request('GET', '/knowledge/bases')
  const kb = bases.find(item => item.name === 'Acceptance Checkout Policy')
  assert.ok(kb?.id)
  assert.equal(await page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), kb.id), true)
  report.phases.push({ name: phase, status: 'passed', kbId: kb.id, sessionId })
  return kb.id
}

function allToolRows(snapshot) { return (snapshot.history || []).filter(item => item.role === 'tool') }
function toolNames(snapshot) { return allToolRows(snapshot).map(item => item.toolName).filter(Boolean) }
async function snapshot(sessionId) { return request('GET', '/chat/snapshot', undefined, { sessionId }) }

async function sendRound(sessionId, round, prompt) {
  phase = `round-${round}`
  const previous = await snapshot(sessionId)
  const previousRun = previous.run?.runId
  await page.keyboard.press('Escape')
  await page.locator('.chat__input').fill(prompt)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const deadline = Date.now() + turnTimeout
  let next, loggedAt = 0
  while (Date.now() < deadline) {
    next = await snapshot(sessionId)
    const run = next.run
    if (run && run.runId !== previousRun) {
      if (run.status === 'succeeded') break
      if (['failed', 'cancelled', 'interrupted', 'waiting'].includes(run.status)) fail(`Round ${round} ended ${run.status}: ${redact(run.stopReason || run.error || '')}`)
    }
    if (Date.now() - loggedAt > 30_000) { progress(`Round ${round}: ${run?.status || 'admitting'}, ${allToolRows(next).length} persisted tool results`); loggedAt = Date.now() }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000))
  }
  assert.ok(next?.run?.runId !== previousRun && next?.run?.status === 'succeeded', `Round ${round} did not succeed within ${turnTimeout} ms`)
  // IDs are normally durable, but slice by the pre-turn count as a safe fallback
  // for history backends that omit an id while persisting a live row.
  const history = (next.history || []).slice((previous.history || []).length)
  assert.ok(history.some(item => item.role === 'assistant' && typeof item.content === 'string' && item.content.trim()), 'Missing persisted assistant response')
  assert.ok(history.some(item => item.role === 'tool'), 'A text-only response does not pass development acceptance')
  const actualModel = next.run.actualModelId || history.find(item => item.modelId)?.modelId
  assert.equal(actualModel, modelId, 'A fallback/fixture model must not pass as the requested real model')
  save(`round-${round}.json`, { run: next.run, history, commandJobs: next.commandJobs })
  await page.screenshot({ path: join(fixture, `round-${round}.png`) })
  report.rounds.push({ round, runId: next.run.runId, actualModel, status: 'passed', toolNames: history.filter(item => item.role === 'tool').map(item => item.toolName) })
  return { ...next, history }
}

function runProjectTests(label) {
  const workspace = join(fixture, 'workspace')
  const tests = readdirSync(join(workspace, 'test')).filter(file => file.endsWith('.test.mjs')).map(file => join('test', file))
  assert.ok(tests.length > 0, 'The model did not create any executable tests')
  let result
  try { result = { status: 0, stdout: execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: workspace, env: cleanEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 60_000 }) } }
  catch (error) { result = { status: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') } }
  save(`${label}-tests.json`, result)
  return result
}

function independentOracle(discountBps, freeShippingCents, shippingCents) {
  const file = pathToFileURL(join(fixture, 'workspace', 'src', 'quote.mjs')).href
  const program = `import assert from 'node:assert/strict';import {quote} from ${JSON.stringify(file)};const d=${discountBps},t=${freeShippingCents},s=${shippingCents};for(const items of [[{unitCents:1000,qty:2}],[{unitCents:t,qty:1}],[{unitCents:t-1,qty:1}],[{unitCents:333,qty:3},{unitCents:147,qty:2}]]){const subtotalCents=items.reduce((n,i)=>n+i.unitCents*i.qty,0),discountCents=Math.round(subtotalCents*d/10000),shippingCents=subtotalCents>=t?0:s;assert.deepEqual(quote(items),{subtotalCents,discountCents,shippingCents,totalCents:subtotalCents-discountCents+shippingCents})}for(const bad of [[{unitCents:-1,qty:1}],[{unitCents:1,qty:0}],[{unitCents:1.5,qty:1}],[{unitCents:1,qty:1.5}],null])assert.throws(()=>quote(bad));console.log('INDEPENDENT_ORACLE_OK')`
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: join(fixture, 'workspace'), env: cleanEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.ok(output.includes('INDEPENDENT_ORACLE_OK'))
  save('independent-oracle.txt', output)
}

async function main() {
  if (!runEnabled && !credentialCheck) {
    console.log('No model calls or Electron launch performed. Use --check-credentials for a read-only credential check; use --run for paid real-model Electron acceptance. See scripts/real-model-acceptance.md.')
    return
  }
  assert.ok(Number.isFinite(turnTimeout) && turnTimeout >= 30_000, 'Invalid turn timeout')
  const model = loadModelReadOnly()
  progress(`Read-only model lookup and in-memory credential decryption passed: ${modelId}`)
  if (!runEnabled) return
  for (const file of [join(engineRoot, 'dist', 'main.js'), join(engineRoot, 'dist', 'runtime', 'build-manifest.json'), join(ideRoot, 'out', 'main', 'index.js')]) assert.ok(existsSync(file), `Build artifact missing: ${file}`)
  const ideRequire = createRequire(join(ideRoot, 'package.json'))
  ;({ _electron: electron, expect } = ideRequire('@playwright/test'))
  const fixtureRoot = join(engineRoot, '.e2e-tmp')
  mkdirSync(fixtureRoot, { recursive: true })
  fixture = mkdtempSync(join(fixtureRoot, 'real-model-'))
  progress(`Isolated output: ${fixture}`)
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  for (const dir of [workspace, profile, join(workspace, '.aether'), join(fixture, 'builtin-skills')]) mkdirSync(dir, { recursive: true })
  const sessionId = `real-model-${randomBytes(6).toString('hex')}`
  const skillStamp = `SKILL_${randomBytes(8).toString('hex')}`, catalogStamp = `MCP_${randomBytes(8).toString('hex')}`, policyStamp = `KB_${randomBytes(8).toString('hex')}`
  const discountBps = 725, freeShippingCents = 5300, shippingCents = 390
  const policy = `CHECKOUT_ACCEPTANCE_POLICY. All amounts are integer cents. Shipping costs ${shippingCents} cents when subtotalCents is below ${freeShippingCents}; free shipping at or above ${freeShippingCents}. Compare the original subtotal before discount. Apply MCP discountBps: discountCents=Math.round(subtotalCents*discountBps/10000). totalCents=subtotalCents-discountCents+shippingCents. Reject non-array items, negative/noninteger unitCents, nonpositive/noninteger qty. policyStamp: ${policyStamp}.`
  const skill = `---\nname: Acceptance Checkout\ndescription: Implement checkout code, tests, and regression fixes using the catalog MCP and bound checkout policy.\n---\nUse the catalog requirements MCP and the bound CHECKOUT_ACCEPTANCE_POLICY. Export quote(items) as a named ESM function in src/quote.mjs; return exactly subtotalCents, discountCents, shippingCents, totalCents. Write test/*.test.mjs using node:test and strict assertions (at least six cases). Use no dependencies, no network from the generated application. Write README.md. Write resource-evidence.json with skillStamp, catalogStamp, policyStamp from their actual resources. skillStamp: ${skillStamp}. Use integer money arithmetic and run tests after changes.`
  writeFileSync(join(fixture, 'SKILL.md'), skill)
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'real-model-checkout', private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs' } }, null, 2))
  writeFileSync(join(workspace, '.aether', 'mcp.json'), JSON.stringify({ mcpServers: {} }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12491, autoStartEngine: false, lastSessionId: sessionId, lastModelId: modelId, lastFolder: workspace, thinkingMode: 'off' }))
  const catalog = { discountBps, catalogStamp, sampleItems: [{ unitCents: 1000, qty: 2 }, { unitCents: 3300, qty: 1 }] }
  const mcp = `const fs=require('node:fs');let pending='';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;let n;while((n=pending.indexOf('\\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);if(!line.trim())continue;let q;try{q=JSON.parse(line)}catch{continue}if(q.method==='initialize')send({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'acceptance-catalog',version:'1'}}});else if(q.method==='tools/list')send({jsonrpc:'2.0',id:q.id,result:{tools:[{name:'requirements',description:'Get checkout discount, sample items and catalogStamp. Required before implementing quote.',inputSchema:{type:'object',properties:{}}}]}});else if(q.method==='tools/call'){fs.appendFileSync(${JSON.stringify(join(fixture, 'mcp-calls.jsonl'))},JSON.stringify({method:q.method,name:q.params?.name,time:Date.now()})+'\\n');send({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(${JSON.stringify(catalog)})}]}})}else if(q.id!==undefined)send({jsonrpc:'2.0',id:q.id,result:{}})}});`
  writeFileSync(join(fixture, 'catalog-mcp.cjs'), mcp)
  phase = 'launch-and-isolated-model'
  await launch()
  await seedIsolatedModel(model)
  model.apiKey = ''
  await page.evaluate(() => window.aether.engine.start())
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect(page.locator('.explorer__root')).toHaveAttribute('title', workspace)
  const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
  assert.equal(resolve(engine.dataDir), join(profile, 'engine', 'state', 'agent.db'))
  report.engine = { buildId: engine.buildId, instanceId: engine.instanceId, dataDir: engine.dataDir }
  const kbId = await installResources(join(fixture, 'SKILL.md'), policy, sessionId)
  const context = '这是隔离的真实开发验收，所有修改只在当前工作区，必须实际调用工具并落盘，不要只给示例代码。使用已导入的 Acceptance Checkout skill、MCP acceptance-catalog 的 requirements 工具以及绑定知识库 CHECKOUT_ACCEPTANCE_POLICY。不要从其他目录读取凭据或应用数据。'
  const one = await sendRound(sessionId, 1, `${context}\n第一轮：先 list_skills/get_skill 并调用 MCP requirements，读取绑定策略。实现 src/quote.mjs 的 named export quote(items)，输入每项 unitCents 与 qty，输出精确的 subtotalCents/discountCents/shippingCents/totalCents 四个整数；校验非法参数。金额、折扣与邮费只以资源要求为准。写 README.md 和 resource-evidence.json，JSON 保存三份资源的 skillStamp/catalogStamp/policyStamp。此轮先完成实现，下一轮再补测试。`)
  assert.ok(toolNames(one).includes('get_skill'), 'Round 1 never read the imported skill')
  assert.ok(toolNames(one).some(name => name.startsWith('mcp_acceptance-catalog_')), 'Round 1 never invoked the configured MCP')
  assert.ok(toolNames(one).some(name => ['write_file', 'edit_file', 'apply_patch'].includes(name)), 'Round 1 lacks a persisted file tool result')
  const evidence = JSON.parse(readFileSync(join(workspace, 'resource-evidence.json'), 'utf8'))
  assert.equal(evidence.skillStamp, skillStamp)
  assert.equal(evidence.catalogStamp, catalogStamp)
  assert.equal(evidence.policyStamp, policyStamp)
  assert.ok(readFileSync(join(workspace, 'README.md'), 'utf8').trim().length > 30)
  assert.ok(readFileSync(join(fixture, 'mcp-calls.jsonl'), 'utf8').includes('requirements'))
  save('report.json', report)

  const two = await sendRound(sessionId, 2, `${context}\n第二轮：给实现补至少六个 node:test 测试，放在 test/*.test.mjs，覆盖折扣取整、免邮阈值上下边界、多商品、非法金额和数量。必须通过 execute_cmd 实际运行 node --test test/*.test.mjs，若失败就修代码重测，读回资源凭证确认保留原值。不要改业务规则或删除有效断言。`)
  assert.ok(toolNames(two).includes('execute_cmd'), 'Round 2 did not execute tests through the engine')
  const roundTwoTests = runProjectTests('round-2-independent')
  assert.equal(roundTwoTests.status, 0, 'Independent execution of model-generated tests failed')
  assert.ok(Number(roundTwoTests.stdout.match(/# pass (\d+)/)?.[1]) >= 6, 'Fewer than six passing model-generated tests')
  independentOracle(discountBps, freeShippingCents, shippingCents)
  const quoteFile = join(workspace, 'src', 'quote.mjs'), good = readFileSync(quoteFile, 'utf8')
  writeFileSync(quoteFile, `throw new Error('ACCEPTANCE_INJECTED_REGRESSION');\n${good}`)
  assert.notEqual(runProjectTests('injected-regression').status, 0, 'Injected regression did not make the suite fail')
  report.regression = { beforeSha256: sha(good), injected: true }
  const three = await sendRound(sessionId, 3, `${context}\n第三轮：当前 checkout 模块出现真实回归。先实际执行现有测试确认失败，调查原因并修复生产代码，保留所有测试，重跑直到全绿。更新 README 的排障说明，并确认三份资源凭证没有变化。不要绕过测试或只解释步骤。`)
  const commandRows = allToolRows(three).filter(item => item.toolName === 'execute_cmd')
  const exitCodes = commandRows.map(item => item.metadata?.exitCode ?? item.metadata?.commandJob?.exitCode)
  assert.ok(exitCodes.some(value => typeof value === 'number' && value !== 0), 'Round 3 did not record a real failing command')
  assert.ok(exitCodes.includes(0), 'Round 3 did not record a successful command after repair')
  const finalTests = runProjectTests('round-3-independent')
  assert.equal(finalTests.status, 0)
  assert.ok(Number(finalTests.stdout.match(/# pass (\d+)/)?.[1]) >= 6)
  assert.ok(!readFileSync(quoteFile, 'utf8').includes('ACCEPTANCE_INJECTED_REGRESSION'))
  const repairedEvidence = JSON.parse(readFileSync(join(workspace, 'resource-evidence.json'), 'utf8'))
  assert.equal(repairedEvidence.skillStamp, skillStamp)
  assert.equal(repairedEvidence.catalogStamp, catalogStamp)
  assert.equal(repairedEvidence.policyStamp, policyStamp)
  independentOracle(discountBps, freeShippingCents, shippingCents)

  phase = 'full-electron-restart'
  const before = await snapshot(sessionId), fileHash = sha(readFileSync(quoteFile)), beforeTools = toolNames(before)
  await page.evaluate(() => window.aether.settings.update({ autoStartEngine: true }))
  await app.close(); app = undefined
  await launch()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect.poll(async () => (await snapshot(sessionId)).run?.status, { timeout: 90_000 }).toBe('succeeded')
  const after = await snapshot(sessionId)
  assert.equal(after.run.runId, before.run.runId)
  assert.equal(after.run.status, 'succeeded')
  assert.deepEqual(toolNames(after), beforeTools, 'Restart lost or replayed persisted tool history')
  assert.equal((after.history || []).filter(item => item.role === 'user').length, 3)
  assert.equal(sha(readFileSync(quoteFile)), fileHash)
  assert.equal(await page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), kbId), true)
  await expect(page.locator('.message--user')).toHaveCount(3)
  await expect(page.getByRole('button', { name: '选择知识库', exact: true })).toContainText('知识库：1 个')
  await page.screenshot({ path: join(fixture, 'after-restart.png') })
  save('after-restart.json', { run: after.run, history: after.history, commandJobs: after.commandJobs })
  report.phases.push({ name: phase, status: 'passed' })
  report.status = 'passed'; report.finishedAt = new Date().toISOString()
  save('report.json', report)
  progress('PASS: three real-model development rounds, independent test/oracle checks, resource evidence and full restart recovery.')
}

try { await main() }
catch (error) {
  report.status = 'failed'; report.failedPhase = phase; report.error = redact(error?.message || String(error)); report.finishedAt = new Date().toISOString()
  if (fixture) {
    save('report.json', report)
    try { await page?.screenshot({ path: join(fixture, 'failure.png') }) } catch {}
  }
  console.error(`[real-model] FAIL during ${phase}: ${report.error}`)
  process.exitCode = 1
} finally {
  if (app) { try { await app.close() } catch {} }
  if (fixture) progress(`Retained isolated evidence: ${fixture}`)
}

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRoot = path.resolve(process.argv[2] ?? '')
if (!fs.existsSync(path.join(sourceRoot, 'cleanup-processes.json'))) throw new Error('Source must be a stopped, retained run')
const cleanup = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'cleanup-processes.json'), 'utf8'))
if (cleanup.remaining?.length || cleanup.errors?.length) throw new Error('Source cleanup has unresolved processes')
const start = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'active-start.json'), 'utf8'))
if (start.sessions.length !== 5) throw new Error('Exactly five retained sessions required')
const proofFile = path.resolve(process.argv[3] ?? '')
const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'))
const models = ['MiniMax-M2.5', 'glm-5.3', 'kimi-k2.6', 'qwen3.8-flash', 'deepseek-v4.1-flash']
if (!proof.passed || !models.slice(0, 3).every(model => proof.cases.some(item => item.model === model && item.passed))) throw new Error('New models need successful same-gateway proof')
const stamp = new Date().toISOString().replace(/[-:.]/g, '')
const root = fs.mkdtempSync(path.join(start.projectRoot, 'runs', `continuation-${stamp}-`))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originalFiles = []
const copy = (relative) => {
  const source = path.join(sourceRoot, relative), target = path.join(root, relative)
  if (!fs.existsSync(source)) return
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    for (const child of fs.readdirSync(source)) copy(path.join(relative, child))
  } else {
    const before = hash(source)
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target)
    if (hash(target) !== before || hash(source) !== before) throw new Error(`Copy drift: ${relative}`)
    originalFiles.push({ path: relative, sha256: before })
  }
}
for (const relative of ['agent.db', 'agent.db-wal', 'agent.db-shm', 'knowledge.db', 'knowledge.db-wal', 'knowledge.db-shm', 'sessions', 'memory', 'global', 'workspace', 'skills']) copy(relative)
const db = new DatabaseSync(path.join(root, 'agent.db'))
try {
  db.exec('PRAGMA busy_timeout=10000')
  const columns = db.prepare('PRAGMA table_info(models)').all().map(row => row.name)
  const template = db.prepare('SELECT * FROM models WHERE tenant_id=? AND model_id=? AND is_enabled=1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get('default', 'deepseek-v4.1-flash')
  if (!template || new URL(template.base_url).host !== proof.host) throw new Error('Gateway proof does not match cloned credentials')
  db.exec('BEGIN IMMEDIATE')
  for (const model of models.slice(0, 3)) {
    const existing = db.prepare('SELECT id FROM models WHERE tenant_id=? AND model_id=? AND deleted_at IS NULL').get('default', model)
    if (existing) continue
    const record = { ...template, id: randomUUID(), model_id: model, provider: 'anthropic', display_name: model,
      capabilities: JSON.stringify({ contextWindow: 100000, toolCalling: true }), created_at: Date.now(), updated_at: Date.now() }
    const names = columns.filter(name => Object.hasOwn(record, name))
    db.prepare(`INSERT INTO models (${names.map(name => '"' + name + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(name => record[name]))
  }
  for (const row of db.prepare('SELECT id,capabilities FROM models WHERE deleted_at IS NULL').all()) {
    let caps = {}; try { caps = JSON.parse(row.capabilities || '{}') } catch { /* Restore a valid capability object. */ }
    db.prepare('UPDATE models SET capabilities=? WHERE id=?').run(JSON.stringify({ ...caps, contextWindow: 100000 }), row.id)
  }
  db.exec('COMMIT')
  const check = Object.values(db.prepare('PRAGMA quick_check').get())[0]
  if (check !== 'ok') throw new Error('Continuation clone quick_check failed')
} finally { db.close() }
fs.writeFileSync(path.join(root, '.instance-token'), randomBytes(32).toString('hex'), { mode: 0o600 })
fs.writeFileSync(path.join(root, 'mcp.json'), '{"mcpServers":{}}\n')
fs.copyFileSync(proofFile, path.join(root, 'gateway-preflight.json'))
for (const name of ['logs', 'resources', 'checkpoints']) fs.mkdirSync(path.join(root, name), { recursive: true })
const oracle = { scope: 'Expected answers must never be included in later probe prompts', sessions: start.sessions.map((session, index) => {
  const code = `LR5-${session.roleId}-${7913 + index}`
  const quota = [37, 43, 59, 61, 73][index]
  return { sessionId: session.sessionId, roleId: session.roleId,
    seedMessage: `本轮新增且长期生效的项目决策：本职责决策编号是 ${code}，迁移批次最多 ${quota} 条；失败重试必须复用同一幂等键。待办核验点叫 continuity-${index + 1}-refund-proof，完成验收前不能标记完成。请通过remember写入当前会话记忆；这些决策只作用当前会话。后续用户更正优先。`,
    probes: [
      { id: 'original-decision', kind: 'exact-fact', question: '本职责最早确定的决策编号是什么？请给出原消息ID或记忆证据，不要猜测。', expectedPatterns: [code] },
      { id: 'current-quota', kind: 'numeric-and-policy', question: '本职责当前迁移批次数量上限及失败重试对幂等键的约定是什么？请回查原始会话。', expectedPatterns: [String(quota), '幂等'] },
      { id: 'unfinished-checkpoint', kind: 'unfinished-work', question: '本职责当初约定的未完成核验点叫什么？在没有新验收证据时应处于什么状态？', expectedPatterns: [`continuity-${index + 1}-refund-proof`, '未完成|不能.*完成|待验收'] },
    ],
    corrections: [{ id: 'quota-correction', message: `更正本职责迁移批次上限：从现在起改为 ${quota + 10} 条，原上限被覆盖；决策编号和幂等键约定继续有效。`,
      probes: [{ id: 'corrected-quota', kind: 'superseded-fact', question: '用户更正后，本职责当前迁移批次上限是多少？说明旧值是否还生效，并引用原消息。', expectedPatterns: [String(quota + 10), '覆盖|不再|旧值|失效'] }] }],
  }
}) }
fs.writeFileSync(path.join(root, 'history-oracle.json'), JSON.stringify(oracle, null, 2) + '\n')
const state = { at: new Date().toISOString(), root, sourceRoot, projectRoot: start.projectRoot, sessions: start.sessions.map(({ index, sessionId, roleId, workspace, agentId }) => ({ index, sessionId, roleId, workspace, agentId })), models,
  contextWindow: 100000, memoryScope: 'session', copiedFiles: originalFiles.length, sourcePreserved: true, sourceFiles: originalFiles,
  credentialScope: 'Existing HTTPS gateway; changes only in retained continuation clone', gatewayPreflight: path.join(root, 'gateway-preflight.json'), historyOracle: path.join(root, 'history-oracle.json') }
fs.writeFileSync(path.join(root, 'continuation-state.json'), JSON.stringify(state, null, 2) + '\n')
console.log(JSON.stringify({ root, sourceRoot, models, contextWindow: 100000, memoryScope: 'session', copiedFiles: originalFiles.length, sourcePreserved: true }))

/**
 * Real importer/runtime/registry/SQLite acceptance with no model or mocks.
 * Set PLUGIN_ACCEPTANCE_ROOT to a NEW absolute directory, then run:
 * npx tsx scripts/plugin-adversarial-acceptance.ts
 * Fixtures and evidence are retained. Production state is never selected.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { AgentContext, ToolResult } from '../src/core/agent-context/types.js'
import type { PluginManifest } from '../src/plugins/types.js'

const requestedRoot = process.env.PLUGIN_ACCEPTANCE_ROOT
assert(requestedRoot && path.isAbsolute(requestedRoot), 'Set PLUGIN_ACCEPTANCE_ROOT to a new absolute directory')
const root = path.resolve(requestedRoot)
assert(!fs.existsSync(root), 'Acceptance root must not exist; existing files are never deleted')
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(path.join(root, 'ACCEPTANCE-ONLY.txt'), 'Isolated acceptance fixtures and evidence.\n', { flag: 'wx' })
process.env.DATA_DIR = path.join(root, 'state', 'agent.db')
process.env.AUTH_ENABLED = 'false'
process.env.OSM_MODE = 'off'
process.env.SKILLS_ROOT = path.join(root, 'skills')
process.env.GLOBAL_SKILLS_ROOT = path.join(root, 'global-skills')
process.env.DEFAULT_SECURITY_MODE = 'standard'

const businessChecks: Record<string, unknown>[] = [], negativeChecks: Record<string, unknown>[] = []
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(), root, productionDataTouched: false,
  execution: 'real importer + immutable service + child-process runtime + selected registry + on-disk SQLite ChangeStore',
  businessChecks, negativeChecks,
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const saveEvidence = () => fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
function write(relative: string, value: string | Buffer) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, value, { flag: 'wx' })
  return target
}
function ok(value: ToolResult): { result: any; artifacts: unknown[] } {
  assert.equal(value.success, true, value.output)
  return JSON.parse(value.output)
}

// Dynamic imports ensure every singleton sees the isolated DATA_DIR.
const database = await import('../src/storage/sqlite/db.js')
const { PluginService } = await import('../src/plugins/service.js')
const { PluginImporter } = await import('../src/plugins/importer.js')
const { runPlugin } = await import('../src/plugins/runtime.js')
const { pluginToolkitId, pluginToolName } = await import('../src/plugins/catalogue.js')
const { createToolRegistry } = await import('../src/tools/registry-factory.js')
const { ChangeStore } = await import('../src/storage/changes/index.js')
const { setSecurityMode, clearSecurityMode } = await import('../src/security/policy-engine.js')
const { skillsRegistry } = await import('../src/skills/index.js')
const tenantId = 'default', service = new PluginService(), importer = new PluginImporter(service), store = new ChangeStore()
const sessions: string[] = []
function context(name: string): AgentContext {
  const workspace = path.join(root, 'workspaces', name)
  fs.mkdirSync(workspace, { recursive: true })
  sessions.push(name)
  setSecurityMode(tenantId, name, 'standard')
  return { tenantId, sessionId: name, workspacePaths: [workspace], projectRoot: workspace, cwd: workspace,
    toolProfile: 'general', logger: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as AgentContext
}
async function registryFor(manifest: PluginManifest, ctx: AgentContext) {
  return (await createToolRegistry({
    workspaceRoot: ctx.cwd, allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true,
    memoryScope: 'off', securityContext: { tenantId, sessionId: ctx.sessionId },
    toolkits: [pluginToolkitId(manifest.id, 1)],
  })).registry
}
async function rejection(name: string, run: () => Promise<unknown>, expectedCode?: string) {
  const started = Date.now()
  let rejected: any
  try { await run() } catch (error) { rejected = error }
  assert(rejected, name + ' must reject')
  if (expectedCode) assert.equal(rejected.code, expectedCode, name + ': ' + String(rejected))
  negativeChecks.push({ name, outcome: 'rejected', code: rejected.code, message: String(rejected.message), durationMs: Date.now() - started })
}
async function refused(name: string, run: () => Promise<ToolResult>) {
  const result = await run()
  assert.equal(result.success, false, name + ' must refuse')
  negativeChecks.push({ name, outcome: 'refused', message: result.output })
}

try {
  await database.initDb()
  // A: a distributable ZIP with multiple entrypoints and nested relative imports.
  const a: PluginManifest = {
    apiVersion: 1, id: 'acceptance-artifacts', name: 'Unicode artifact workshop', version: '1.0.0',
    description: 'Produce exact text and binary deliverables and inspect Unicode text', runtime: 'node',
    tools: [
      { name: 'produce', description: 'Produce an exact report and attachment', inputSchema: { type: 'object', properties: {} }, entry: 'tools/produce/main.mjs' },
      { name: 'inspect', description: 'Inspect Unicode code points', inputSchema: { type: 'object', properties: {} }, entry: 'tools/inspect.mjs' },
    ],
  }
  const aFiles = {
    'aether-plugin.json': JSON.stringify(a),
    'lib/shared.mjs': "export const text = '标题：插件验收 🍎\\r\\n第二行：中文、café、e\\u0301\\r\\n'; export const bytes = [0,255,128,13,10,65,0,254]; export const count = value => [...value].length;",
    'tools/produce/main.mjs': "import {text,bytes,count} from '../../lib/shared.mjs'; let raw='';for await(const chunk of process.stdin)raw+=chunk;const {args}=JSON.parse(raw);console.log('plugin diagnostic before final JSON');console.log(JSON.stringify({result:{title:'验收完成',codePoints:count(text)},artifacts:args.artifacts??[{path:'成果/报告.txt',content:text},{path:'成果/附件.bin',content:Buffer.from(bytes).toString('base64'),encoding:'base64'}]}));",
    'tools/inspect.mjs': "import {count} from '../lib/shared.mjs';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {args}=JSON.parse(raw);console.log(JSON.stringify({result:{codePoints:count(args.text),utf8Bytes:Buffer.byteLength(args.text)}}));",
  }
  const archive = zipSync(Object.fromEntries(Object.entries(aFiles).map(([name, value]) => ['wrapped-plugin/' + name, strToU8(value)])))
  const archiveFile = write('sources/artifacts.zip', Buffer.from(archive))
  const aJob = await importer.previewImport(tenantId, { type: 'zip', path: archiveFile })
  assert.equal(aJob.status, 'prepared')
  assert.equal((await service.list(tenantId)).length, 0, 'Preview must not install a plugin')
  await importer.installImport(tenantId, aJob.jobId)
  const aDraft = await service.snapshot(tenantId, a.id, 1, { allowDraft: true })
  const draftResult = await runPlugin(aDraft, 'inspect', { text: '中文🍎' })
  assert.deepEqual(draftResult.result, { codePoints: 3, utf8Bytes: 10 })
  await service.publish(tenantId, a.id, 1)
  const aCtx = context('artifact-business'), aRegistry = await registryFor(a, aCtx)
  const aNames = a.tools.map(tool => pluginToolName(a.id, tool.name))
  assert(aNames.every(name => aRegistry.listForRequest().some(tool => tool.name === name)), 'Selected tools must reach model request definitions')
  assert.deepEqual(ok(await aRegistry.execute(aNames[1], { text: '中文🍎' }, aCtx)).result, { codePoints: 3, utf8Bytes: 10 })
  const produced = await aRegistry.execute(aNames[0], {}, aCtx)
  assert.equal(ok(produced).result.title, '验收完成')
  const expected = [
    ['成果/报告.txt', Buffer.from('标题：插件验收 🍎\r\n第二行：中文、café、e\u0301\r\n')],
    ['成果/附件.bin', Buffer.from([0, 255, 128, 13, 10, 65, 0, 254])],
  ] as const
  const artifactEvidence = expected.map(([relative, bytes]) => {
    const actual = fs.readFileSync(path.join(aCtx.cwd!, relative))
    assert.deepEqual(actual, bytes)
    return { path: relative, bytes: actual.length, sha256: sha256(actual) }
  })
  assert.equal(produced.changes?.length, 2)
  const receipts = await store.list(tenantId, aCtx.sessionId)
  assert.equal(receipts.length, 2)
  assert(receipts.every(change => change.newHash && change.status === 'pending'))
  for (const [relative, bytes] of expected) {
    const absolute = path.resolve(aCtx.cwd!, relative)
    const receipt = receipts.find(change => process.platform === 'win32'
      ? change.path.toLowerCase() === absolute.toLowerCase() : change.path === absolute)
    assert.equal(receipt?.newHash, 'sha256:' + sha256(bytes), 'The durable receipt must hash the exact artifact bytes')
  }
  const reverted = await store.revertBatch(tenantId, { sessionId: aCtx.sessionId })
  assert.equal(reverted.reverted, 2)
  assert.equal(reverted.failed + reverted.conflicts + reverted.unavailable, 0)
  assert.equal(fs.existsSync(path.join(aCtx.cwd!, '成果')), false, 'Revert must remove newly created empty parents')
  assert((await store.list(tenantId, aCtx.sessionId)).every(change => change.status === 'reverted'))
  businessChecks.push({ scenario: 'A', name: 'ZIP → draft test → publish → selected registry → exact artifacts → durable revert',
    importJob: aJob.jobId, archiveSha256: sha256(Buffer.from(archive)), plugin: a.id, revisionHash: aDraft.hash,
    tools: aNames, unicodeInspection: draftResult.result, artifacts: artifactEvidence, revert: reverted })
  saveEvidence()

  // B: state is local to an invocation; parallel calls use independent processes.
  const b: PluginManifest = { apiVersion: 1, id: 'acceptance-data', name: 'CSV and asynchronous data workshop', version: '1.0.0',
    description: 'Parse CSV edge cases and coordinate bounded asynchronous batches', runtime: 'node',
    tools: ['csv', 'batch', 'bounded', 'hang'].map(name => ({ name, description: 'Acceptance data ' + name, inputSchema: { type: 'object', properties: {} }, entry: 'runner.mjs' })) }
  const bRunner = [
    "import {createHash} from 'node:crypto';",
    "let raw='';for await(const chunk of process.stdin)raw+=chunk;const {tool,args}=JSON.parse(raw);",
    "const hash=value=>createHash('sha256').update(value).digest('hex');",
    "function csv(input){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<input.length;i++){const c=input[i];if(quoted){if(c==='\"'&&input[i+1]==='\"'){cell+='\"';i++;}else if(c==='\"')quoted=false;else cell+=c;}else if(c==='\"'){if(cell)throw Error('invalid quote');quoted=true;}else if(c===','){row.push(cell);cell='';}else if(c==='\\r'||c==='\\n'){if(c==='\\r'&&input[i+1]==='\\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}if(quoted)throw Error('unclosed quote');if(cell||row.length){row.push(cell);rows.push(row);}return rows;}",
    "if(tool==='csv'){const rows=csv(args.csv),headers=rows.shift(),records=rows.map(row=>{if(row.length!==headers.length)throw Error('column mismatch');const obj=Object.create(null);headers.forEach((key,i)=>obj[key]=row[i]);return obj;});console.log(JSON.stringify({result:{rows:records,headers,prototypeClean:!Object.hasOwn(Object.prototype,'polluted')},artifacts:[{path:'parsed/结果.json',content:JSON.stringify(records,null,2)+'\\n'}]}));}",
    "else if(tool==='batch'){let completed=0;const values=await Promise.all(args.values.map(async(value,index)=>{await new Promise(resolve=>setTimeout(resolve,(index%3+1)*3));completed++;return {value,squared:value*value};}));console.log(JSON.stringify({result:{tag:args.tag,initial:0,completed,values,pid:process.pid}}));}",
    "else if(tool==='bounded'){const output='Z'.repeat(args.outputBytes);console.log(JSON.stringify({result:{inputBytes:Buffer.byteLength(args.text),inputHash:hash(args.text),output,outputHash:hash(output)}}));}",
    "else if(tool==='hang'){console.error('started cancellation probe');await new Promise(resolve=>setTimeout(resolve,30000));console.log(JSON.stringify({result:'late'}));}",
    "else throw Error('unsupported tool');",
  ].join('\n')
  write('sources/data/aether-plugin.json', JSON.stringify(b))
  write('sources/data/runner.mjs', bRunner)
  const bJob = await importer.previewImport(tenantId, { type: 'local', path: path.join(root, 'sources', 'data') })
  await importer.installImport(tenantId, bJob.jobId)
  const bDraft = await service.snapshot(tenantId, b.id, 1, { allowDraft: true })
  assert.equal(((await runPlugin(bDraft, 'batch', { tag: 'draft', values: [2] })).result as any).completed, 1)
  await service.publish(tenantId, b.id, 1)
  const bCtx = context('data-business'), bRegistry = await registryFor(b, bCtx)
  const callB = (name: string, args: unknown, ctx = bCtx) => bRegistry.execute(pluginToolName(b.id, name), args, ctx)
  const csv = '__proto__,constructor,note,名字\r\n"safe proto","safe constructor","line one\r\nline two, ""quoted""",张三\r\nordinary,ctor,"逗号,测试",李四\r\n'
  const parsed = ok(await callB('csv', { csv })).result
  assert.equal(parsed.rows.length, 2)
  assert.equal(Object.hasOwn(parsed.rows[0], '__proto__'), true)
  assert.equal(parsed.rows[0].__proto__, 'safe proto')
  assert.equal(parsed.rows[0].constructor, 'safe constructor')
  assert.equal(parsed.rows[0].note, 'line one\r\nline two, "quoted"')
  assert.equal(parsed.rows[1].名字, '李四')
  assert.equal(parsed.prototypeClean, true)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  const csvArtifact = fs.readFileSync(path.join(bCtx.cwd!, 'parsed', '结果.json'))
  assert.deepEqual(JSON.parse(csvArtifact.toString()), parsed.rows)
  const batches = await Promise.all([0, 1, 2].map(async index => ok(await callB('batch', { tag: 'batch-' + index, values: [index + 1, 5, 9] })).result))
  batches.forEach((result, index) => {
    assert.equal(result.tag, 'batch-' + index)
    assert.equal(result.initial, 0)
    assert.equal(result.completed, 3)
    assert.deepEqual(result.values.map((item: any) => item.squared), [(index + 1) ** 2, 25, 81])
  })
  assert.equal(new Set(batches.map(item => item.pid)).size, 3, 'Concurrent calls must use independent child processes')
  const inputText = 'x'.repeat(180_000)
  const large = ok(await callB('bounded', { text: inputText, outputBytes: 1_600_000 })).result
  assert.equal(large.inputBytes, 180_000)
  assert.equal(large.inputHash, sha256(inputText))
  assert.equal(large.output.length, 1_600_000)
  assert.equal(large.outputHash, sha256(large.output))
  businessChecks.push({ scenario: 'B', name: 'Directory → draft test → publish → CSV / concurrent state / bounded large data',
    importJob: bJob.jobId, plugin: b.id, revisionHash: bDraft.hash,
    csv: { rows: parsed.rows, artifactBytes: csvArtifact.length, artifactSha256: sha256(csvArtifact) },
    concurrentBatches: batches, largeData: { inputBytes: large.inputBytes, inputHash: large.inputHash, outputBytes: large.output.length, outputHash: large.outputHash },
    stateContract: 'State lives within one invocation. A subsequent call starts fresh. Persistent plugin state is not claimed.' })
  saveEvidence()

  // These are negative checks, not successful business functionality.
  const bSealed = await service.snapshot(tenantId, b.id, 1)
  await rejection('input bound', () => runPlugin(bSealed, 'bounded', { text: 'x'.repeat(270_000), outputBytes: 1 }), 'PLUGIN_INPUT_LIMIT')
  await rejection('output bound', () => runPlugin(bSealed, 'bounded', { text: '', outputBytes: 2_200_000 }), 'PLUGIN_OUTPUT_LIMIT')
  await rejection('deadline kills process', () => runPlugin(bSealed, 'hang', {}, { timeoutMs: 120 }), 'PLUGIN_TIMEOUT')
  const cancel = new AbortController(), cancelTimer = setTimeout(() => cancel.abort(), 150)
  try { await rejection('cancel kills process', () => runPlugin(bSealed, 'hang', {}, { signal: cancel.signal }), 'PLUGIN_CANCELLED') }
  finally { clearTimeout(cancelTimer) }
  assert.equal(ok(await callB('batch', { tag: 'after-kill', values: [6] })).result.completed, 1)
  negativeChecks.push({ name: 'capacity recovers after timeout and cancellation', outcome: 'usable again' })
  const maliciousArchive = zipSync({ 'aether-plugin.json': strToU8(JSON.stringify(a)), '../escape.mjs': strToU8('console.log(1)') })
  await rejection('ZIP path traversal', () => importer.previewImport(tenantId, { type: 'zip', base64: Buffer.from(maliciousArchive).toString('base64') }))
  assert.equal(fs.existsSync(path.join(root, 'escape.mjs')), false)
  await refused('artifact path traversal', () => aRegistry.execute(aNames[0], { artifacts: [{ path: '../escape.txt', content: 'bad' }] }, aCtx))
  await refused('duplicate artifact preflight', () => aRegistry.execute(aNames[0], { artifacts: [{ path: 'duplicate.txt', content: 'one' }, { path: 'duplicate.txt', content: 'two' }] }, aCtx))
  assert.equal(fs.existsSync(path.join(aCtx.cwd!, 'duplicate.txt')), false)
  await refused('artifact ancestor conflict preflight', () => aRegistry.execute(aNames[0], { artifacts: [{ path: 'parent.txt', content: 'one' }, { path: 'parent.txt/child.txt', content: 'two' }] }, aCtx))
  assert.equal(fs.existsSync(path.join(aCtx.cwd!, 'parent.txt')), false)
  await service.setEnabled(tenantId, b.id, false)
  await refused('disabled plugin blocked in existing registry', () => callB('batch', { tag: 'disabled', values: [1] }))
  await service.setEnabled(tenantId, b.id, true)
  const entry = path.join(bSealed.directory, 'runner.mjs'), original = fs.readFileSync(entry)
  try {
    fs.appendFileSync(entry, '\n// unauthorized byte change\n')
    await refused('sealed executable tampering blocked', () => callB('batch', { tag: 'tampered', values: [1] }))
  } finally { fs.writeFileSync(entry, original) }
  assert.equal(ok(await callB('batch', { tag: 'restored', values: [7] })).result.values[0].squared, 49)
  await store.revertBatch(tenantId, { sessionId: bCtx.sessionId })
  assert.equal(fs.existsSync(path.join(bCtx.cwd!, 'parsed')), false)
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  process.exitCode = 1
} finally {
  sessions.forEach(sessionId => clearSecurityMode(tenantId, sessionId))
  skillsRegistry.stop()
  try { evidence.databaseClose = await database.closeDb() }
  catch (error) { evidence.cleanupError = String(error); process.exitCode = 1 }
  evidence.finishedAt = new Date().toISOString()
  saveEvidence()
  console.log(JSON.stringify({ status: evidence.status, businessChecks: businessChecks.length, negativeChecks: negativeChecks.length, evidence: path.join(root, 'evidence.json') }))
}

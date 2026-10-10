import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { consumeSSE, executeTests } from './project-driver.mjs'

const root = path.resolve(process.env.LONGRUN_RUN_ROOT)
const base = process.env.LONGRUN_BASE
const headers = { 'content-type': 'application/json', 'x-aether-instance-token': process.env.LONGRUN_TOKEN, 'x-aether-tool-profile': 'code' }
const requestedModels = (process.env.LONGRUN_MODEL_LIST ?? '').split(',').map(value => value.trim()).filter(Boolean)
const cases = requestedModels.length
  ? requestedModels.map((model, index) => ({ model, thinkingMode: index < 3 ? false : 'low', temperature: index < 3 ? 0.2 : 0.35 }))
  : [
      { model: 'qwen3.8-flash', thinkingMode: false, temperature: 0.2 },
      { model: 'qwen3.8-flash', thinkingMode: 'low', temperature: 0.1 },
      { model: process.env.LONGRUN_OTHER_MODEL, thinkingMode: 'low', temperature: 0.35 },
    ]
const request = async (route, options = {}) => {
  const response = await fetch(base + '/api/v1' + route, { headers, ...options, signal: options.signal ?? AbortSignal.timeout(15000) })
  const value = await response.json()
  if (!response.ok || value.code >= 40000 || value.success === false) throw new Error(`${route}: HTTP ${response.status}, code ${value.code}`)
  return value.data
}
const results = await Promise.all(cases.map(async (config, index) => {
  const workspace = path.join(root, 'preflight', `case-${index + 1}`)
  fs.mkdirSync(workspace, { recursive: true })
  const sessionId = `model-preflight-${index + 1}-${randomUUID()}`
  const test = `import {test} from 'node:test';import assert from 'node:assert/strict';import {normalizeLabel} from './label.mjs';
test('collapse spacing',()=>assert.equal(normalizeLabel('  Build \\t UI  '),'Build UI'));
test('preserve unicode',()=>assert.equal(normalizeLabel('  开发 看板 '),'开发 看板'));
test('NFKC input',()=>assert.equal(normalizeLabel('ＡＢＣ'),'ABC'));
test('empty invalid',()=>assert.throws(()=>normalizeLabel('  '),RangeError));
test('type invalid',()=>assert.throws(()=>normalizeLabel(42),TypeError));
test('no lowercasing',()=>assert.equal(normalizeLabel('ReleaseAPI'),'ReleaseAPI'));
`
  fs.writeFileSync(path.join(workspace, 'contract.test.mjs'), test)
  fs.writeFileSync(path.join(workspace, 'label.mjs'), 'export function normalizeLabel(value) { throw new Error("NOT_IMPLEMENTED") }\n')
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Implement normalizeLabel: require a string, normalize Unicode NFKC, trim and collapse whitespace into single spaces; empty results throw RangeError, other types TypeError. Preserve case and non-ASCII text.\n')
  const out = { model: config.model, config, sessionId, workspace, startedAt: new Date().toISOString(), errors: [], passed: false }
  let agent
  try {
    agent = await request('/agents', { method: 'POST', body: JSON.stringify({ name: `Model preflight ${index + 1}`, model: config.model, temperature: config.temperature, allowedTools: ['read_file', 'write_file', 'edit_file', 'execute_cmd'], skills: [], mcpServers: [], knowledgeBases: [] }) })
    const body = { sessionId, agentId: agent.id, model: config.model, thinkingMode: config.thinkingMode, memoryScope: 'off', inheritContext: true, workspacePaths: [workspace], allowedTools: ['read_file', 'write_file', 'edit_file', 'execute_cmd'], message: `This is a real model/tool compatibility preflight. Read ${path.join(workspace, 'README.md')}, implement only label.mjs, never change contract.test.mjs. Execute execute_cmd with command node, args ["--test","contract.test.mjs"], cwd ${JSON.stringify(workspace)}, timeoutMs 30000. Fix failures until all six tests pass, then give the actual result. Do not use shell redirection, node -e, install, delete, or ask for approval bypass.` }
    const response = await fetch(base + '/api/v1/chat', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5 * 60000) })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`Preflight chat not SSE (${response.status}): ${(await response.text()).slice(0, 1000)}`)
    await consumeSSE(response.body, frame => {
      fs.appendFileSync(path.join(workspace, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...frame }) + '\n')
      if (frame.data.run) out.run = frame.data.run
      if (frame.data.error) out.errors.push({ source: 'sse', error: frame.data.error })
      if (frame.data.permissionRequest) out.errors.push({ source: 'permission', request: frame.data.permissionRequest })
    })
    const snapshot = await request('/chat/snapshot?sessionId=' + encodeURIComponent(sessionId))
    out.run = snapshot.run ?? out.run
    out.jobs = snapshot.commandJobs ?? []
    out.verification = await executeTests(workspace, { command: 'node', args: ['--test', 'contract.test.mjs'] }, 30000)
    out.protectedContractUnchanged = fs.readFileSync(path.join(workspace, 'contract.test.mjs'), 'utf8') === test
    out.agentTestsSucceeded = out.jobs.some(job => job.runId === out.run?.runId && job.status === 'succeeded' && job.exitCode === 0 && job.command === 'node' && JSON.stringify(job.args) === JSON.stringify(['--test', 'contract.test.mjs']))
    out.passed = out.run?.status === 'succeeded' && out.run?.modelId === config.model && out.run?.actualModelId === config.model && out.errors.length === 0 && out.verification.exitCode === 0 && out.verification.contractPassed === true && out.protectedContractUnchanged && out.agentTestsSucceeded
  } catch (error) { out.errors.push({ source: 'preflight', message: error.message }) }
  finally {
    try { out.cancel = await request('/chat/cancel', { method: 'POST', body: JSON.stringify({ sessionId }) }) } catch (error) { out.errors.push({ source: 'cancel', message: error.message }); out.passed = false }
  }
  out.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(workspace, 'result.json'), JSON.stringify(out, null, 2) + '\n')
  return out
}))
const result = { at: new Date().toISOString(), passed: results.every(value => value.passed), cases: results }
fs.writeFileSync(path.join(root, 'model-agent-preflight.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ passed: result.passed, cases: results.map(value => ({ model: value.config.model, thinkingMode: value.config.thinkingMode, status: value.run?.status, passed: value.passed, errors: value.errors })) }))
process.exitCode = result.passed ? 0 : 2

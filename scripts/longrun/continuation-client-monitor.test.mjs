import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadConfiguration, historyTitle, normalizeLease, observationFingerprint, parseArguments, runMonitor, validateObservation } from './continuation-client-monitor.mjs'

const buildId = 'sha256:' + 'a'.repeat(64)
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-client-monitor-contract-'))
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^aether-client-monitor-contract-/); fs.rmSync(directory, { recursive: true, force: true }) })
  const runRoot = path.join(directory, 'run'), clientRoot = path.join(directory, 'client')
  const write = (relative, value) => { const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
  write('run/continuation-state.json', { root: runRoot, sourceRoot: path.join(directory, 'original'), sessions: [1, 2, 3, 4, 5].map(index => ({ index, sessionId: 'session-' + index })) })
  write('run/supervisor-status.json', { phase: 'active', base: 'http://127.0.0.1:12500', buildId })
  fs.writeFileSync(path.join(runRoot, '.instance-token'), 'fixture-secret-token')
  write('client/resources/engine/win32-x64/stage-manifest.json', { buildId })
  write('client/resources/engine/win32-x64/dist/runtime/build-manifest.json', { buildId })
  write('client/package.json', { main: 'out/main/index.js' }); write('client/out/main/index.js', {})
  return { runRoot, clientRoot, write, options: { runRoot, clientRoot, buildId, intervalMs: 60_000, check: true } }
}

test('check validates retained candidate/session identity without loading or launching Electron or writing evidence', async t => {
  const f = fixture(t), before = fs.readdirSync(f.runRoot)
  const result = await runMonitor(f.options)
  assert.equal(result.checked, true); assert.equal(result.launched, false); assert.equal(result.sessions.length, 5)
  assert.deepEqual(fs.readdirSync(f.runRoot), before)
  assert.equal(JSON.stringify(result).includes('fixture-secret-token'), false)
})

test('refuses foreign run roots, duplicate retained sessions, non-owned endpoints and candidate drift', t => {
  const f = fixture(t)
  f.write('run/supervisor-status.json', { phase: 'active', base: 'http://127.0.0.1:12500', buildId: 'sha256:' + 'b'.repeat(64) })
  assert.throws(() => loadConfiguration(f.options), /Supervisor candidate/)
  for (const base of ['https://127.0.0.1:12500', 'http://outside.invalid', 'http://token@127.0.0.1:12500', 'http://127.0.0.1:12500/other']) {
    f.write('run/supervisor-status.json', { phase: 'active', base, buildId }); assert.throws(() => loadConfiguration(f.options), /exact loopback/)
  }
  f.write('run/supervisor-status.json', { phase: 'active', base: 'http://127.0.0.1:12500', buildId })
  f.write('run/continuation-state.json', { root: f.runRoot, sessions: Array(5).fill({ sessionId: 'same' }) })
  assert.throws(() => loadConfiguration(f.options), /unique/)
  f.write('run/continuation-state.json', { root: path.dirname(f.runRoot), sessions: [] })
  assert.throws(() => loadConfiguration(f.options), /does not match/)
})

test('browser lease authorizes only one exact retained selected session with an unexpired request identity', () => {
  const request = { requestId: 'actual-probe-1', sessionId: 's1', expiresAt: '2026-10-10T10:02:00Z' }, at = Date.parse('2026-10-10T10:00:00Z')
  assert.equal(normalizeLease(request, ['s1', 's2'], at).sessionId, 's1')
  assert.throws(() => normalizeLease({ ...request, sessionId: 'foreign' }, ['s1'], at), /original retained/)
  assert.throws(() => normalizeLease({ ...request, requestId: '../escape' }, ['s1'], at), /identity/)
  assert.throws(() => normalizeLease(request, ['s1'], at + 120_000), /future/)
})

function observation() {
  const snapshot = { schemaVersion: 1, sessionId: 's1', history: [{ id: 'old-user', role: 'user' }, { id: 'u1', role: 'user' }],
    run: { sessionId: 's1', runId: 'r1', modelId: 'MiniMax-M2.5', actualModelId: 'MiniMax-M2.5', userMessageId: 'u1', turnId: 't1', status: 'running', requestConfig: { skills: ['skill-1'], mcpServers: ['mcp-1'], knowledgeBases: ['kb-1'], memoryScope: 'session' } } }
  const memory = { sessionId: 's1', memoryScope: 'session', effectiveScope: 'session' }
  const ui = { sessionId: 's1', modelTitle: '当前模型：MiniMax-M2.5', resourceLabels: ['移除技能 skill-1', '移除 MCP mcp-1', '移除知识库 kb-1'], memoryLabel: '仅本会话⌄', userIds: ['u1'], latestTurnId: 't1', browser: { sessionId: 's1', status: 'connected' } }
  return { snapshot, memory, ui }
}

test('compares actual restored resources/model/memory/message identities and permits the real paginated UI window', () => {
  const { snapshot, memory, ui } = observation()
  assert.equal(validateObservation(snapshot, memory, ui).requestedModel, 'MiniMax-M2.5')
  assert.throws(() => validateObservation(snapshot, memory, { ...ui, modelTitle: '当前模型：kimi-k2.6' }), /requested model/)
  assert.throws(() => validateObservation(snapshot, memory, { ...ui, browser: { status: 'connected', sessionId: 's2' } }), /another session/)
  assert.throws(() => validateObservation(snapshot, memory, { ...ui, resourceLabels: [] }), /resources/)
  assert.throws(() => validateObservation(snapshot, memory, { ...ui, memoryLabel: '全局记忆' }), /Memory menu/)
  assert.throws(() => validateObservation(snapshot, memory, { ...ui, userIds: ['u1', 'foreign'] }), /another selected session/)
  assert.throws(() => validateObservation(snapshot, memory, { ...ui, userIds: ['u1', 'u1'] }), /duplicated/)
  assert.throws(() => validateObservation(snapshot, memory, { ...ui, latestTurnId: 'foreign-turn' }), /another turn/)
})

test('rotation fingerprint detects a new model/resource/root or changed memory but permits progress within the same request', () => {
  const { snapshot, memory } = observation(), original = observationFingerprint(snapshot, memory)
  assert.equal(observationFingerprint({ ...snapshot, run: { ...snapshot.run, status: 'succeeded' } }, memory), original)
  assert.notEqual(observationFingerprint({ ...snapshot, run: { ...snapshot.run, modelId: 'kimi-k2.6' } }, memory), original)
  assert.notEqual(observationFingerprint({ ...snapshot, run: { ...snapshot.run, runId: 'r2' } }, memory), original)
  assert.notEqual(observationFingerprint(snapshot, { ...memory, memoryScope: 'global' }), original)
})

test('argument parsing and content titles preserve real attachment text while rejecting malformed startup', () => {
  const args = ['--run-root', 'run', '--client-root', 'candidate', '--build-id', buildId, '--check']
  assert.equal(parseArguments(args).check, true)
  assert.throws(() => parseArguments([...args, '--check']), /Repeated/)
  assert.throws(() => parseArguments([...args, '--interval-ms', 'NaN']), /interval/)
  assert.equal(historyTitle(JSON.stringify([{ type: 'text', text: '开发项目\n阶段1' }, { type: 'image' }])), '开发项目')
  assert.equal(historyTitle('x'.repeat(51)), 'x'.repeat(50) + '…')
})

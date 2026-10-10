import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverContinuation } from './recover-continuation-state.mjs'
import { modelFor } from './continuation-driver.mjs'

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-recover-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const runs = path.join(project, 'runs'), source = path.join(runs, 'old'), target = path.join(runs, 'recovery-test')
  fs.mkdirSync(source, { recursive: true })
  const write = (relative, value) => { const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
  const sessions = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, sessionId: 'retained-' + i, roleId: 'role-' + i, accepted: i === 4 ? [{ id: 'accepted', kind: 'retained-audit' }] : [], rounds: [{ success: false, evidenceFile: path.join(source, 'sessions/session-' + (i + 1) + '/failure.json') }], errors: [{ message: 'original failure' }], pending: null, status: 'failed' }))
  write('continuation-state.json', { root: source, sourceRoot: path.join(runs, 'R4'), projectRoot: project, sessions })
  write('checkpoint.json', { root: source, sourceRoot: path.join(runs, 'R4'), firstDispatchAt: '2026-01-01T00:00:00Z', durationMs: 1, sessions })
  write('continuation-cleanup.json', { inventoryComplete: true, remaining: [], errors: [], databaseAudit: { passed: true, databases: ['agent', 'memory', 'knowledge'].map(file => ({ file, backend: 'native-libsql', passed: true })) } })
  write('supervisor-status.json', { phase: 'stopped' })
  write('requirements/queue.json', { requirements: [{ id: 'next', dependencies: ['accepted', 'runtime-upgrade-acceptance-gate'] }] })
  write('requirements/frozen/next/baseline.json', { exitCode: 1, testSummary: { pass: 1, fail: 3 } })
  write('sessions/default/retained-0.jsonl', { originalMessage: 'private archived fact' })
  write('sessions/session-1/failure.json', { failed: true })
  write('resources.json', { engineLogFile: path.join(source, 'engine.out.log'), knowledgeApiAcceptance: { passed: true }, inlineMcpServers: [{ args: ['fixture', path.join(source, 'resources')] }] })
  return { source, target, write }
}

test('recovery keeps five identities, old failures, accepted work and original red baseline without replaying old attempts', t => {
  const { source, target } = fixture(t), old = fs.readFileSync(path.join(source, 'checkpoint.json'))
  const result = recoverContinuation(source, target)
  assert.equal(result.sessionIds.length, 5)
  const checkpoint = JSON.parse(fs.readFileSync(path.join(target, 'checkpoint.json')))
  assert.equal(checkpoint.firstDispatchAt, null)
  assert.equal(checkpoint.durationMs, 360 * 60000)
  assert.deepEqual(checkpoint.sessions[4].accepted.map(item => item.id), ['accepted'])
  assert.equal(checkpoint.sessions[4].modelRotationBase, 1)
  assert.equal(modelFor(5, checkpoint.sessions[4].accepted.length - checkpoint.sessions[4].modelRotationBase), 'glm-5.3')
  assert.equal(checkpoint.sessions.every(item => item.rounds.length === 0 && item.errors.length === 0 && !item.pending), true)
  assert.deepEqual(fs.readFileSync(path.join(source, 'checkpoint.json')), old)
  assert.equal(fs.existsSync(path.join(target, 'sessions/session-1/failure.json')), false)
  assert.equal(fs.existsSync(path.join(target, 'sessions/default/retained-0.jsonl')), true)
  const history = JSON.parse(fs.readFileSync(path.join(target, 'recovery-history.json')))
  assert.equal(history.priorSessions[0].rounds[0].success, false)
  assert.equal(fs.existsSync(history.priorSessions[0].rounds[0].evidenceFile), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'requirements/frozen/next/baseline.json'))).testSummary.fail, 3)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'requirements/queue.json'))).requirements[0].dependencies, ['accepted'])
  const resources = JSON.parse(fs.readFileSync(path.join(target, 'resources.json')))
  assert.equal(resources.engineLogFile, path.join(target, 'engine.out.log'))
  assert.equal(resources.knowledgeApiAcceptance.passed, false)
})

test('recovery rejects active processes, failed integrity and source aliases before creating any run', t => {
  const { source, target, write } = fixture(t)
  write('continuation-cleanup.json', { remaining: [{ pid: 123 }], errors: [] })
  assert.throws(() => recoverContinuation(source, target), /unresolved/)
  assert.equal(fs.existsSync(target), false)
  write('continuation-cleanup.json', { inventoryComplete: true, remaining: [], errors: [], databaseAudit: { passed: false } })
  assert.throws(() => recoverContinuation(source, target), /Authoritative/)
  assert.equal(fs.existsSync(target), false)
})

test('an empty list from a failed process inventory is never cleanup proof', t => {
  const { source, target, write } = fixture(t)
  write('continuation-cleanup.json', { remaining: [], errors: [], inventoryComplete: false })
  assert.throws(() => recoverContinuation(source, target), /Complete stopped process/)
  assert.equal(fs.existsSync(target), false)
})

test('recovery refuses an existing destination or symlinked runtime data', t => {
  const { source, target } = fixture(t)
  fs.mkdirSync(target)
  assert.throws(() => recoverContinuation(source, target), /new contained/)
})

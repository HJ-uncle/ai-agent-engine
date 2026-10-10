import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { recordClientAcceptance, parseArguments, fullCommand } from './record-client-acceptance.mjs'
import { qualifyClientEvidence } from './analyze-continuation.mjs'

const buildId = 'sha256:' + 'a'.repeat(64)
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-acceptance-record-'))
  t.after(() => { assert.equal(path.dirname(temp), os.tmpdir()); assert.match(path.basename(temp), /^client-acceptance-record-/); fs.rmSync(temp, { recursive: true, force: true }) })
  const engineRoot = path.join(temp, 'engine'), runRoot = path.join(engineRoot, 'test-projects', 'longrun-20261009', 'runs', 'recovery-fixture')
  put(path.join(runRoot, 'continuation-state.json'), { root: runRoot, sourceRoot: path.join(path.dirname(runRoot), 'original'), projectRoot: path.dirname(path.dirname(runRoot)) })
  put(path.join(runRoot, 'continuation-freeze.json'), { at: 1000, source: { manifest: { buildId } } })
  const specs = ['create and read', 'edit and delete'].map(title => ({ file: 'crud.spec.ts', title, ok: true, tests: [{ projectName: '', expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] }))
  const raw = { config: { argv: ['node', 'playwright', 'test', '--reporter=list,json', '--output=../results'] }, suites: [{ title: 'crud.spec.ts', specs }], errors: [], stats: { startTime: 1200, duration: 100, expected: 2, skipped: 0, unexpected: 0, flaky: 0 } }
  const list = structuredClone(raw)
  list.config.argv = ['node', 'playwright', 'test', '--list', '--reporter=json']
  for (const spec of list.suites[0].specs) { spec.tests[0].results = []; spec.tests[0].status = 'skipped' }
  const listFile = path.join(temp, 'registration.json'), reportFile = path.join(temp, 'execution.json'), logFile = path.join(temp, 'execution.log')
  put(listFile, list); put(reportFile, raw); put(logFile, '2 passed\n')
  const options = { engineRoot, runRoot, buildId, startedAt: 1100, finishedAt: 1400, listFile, reportFile, logFile, exitCode: 0, signal: null, timedOut: false }
  const save = () => { put(listFile, list); put(reportFile, raw) }
  return { temp, runRoot, engineRoot, options, list, raw, save }
}

test('records exact full workflow identities and unchanged raw hashes in the owned run', t => {
  const f = fixture(t), before = new Map([f.options.listFile, f.options.reportFile, path.join(f.runRoot, 'continuation-freeze.json')].map(file => [file, sha(fs.readFileSync(file))]))
  const { file, receipt } = recordClientAcceptance(f.options)
  assert.equal(receipt.scope, 'full-client'); assert.equal(receipt.fullSuite, true); assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.checks.map(row => row.name), ['crud.spec.ts :: crud.spec.ts > create and read', 'crud.spec.ts :: crud.spec.ts > edit and delete'])
  assert.deepEqual(receipt.totals, { expected: 2, executed: 2, passed: 2, failed: 0, skipped: 0, flaky: 0, notRun: 0 })
  assert.equal(receipt.exitCode, 0); assert.equal(receipt.signal, null); assert.equal(receipt.timedOut, false)
  for (const [source, hash] of before) assert.equal(sha(fs.readFileSync(source)), hash)
  assert.equal(sha(fs.readFileSync(path.join(f.runRoot, receipt.listFile))), receipt.listSha256)
  assert.equal(sha(fs.readFileSync(path.join(f.runRoot, receipt.rawReportFile))), receipt.rawReportSha256)
  assert.equal(qualifyClientEvidence(receipt, file, buildId, 1000).passed, true)
  assert.equal(JSON.parse(fs.readFileSync(file)).passed, true)
})

test('does not overwrite any previous acceptance or partial raw proof', t => {
  for (const target of ['client-acceptance.json', 'proofs/full-client/execution.json']) {
    const f = fixture(t), file = path.join(f.runRoot, target); put(file, 'prior proof')
    assert.throws(() => recordClientAcceptance(f.options), /already exists/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'prior proof')
    assert.equal(fs.existsSync(path.join(f.runRoot, 'proofs/full-client/registration.json')), false)
  }
})

test('rejects wrong ownership, escape directories and changed freeze build identities before writing', t => {
  const f = fixture(t)
  assert.throws(() => recordClientAcceptance({ ...f.options, runRoot: f.engineRoot }), /owned recovery/)
  const state = path.join(f.runRoot, 'continuation-state.json')
  put(state, { root: f.runRoot, sourceRoot: f.runRoot })
  assert.throws(() => recordClientAcceptance(f.options), /ownership/)
  put(state, { root: f.runRoot, sourceRoot: path.dirname(f.runRoot) })
  assert.throws(() => recordClientAcceptance({ ...f.options, buildId: 'sha256:' + 'b'.repeat(64) }), /buildId/)
  assert.equal(fs.existsSync(path.join(f.runRoot, 'proofs')), false)
})

test('rejects linked proof directories and linked source evidence before writes', t => {
  const f = fixture(t), outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(f.runRoot, 'proofs'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => recordClientAcceptance(f.options), /contains a link/)
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.unlinkSync(path.join(f.runRoot, 'proofs'))
  fs.symlinkSync(path.join(outside, 'missing'), path.join(f.runRoot, 'proofs'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => recordClientAcceptance(f.options), /contains a link/)
  fs.unlinkSync(path.join(f.runRoot, 'proofs'))
  const linked = path.join(f.temp, 'linked-input'); fs.symlinkSync(path.dirname(f.options.listFile), linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => recordClientAcceptance({ ...f.options, listFile: path.join(linked, 'registration.json') }), /contains a link/)
  assert.equal(fs.existsSync(path.join(f.runRoot, 'proofs')), false)
})

for (const mutation of ['failure', 'skip', 'flaky', 'missing', 'duplicate', 'global-error', 'exit-code', 'signal', 'timed-out', 'filtered-list', 'filtered-execution', 'stale', 'missing-duration']) {
  test('preserves '+mutation+' evidence and records an unpassed gate', t => {
    const f = fixture(t), spec = f.raw.suites[0].specs[1], observed = spec.tests[0]
    if (mutation === 'failure') { spec.ok = false; observed.status = 'unexpected'; observed.results[0].status = 'failed'; f.raw.stats.expected = 1; f.raw.stats.unexpected = 1 }
    if (mutation === 'skip') { spec.ok = false; observed.status = 'skipped'; observed.results[0].status = 'skipped'; f.raw.stats.expected = 1; f.raw.stats.skipped = 1 }
    if (mutation === 'flaky') { observed.status = 'flaky'; observed.results.unshift({ status: 'failed' }); f.raw.stats.expected = 1; f.raw.stats.flaky = 1 }
    if (mutation === 'missing') f.raw.suites[0].specs.pop()
    if (mutation === 'duplicate') f.raw.suites[0].specs.push(structuredClone(spec))
    if (mutation === 'global-error') f.raw.errors.push({ message: 'Actual beforeAll failure' })
    if (mutation === 'exit-code') f.options.exitCode = 1
    if (mutation === 'signal') f.options.signal = 'SIGTERM'
    if (mutation === 'timed-out') f.options.timedOut = true
    if (mutation === 'filtered-list') f.list.config.argv.push('crud.spec.ts')
    if (mutation === 'filtered-execution') f.raw.config.argv.push('--grep=create')
    if (mutation === 'stale') f.raw.stats.startTime = 900
    if (mutation === 'missing-duration') delete f.raw.stats.duration
    f.save()
    const { receipt, file } = recordClientAcceptance(f.options)
    assert.equal(receipt.passed, false)
    assert.equal(receipt.qualification.passed, false)
    assert.ok(receipt.qualification.reasons.length)
    assert.equal(sha(fs.readFileSync(path.join(f.runRoot, receipt.rawReportFile))), sha(fs.readFileSync(f.options.reportFile)))
    assert.equal(JSON.parse(fs.readFileSync(file)).passed, false)
    if (mutation === 'skip') assert.equal(receipt.totals.skipped, 1)
  })
}

test('invalid JSON is retained byte-for-byte and cannot qualify as passed', t => {
  const f = fixture(t); fs.writeFileSync(f.options.reportFile, '{truncated report')
  const { receipt } = recordClientAcceptance(f.options)
  assert.equal(receipt.passed, false); assert.match(receipt.qualification.reasons.join('\n'), /not valid JSON/)
  assert.equal(fs.readFileSync(path.join(f.runRoot, receipt.rawReportFile), 'utf8'), '{truncated report')
})

test('CLI and full-command parsing cannot silently narrow or fabricate run status', () => {
  assert.equal(fullCommand(['node', 'cli', 'test', '--list', '--reporter', 'json'], true), true)
  assert.equal(fullCommand(['node', 'cli', 'test', '--reporter=list,json'], false), true)
  for (const flag of ['crud.spec.ts', '--grep=crud', '--project=only', '--shard=1/2', '--last-failed', '--repeat-each=2']) assert.equal(fullCommand(['node', 'cli', 'test', flag], false), false)
  assert.equal(fullCommand(['node', 'cli', 'test', '--list'], false), false)
  assert.throws(() => parseArguments(['--signal', 'TERM', '--signal', 'KILL']), /duplicate/)
  assert.throws(() => parseArguments(['--timed-out', 'maybe']), /true or false/)
  assert.throws(() => parseArguments(['--exit-code']), /incomplete/)
  assert.deepEqual(parseArguments(['--exit-code', '0']), { exitCode: 0, signal: null, timedOut: false })
})
